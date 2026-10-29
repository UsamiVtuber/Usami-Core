import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTtsHandler } from '../server.mjs';
import { createSemaphore } from '../src/semaphore.js';

// O provedor de TTS não tolera síntese em paralelo (5 POSTs = 5×504): quem
// garante isso é o servidor, não o cliente.

const JSON_HEADERS = { 'content-type': 'application/json', host: '127.0.0.1:8787' };
const GEMINI_TEST_KEY = 'gem-test-key-000';

function mockReq(body) {
  return {
    method: 'POST',
    url: '/api/tts',
    headers: JSON_HEADERS,
    async *[Symbol.asyncIterator]() { yield Buffer.from(body); },
  };
}

function mockRes() {
  const res = { statusCode: null, headers: null, body: '' };
  res.writeHead = (status, headers) => { res.statusCode = status; res.headers = headers; };
  res.end = data => { res.body = data; };
  return res;
}

function geminiAudioResponse() {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: Buffer.from('abcd').toString('base64') } }] } }],
    }),
  };
}

async function speak(handler, text = 'oi') {
  const res = mockRes();
  await handler(mockReq(JSON.stringify({ text })), res);
  return res;
}

const config = async () => ({ provider: 'gemini', apiKey: GEMINI_TEST_KEY });

test('requisições simultâneas chegam ao provedor uma por vez', async () => {
  let inflight = 0;
  let peak = 0;
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    inflight++;
    peak = Math.max(peak, inflight);
    await new Promise(resolve => setTimeout(resolve, 15));
    inflight--;
    return geminiAudioResponse();
  };
  const handler = createTtsHandler({ provider: 'gemini', fetchImpl, getConfig: config });
  const results = await Promise.all([1, 2, 3, 4].map(() => speak(handler)));
  assert.deepEqual(results.map(res => res.statusCode), [200, 200, 200, 200]);
  assert.equal(peak, 1, 'no máximo uma chamada em voo no provedor');
  assert.equal(calls, 4);
});

test('fila cheia responde 429 sem chamar o provedor', async () => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const handler = createTtsHandler({
    provider: 'gemini',
    fetchImpl: async () => { calls++; await held; return geminiAudioResponse(); },
    gate: createSemaphore({ limit: 1, maxQueue: 1 }),
    getConfig: config,
  });
  const first = speak(handler);
  const second = speak(handler);
  await new Promise(resolve => setTimeout(resolve, 20));
  const third = await speak(handler);
  assert.equal(third.statusCode, 429);
  assert.equal(calls, 1, 'só a primeira chegou ao provedor');
  release();
  assert.equal((await first).statusCode, 200);
  assert.equal((await second).statusCode, 200);
});

test('a mesma frase pedida em paralelo sintetiza uma vez só: o cache serve a que esperou', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'usami-tts-dup-'));
  let calls = 0;
  const handler = createTtsHandler({
    cache: true,
    cacheDir,
    provider: 'gemini',
    getConfig: config,
    fetchImpl: async () => { calls++; await new Promise(resolve => setTimeout(resolve, 15)); return geminiAudioResponse(); },
  });
  try {
    const results = await Promise.all([speak(handler), speak(handler), speak(handler)]);
    assert.deepEqual(results.map(res => res.statusCode), [200, 200, 200]);
    assert.equal(calls, 1);
    assert.equal(results.filter(res => res.headers['X-TTS-Cache'] === 'HIT').length, 2);
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
});
