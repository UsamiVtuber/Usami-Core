import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeMedia, probeMedia, DEFAULT_GEMINI_VISION_MODEL } from '../src/media-analyzer.js';

test('media-analyzer: probeMedia lida com arquivo inexistente sem lançar exceção', async () => {
  const result = await probeMedia('caminho/inexistente/video.mp4');
  assert.equal(result.hasVideo, false);
  assert.equal(result.hasAudio, false);
  assert.ok(result.error);
});

test('media-analyzer: analyzeMedia sem apiKey retorna resposta amigável de erro', async () => {
  const result = await analyzeMedia({
    mimeType: 'image/jpeg',
    dataBase64: 'fakebase64',
    apiKey: '',
  });

  assert.equal(result.ok, false);
  assert.match(result.reply, /chave de visão/i);
  assert.equal(result.gesture, 'scratchHead');
});

test('media-analyzer: analyzeMedia para imagem monta requisição Gemini e faz parse de OCR e resposta', async () => {
  let capturedUrl = '';
  let capturedBody = null;

  const mockFetch = async (url, opts) => {
    capturedUrl = url;
    capturedBody = JSON.parse(opts.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
                reply: 'Que imagem legal! Li tudo que tava escrito aí.',
                gesture: 'clap',
                actions: [{ type: 'set_expression', name: '01-prefab_happy01', weight: 1 }],
                ocr: ['TITULO IMPORTANTE', 'Subtítulo explicativo'],
                summary: 'Print de documento ou imagem com texto claro',
              }),
            }],
          },
        }],
      }),
    };
  };

  const result = await analyzeMedia({
    mimeType: 'image/png',
    dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    filename: 'teste.png',
    userPrompt: 'O que está escrito?',
    apiKey: 'mock-key-123',
    fetchImpl: mockFetch,
  });

  assert.equal(result.ok, true);
  assert.match(capturedUrl, new RegExp(DEFAULT_GEMINI_VISION_MODEL));
  assert.match(capturedUrl, /key=mock-key-123/);
  assert.equal(capturedBody.contents[0].parts[0].inlineData.mimeType, 'image/png');
  assert.equal(result.reply, 'Que imagem legal! Li tudo que tava escrito aí.');
  assert.equal(result.gesture, 'clap');
  assert.deepEqual(result.ocr, ['TITULO IMPORTANTE', 'Subtítulo explicativo']);
});

test('media-analyzer: createMediaAnalyzeHandler valida rota e rejeita sem payload', async () => {
  const { createMediaAnalyzeHandler } = await import('../server.mjs');
  const handler = createMediaAnalyzeHandler({
    allowedOrigins: ['http://localhost:5173'],
    getKey: async () => 'test-key',
  });

  let status = 0;
  let responseData = null;
  const mockRes = {
    writeHead(s) { status = s; },
    end(d) { responseData = JSON.parse(d); },
  };

  const reqGet = { method: 'GET', url: '/api/media/analyze', headers: { origin: 'http://localhost:5173', host: 'localhost:5173' } };
  await handler(reqGet, mockRes);
  assert.equal(status, 404);

  const reqPostEmpty = {
    method: 'POST',
    url: '/api/media/analyze',
    headers: { origin: 'http://localhost:5173', host: 'localhost:5173' },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from('{}');
    },
  };
  await handler(reqPostEmpty, mockRes);
  assert.equal(status, 400);
});

test('media-analyzer: createMediaAnalyzeHandler persiste turno e resumo na memória ao concluir', async () => {
  const { createMediaAnalyzeHandler } = await import('../server.mjs');

  const historyRecorded = [];
  const recentFactsRecorded = [];
  const mockMemoryStore = {
    getAll: () => ({ affinity: { score: 50 }, user: { nickname: 'Mari' } }),
    getSections: () => ({}),
    getRecentFacts: () => [],
    getTodayHistory: () => [],
    getSummaries: () => [],
    appendHistory: (role, content) => { historyRecorded.push({ role, content }); },
    addRecentFact: (fact) => { recentFactsRecorded.push(fact); },
  };

  const mockFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [{
        content: {
          parts: [{
            text: JSON.stringify({
              reply: 'Adorei a foto do bolo!',
              gesture: 'happy',
              actions: [],
              ocr: ['Parabéns!'],
              summary: 'Foto de um bolo de aniversário com velinhas',
            }),
          }],
        },
      }],
    }),
  });

  const handler = createMediaAnalyzeHandler({
    allowedOrigins: ['http://localhost:5173'],
    getKey: async () => 'test-key',
    memoryStore: mockMemoryStore,
    fetchImpl: mockFetch,
  });

  let status = 0;
  const mockRes = {
    writeHead(s) { status = s; },
    end() {},
  };

  const req = {
    method: 'POST',
    url: '/api/media/analyze',
    headers: { origin: 'http://localhost:5173', host: 'localhost:5173' },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify({
        mimeType: 'image/jpeg',
        data: 'fakebase64',
        filename: 'bolo.jpg',
        prompt: 'Olha que bolo lindo',
      }));
    },
  };

  await handler(req, mockRes);
  assert.equal(status, 200);
  assert.equal(historyRecorded.length, 2);
  assert.equal(historyRecorded[0].role, 'user');
  assert.match(historyRecorded[0].content, /bolo\.jpg/);
  assert.match(historyRecorded[0].content, /bolo de aniversário/);
  assert.equal(historyRecorded[1].role, 'assistant');
  assert.equal(historyRecorded[1].content, 'Adorei a foto do bolo!');
  assert.equal(recentFactsRecorded.length, 1);
  assert.match(recentFactsRecorded[0], /bolo\.jpg/);
});

test('media-analyzer: analyzeMedia recupera resposta via salvage se o JSON vier truncado', async () => {
  const truncatedCandidate = '{"reply": "Uau, que captura de tela detalhada!", "gesture": "surprised", "actions": [{"type": "set_';

  const mockFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [{
        content: {
          parts: [{
            text: truncatedCandidate,
          }],
        },
      }],
    }),
  });

  const result = await analyzeMedia({
    mimeType: 'image/png',
    dataBase64: 'fakebase64',
    filename: 'screenshot.png',
    apiKey: 'test-key',
    fetchImpl: mockFetch,
  });

  assert.equal(result.ok, true);
  assert.equal(result.reply, 'Uau, que captura de tela detalhada!');
  assert.equal(result.gesture, 'surprised');
});



