import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTtsHandler } from '../server.mjs';

const TEST_KEY = 'sk-eleven-test-key-000';
const AUDIO_BYTES = [0x01, 0x02, 0x03, 0x04];
const JSON_HEADERS = { 'content-type': 'application/json', host: '127.0.0.1:8787' };

function mockReq({ method = 'POST', url = '/api/tts', headers = {}, body = '' } = {}) {
  const chunks = body ? [Buffer.from(body)] : [];
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

function audioResponse(bytes) {
  return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array(bytes).buffer };
}

const GEMINI_TEST_KEY = 'gem-test-key-000';
const GEMINI_PCM = Buffer.from('abcd');
const GEMINI_URL_RE = /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-2\.5-flash-preview-tts:generateContent$/;

function geminiAudioResponse({ pcm = GEMINI_PCM, mimeType = 'audio/L16;codec=pcm;rate=24000' } = {}) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [{ content: { parts: [{ inlineData: { mimeType, data: pcm.toString('base64') } }] } }],
    }),
  };
}

function writeEnvFile(content) {
  const dir = mkdtempSync(join(tmpdir(), 'usami-tts-'));
  const path = join(dir, 'keys.env');
  writeFileSync(path, content, 'utf8');
  return { path, dir };
}

async function speak(handler) {
  const res = mockRes();
  await handler(mockReq({ headers: JSON_HEADERS, body: JSON.stringify({ text: 'oi' }) }), res);
  return res;
}

test('handler: gemini voz desenhada (prefixo voice_) envia voiceConfig.voice e devolve WAV RIFF', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return geminiAudioResponse();
  };
  const handler = createTtsHandler({
    fetchImpl,
    getConfig: async () => ({ provider: 'gemini', apiKey: GEMINI_TEST_KEY, geminiModel: 'gemini-3.8-flash-tts', geminiVoice: 'voice_cewhmedkmma9' }),
  });
  const res = await speak(handler);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Content-Type'], 'audio/wav');
  assert.equal(res.body.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-3\.8-flash-tts:generateContent$/);
  const sent = JSON.parse(calls[0].options.body);
  assert.equal(sent.generationConfig.speechConfig.voiceConfig.voice, 'voice_cewhmedkmma9');
  assert.equal(sent.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig, undefined);
});

test('handler: gemini voz pré-pronta mantém prebuiltVoiceConfig (regressão)', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return geminiAudioResponse();
  };
  const handler = createTtsHandler({
    fetchImpl,
    getConfig: async () => ({ provider: 'gemini', apiKey: GEMINI_TEST_KEY, geminiVoice: 'Kore' }),
  });
  const res = await speak(handler);
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, GEMINI_URL_RE);
  const sent = JSON.parse(calls[0].options.body);
  assert.equal(sent.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Kore');
  assert.equal(sent.generationConfig.speechConfig.voiceConfig.voice, undefined);
});

test('handler: 200 devolve áudio e envia text/model_id com xi-api-key', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return audioResponse(AUDIO_BYTES);
  };
  const handler = createTtsHandler({ fetchImpl, getConfig: async () => ({ apiKey: TEST_KEY, voiceId: 'voice-42' }), model: 'eleven_multilingual_v2' });
  const res = mockRes();
  await handler(mockReq({ headers: JSON_HEADERS, body: JSON.stringify({ text: 'oi' }) }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Content-Type'], 'audio/mpeg');
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.deepEqual(res.body, Buffer.from(AUDIO_BYTES));
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /^https:\/\/api\.elevenlabs\.io\/v1\/text-to-speech\/voice-42\?output_format=mp3_44100_128$/);
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers['xi-api-key'], TEST_KEY);
  const sent = JSON.parse(calls[0].options.body);
  assert.equal(sent.text, 'oi');
  assert.equal(sent.model_id, 'eleven_multilingual_v2');
  assert.equal(sent.output_format, 'mp3_44100_128');
  // a apiKey jamais aparece na resposta ao cliente
  assert.ok(!res.body.toString().includes(TEST_KEY));
  assert.ok(!JSON.stringify(res.headers).includes(TEST_KEY));
});

test('handler: 503 quando o env apontado por options.envPath não existe', async () => {
  let calls = 0;
  const handler = createTtsHandler({
    envPath: 'A:/Usami Project/tests/__env_inexistente__.env',
    fetchImpl: async () => { calls++; return audioResponse(AUDIO_BYTES); },
  });
  const res = mockRes();
  await handler(mockReq({ headers: JSON_HEADERS, body: JSON.stringify({ text: 'oi' }) }), res);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(JSON.parse(res.body), { error: 'TTS indisponível: configuração ausente.' });
  assert.equal(calls, 0);
});

