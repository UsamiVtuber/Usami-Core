import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCharacterRegistry, extractRequestCharacterId } from '../src/character-context.js';
import { createMemoryStore } from '../src/memory-store.js';

process.env.USE_NVIDIA = 'false';
const scratchDir = mkdtempSync(join(tmpdir(), 'usami-char-ctx-init-'));
process.env.USAMI_DATA_DIR = scratchDir;
const {
  createCharactersHandler,
  createChatHandler,
  createMemoryHandler,
  createPersonalityHandler,
} = await import('../server.mjs');

function mockReq({ method = 'GET', url = '/', headers = {}, body = '' } = {}) {
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

test('extractRequestCharacterId: valida cabeçalho x-character-id e rejeita path traversal', () => {
  assert.deepEqual(extractRequestCharacterId({ headers: {} }), {
    ok: true,
    characterId: 'usami-classic',
    explicit: false,
  });
  assert.deepEqual(extractRequestCharacterId({ headers: { 'x-character-id': 'test-dummy' } }), {
    ok: true,
    characterId: 'test-dummy',
    explicit: true,
  });
  const invalid = extractRequestCharacterId({ headers: { 'x-character-id': '../hack' } });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.status, 400);
});

test('x-character-id: requisições isoladas entre usami-classic e test-dummy não vazam estado', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'usami-ctx-isolation-'));
  const defaultMemory = createMemoryStore({ dataDir: dir });
  defaultMemory.load();
  const registry = createCharacterRegistry({
    dataDir: dir,
    defaultStores: { memoryStore: defaultMemory },
    allowSyntheticManifest: true,
  });

  const handleChat = createChatHandler({
    characterRegistry: registry,
    memoryStore: defaultMemory,
    vaultSearch: async () => null,
    getKey: async () => 'test-key',
    fetchImpl: async (_url, opts) => {
      const sys = JSON.parse(opts.body).messages.find(m => m.role === 'system')?.content || '';
      const reply = sys.includes('test-dummy') ? 'Sou o test-dummy!' : 'Sou a Usami!';
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({ reply, gesture: 'nod', actions: [], remember: null }) } }],
        }),
      };
    },
  });

  const handleMemory = createMemoryHandler({
    characterRegistry: registry,
    apiToken: 'tok-ctx',
  });
  const handlePersonality = createPersonalityHandler({
    characterRegistry: registry,
    apiToken: 'tok-ctx',
  });

  try {
    // Turno no test-dummy grava apenas no diretório isolado de characters/test-dummy
    const chatDummy = mockRes();
    await handleChat(mockReq({
      method: 'POST',
      url: '/api/chat',
      headers: { host: '127.0.0.1:8787', 'content-type': 'application/json', 'x-character-id': 'test-dummy' },
      body: JSON.stringify({ message: 'Oi test-dummy' }),
    }), chatDummy);
    assert.equal(chatDummy.statusCode, 200);
    assert.equal(JSON.parse(chatDummy.body).reply, 'Sou o test-dummy!');

    // Turno na usami-classic preserva estado independente
    const chatUsami = mockRes();
    await handleChat(mockReq({
      method: 'POST',
      url: '/api/chat',
      headers: { host: '127.0.0.1:8787', 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Oi Usami' }),
    }), chatUsami);
    assert.equal(chatUsami.statusCode, 200);
    assert.equal(JSON.parse(chatUsami.body).reply, 'Sou a Usami!');

    // Verifica histórico de memória isolado via API
    const memDummyRes = mockRes();
    await handleMemory(mockReq({
      method: 'GET',
      url: '/api/memory',
      headers: { host: '127.0.0.1:8787', 'x-usami-token': 'tok-ctx', 'x-character-id': 'test-dummy' },
    }), memDummyRes);
    const dummyData = JSON.parse(memDummyRes.body);
    assert.equal(dummyData.memory.history.length, 1);

    // Verifica rejeição HTTP 400 para cabeçalho inválido
    const badRes = mockRes();
    await handleChat(mockReq({
      method: 'POST',
      url: '/api/chat',
      headers: { host: '127.0.0.1:8787', 'content-type': 'application/json', 'x-character-id': '../escape' },
      body: JSON.stringify({ message: 'oi' }),
    }), badRes);
    assert.equal(badRes.statusCode, 400);

    // Personalidade do dummy salva sem alterar usami-classic
    const postPers = mockRes();
    await handlePersonality(mockReq({
      method: 'POST',
      url: '/api/personality',
      headers: { host: '127.0.0.1:8787', 'content-type': 'application/json', 'x-usami-token': 'tok-ctx', 'x-character-id': 'test-dummy' },
      body: JSON.stringify({ traits: { warmth: 95 }, customPrompt: 'Personalidade do Dummy' }),
    }), postPers);
    assert.equal(postPers.statusCode, 200);

    const getUsamiPers = mockRes();
    await handlePersonality(mockReq({
      method: 'GET',
      url: '/api/personality',
      headers: { host: '127.0.0.1:8787', 'x-usami-token': 'tok-ctx', 'x-character-id': 'usami-classic' },
    }), getUsamiPers);
    assert.equal(JSON.parse(getUsamiPers.body).personality.customPrompt, '');

    assert.equal(existsSync(join(dir, 'characters', 'test-dummy', 'personality.json')), true);
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { }
  }
});

test('createCharactersHandler: GET /api/characters, GET/POST /api/characters/active', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'usami-chars-route-'));
  const registry = createCharacterRegistry({ dataDir: dir, allowSyntheticManifest: true });
  registry.getOrCreate('test-dummy');
  const handler = createCharactersHandler({ characterRegistry: registry, apiToken: 'tok-chars' });

  try {
    const listRes = mockRes();
    await handler(mockReq({
      method: 'GET',
      url: '/api/characters',
      headers: { host: '127.0.0.1:8787', 'x-usami-token': 'tok-chars' },
    }), listRes);
    assert.equal(listRes.statusCode, 200);
    const listJson = JSON.parse(listRes.body);
    assert.equal(listJson.activeCharacterId, 'usami-classic');
    assert.ok(listJson.characters.some(c => c.characterId === 'test-dummy'));

    const postActive = mockRes();
    await handler(mockReq({
      method: 'POST',
      url: '/api/characters/active',
      headers: { host: '127.0.0.1:8787', 'content-type': 'application/json', 'x-usami-token': 'tok-chars' },
      body: JSON.stringify({ characterId: 'test-dummy' }),
    }), postActive);
    assert.equal(postActive.statusCode, 200);
    assert.equal(JSON.parse(postActive.body).characterId, 'test-dummy');

    const getActive = mockRes();
    await handler(mockReq({
      method: 'GET',
      url: '/api/characters/active',
      headers: { host: '127.0.0.1:8787', 'x-usami-token': 'tok-chars' },
    }), getActive);
    assert.equal(getActive.statusCode, 200);
    assert.equal(JSON.parse(getActive.body).characterId, 'test-dummy');
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { }
  }
});
