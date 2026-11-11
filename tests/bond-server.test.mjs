import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBondStore } from '../src/bond-store.js';
import { createMemoryStore } from '../src/memory-store.js';

// O server.mjs cria os depósitos padrão na avaliação do módulo; o diretório é
// trocado ANTES do import para nenhum teste encostar em data/.
const scratchDir = mkdtempSync(join(tmpdir(), 'usami-bond-api-'));
process.env.USAMI_DATA_DIR = scratchDir;
process.env.USAMI_KEYS_FILE = process.env.USAMI_KEYS_FILE || join(scratchDir, 'no-keys.env');

const { createBondHandler } = await import('../server.mjs');

const TEST_TOKEN = 'token-de-teste';

function mockReq({ method = 'GET', url = '/api/bond', headers = {}, body = '' } = {}) {
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

async function call(handler, req) {
  const res = mockRes();
  await handler(req, res);
  return { status: res.statusCode, data: JSON.parse(res.body) };
}

function seeded() {
  const dir = mkdtempSync(join(tmpdir(), 'usami-bond-seed-'));
  const store = createBondStore({ dataDir: dir });
  store.load();
  return { dir, store, handler: createBondHandler({ bondStore: store, apiToken: TEST_TOKEN }) };
}

test('rotas do vínculo exigem token: sem ele 401, sem token no servidor 503', async () => {
  const { dir, store } = seeded();
  try {
    const denied = await call(createBondHandler({ bondStore: store, apiToken: TEST_TOKEN }), mockReq({ headers: { 'x-usami-token': '' } }));
    assert.equal(denied.status, 401);
    const closed = await call(createBondHandler({ bondStore: store, apiToken: null }), mockReq());
    assert.equal(closed.status, 503);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Host fora da allowlist é 403 mesmo com Origin igual ao Host', async () => {
  const { dir, handler } = seeded();
  try {
    const res = await call(handler, mockReq({ headers: { host: 'evil.com', origin: 'http://evil.com' } }));
    assert.equal(res.status, 403);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GET /api/bond devolve medidores, histórico e resumo do nível', async () => {
  const { dir, store, handler } = seeded();
  try {
    store.awardChat('kkkk que demais');
    const { status, data } = await call(handler, mockReq());
    assert.equal(status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.bond.intimacy.carinho, 1);
    assert.equal(data.bond.intimacy.humor, 2);
    assert.equal(data.bond.summary.level, 1);
    assert.equal(data.bond.log[0].kind, 'laugh');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('POST /api/bond/event calcula o ganho no core (voz e risada)', async () => {
  const { dir, store, handler } = seeded();
  try {
    const laugh = await call(handler, jsonReq('/api/bond/event', { content: 'hahaha' }));
    assert.equal(laugh.status, 200);
    assert.equal(laugh.data.bond.intimacy.humor, 2);
    assert.equal(laugh.data.bond.event.kind, 'laugh');

    const spoken = await call(handler, jsonReq('/api/bond/event', { content: 'oi', spoken: true }));
    assert.equal(spoken.data.bond.intimacy.companhia, 2);
    assert.equal(spoken.data.bond.event.kind, 'voice');

    assert.equal(store.getAll().intimacy.carinho, 2, 'o store foi atualizado pelo handler');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('POST /api/bond/import migra o localStorage uma única vez', async () => {
  const { dir, handler } = seeded();
  try {
    const first = await call(handler, jsonReq('/api/bond/import', {
      intimacy: { carinho: 40, humor: 3 },
      log: [{ kind: 'chat', text: 'Vocês conversaram', at: 1700000000000, gains: { carinho: 1 } }],
    }));
    assert.equal(first.status, 200);
    assert.equal(first.data.bond.imported, true);
    assert.equal(first.data.bond.intimacy.carinho, 40);

    const second = await call(handler, jsonReq('/api/bond/import', { intimacy: { carinho: 1 } }));
    assert.equal(second.data.bond.imported, false);
    assert.equal(second.data.bond.intimacy.carinho, 40);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('POST /api/bond/reset exige confirmação escrita e zera o estado', async () => {
  const { dir, store, handler } = seeded();
  try {
    store.awardChat('oi');
    const denied = await call(handler, jsonReq('/api/bond/reset', { confirm: 'apagar tudo' }));
    assert.equal(denied.status, 403);
    assert.equal(store.getAll().intimacy.carinho, 1);

    const reset = await call(handler, jsonReq('/api/bond/reset', { confirm: 'APAGAR' }));
    assert.equal(reset.status, 200);
    assert.deepEqual(reset.data.bond.intimacy, { carinho: 0, humor: 0, companhia: 0 });
    assert.deepEqual(reset.data.bond.log, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('eventos do vínculo espelham os medidores no memory.json', async () => {
  const { dir, store } = seeded();
  const memoryDir = mkdtempSync(join(tmpdir(), 'usami-bond-mirror-'));
  const memoryStore = createMemoryStore({ dataDir: memoryDir });
  memoryStore.load();
  try {
    const handler = createBondHandler({ bondStore: store, memoryStore, apiToken: TEST_TOKEN });
    await call(handler, jsonReq('/api/bond/event', { content: 'oi', spoken: true }));
    assert.deepEqual(memoryStore.getBondMirror().intimacy, { carinho: 1, humor: 0, companhia: 2 });

    // reset também atualiza o espelho, em vez de deixar o valor antigo
    await call(handler, jsonReq('/api/bond/reset', { confirm: 'APAGAR' }));
    assert.deepEqual(memoryStore.getBondMirror().intimacy, { carinho: 0, humor: 0, companhia: 0 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(memoryDir, { recursive: true, force: true });
  }
});

test('validação: conteúdo ausente, metodo errado e Content-Type inválido', async () => {
  const { dir, handler } = seeded();
  try {
    assert.equal((await call(handler, jsonReq('/api/bond/event', { content: '  ' }))).status, 400);
    assert.equal((await call(handler, mockReq({ method: 'GET', url: '/api/bond/event' }))).status, 404);
    assert.equal((await call(handler, mockReq({ method: 'POST', url: '/api/bond/event', body: '{}' }))).status, 403);
    assert.equal((await call(handler, jsonReq('/api/bond/outra', {}))).status, 404);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