test('handler: 503 quando getConfig não resolve key/voiceId ou falha', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return audioResponse(AUDIO_BYTES); };
  const handlerNull = createTtsHandler({ getConfig: async () => null, fetchImpl });
  const resNull = mockRes();
  await handlerNull(mockReq({ headers: JSON_HEADERS, body: JSON.stringify({ text: 'oi' }) }), resNull);
  assert.equal(resNull.statusCode, 503);
  const handlerPartial = createTtsHandler({ getConfig: async () => ({ apiKey: TEST_KEY }), fetchImpl });
  const resPartial = mockRes();
  await handlerPartial(mockReq({ headers: JSON_HEADERS, body: JSON.stringify({ text: 'oi' }) }), resPartial);
  assert.equal(resPartial.statusCode, 503);
  const handlerThrow = createTtsHandler({ getConfig: async () => { throw new Error('boom'); }, fetchImpl });
  const resThrow = mockRes();
  await handlerThrow(mockReq({ headers: JSON_HEADERS, body: JSON.stringify({ text: 'oi' }) }), resThrow);
  assert.equal(resThrow.statusCode, 503);
  assert.equal(calls, 0);
});

test('handler: 429 do provedor preserva status; 500 vira 502; sem key no corpo', async () => {
  const getConfig = async () => ({ apiKey: TEST_KEY, voiceId: 'voice-42' });
  const handler429 = createTtsHandler({ getConfig, fetchImpl: async () => ({ ok: false, status: 429, text: async () => 'upstream body ' + TEST_KEY }) });
  const res429 = mockRes();
  await handler429(mockReq({ headers: JSON_HEADERS, body: JSON.stringify({ text: 'oi' }) }), res429);
  assert.equal(res429.statusCode, 429);
  const data429 = JSON.parse(res429.body);
  assert.equal(typeof data429.error, 'string');
  assert.ok(data429.error.length > 0);
  assert.ok(!res429.body.includes(TEST_KEY));

  const handler500 = createTtsHandler({ getConfig, fetchImpl: async () => ({ ok: false, status: 500 }) });
  const res500 = mockRes();
  await handler500(mockReq({ headers: JSON_HEADERS, body: JSON.stringify({ text: 'oi' }) }), res500);
  assert.equal(res500.statusCode, 502);
  assert.deepEqual(JSON.parse(res500.body), { error: 'TTS falhou no provedor.' });
  assert.ok(!res500.body.includes(TEST_KEY));
});

test('handler: 403 origem não autorizada', async () => {
  let calls = 0;
  const handler = createTtsHandler({ getConfig: async () => ({ apiKey: TEST_KEY, voiceId: 'v' }), fetchImpl: async () => { calls++; return audioResponse(AUDIO_BYTES); } });
  const res = mockRes();
  await handler(mockReq({ headers: { origin: 'https://evil.com', ...JSON_HEADERS }, body: JSON.stringify({ text: 'oi' }) }), res);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(JSON.parse(res.body), { error: 'Origem não autorizada.' });
  assert.equal(calls, 0);
});

test('handler: 400 texto vazio, ausente ou longo demais', async () => {
  const handler = createTtsHandler({ getConfig: async () => ({ apiKey: TEST_KEY, voiceId: 'v' }), fetchImpl: async () => audioResponse(AUDIO_BYTES) });
  for (const text of ['', '   ', 'x'.repeat(2001)]) {
    const res = mockRes();
    await handler(mockReq({ headers: JSON_HEADERS, body: JSON.stringify({ text }) }), res);
    assert.equal(res.statusCode, 400);
  }
  const resMissing = mockRes();
  await handler(mockReq({ headers: JSON_HEADERS, body: JSON.stringify({}) }), resMissing);
  assert.equal(resMissing.statusCode, 400);
  const resJson = mockRes();
  await handler(mockReq({ headers: JSON_HEADERS, body: 'not json' }), resJson);
  assert.equal(resJson.statusCode, 400);
});

test('handler: 404 para método/rota incorretos', async () => {
  const handler = createTtsHandler({ getConfig: async () => ({ apiKey: TEST_KEY, voiceId: 'v' }), fetchImpl: async () => audioResponse(AUDIO_BYTES) });
  const resGet = mockRes();
  await handler(mockReq({ method: 'GET', url: '/api/tts', headers: { host: '127.0.0.1:8787' } }), resGet);
  assert.equal(resGet.statusCode, 404);
  const resOther = mockRes();
  await handler(mockReq({ method: 'POST', url: '/api/other', headers: { host: '127.0.0.1:8787' } }), resOther);
  assert.equal(resOther.statusCode, 404);
});

test('handler: 413 body acima do limite do chat', async () => {
  const handler = createTtsHandler({ getConfig: async () => ({ apiKey: TEST_KEY, voiceId: 'v' }), fetchImpl: async () => audioResponse(AUDIO_BYTES) });
  const res = mockRes();
  await handler(mockReq({ headers: JSON_HEADERS, body: 'x'.repeat(9000) }), res);
  assert.equal(res.statusCode, 413);
});

