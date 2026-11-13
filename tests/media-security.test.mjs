import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Isola o depósito de módulo do server.mjs antes do import (nunca toca em data/).
process.env.USAMI_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'usami-media-security-mod-'));
process.env.USE_NVIDIA = 'false';

const { analyzeMedia, videoTempPath, VIDEO_EXTENSIONS } = await import('../src/media-analyzer.js');
const { createMediaAnalyzeHandler } = await import('../server.mjs');

const ORIGINS = ['http://127.0.0.1:5173'];
const TOKEN = 'media-token';

function geminiImageResponse(reply = 'Vi tudo!') {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify({ reply, gesture: 'nod', actions: [], ocr: [] }) } }],
    }),
  };
}

// --- B1: caminho do vídeo --------------------------------------------------

test('videoTempPath: nome interno fixo e extensão só da allowlist', () => {
  const dir = path.join(tmpdir(), 'usami-fake-temp');
  const cases = [
    ['../../escape.mp4', 'input.mp4'],
    ['..\\..\\escape.webm', 'input.webm'],
    ['clip.MKV', 'input.mkv'],
    ['viagem.mov', 'input.mov'],
    ['antigo.avi', 'input.avi'],
    ['meme.gif', 'input.mp4'],
    ['sem-extensao', 'input.mp4'],
    ['', 'input.mp4'],
    [undefined, 'input.mp4'],
    ['a/b/c/../../../x.webm', 'input.webm'],
  ];
  for (const [filename, expected] of cases) {
    const result = videoTempPath(dir, filename);
    assert.equal(result, path.join(dir, expected), String(filename));
    assert.equal(path.dirname(path.resolve(result)), path.resolve(dir), `${filename} não escapa do temp`);
  }
  assert.deepEqual([...VIDEO_EXTENSIONS], ['mp4', 'webm', 'mkv', 'mov', 'avi']);
});

test('analyzeMedia com filename "../../escape.mp4" grava DENTRO do temp e nada no diretório pai', async () => {
  const parentEscape = path.join(tmpdir(), 'escape.mp4');
  assert.equal(existsSync(parentEscape), false, 'pré-condição: nada em tmpdir antes');

  const captured = [];
  let writtenBytes = null;
  const payload = Buffer.from('bytes-do-video');

  const extractMedia = async ({ videoPath, outputDir }) => {
    captured.push({ videoPath, outputDir });
    writtenBytes = await readFile(videoPath);
    return { probe: { durationSec: 1, hasVideo: true, hasAudio: false }, frames: [], audio: null };
  };

  const result = await analyzeMedia({
    mimeType: 'video/mp4',
    dataBase64: payload.toString('base64'),
    filename: '../../escape.mp4',
    apiKey: 'chave-de-teste',
    fetchImpl: async () => geminiImageResponse('vídeo lido'),
    extractMedia,
  });

  assert.equal(result.ok, true, result.error);
  assert.equal(captured.length, 1);
  const { videoPath, outputDir } = captured[0];
  assert.equal(videoPath, path.join(outputDir, 'input.mp4'), 'nome interno fixo, não o filename cru');
  assert.equal(path.dirname(path.resolve(videoPath)), path.resolve(outputDir));
  assert.match(path.basename(outputDir), /^usami-media-/);
  assert.deepEqual(writtenBytes, payload, 'os bytes do cliente foram para o arquivo do temp');
  assert.equal(existsSync(parentEscape), false, 'nada foi criado no diretório pai do mkdtemp');
  assert.equal(existsSync(outputDir), false, 'o temp é apagado no finally');
});

