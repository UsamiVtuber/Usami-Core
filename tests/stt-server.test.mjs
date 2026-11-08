import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSttHandler, parseMultipartAudio } from '../server.mjs';
import { buildTranscribeCommand, resolveWhisperModelName, resetWhisperModelCache } from '../src/stt.js';

const BOUNDARY = 'usamiBoundary42';
const API_TOKEN = 'token-teste';
const MULTIPART_HEADERS = { 'content-type': 'multipart/form-data; boundary=' + BOUNDARY, host: '127.0.0.1:8787', 'x-usami-token': API_TOKEN };
const AUDIO_BYTES = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0xff, 0x10, 0x7f]);

// Toda rota /api/stt é escrita sensível (D2): os testes autenticam por padrão.
function createHandler(options = {}) {
  return createSttHandler({ apiToken: API_TOKEN, ...options });
}

function mockReq({ method = 'POST', url = '/api/stt', headers = {}, body = '' } = {}) {
  const chunks = Buffer.isBuffer(body) ? [body] : [Buffer.from(body)];
  return {
    method,
    url,
    headers,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

function mockRes() {
  const res = { statusCode: null, headers: null, body: '' };
  res.writeHead = (status, headers) => { res.statusCode = status; res.headers = headers; };
  res.end = (data) => { res.body = data; };
  return res;
}

function multipartBody(parts) {
  const chunks = [];
  for (const part of parts) {
    chunks.push(Buffer.from('--' + BOUNDARY + '\r\n'));
    let header = 'Content-Disposition: form-data; name="' + part.name + '"';
    if (part.filename !== undefined) header += '; filename="' + part.filename + '"';
    header += '\r\n';
    if (part.contentType) header += 'Content-Type: ' + part.contentType + '\r\n';
    chunks.push(Buffer.from(header + '\r\n'));
    chunks.push(Buffer.isBuffer(part.data) ? part.data : Buffer.from(part.data));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from('--' + BOUNDARY + '--\r\n'));
  return Buffer.concat(chunks);
}

function audioBody(data = AUDIO_BYTES, filename = 'blob.webm') {
  // um campo de texto antes do arquivo garante que o parser ignora extras
  return multipartBody([
    { name: 'language', data: 'ignored' },
    { name: 'audio', filename, contentType: 'audio/webm', data },
  ]);
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'usami-stt-'));
}

async function call(handler, { body, headers = MULTIPART_HEADERS, method = 'POST', url = '/api/stt' } = {}) {
  const res = mockRes();
  await handler(mockReq({ method, url, headers, body }), res);
  return res;
}

