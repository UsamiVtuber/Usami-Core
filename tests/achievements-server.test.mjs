import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBondStore } from '../src/bond-store.js';
import { createAchievementsStore } from '../src/achievements-store.js';
import { ACHIEVEMENTS } from '../src/achievements.js';

// O server.mjs cria os depósitos padrão na avaliação do módulo; o diretório é
// trocado ANTES do import para nenhum teste encostar em data/.
const scratchDir = mkdtempSync(join(tmpdir(), 'usami-achievements-api-'));
process.env.USAMI_DATA_DIR = scratchDir;
process.env.USAMI_KEYS_FILE = process.env.USAMI_KEYS_FILE || join(scratchDir, 'no-keys.env');

const { createBondHandler, createAchievementsHandler } = await import('../server.mjs');

const TEST_TOKEN = 'token-de-teste';

function mockReq({ method = 'GET', url = '/api/achievements', headers = {}, body = '' } = {}) {
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
  const dir = mkdtempSync(join(tmpdir(), 'usami-achievements-seed-'));
  const bondStore = createBondStore({ dataDir: dir });
  bondStore.load();
  const achievementsStore = createAchievementsStore({ dataDir: dir });
  achievementsStore.load();
  return {
    dir,
    bondStore,
    achievementsStore,
    bondHandler: createBondHandler({ bondStore, achievementsStore, apiToken: TEST_TOKEN }),
    handler: createAchievementsHandler({ achievementsStore, bondStore, apiToken: TEST_TOKEN }),
  };
}

test('GET /api/achievements exige token: sem ele 401, sem token no servidor 503', async () => {
  const { dir, bondStore, achievementsStore } = seeded();
  try {
    const denied = await call(
      createAchievementsHandler({ achievementsStore, bondStore, apiToken: TEST_TOKEN }),
      mockReq({ headers: { 'x-usami-token': '' } }),
    );
    assert.equal(denied.status, 401);
    const closed = await call(
      createAchievementsHandler({ achievementsStore, bondStore, apiToken: null }),
      mockReq(),
    );
    assert.equal(closed.status, 503);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Host fora da allowlist é 403 mesmo com token', async () => {
  const { dir, handler } = seeded();
  try {
    const res = await call(handler, mockReq({ headers: { host: 'evil.com', origin: 'http://evil.com' } }));
    assert.equal(res.status, 403);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GET /api/achievements devolve o contrato: todos os itens com unlocked e unlockedAt', async () => {
  const { dir, handler } = seeded();
  try {
    const { status, data } = await call(handler, mockReq());
    assert.equal(status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.achievements.length, ACHIEVEMENTS.length);
    for (const item of data.achievements) {
      assert.ok(typeof item.id === 'string' && item.id.length > 0);
      assert.ok(typeof item.name === 'string' && item.name.length > 0);
      assert.ok(typeof item.description === 'string' && item.description.length > 0);
      assert.ok(typeof item.icon === 'string' && item.icon.length > 0);
      assert.equal(item.unlocked, false);
      assert.equal(item.unlockedAt, null);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('evento de bond destrava conquista e GET /api/achievements reflete com unlockedAt ISO', async () => {
  const { dir, bondHandler, handler, achievementsStore } = seeded();
  try {
    const laugh = await call(bondHandler, jsonReq('/api/bond/event', { content: 'kkkk que demais' }));
    assert.equal(laugh.status, 200);

    const { status, data } = await call(handler, mockReq());
    assert.equal(status, 200);
    const byId = Object.fromEntries(data.achievements.map(item => [item.id, item]));
    assert.equal(byId['primeira-conversa'].unlocked, true);
    assert.equal(byId['risada-juntos'].unlocked, true);
    assert.ok(!Number.isNaN(Date.parse(byId['primeira-conversa'].unlockedAt)), 'unlockedAt é ISO parseável');
    assert.equal(byId['na-linha'].unlocked, false, 'chamada ainda não aconteceu');

    const saved = achievementsStore.getAll().unlocked;
    assert.ok(saved['primeira-conversa'] && saved['risada-juntos']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unlockedAt não muda após eventos novos e chamada destrava "Na Linha"', async () => {
  const { dir, bondHandler, handler } = seeded();
  try {
    await call(bondHandler, jsonReq('/api/bond/event', { content: 'oi' }));
    const first = await call(handler, mockReq());
    const atFirst = first.data.achievements.find(item => item.id === 'primeira-conversa').unlockedAt;

    await call(bondHandler, jsonReq('/api/bond/event', { kind: 'call', minutes: 3 }));
    const second = await call(handler, mockReq());
    const byId = Object.fromEntries(second.data.achievements.map(item => [item.id, item]));
    assert.equal(byId['primeira-conversa'].unlockedAt, atFirst, 'desbloqueio antigo preservado');
    assert.equal(byId['na-linha'].unlocked, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('método errado na rota de conquistas é 404', async () => {
  const { dir, handler } = seeded();
  try {
    const res = await call(handler, mockReq({ method: 'POST', url: '/api/achievements', body: '{}' }));
    assert.equal(res.status, 404);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
