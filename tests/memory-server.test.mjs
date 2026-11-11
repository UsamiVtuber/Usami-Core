import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryStore } from '../src/memory-store.js';
import { createBondStore } from '../src/bond-store.js';

// O server.mjs cria o depósito padrão na avaliação do módulo; o diretório é
// trocado ANTES do import para nenhum teste encostar em data/.
const scratchDir = mkdtempSync(join(tmpdir(), 'usami-memory-api-'));
process.env.USAMI_DATA_DIR = scratchDir;
process.env.USAMI_KEYS_FILE = process.env.USAMI_KEYS_FILE || join(scratchDir, 'no-keys.env');

const { createMemoryHandler } = await import('../server.mjs');

const TEST_TOKEN = 'token-de-teste';

function mockReq({ method = 'GET', url = '/api/memory', headers = {}, body = '' } = {}) {
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

function jsonReq(payload, headers = {}) {
  return mockReq({
    method: 'POST',
    url: '/api/memory/forget',
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
  const dir = mkdtempSync(join(tmpdir(), 'usami-memory-seed-'));
  const store = createMemoryStore({ dataDir: dir });
  store.load();
  store.addCoreFact('tem um gato chamado Mochi', 'user');
  store.addCoreFact('gosta de café gelado', 'preferences');
  store.addRecentFact('está aprendendo three.js', 7, 'hobbies');
  store.upsertSummary('2026-10-23', 'conversamos sobre gatos');
  store.appendHistory('user', 'oi', '2026-10-24T12:00:00.000Z');
  store.setAffinity(42, '2026-10-24');
  // Vínculo real em diretório próprio: o espelho na memória sai do bond.json.
  const bondStore = createBondStore({ dataDir: dir });
  bondStore.load();
  bondStore.importState({ intimacy: { carinho: 31, companhia: 26 }, log: [] });
  store.setBondMirror(bondStore.getAll());
  return { dir, store, bondStore, handler: createMemoryHandler({ memoryStore: store, bondStore, apiToken: TEST_TOKEN }) };
}

test('rotas de memória exigem token: sem ele 401, errado 401, sem token no servidor 503', async () => {
  const savedToken = process.env.USAMI_API_TOKEN;
  delete process.env.USAMI_API_TOKEN;
  const { dir, handler } = seeded();
  try {
    assert.equal((await call(handler, mockReq({ headers: { 'x-usami-token': '' } }))).status, 401);
    assert.equal((await call(handler, mockReq({ headers: { 'x-usami-token': 'outro' } }))).status, 401);
    const open = createMemoryHandler({ memoryStore: seeded().store, apiToken: null });
    assert.equal((await call(open, mockReq())).status, 503);
  } finally {
    if (savedToken !== undefined) process.env.USAMI_API_TOKEN = savedToken;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Host fora da allowlist (DNS rebinding) é 403 mesmo com Origin igual ao Host', async () => {
  const { dir, handler } = seeded();
  try {
    const res = await call(handler, mockReq({ headers: { host: 'evil.com', origin: 'http://evil.com' } }));
    assert.equal(res.status, 403);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GET /api/memory devolve seções, recentes, resumos e dias — sem o texto das mensagens', async () => {
  const { dir, handler } = seeded();
  try {
    const { status, data } = await call(handler, mockReq());
    assert.equal(status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.memory.version, 2);
    assert.deepEqual(data.memory.sections.user, ['tem um gato chamado Mochi']);
    assert.deepEqual(data.memory.sections.preferences, ['gosta de café gelado']);
    assert.equal(data.memory.recentFacts[0].section, 'hobbies');
    assert.deepEqual(data.memory.summaries, [{ date: '2026-10-23', summary: 'conversamos sobre gatos' }]);
    assert.equal(data.memory.history.length, 1);
    assert.equal(data.memory.history[0].count, 1);
    assert.equal(data.memory.affinity.score, 42);
    // espelho do vínculo: mesmos números do /api/bond, com nível derivado
    assert.equal(data.memory.bond.intimacy.carinho, 31);
    assert.equal(data.memory.bond.intimacy.companhia, 26);
    assert.equal(data.memory.bond.meters.carinho.level, 2);
    assert.equal(data.memory.bond.summary.level, 2);
    assert.ok(!JSON.stringify(data).includes('"oi"'), 'conteúdo da conversa não vaza no snapshot');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('forget sem confirmação escrita não apaga nada', async () => {
  const { dir, store, handler } = seeded();
  try {
    const missing = await call(handler, jsonReq({ kind: 'fact', section: 'user', fact: 'tem um gato chamado Mochi' }));
    assert.equal(missing.status, 403);

    const wrong = await call(handler, jsonReq({ kind: 'all', confirm: 'apagar tudo' }));
    assert.equal(wrong.status, 403);
    assert.deepEqual(store.getSections().user, ['tem um gato chamado Mochi']);
    assert.equal(store.getAffinity().score, 42);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('forget granular: fato, recente, seção, resumo, histórico — cada um com snapshot atualizado', async () => {
  const { dir, store, handler } = seeded();
  try {
    const fact = await call(handler, jsonReq({ kind: 'fact', section: 'user', fact: 'TEM UM GATO chamado mochi', confirm: 'apagar' }));
    assert.equal(fact.status, 200);
    assert.equal(fact.data.removed, 1);
    assert.deepEqual(fact.data.memory.sections.user, []);

    const recent = await call(handler, jsonReq({ kind: 'recent', fact: 'está aprendendo three.js', confirm: 'APAGAR' }));
    assert.equal(recent.data.removed, 1);
    assert.equal(recent.data.memory.recentFacts.length, 0);

    const section = await call(handler, jsonReq({ kind: 'section', section: 'preferences', confirm: 'APAGAR' }));
    assert.equal(section.data.removed, 1);
    assert.deepEqual(section.data.memory.sections.preferences, []);

    const summary = await call(handler, jsonReq({ kind: 'summary', date: '2026-10-23', confirm: 'APAGAR' }));
    assert.equal(summary.data.removed, 1);
    assert.deepEqual(summary.data.memory.summaries, []);

    const history = await call(handler, jsonReq({ kind: 'history', confirm: 'APAGAR' }));
    assert.equal(history.data.removed, 1);
    assert.deepEqual(history.data.memory.history, []);

    // nada disso mexeu na afinidade; "all" é quem zera
    assert.equal(store.getAffinity().score, 42);
    const all = await call(handler, jsonReq({ kind: 'all', confirm: 'APAGAR' }));
    assert.equal(all.status, 200);
    assert.equal(all.data.memory.affinity.score, 0);
    assert.equal(all.data.memory.sections.user.length, 0);
    // os medidores vivem no bond.json: limpar a memória não apaga o vínculo,
    // então o espelho volta na resposta em vez de sumir.
    assert.equal(all.data.memory.bond.intimacy.carinho, 31);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('validação: kind, seção e data inválidos devolvem 400; origem externa 403', async () => {
  const { dir, handler } = seeded();
  try {
    assert.equal((await call(handler, jsonReq({ kind: 'nada', confirm: 'APAGAR' }))).status, 400);
    assert.equal((await call(handler, jsonReq({ kind: 'fact', section: 'inventada', fact: 'x', confirm: 'APAGAR' }))).status, 400);
    assert.equal((await call(handler, jsonReq({ kind: 'fact', section: 'user', confirm: 'APAGAR' }))).status, 400);
    assert.equal((await call(handler, jsonReq({ kind: 'summary', date: 'ontem', confirm: 'APAGAR' }))).status, 400);
    assert.equal((await call(handler, jsonReq({ kind: 'all', confirm: 'APAGAR' }, { origin: 'https://evil.com', host: 'localhost:8787' }))).status, 403);
    assert.equal((await call(handler, mockReq({ method: 'POST', url: '/api/memory' }))).status, 404);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