test('handler: 504 timeout ou erro de rede', async () => {
  const getConfig = async () => ({ apiKey: TEST_KEY, voiceId: 'v' });
  const handlerTimeout = createTtsHandler({ getConfig, fetchImpl: async () => { const e = new Error('timeout'); e.name = 'TimeoutError'; throw e; } });
  const resTimeout = mockRes();
  await handlerTimeout(mockReq({ headers: JSON_HEADERS, body: JSON.stringify({ text: 'oi' }) }), resTimeout);
  assert.equal(resTimeout.statusCode, 504);
  assert.deepEqual(JSON.parse(resTimeout.body), { error: 'TTS expirou.' });
  assert.ok(!resTimeout.body.includes(TEST_KEY));

  const handlerNet = createTtsHandler({ getConfig, fetchImpl: async () => { throw new Error('ECONNRESET'); } });
  const resNet = mockRes();
  await handlerNet(mockReq({ headers: JSON_HEADERS, body: JSON.stringify({ text: 'oi' }) }), resNet);
  assert.equal(resNet.statusCode, 504);
  assert.deepEqual(JSON.parse(resNet.body), { error: 'TTS expirou.' });
});

test('handler: voiceId é codificado como componente de URL', async () => {
  const calls = [];
  const fetchImpl = async (url) => { calls.push(url); return audioResponse(AUDIO_BYTES); };
  const handler = createTtsHandler({ ttsUrl: 'https://tts.example.com/', getConfig: async () => ({ apiKey: TEST_KEY, voiceId: 'a b/c?d' }), fetchImpl });
  const res = mockRes();
  await handler(mockReq({ headers: JSON_HEADERS, body: JSON.stringify({ text: 'oi' }) }), res);
  assert.equal(res.statusCode, 200);
  assert.match(calls[0], /^https:\/\/tts\.example\.com\/v1\/text-to-speech\/a%20b%2Fc%3Fd\?output_format=mp3_44100_128$/);
  assert.ok(!calls[0].includes('a b/c?d'));
});

test('gemini: 200 devolve WAV (RIFF) e envia x-goog-api-key com responseModalities AUDIO', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => { calls.push({ url, options }); return geminiAudioResponse(); };
  const handler = createTtsHandler({ fetchImpl, getConfig: async () => ({ provider: 'gemini', apiKey: GEMINI_TEST_KEY }) });
  const res = await speak(handler);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Content-Type'], 'audio/wav');
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.match(calls[0].url, GEMINI_URL_RE);
  assert.ok(!calls[0].url.includes(GEMINI_TEST_KEY));
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers['x-goog-api-key'], GEMINI_TEST_KEY);
  const sent = JSON.parse(calls[0].options.body);
  // a direcao de estilo vai em TAG: em prosa o modelo lia a instrucao em voz alta
  assert.equal(sent.contents[0].parts[0].text, '[em português do Brasil, voz de personagem de anime, muito aguda e brilhante, timbre leve e expressivo, dicção rápida e nítida] oi');
  assert.deepEqual(sent.generationConfig.responseModalities, ['AUDIO']);
  assert.equal(sent.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Kore');
  // WAV: header RIFF de 44 bytes + PCM; a key não aparece na resposta
  assert.equal(res.body.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(res.body.subarray(8, 12).toString('ascii'), 'WAVE');
  assert.equal(res.body.subarray(12, 16).toString('ascii'), 'fmt ');
  assert.equal(res.body.subarray(36, 40).toString('ascii'), 'data');
  assert.equal(res.body.length, 44 + GEMINI_PCM.length);
  assert.equal(res.body.readUInt32LE(4), 36 + GEMINI_PCM.length);
  assert.equal(res.body.readUInt16LE(20), 1);
  assert.equal(res.body.readUInt16LE(22), 1);
  assert.equal(res.body.readUInt32LE(24), 24000);
  assert.equal(res.body.readUInt32LE(28), 48000);
  assert.equal(res.body.readUInt16LE(32), 2);
  assert.equal(res.body.readUInt16LE(34), 16);
  assert.equal(res.body.readUInt32LE(40), GEMINI_PCM.length);
  assert.deepEqual(res.body.subarray(44), GEMINI_PCM);
  assert.ok(!res.body.toString('utf8').includes(GEMINI_TEST_KEY));
  assert.ok(!JSON.stringify(res.headers).includes(GEMINI_TEST_KEY));
});

test('gemini: rate=16000 do mimeType é refletido no header WAV', async () => {
  const fetchImpl = async () => geminiAudioResponse({ mimeType: 'audio/L16;codec=pcm;rate=16000' });
  const handler = createTtsHandler({ fetchImpl, getConfig: async () => ({ provider: 'gemini', apiKey: GEMINI_TEST_KEY }) });
  const res = await speak(handler);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.readUInt32LE(24), 16000); // sampleRate
  assert.equal(res.body.readUInt32LE(28), 32000); // byteRate = rate * 2
  assert.equal(res.body.readUInt16LE(32), 2); // blockAlign
  assert.equal(res.body.readUInt16LE(34), 16); // bitsPerSample
});

