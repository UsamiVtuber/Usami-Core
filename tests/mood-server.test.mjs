import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMoodStore } from '../src/mood-store.js';
import { createMemoryStore } from '../src/memory-store.js';
import { createPersonalityStore } from '../src/personality-store.js';

const scratchDir = mkdtempSync(join(tmpdir(), 'usami-mood-api-'));
process.env.USAMI_DATA_DIR = scratchDir;
process.env.USAMI_KEYS_FILE = process.env.USAMI_KEYS_FILE || join(scratchDir, 'no-keys.env');

const { createMoodHandler, createChatHandler } = await import('../server.mjs');

const TEST_TOKEN = 'token-mood-teste';

function mockReq({ method = 'GET', url = '/api/mood', headers = {}, body = '' } = {}) {
  const chunks = body ? [Buffer.from(body)] : [];
  return {
    method,
    url,
    headers: { host: '127.0.0.1:8787', 'x-usami-token': TEST_TOKEN, ...headers },
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

function jsonReq(url, payload, headers = {}) {
  return mockReq({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });
}

test('GET/POST /api/mood exige token e atualiza o humor', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'usami-mood-route-'));
  try {
    const moodStore = createMoodStore({ dataDir: dir });
    moodStore.load();
    const memoryStore = createMemoryStore({ dataDir: dir });
    memoryStore.load();
    const handleMood = createMoodHandler({ moodStore, memoryStore, apiToken: TEST_TOKEN });

    const unauth = mockRes();
    await handleMood(mockReq({ headers: { 'x-usami-token': '' } }), unauth);
    assert.equal(unauth.statusCode, 401);

    const getRes = mockRes();
    await handleMood(mockReq(), getRes);
    assert.equal(getRes.statusCode, 200);
    assert.equal(JSON.parse(getRes.body).mood.id, 'soft');

    const postRes = mockRes();
    await handleMood(
      jsonReq('/api/mood/event', { emotion: 'shy', reason: 'Recebeu um elogio fofo.' }),
      postRes,
    );
    assert.equal(postRes.statusCode, 200);
    const updated = JSON.parse(postRes.body).mood;
    assert.equal(updated.id, 'shy');
    assert.equal(updated.reason, 'Recebeu um elogio fofo.');

    const resetRes = mockRes();
    await handleMood(jsonReq('/api/mood/reset', {}), resetRes);
    assert.equal(resetRes.statusCode, 200);
    assert.equal(JSON.parse(resetRes.body).mood.id, 'soft');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('POST /api/chat injeta humor no prompt e retorna humor atualizado', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'usami-mood-chat-'));
  try {
    const moodStore = createMoodStore({ dataDir: dir });
    moodStore.load();
    moodStore.recordEvent({ emotion: 'shy', reason: 'Estava tímida antes da pergunta.' });

    const memoryStore = createMemoryStore({ dataDir: dir });
    memoryStore.load();
    const personalityStore = createPersonalityStore({ dataDir: dir });
    personalityStore.load();

    let capturedSystem = '';
    const fetchStub = async (url, init) => {
      const payload = JSON.parse(init.body);
      capturedSystem = payload.messages[0].content;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{
            message: {
              content: JSON.stringify({
                reply: 'N-não é nada disso, baka!',
                gesture: 'blush',
                actions: [{ type: 'set_expression', name: '16-prefab_awkward02', weight: 0.85 }],
                remember: null,
              }),
            },
          }],
        }),
      };
    };

    const handleChat = createChatHandler({
      memoryStore,
      personalityStore,
      moodStore,
      useNvidia: () => false,
      getKey: async () => 'sk-test-openrouter',
      fetchImpl: fetchStub,
      vaultSearch: async () => null,
      proactiveEngine: { markUserActivity() {}, setBusy() {} },
    });

    const res = mockRes();
    await handleChat(
      jsonReq('/api/chat', { message: 'você fica fofa assim' }),
      res,
    );
    assert.equal(res.statusCode, 200);
    assert.match(capturedSystem, /=== HUMOR ATUAL ===/);
    assert.match(capturedSystem, /Envergonhada/);

    const body = JSON.parse(res.body);
    assert.equal(body.mood.id, 'shy');
    assert.equal(body.mood.expression.name, '16-prefab_awkward02');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test.after(() => {
  rmSync(scratchDir, { recursive: true, force: true });
});
