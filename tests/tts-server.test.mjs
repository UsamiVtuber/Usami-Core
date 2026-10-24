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
  assert.ok(sent.contents[0].parts[0].text.startsWith('Leia em português do Brasil, com tom acolhedor e animado:'));
  assert.ok(sent.contents[0].parts[0].text.endsWith('oi'));
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
  assert.equal(sent.contents[0].parts[0].text, 'Leia em português do Brasil, com tom acolhedor e animado, com voz alegre e brilhante: que bom te ver');
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
  assert.equal(sent.contents[0].parts[0].text, 'Leia em português do Brasil, com tom acolhedor e animado: tudo certo');
});

test('gemini: styleId desconhecido cai na instrução base (fallback determinístico)', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => { calls.push({ url, options }); return geminiAudioResponse(); };
  const handler = createTtsHandler({ fetchImpl, getConfig: async () => ({ provider: 'gemini', apiKey: GEMINI_TEST_KEY }) });
  const res = mockRes();
  await handler(mockReq({ headers: JSON_HEADERS, body: JSON.stringify({ text: 'estranho isso', styleId: 'estranho-x' }) }), res);
  assert.equal(res.statusCode, 200);
  const sent = JSON.parse(calls[0].options.body);
  assert.equal(sent.contents[0].parts[0].text, 'Leia em português do Brasil, com tom acolhedor e animado: estranho isso');
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