test('gemini: 401 vira 502; 400 e 429 preservados; key nunca na resposta', async () => {
  const getConfig = async () => ({ provider: 'gemini', apiKey: GEMINI_TEST_KEY });
  const handler401 = createTtsHandler({ getConfig, fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'google body ' + GEMINI_TEST_KEY }) });
  const res401 = await speak(handler401);
  assert.equal(res401.statusCode, 502);
  assert.deepEqual(JSON.parse(res401.body), { error: 'TTS falhou no provedor.' });
  assert.ok(!res401.body.includes(GEMINI_TEST_KEY));
  assert.ok(!JSON.stringify(res401.headers).includes(GEMINI_TEST_KEY));

  const handler400 = createTtsHandler({ getConfig, fetchImpl: async () => ({ ok: false, status: 400 }) });
  const res400 = await speak(handler400);
  assert.equal(res400.statusCode, 400);

  const handler429 = createTtsHandler({ getConfig, fetchImpl: async () => ({ ok: false, status: 429 }) });
  const res429 = await speak(handler429);
  assert.equal(res429.statusCode, 429);
  assert.equal(typeof JSON.parse(res429.body).error, 'string');
});

test('gemini: timeout/rede → 504; resposta sem áudio → 502', async () => {
  const getConfig = async () => ({ provider: 'gemini', apiKey: GEMINI_TEST_KEY });
  const handlerTimeout = createTtsHandler({ getConfig, fetchImpl: async () => { const e = new Error('timeout'); e.name = 'TimeoutError'; throw e; } });
  const resTimeout = await speak(handlerTimeout);
  assert.equal(resTimeout.statusCode, 504);
  assert.deepEqual(JSON.parse(resTimeout.body), { error: 'TTS expirou.' });

  const handlerNoAudio = createTtsHandler({
    getConfig,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'sem audio' }] } }] }) }),
  });
  const resNoAudio = await speak(handlerNoAudio);
  assert.equal(resNoAudio.statusCode, 502);
  assert.deepEqual(JSON.parse(resNoAudio.body), { error: 'TTS falhou no provedor.' });
});

test('provider: prioridade automática gemini > elevenlabs; sem chaves → 503', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return String(url).includes('generativelanguage.googleapis.com') ? geminiAudioResponse() : audioResponse(AUDIO_BYTES);
  };

  const geminiEnv = writeEnvFile('GEMINI_API_KEY=' + GEMINI_TEST_KEY + '\n');
  try {
    const res = await speak(createTtsHandler({ envPath: geminiEnv.path, fetchImpl }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['Content-Type'], 'audio/wav');
    assert.match(calls[0], GEMINI_URL_RE);
  } finally {
    rmSync(geminiEnv.dir, { recursive: true, force: true });
  }

  const elevenEnv = writeEnvFile('ELEVENLABS_API_KEY=' + TEST_KEY + '\nELEVENLABS_VOICE_ID=voice-42\n');
  try {
    const res = await speak(createTtsHandler({ envPath: elevenEnv.path, fetchImpl }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['Content-Type'], 'audio/mpeg');
    assert.match(calls[1], /^https:\/\/api\.elevenlabs\.io\/v1\/text-to-speech\/voice-42\?output_format=mp3_44100_128$/);
  } finally {
    rmSync(elevenEnv.dir, { recursive: true, force: true });
  }

  const emptyEnv = writeEnvFile('# sem credenciais\n');
  try {
    const res = await speak(createTtsHandler({ envPath: emptyEnv.path, fetchImpl }));
    assert.equal(res.statusCode, 503);
    assert.deepEqual(JSON.parse(res.body), { error: 'TTS indisponível: configuração ausente.' });
    assert.equal(calls.length, 2);
  } finally {
    rmSync(emptyEnv.dir, { recursive: true, force: true });
  }
});

test('provider: options.provider="elevenlabs" vence com ambos configurados', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return String(url).includes('generativelanguage.googleapis.com') ? geminiAudioResponse() : audioResponse(AUDIO_BYTES);
  };
  const bothEnv = writeEnvFile('GEMINI_API_KEY=' + GEMINI_TEST_KEY + '\nELEVENLABS_API_KEY=' + TEST_KEY + '\nELEVENLABS_VOICE_ID=voice-42\n');
  try {
    const res = await speak(createTtsHandler({ envPath: bothEnv.path, provider: 'elevenlabs', fetchImpl }));
    assert.equal(res.statusCode, 200);
    assert.equal(calls.length, 1);
    assert.match(calls[0], /^https:\/\/api\.elevenlabs\.io\/v1\/text-to-speech\/voice-42\?output_format=mp3_44100_128$/);
  } finally {
    rmSync(bothEnv.dir, { recursive: true, force: true });
  }
});