test('handler: 200 transcreve o áudio e devolve { text } com temp criado e apagado', async () => {
  const dir = tempDir();
  const seen = [];
  const transcribeImpl = async (args) => {
    seen.push(args);
    assert.ok(existsSync(args.audioPath), 'temp file exists during transcription');
    assert.deepEqual(await readFile(args.audioPath), AUDIO_BYTES, 'temp file holds the uploaded bytes');
    return ' olá mundo ';
  };
  try {
    const handler = createHandler({ transcribeImpl, tmpDir: dir, getConfig: async () => ({ whisperModel: 'tiny' }) });
    const res = await call(handler, { body: audioBody() });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['Content-Type'], 'application/json; charset=utf-8');
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assert.deepEqual(JSON.parse(res.body), { text: 'olá mundo' });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].modelName, 'tiny');
    assert.equal(seen[0].language, 'pt');
    assert.equal(seen[0].beamSize, 1);
    assert.equal(seen[0].timeoutMs, 60000);
    assert.match(seen[0].audioPath, /\.webm$/);
    assert.ok(!existsSync(seen[0].audioPath), 'temp file removed after transcription');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('handler: origem do host é aceita (mesmo padrão do chat/tts)', async () => {
  const dir = tempDir();
  try {
    const handler = createHandler({ transcribeImpl: async () => 'oi', tmpDir: dir });
    const res = await call(handler, { body: audioBody(), headers: { ...MULTIPART_HEADERS, origin: 'http://127.0.0.1:5173' } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), { text: 'oi' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('handler: 400 quando o campo audio está ausente (impl nunca chamado)', async () => {
  let calls = 0;
  const handler = createHandler({ transcribeImpl: async () => { calls++; return 'x'; } });
  const textOnly = await call(handler, { body: multipartBody([{ name: 'message', data: 'oi' }]) });
  assert.equal(textOnly.statusCode, 400);
  assert.deepEqual(JSON.parse(textOnly.body), { error: 'Campo "audio" ausente.' });
  const emptyBody = await call(handler, { body: Buffer.alloc(0) });
  assert.equal(emptyBody.statusCode, 400);
  const noBoundary = await call(handler, { headers: { 'content-type': 'multipart/form-data', host: '127.0.0.1:8787', 'x-usami-token': API_TOKEN }, body: audioBody() });
  assert.equal(noBoundary.statusCode, 400);
  assert.deepEqual(JSON.parse(noBoundary.body), { error: 'Requisição multipart inválida (boundary ausente).' });
  assert.equal(calls, 0);
});

test('handler: 400 quando o arquivo de áudio está vazio', async () => {
  let calls = 0;
  const handler = createHandler({ transcribeImpl: async () => { calls++; return 'x'; } });
  const res = await call(handler, { body: multipartBody([{ name: 'audio', filename: 'blob.webm', contentType: 'audio/webm', data: Buffer.alloc(0) }]) });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(JSON.parse(res.body), { error: 'Arquivo de áudio vazio.' });
  assert.equal(calls, 0);
});

test('handler: 403 origem não autorizada (impl nunca chamado)', async () => {
  let calls = 0;
  const handler = createHandler({ transcribeImpl: async () => { calls++; return 'x'; } });
  const res = await call(handler, { body: audioBody(), headers: { ...MULTIPART_HEADERS, origin: 'https://evil.com' } });
  assert.equal(res.statusCode, 403);
  assert.deepEqual(JSON.parse(res.body), { error: 'Origem não autorizada.' });
  assert.equal(calls, 0);
});

test('handler: 403 content-type não é multipart/form-data', async () => {
  let calls = 0;
  const handler = createHandler({ transcribeImpl: async () => { calls++; return 'x'; } });
  const res = await call(handler, { body: JSON.stringify({ text: 'oi' }), headers: { 'content-type': 'application/json', host: '127.0.0.1:8787', 'x-usami-token': API_TOKEN } });
  assert.equal(res.statusCode, 403);
  assert.deepEqual(JSON.parse(res.body), { error: 'Content-Type inválido.' });
  assert.equal(calls, 0);
});

test('handler: 404 método ou rota incorretos', async () => {
  const handler = createHandler({ transcribeImpl: async () => 'x' });
  const get = await call(handler, { method: 'GET', headers: { host: '127.0.0.1:8787' } });
  assert.equal(get.statusCode, 404);
  const other = await call(handler, { method: 'POST', url: '/api/other', headers: { host: '127.0.0.1:8787' }, body: audioBody() });
  assert.equal(other.statusCode, 404);
  assert.deepEqual(JSON.parse(other.body), { error: 'Não encontrado.' });
});

test('handler: 500 quando a transcrição falha (temp é apagado mesmo assim)', async () => {
  const dir = tempDir();
  const seen = [];
  const transcribeImpl = async (args) => {
    seen.push(args.audioPath);
    throw new Error('boom');
  };
  try {
    const handler = createHandler({ transcribeImpl, tmpDir: dir });
    const res = await call(handler, { body: audioBody() });
    assert.equal(res.statusCode, 500);
    assert.deepEqual(JSON.parse(res.body), { error: 'Falha na transcrição.' });
    assert.ok(!existsSync(seen[0]), 'temp removed even on failure');

    const handlerNonString = createHandler({ transcribeImpl: async () => null, tmpDir: dir });
    const resNull = await call(handlerNonString, { body: audioBody() });
    assert.equal(resNull.statusCode, 500);
    assert.deepEqual(JSON.parse(resNull.body), { error: 'Falha na transcrição.' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('handler: 504 quando a transcrição demora mais que timeoutMs (temp é apagado)', async () => {
  const dir = tempDir();
  const seen = [];
  const transcribeImpl = async (args) => {
    seen.push(args.audioPath);
    await new Promise(resolve => setTimeout(resolve, 300));
    return 'tarde demais';
  };
  try {
    const handler = createHandler({ transcribeImpl, tmpDir: dir, timeoutMs: 50 });
    const res = await call(handler, { body: audioBody() });
    assert.equal(res.statusCode, 504);
    assert.deepEqual(JSON.parse(res.body), { error: 'Transcrição expirou.' });
    assert.ok(!existsSync(seen[0]), 'temp removed even on timeout');

    // impl que rejeita com TimeoutError (comportamento do transcribeAudio real)
    const handlerTimeoutError = createHandler({
      tmpDir: dir,
      timeoutMs: 60000,
      transcribeImpl: async () => { const e = new Error('expirou'); e.name = 'TimeoutError'; throw e; },
    });
    const resTimeoutError = await call(handlerTimeoutError, { body: audioBody() });
    assert.equal(resTimeoutError.statusCode, 504);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('handler: 413 áudio acima do limite de bytes', async () => {
  let calls = 0;
  const handler = createHandler({ transcribeImpl: async () => { calls++; return 'x'; }, maxBodyBytes: 16 });
  const res = await call(handler, { body: audioBody(Buffer.alloc(64, 0x01)) });
  assert.equal(res.statusCode, 413);
  assert.deepEqual(JSON.parse(res.body), { error: 'Áudio muito grande.' });
  assert.equal(calls, 0);
});

test('handler: modelName vem de options.model > config > env, com fallback "base"', async () => {
  const dir = tempDir();
  const savedEnv = process.env.WHISPER_MODEL;
  const names = [];
  const impl = async (args) => { names.push(args.modelName); return 'x'; };
  try {
    delete process.env.WHISPER_MODEL;
    const body = audioBody(Buffer.from([0x01]));
    const viaConfig = createHandler({ transcribeImpl: impl, tmpDir: dir, getConfig: async () => ({ WHISPER_MODEL: 'via-config' }) });
    await call(viaConfig, { body });
    const viaString = createHandler({ transcribeImpl: impl, tmpDir: dir, getConfig: async () => 'via-string' });
    await call(viaString, { body });
    const viaOptions = createHandler({ transcribeImpl: impl, tmpDir: dir, model: 'via-options', getConfig: async () => ({ whisperModel: 'via-config' }) });
    await call(viaOptions, { body });
    const broken = createHandler({ transcribeImpl: impl, tmpDir: dir, getConfig: async () => { throw new Error('boom'); } });
    await call(broken, { body });
    assert.deepEqual(names, ['via-config', 'via-string', 'via-options', 'base']);
  } finally {
    if (savedEnv === undefined) delete process.env.WHISPER_MODEL;
    else process.env.WHISPER_MODEL = savedEnv;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('handler: 401 sem token; 503 quando o servidor não tem token configurado', async () => {
  let calls = 0;
  const handler = createHandler({ transcribeImpl: async () => { calls++; return 'x'; } });
  const { 'x-usami-token': _omit, ...noToken } = MULTIPART_HEADERS;
  const missing = await call(handler, { body: audioBody(), headers: noToken });
  assert.equal(missing.statusCode, 401);
  assert.deepEqual(JSON.parse(missing.body), { error: 'Token ausente ou inválido.' });

  const wrong = await call(handler, { body: audioBody(), headers: { ...MULTIPART_HEADERS, 'x-usami-token': 'token-errado' } });
  assert.equal(wrong.statusCode, 401);

  const failClosed = await call(createSttHandler({ apiToken: '', transcribeImpl: async () => { calls++; return 'x'; } }), { body: audioBody() });
  assert.equal(failClosed.statusCode, 503);
  assert.equal(calls, 0);
});

test('handler: semáforo limita a 1 transcrição simultânea e rejeita a 4ª (fila 2)', async () => {
  const dir = tempDir();
  let active = 0;
  let peak = 0;
  const transcribeImpl = async () => {
    active++;
    peak = Math.max(peak, active);
    try {
      await new Promise(resolve => setTimeout(resolve, 120));
      return 'ok';
    } finally {
      active--;
    }
  };
  try {
    const handler = createHandler({ transcribeImpl, tmpDir: dir });
    const responses = await Promise.all([
      call(handler, { body: audioBody() }),
      call(handler, { body: audioBody() }),
      call(handler, { body: audioBody() }),
      call(handler, { body: audioBody() }),
    ]);
    const statuses = responses.map(res => res.statusCode).sort((a, b) => a - b);
    assert.deepEqual(statuses, [200, 200, 200, 429]);
    assert.equal(peak, 1, 'nunca há duas transcrições ao mesmo tempo');
    const busy = responses.find(res => res.statusCode === 429);
    assert.deepEqual(JSON.parse(busy.body), { error: 'STT ocupado, tente novamente.' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parseMultipartAudio: extrai bytes exatos do campo audio (binário) e extensão', () => {
  const parsed = parseMultipartAudio(audioBody(), 'multipart/form-data; boundary=' + BOUNDARY);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.audio, AUDIO_BYTES);
  assert.equal(parsed.extension, 'webm');
  const ogg = parseMultipartAudio(audioBody(AUDIO_BYTES, 'rec-123.ogg'), 'multipart/form-data; boundary=' + BOUNDARY);
  assert.equal(ogg.ok, true);
  assert.equal(ogg.extension, 'ogg');
});

test('parseMultipartAudio: boundary entre aspas, sem filename e boundary ausente', () => {
  const quoted = parseMultipartAudio(audioBody(), 'multipart/form-data; boundary="' + BOUNDARY + '"');
  assert.equal(quoted.ok, true);
  assert.deepEqual(quoted.audio, AUDIO_BYTES);
  const noName = parseMultipartAudio(multipartBody([{ name: 'audio', data: AUDIO_BYTES }]), 'multipart/form-data; boundary=' + BOUNDARY);
  assert.equal(noName.ok, true);
  assert.equal(noName.extension, null);
  assert.deepEqual(noName.audio, AUDIO_BYTES);
  assert.equal(parseMultipartAudio(Buffer.alloc(0), 'multipart/form-data').ok, false);
});

test('buildTranscribeCommand: comando python exato do faster-whisper (argv e código)', () => {
  const args = buildTranscribeCommand({ audioPath: 'tmp/abc.webm', modelName: 'base', language: 'pt', beamSize: 1 });
  assert.equal(args[0], '-c');
  const code = args[1];
  assert.ok(code.includes('from faster_whisper import WhisperModel'));
  assert.ok(code.includes('model = WhisperModel(sys.argv[1], device="cpu", compute_type="int8")'));
  assert.ok(code.includes('segments, _ = model.transcribe(sys.argv[2], language=sys.argv[3], beam_size=int(sys.argv[4]))'));
  assert.ok(code.includes('print(" ".join(segment.text for segment in segments))'));
  // shim de compatibilidade: av.open(metadata_errors=...) quebrou em av 19
  assert.ok(code.includes('av.open = _av_open_compat'));
  assert.deepEqual(args.slice(2), ['base', 'tmp/abc.webm', 'pt', '1']);
  // beamSize inválido cai em 1; language vazia cai em 'pt'
  const guarded = buildTranscribeCommand({ audioPath: 'tmp/x.ogg', modelName: 'tiny', language: '', beamSize: 'não-número' });
  assert.deepEqual(guarded.slice(2), ['tiny', 'tmp/x.ogg', 'pt', '1']);
});

test('resolveWhisperModelName: cacheia o nome do modelo na primeira resolução', () => {
  const saved = process.env.WHISPER_MODEL;
  try {
    resetWhisperModelCache();
    process.env.WHISPER_MODEL = 'tiny';
    assert.equal(resolveWhisperModelName(), 'tiny');
    process.env.WHISPER_MODEL = 'base';
    assert.equal(resolveWhisperModelName(), 'tiny', 'cached value wins over later env changes');
    resetWhisperModelCache();
    assert.equal(resolveWhisperModelName(), 'base');
    delete process.env.WHISPER_MODEL;
    resetWhisperModelCache();
    assert.equal(resolveWhisperModelName(), 'base', 'default fallback');
  } finally {
    if (saved === undefined) delete process.env.WHISPER_MODEL;
    else process.env.WHISPER_MODEL = saved;
    resetWhisperModelCache();
  }
});