test('handler /api/media/analyze repassa o caminho contido (filename hostil, vídeo)', async () => {
  const captured = [];
  const handler = createMediaAnalyzeHandler({
    allowedOrigins: ORIGINS,
    apiToken: TOKEN,
    getKey: async () => 'chave',
    fetchImpl: async () => geminiImageResponse('ok'),
    extractMedia: async ({ videoPath }) => {
      captured.push(videoPath);
      return { probe: { durationSec: 1, hasVideo: true, hasAudio: false }, frames: [], audio: null };
    },
  });

  const res = { statusCode: null, body: '' };
  res.writeHead = status => { res.statusCode = status; };
  res.end = data => { res.body = data; };

  const req = {
    method: 'POST',
    url: '/api/media/analyze',
    headers: { origin: ORIGINS[0], host: '127.0.0.1:8787', 'x-usami-token': TOKEN },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify({ mimeType: 'video/mp4', data: 'AAAA', filename: '../../escape.mp4' }));
    },
  };

  await handler(req, res);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(captured.length, 1);
  assert.equal(path.basename(captured[0]), 'input.mp4');
  assert.equal(existsSync(path.join(tmpdir(), 'escape.mp4')), false);
});

test('B15: actions da mídia passam por sanitizeActions e pelo catálogo do corpo', async () => {
  const handler = createMediaAnalyzeHandler({
    allowedOrigins: ORIGINS,
    apiToken: TOKEN,
    getKey: async () => 'chave',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({
          reply: 'olha só!',
          gesture: 'nod',
          actions: [
            { type: 'set_expression', name: 'happy', weight: 0.8 },
            { type: 'set_expression', name: 'sad', weight: 0.5 },
            { type: 'dance', name: 'fora-da-allowlist' },
          ],
          ocr: [],
        }) } }],
      }),
    }),
  });

  const res = { statusCode: null, body: '' };
  res.writeHead = status => { res.statusCode = status; };
  res.end = data => { res.body = data; };
  const req = {
    method: 'POST',
    url: '/api/media/analyze',
    headers: { origin: ORIGINS[0], host: '127.0.0.1:8787', 'x-usami-token': TOKEN },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify({
        mimeType: 'image/png',
        data: 'AAAA',
        filename: 'a.png',
        capabilities: { expressions: ['happy'], gestures: [] },
      }));
    },
  };

  await handler(req, res);
  assert.equal(res.statusCode, 200, res.body);
  const body = JSON.parse(res.body);
  // 'dance' não é verbo do director e 'sad' não está no catálogo do cliente.
  assert.deepEqual(body.actions, [{ type: 'set_expression', name: 'happy', weight: 0.8 }]);
});

// --- B2: chave fora da URL e erro genérico ---------------------------------
test('Vision é chamado com Authorization Bearer no header e SEM ?key= na URL', async () => {
  let capturedUrl = null;
  let capturedHeaders = null;
  await analyzeMedia({
    mimeType: 'image/png',
    dataBase64: 'AAAA',
    filename: 'a.png',
    apiKey: 'segredo-gemini-123',
    fetchImpl: async (url, options) => {
      capturedUrl = url;
      capturedHeaders = options.headers;
      return geminiImageResponse();
    },
  });
  assert.ok(!capturedUrl.includes('key='), `URL não pode carregar a chave: ${capturedUrl}`);
  assert.ok(!capturedUrl.includes('segredo-gemini-123'));
  assert.equal(capturedHeaders['Authorization'], 'Bearer segredo-gemini-123');
  assert.equal(capturedHeaders['Content-Type'], 'application/json');
});

test('erro HTTP do provedor não devolve corpo/segredo ao cliente', async () => {
  const result = await analyzeMedia({
    mimeType: 'image/png',
    dataBase64: 'AAAA',
    apiKey: 'segredo-gemini-123',
    fetchImpl: async () => ({
      ok: false,
      status: 400,
      text: async () => 'API key not valid: segredo-gemini-123 (key=segredo-gemini-123)',
    }),
  });
  assert.equal(result.ok, false);
  assert.ok(!result.error.includes('segredo-gemini-123'), 'chave não vaza no erro');
  assert.match(result.error, /HTTP 400/);
  assert.doesNotMatch(result.error, /API key not valid/);
});