test('gemini: options/config ajustam model e voice', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => { calls.push({ url, options }); return geminiAudioResponse(); };
  const handler = createTtsHandler({
    fetchImpl,
    geminiModel: 'gemini-2.5-flash-preview-tts-x',
    getConfig: async () => ({ provider: 'gemini', apiKey: GEMINI_TEST_KEY, geminiVoice: 'Puck' }),
  });
  const res = await speak(handler);
  assert.equal(res.statusCode, 200);
  assert.match(calls[0].url, /\/v1beta\/models\/gemini-2\.5-flash-preview-tts-x:generateContent$/);
  const sent = JSON.parse(calls[0].options.body);
  assert.equal(sent.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Puck');
});

test('gemini: styleId happy insere a cláusula da emoção e mantém o voiceConfig', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => { calls.push({ url, options }); return geminiAudioResponse(); };
  const handler = createTtsHandler({ fetchImpl, getConfig: async () => ({ provider: 'gemini', apiKey: GEMINI_TEST_KEY }) });
  const res = mockRes();
  await handler(mockReq({ headers: JSON_HEADERS, body: JSON.stringify({ text: 'que bom te ver', styleId: 'happy' }) }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 1);
  const sent = JSON.parse(calls[0].options.body);
  assert.equal(sent.contents[0].parts[0].text, '[em português do Brasil, voz de personagem de anime, muito aguda e brilhante, timbre leve e expressivo, dicção rápida e nítida, super animada e hiperexpressiva, aguda e saltitante, sorriso na voz, consoantes punchy] que bom te ver');
  // a cláusula não altera a voz enviada ao Google
  assert.equal(sent.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Kore');
  assert.equal(sent.generationConfig.speechConfig.voiceConfig.voice, undefined);
});

test('gemini: styleId neutral mantém a instrução base exata', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => { calls.push({ url, options }); return geminiAudioResponse(); };
  const handler = createTtsHandler({ fetchImpl, getConfig: async () => ({ provider: 'gemini', apiKey: GEMINI_TEST_KEY }) });
  const res = mockRes();
  await handler(mockReq({ headers: JSON_HEADERS, body: JSON.stringify({ text: 'tudo certo', styleId: 'neutral' }) }), res);
  assert.equal(res.statusCode, 200);
  const sent = JSON.parse(calls[0].options.body);
  assert.equal(sent.contents[0].parts[0].text, '[em português do Brasil, voz de personagem de anime, muito aguda e brilhante, timbre leve e expressivo, dicção rápida e nítida] tudo certo');
});

test('gemini: styleId desconhecido cai na instrução base (fallback determinístico)', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => { calls.push({ url, options }); return geminiAudioResponse(); };
  const handler = createTtsHandler({ fetchImpl, getConfig: async () => ({ provider: 'gemini', apiKey: GEMINI_TEST_KEY }) });
  const res = mockRes();
  await handler(mockReq({ headers: JSON_HEADERS, body: JSON.stringify({ text: 'estranho isso', styleId: 'estranho-x' }) }), res);
  assert.equal(res.statusCode, 200);
  const sent = JSON.parse(calls[0].options.body);
  assert.equal(sent.contents[0].parts[0].text, '[em português do Brasil, voz de personagem de anime, muito aguda e brilhante, timbre leve e expressivo, dicção rápida e nítida] estranho isso');
});

