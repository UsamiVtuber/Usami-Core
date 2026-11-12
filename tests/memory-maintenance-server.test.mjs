import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryStore } from '../src/memory-store.js';

const scratchDir = mkdtempSync(join(tmpdir(), 'usami-maint-test-'));
process.env.USAMI_DATA_DIR = scratchDir;
process.env.USAMI_KEYS_FILE = process.env.USAMI_KEYS_FILE || join(scratchDir, 'no-keys.env');

const { createMemoryHandler } = await import('../server.mjs');

const TEST_TOKEN = 'token-manutencao-123';

function mockReq({ method = 'POST', url = '/api/memory/maintenance', headers = {}, body = '' } = {}) {
  const chunks = body ? [Buffer.from(body)] : [];
  return {
    method,
    url,
    headers: { host: '127.0.0.1:8787', origin: 'http://127.0.0.1:5173', 'x-usami-token': TEST_TOKEN, ...headers },
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

test('POST /api/memory/maintenance: executa rotina noturna com sucesso e exige token', async () => {
  const store = createMemoryStore({ dataDir: scratchDir });
  store.load();

  const mockLanceStore = {
    async init() {},
    async count() { return 5; },
  };

  const handler = createMemoryHandler({
    memoryStore: store,
    lanceStore: mockLanceStore,
    apiToken: TEST_TOKEN,
  });

  // 1. Sem token -> 401
  const unauthReq = mockReq({ headers: { 'x-usami-token': 'token-errado' } });
  const unauthRes = mockRes();
  await handler(unauthReq, unauthRes);
  assert.equal(unauthRes.statusCode, 401);

  // 2. Com token correto -> 200 e execução completa
  const okReq = mockReq();
  const okRes = mockRes();
  await handler(okReq, okRes);
  assert.equal(okRes.statusCode, 200);

  const payload = JSON.parse(okRes.body);
  assert.equal(payload.ok, true);
  assert.ok(payload.maintenanceAt);
  assert.equal(payload.lanceDbChunks, 5);
  assert.ok(payload.memory);

  try {
    rmSync(scratchDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});