test('exceção interna vira mensagem genérica, nunca err.message', async () => {
  const result = await analyzeMedia({
    mimeType: 'image/png',
    dataBase64: 'AAAA',
    apiKey: 'segredo-gemini-123',
    fetchImpl: async () => { throw new Error('falha crua com segredo-gemini-123'); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'Falha interna ao processar a mídia.');
  assert.ok(!JSON.stringify(result).includes('segredo-gemini-123'));
});

// --- B5: token na escrita -------------------------------------------------

test('POST /api/media/analyze exige token; GET continua 404', async () => {
  const handler = createMediaAnalyzeHandler({
    allowedOrigins: ORIGINS,
    apiToken: TOKEN,
    getKey: async () => 'chave',
    fetchImpl: async () => geminiImageResponse(),
  });
  const res = { statusCode: null, body: '' };
  res.writeHead = status => { res.statusCode = status; };
  res.end = data => { res.body = data; };

  const req = {
    method: 'POST',
    url: '/api/media/analyze',
    headers: { origin: ORIGINS[0], host: '127.0.0.1:8787' },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify({ mimeType: 'image/png', data: 'AAAA' }));
    },
  };
  await handler(req, res);
  assert.equal(res.statusCode, 401);
  assert.match(JSON.parse(res.body).error, /Token/);

  const evil = { ...req, headers: { ...req.headers, origin: 'https://evil.example', 'x-usami-token': TOKEN } };
  const resEvil = { statusCode: null, body: '' };
  resEvil.writeHead = status => { resEvil.statusCode = status; };
  resEvil.end = data => { resEvil.body = data; };
  await handler(evil, resEvil);
  assert.equal(resEvil.statusCode, 403);
});

test('limite de bytes do corpo usa a mensagem real (48MB)', async () => {
  const handler = createMediaAnalyzeHandler({
    allowedOrigins: ORIGINS,
    apiToken: TOKEN,
    getKey: async () => 'chave',
    maxBodyBytes: 64,
  });
  const res = { statusCode: null, body: '' };
  res.writeHead = status => { res.statusCode = status; };
  res.end = data => { res.body = data; };
  const req = {
    method: 'POST',
    url: '/api/media/analyze',
    headers: { origin: ORIGINS[0], host: '127.0.0.1:8787', 'x-usami-token': TOKEN },
    async *[Symbol.asyncIterator]() {
      yield Buffer.alloc(128, 0x41);
    },
  };
  await handler(req, res);
  assert.equal(res.statusCode, 413);
  assert.match(JSON.parse(res.body).error, /48MB/);
});

// --- B11: gate de concorrência -------------------------------------------

test('duas análises simultâneas não rodam o extrator em paralelo', async () => {
  let active = 0;
  let peak = 0;
  const handler = createMediaAnalyzeHandler({
    allowedOrigins: ORIGINS,
    apiToken: TOKEN,
    getKey: async () => 'chave',
    fetchImpl: async () => geminiImageResponse(),
    extractMedia: async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 20));
      active -= 1;
      return { probe: { durationSec: 1, hasVideo: true, hasAudio: false }, frames: [], audio: null };
    },
  });
  const call = () => {
    const res = { statusCode: null, body: '' };
    res.writeHead = status => { res.statusCode = status; };
    res.end = data => { res.body = data; };
    const req = {
      method: 'POST',
      url: '/api/media/analyze',
      headers: { origin: ORIGINS[0], host: '127.0.0.1:8787', 'x-usami-token': TOKEN },
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(JSON.stringify({ mimeType: 'video/mp4', data: 'AAAA', filename: 'a.mp4' }));
      },
    };
    return handler(req, res).then(() => res);
  };
  const [first, second] = await Promise.all([call(), call()]);
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(second.statusCode, 200, second.body);
  assert.equal(peak, 1, 'uma análise por vez');
});

test.after(async () => {
  await rm(process.env.USAMI_DATA_DIR, { recursive: true, force: true });
});