test('gemini: WAV completo do provedor passa intacto — sem segundo header nem estouro no fim', async () => {
  // O provedor devolve hoje um WAV válido (mimeType audio/wav) com um chunk C2PA de
  // proveniência depois do data. Embrulhar isso de novo declara os metadados como
  // amostras: ~63 ms de ruído em fundo de escala ao final de cada fala.
  const pcm = Buffer.alloc(200, 0);
  for (let i = 0; i < 100; i++) pcm.writeInt16LE(i * 50, i * 2);
  const meta = Buffer.from('{"digitalsourcetype/trainedAlgorithmicMedia}');
  const inner = Buffer.concat([
    (() => {
      const h = Buffer.alloc(44);
      h.write('RIFF', 0, 'ascii');
      h.writeUInt32LE(36 + pcm.length + meta.length + 8, 4);
      h.write('WAVE', 8, 'ascii');
      h.write('fmt ', 12, 'ascii');
      h.writeUInt32LE(16, 16);
      h.writeUInt16LE(1, 20);
      h.writeUInt16LE(1, 22);
      h.writeUInt32LE(24000, 24);
      h.writeUInt32LE(48000, 28);
      h.writeUInt16LE(2, 32);
      h.writeUInt16LE(16, 34);
      h.write('data', 36, 'ascii');
      h.writeUInt32LE(pcm.length, 40);
      return h;
    })(),
    pcm,
    Buffer.concat([Buffer.from('C2PA', 'ascii'), (() => { const s = Buffer.alloc(4); s.writeUInt32LE(meta.length, 0); return s; })(), meta]),
  ]);
  const calls = [];
  const fetchImpl = async (url, options) => { calls.push({ url, options }); return geminiAudioResponse({ pcm: inner, mimeType: 'audio/wav' }); };
  const handler = createTtsHandler({ fetchImpl, getConfig: async () => ({ provider: 'gemini', apiKey: GEMINI_TEST_KEY }) });
  const res = mockRes();
  await handler(mockReq({ headers: JSON_HEADERS, body: JSON.stringify({ text: 'oi de novo', styleId: 'neutral' }) }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Content-Type'], 'audio/wav');
  // byte a byte o que o provedor mandou — nada de header duplicado
  assert.ok(res.body.equals(inner), 'o payload do provedor deve passar intacto');
  assert.equal(res.body.readUInt32LE(40), 200, 'o chunk data continua com o tamanho do provedor');
  assert.ok(!res.body.subarray(44, 48).equals(Buffer.from('RIFF')), 'sem segundo header RIFF dentro dos samples');
});

test('handler: cache local separa a direção de estilo, não só o styleId', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const cacheDir = await mkdtemp(join(tmpdir(), 'usami-tts-instr-'));
  let calls = 0;
  const handlerFor = instruction => createTtsHandler({
    cache: true,
    cacheDir,
    provider: 'gemini',
    geminiInstruction: instruction,
    getConfig: async () => ({ provider: 'gemini', apiKey: GEMINI_TEST_KEY }),
    fetchImpl: async () => { calls++; return geminiAudioResponse(); },
  });
  try {
    // Mesmo texto e mesmo styleId: trocar a cláusula da emoção tem que mudar o áudio.
    const before = handlerFor('[em português, voz tímida e envergonhada] ');
    const first = mockRes();
    await before(mockReq({ headers: JSON_HEADERS, body: JSON.stringify({ text: 'não é nada disso', styleId: 'shy' }) }), first);
    const hit = mockRes();
    await before(mockReq({ headers: JSON_HEADERS, body: JSON.stringify({ text: 'não é nada disso', styleId: 'shy' }) }), hit);
    assert.equal(calls, 1);
    assert.equal(hit.headers['X-TTS-Cache'], 'HIT');

    const after = handlerFor('[em português, baixinha, hesitante e doce, quase sussurrada, com vergonha] ');
    const miss = mockRes();
    await after(mockReq({ headers: JSON_HEADERS, body: JSON.stringify({ text: 'não é nada disso', styleId: 'shy' }) }), miss);
    assert.equal(calls, 2);
    assert.equal(miss.headers['X-TTS-Cache'], undefined);
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test('gemini: cláusula de timidez suave — sem "envergonhada", que a modelo encena repetindo', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => { calls.push({ url, options }); return geminiAudioResponse(); };
  const handler = createTtsHandler({ fetchImpl, getConfig: async () => ({ provider: 'gemini', apiKey: GEMINI_TEST_KEY }) });
  const res = mockRes();
  await handler(mockReq({ headers: JSON_HEADERS, body: JSON.stringify({ text: 'hmph', styleId: 'shy' }) }), res);
  assert.equal(res.statusCode, 200);
  const sent = JSON.parse(calls[0].options.body);
  assert.equal(sent.contents[0].parts[0].text, '[em português do Brasil, voz de personagem de anime, muito aguda e brilhante, timbre leve e expressivo, dicção rápida e nítida, baixinha, hesitante e doce, quase sussurrada, com vergonha] hmph');
});

test('gemini: styleId V2 (<registro>_<emoção>) aplica cláusula combinada de registro e emoção', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => { calls.push({ url, options }); return geminiAudioResponse(); };
  const handler = createTtsHandler({ fetchImpl, getConfig: async () => ({ provider: 'gemini', apiKey: GEMINI_TEST_KEY }) });
  const res = mockRes();
  await handler(mockReq({ headers: JSON_HEADERS, body: JSON.stringify({ text: 'boa noite...', styleId: 'whisper_sleepy' }) }), res);
  assert.equal(res.statusCode, 200);
  const sent = JSON.parse(calls[0].options.body);
  assert.match(sent.contents[0].parts[0].text, /^\[.*sussurrada bem baixinho.*sonolenta, lenta e macia.*\] boa noite\.\.\.$/);
});

test('handler: cache local evita nova chamada e separa estilos', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const cacheDir = await mkdtemp(join(tmpdir(), 'usami-tts-handler-'));
  let calls = 0;
  try {
    const handler = createTtsHandler({
      cache: true,
      cacheDir,
      model: 'test-model',
      getConfig: async () => ({ apiKey: TEST_KEY, voiceId: 'voice-42' }),
      fetchImpl: async () => { calls++; return audioResponse(AUDIO_BYTES); },
    });
    const request = styleId => mockReq({ headers: JSON_HEADERS, body: JSON.stringify({ text: 'oi', styleId }) });
    const first = mockRes();
    await handler(request('warm'), first);
    const second = mockRes();
    await handler(request('warm'), second);
    const third = mockRes();
    await handler(request('playful'), third);
    assert.equal(calls, 2);
    assert.equal(first.headers['X-TTS-Cache'], undefined);
    assert.equal(second.headers['X-TTS-Cache'], 'HIT');
    assert.equal(third.headers['X-TTS-Cache'], undefined);
    assert.deepEqual(second.body, Buffer.from(AUDIO_BYTES));
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
});

// --- Voz em streaming (PCM cru) --------------------------------------------

const GEMINI_STREAM_URL = /:streamGenerateContent\?alt=sse$/;

function audioEvent(pcm, mimeType = 'audio/l16; rate=24000; channels=1') {
  return { candidates: [{ content: { parts: [{ inlineData: { mimeType, data: Buffer.from(pcm).toString('base64') } }] } }] };
}

// Resposta de SSE falsa: uma stream legível por getReader(), opcionalmente
// picotada em pedaços arbitrários como faz a rede de verdade. O provedor real
// separa eventos em CRLFCRLF, então é esse o enquadramento padrão do mock.
function sseResponse(events, { splitAt = null, separator = '\r\n\r\n' } = {}) {
  const text = events.map(event => 'data: ' + JSON.stringify(event) + separator).join('');
  const whole = Buffer.from(text);
  const pieces = splitAt === null ? [whole] : [whole.subarray(0, splitAt), whole.subarray(splitAt)];
  let index = 0;
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        async read() {
          if (index >= pieces.length) return { done: true };
          const piece = pieces[index++];
          return { done: false, value: new Uint8Array(piece) };
        },
      }),
    },
  };
}

function streamRes() {
  const res = { statusCode: null, headers: null, written: [], ended: false };
  res.writeHead = (status, headers) => { res.statusCode = status; res.headers = headers; };
  res.write = chunk => { res.written.push(Buffer.from(chunk)); return true; };
  res.end = data => { if (data) res.written.push(Buffer.from(data)); res.ended = true; };
  return res;
}

const spoken = res => Buffer.concat(res.written);

test('gemini stream: responde PCM cru chunk por chunk com X-TTS-Stream', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return sseResponse([audioEvent('aaaa'), audioEvent('bbbb')]);
  };
  const handler = createTtsHandler({
    fetchImpl,
    getConfig: async () => ({ provider: 'gemini', apiKey: GEMINI_TEST_KEY, geminiModel: 'gemini-3.8-flash-tts', geminiVoice: 'voice_cewhmedkmma9' }),
  });
  const res = streamRes();
  await handler(mockReq({ headers: JSON_HEADERS, body: JSON.stringify({ text: 'oi', styleId: 'happy', stream: true }) }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Content-Type'], 'audio/l16; codec=pcm; rate=24000');
  assert.equal(res.headers['X-TTS-Stream'], '1');
  assert.equal(res.ended, true);
  assert.equal(spoken(res).toString(), 'aaaabbbb');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, GEMINI_STREAM_URL);
  // o corpo é o mesmo esquema do caminho normal: speechConfig dentro de generationConfig
  const sent = JSON.parse(calls[0].options.body);
  assert.deepEqual(sent.generationConfig.responseModalities, ['AUDIO']);
  assert.equal(sent.generationConfig.speechConfig.voiceConfig.voice, 'voice_cewhmedkmma9');
  assert.equal(sent.contents[0].parts[0].text, '[em português do Brasil, voz de personagem de anime, muito aguda e brilhante, timbre leve e expressivo, dicção rápida e nítida, super animada e hiperexpressiva, aguda e saltitante, sorriso na voz, consoantes punchy] oi');
});

test('gemini stream: SSE picotado no meio do base64 ainda sai áudio inteiro', async () => {
  const fetchImpl = async () => sseResponse([audioEvent('aaaa'), audioEvent('bbbb')], { splitAt: 40 });
  const handler = createTtsHandler({
    fetchImpl,
    getConfig: async () => ({ provider: 'gemini', apiKey: GEMINI_TEST_KEY, geminiModel: 'gemini-3.8-flash-tts', geminiVoice: 'Kore' }),
  });
  const res = streamRes();
  await handler(mockReq({ headers: JSON_HEADERS, body: JSON.stringify({ text: 'oi', stream: true }) }), res);
  assert.equal(spoken(res).toString(), 'aaaabbbb');
});

test('gemini stream: todos os eventos saem, não só o primeiro (CRLF e LF)', async () => {
  for (const separator of ['\r\n\r\n', '\n\n']) {
    const events = Array.from({ length: 9 }, (_, index) => audioEvent('s' + index));
    const fetchImpl = async () => sseResponse(events, { separator });
    const handler = createTtsHandler({
      fetchImpl,
      getConfig: async () => ({ provider: 'gemini', apiKey: GEMINI_TEST_KEY, geminiModel: 'gemini-3.8-flash-tts', geminiVoice: 'Kore' }),
    });
    const res = streamRes();
    await handler(mockReq({ headers: JSON_HEADERS, body: JSON.stringify({ text: 'oi', stream: true }) }), res);
    assert.equal(spoken(res).toString(), events.map((_, index) => 's' + index).join(''), 'separator ' + JSON.stringify(separator));
  }
});

test('gemini stream: o WAV do stream alimenta o cache e o HIT serve o blob', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const cacheDir = await mkdtemp(join(tmpdir(), 'usami-tts-stream-'));
  const calls = [];
  try {
    const handler = createTtsHandler({
      cache: true,
      cacheDir,
      fetchImpl: async url => { calls.push(url); return sseResponse([audioEvent('abcd')]); },
      getConfig: async () => ({ provider: 'gemini', apiKey: GEMINI_TEST_KEY, geminiModel: 'gemini-3.8-flash-tts', geminiVoice: 'Kore' }),
    });
    const request = () => mockReq({ headers: JSON_HEADERS, body: JSON.stringify({ text: 'oi', stream: true }) });
    const first = streamRes();
    await handler(request(), first);
    assert.equal(spoken(first).toString(), 'abcd');
    const second = mockRes();
    await handler(request(), second);
    assert.equal(calls.length, 1);
    assert.equal(second.headers['X-TTS-Cache'], 'HIT');
    // HIT não é stream: devolve o WAV empacotado e o cliente toca pelo caminho normal.
    assert.equal(second.headers['X-TTS-Stream'], undefined);
    assert.equal(second.headers['Content-Type'], 'audio/wav');
    assert.equal(Buffer.from(second.body).subarray(0, 4).toString('ascii'), 'RIFF');
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test('gemini stream: sem áudio no SSE cai no caminho normal e responde WAV', async () => {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    return url.match(GEMINI_STREAM_URL) ? sseResponse([{ candidates: [{ finishReason: 'STOP' }] }]) : geminiAudioResponse();
  };
  const handler = createTtsHandler({
    fetchImpl,
    getConfig: async () => ({ provider: 'gemini', apiKey: GEMINI_TEST_KEY, geminiModel: 'gemini-3.8-flash-tts', geminiVoice: 'Kore' }),
  });
  const res = mockRes();
  await handler(mockReq({ headers: JSON_HEADERS, body: JSON.stringify({ text: 'oi', stream: true }) }), res);
  assert.equal(calls.length, 2);
  assert.match(calls[1], /:generateContent$/);
  assert.equal(res.headers['Content-Type'], 'audio/wav');
  assert.equal(res.body.subarray(0, 4).toString('ascii'), 'RIFF');
});

test('gemini stream: HTTP falho no stream não escreve nada e o normal responde', async () => {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    if (url.match(GEMINI_STREAM_URL)) return { ok: false, status: 503 };
    return geminiAudioResponse();
  };
  const handler = createTtsHandler({
    fetchImpl,
    getConfig: async () => ({ provider: 'gemini', apiKey: GEMINI_TEST_KEY, geminiModel: 'gemini-3.8-flash-tts', geminiVoice: 'Kore' }),
  });
  const res = mockRes();
  await handler(mockReq({ headers: JSON_HEADERS, body: JSON.stringify({ text: 'oi', stream: true }) }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['X-TTS-Stream'], undefined);
});

test('tts: provedor sem streaming (elevenlabs) segue o caminho normal', async () => {
  const calls = [];
  const handler = createTtsHandler({
    fetchImpl: async (url, options) => { calls.push({ url, options }); return audioResponse(AUDIO_BYTES); },
    getConfig: async () => ({ apiKey: TEST_KEY, voiceId: 'voice-42' }),
  });
  const res = mockRes();
  await handler(mockReq({ headers: JSON_HEADERS, body: JSON.stringify({ text: 'oi', stream: true }) }), res);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /api\.elevenlabs\.io/);
  assert.equal(res.headers['X-TTS-Stream'], undefined);
});

test('parseTtsBody: stream é flag booleano, não string qualquer', async () => {
  const { parseTtsBody } = await import('../server.mjs');
  assert.equal(parseTtsBody(JSON.stringify({ text: 'oi', stream: true })).stream, true);
  assert.equal(parseTtsBody(JSON.stringify({ text: 'oi', stream: 'true' })).stream, false);
  assert.equal(parseTtsBody(JSON.stringify({ text: 'oi' })).stream, false);
});
