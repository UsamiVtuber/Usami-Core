import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOperationalMemoryStore } from '../src/operational-memory-store.js';

// O server.mjs cria os depósitos padrão na avaliação do módulo; o diretório é
// trocado ANTES do import para nenhum teste encostar em data/.
const scratchDir = mkdtempSync(join(tmpdir(), 'usami-opmem-api-'));
process.env.USAMI_DATA_DIR = scratchDir;
process.env.USAMI_KEYS_FILE = process.env.USAMI_KEYS_FILE || join(scratchDir, 'no-keys.env');

const { createOperationalMemoryHandler } = await import('../server.mjs');

const TEST_TOKEN = 'token-de-teste';

function mockReq({ method = 'GET', url = '/api/agent/memory', headers = {}, body = '' } = {}) {
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

function jsonReq(url, payload, { method = 'POST', headers = {} } = {}) {
  return mockReq({
    method,
    url,
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
}

async function call(handler, req) {
  const res = mockRes();
  await handler(req, res);
  return { status: res.statusCode, data: JSON.parse(res.body) };
}

function seeded() {
  const dir = mkdtempSync(join(tmpdir(), 'usami-opmem-seed-'));
  const store = createOperationalMemoryStore({ dataDir: dir });
  store.load();
  return { dir, store, handler: createOperationalMemoryHandler({ operationalStore: store, apiToken: TEST_TOKEN }) };
}

test('memória operacional exige token: sem ele 401, sem token no servidor 503', async () => {
  const { dir, store } = seeded();
  try {
    const denied = await call(
      createOperationalMemoryHandler({ operationalStore: store, apiToken: TEST_TOKEN }),
      mockReq({ headers: { 'x-usami-token': '' } }),
    );
    assert.equal(denied.status, 401);
    const closed = await call(createOperationalMemoryHandler({ operationalStore: store, apiToken: null }), mockReq());
    assert.equal(closed.status, 503);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Host fora da allowlist é 403', async () => {
  const { dir, handler } = seeded();
  try {
    const res = await call(handler, mockReq({ headers: { host: 'evil.com', origin: 'http://evil.com' } }));
    assert.equal(res.status, 403);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('POST cria com defaults e GET lista, busca por id e trilha', async () => {
  const { dir, store, handler } = seeded();
  try {
    const created = await call(handler, jsonReq('/api/agent/memory', {
      kind: 'task',
      title: 'revisar PR do desktop',
      dueAt: '2026-11-12',
    }));
    assert.equal(created.status, 201);
    assert.equal(created.data.ok, true);
    assert.match(created.data.record.id, /^op-[0-9a-f]{12}$/);
    assert.equal(created.data.record.status, 'open');
    assert.equal(created.data.record.origin, 'user');
    assert.equal(created.data.record.schema, 'usami.agent.operational.v1');

    const list = await call(handler, mockReq({ url: '/api/agent/memory' }));
    assert.equal(list.status, 200);
    assert.equal(list.data.count, 1);
    assert.equal(list.data.records[0].id, created.data.record.id);

    const byId = await call(handler, mockReq({ url: `/api/agent/memory/${created.data.record.id}` }));
    assert.equal(byId.status, 200);
    assert.equal(byId.data.record.title, 'revisar PR do desktop');

    const trail = await call(handler, mockReq({ url: '/api/agent/memory/trail' }));
    assert.equal(trail.status, 200);
    assert.equal(trail.data.trail.at(-1).action, 'create');
    assert.equal(trail.data.trail.at(-1).id, created.data.record.id);
    assert.equal(JSON.stringify(trail.data.trail).includes('revisar PR do desktop'), false, 'trilha não expõe o texto');

    assert.equal(store.getAll().records.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GET filtra por status, tipo, projeto e janela de dueAt', async () => {
  const { dir, handler } = seeded();
  try {
    const project = (await call(handler, jsonReq('/api/agent/memory', { kind: 'project', title: 'USAMI 2.0', status: 'in_progress' }))).data.record;
    await call(handler, jsonReq('/api/agent/memory', { kind: 'task', title: 'preparar briefing', dueAt: '2026-11-12', projectId: project.id }));
    await call(handler, jsonReq('/api/agent/memory', { kind: 'commitment', title: 'reunião com Ezequiel', status: 'done', dueAt: '2026-11-13T15:00:00.000Z', projectId: project.id }));

    const open = await call(handler, mockReq({ url: '/api/agent/memory?status=open' }));
    assert.equal(open.data.count, 1);
    assert.equal(open.data.records[0].title, 'preparar briefing');

    const tasks = await call(handler, mockReq({ url: '/api/agent/memory?kind=task' }));
    assert.equal(tasks.data.count, 1);

    const byProject = await call(handler, mockReq({ url: `/api/agent/memory?projectId=${project.id}` }));
    assert.equal(byProject.data.count, 2);

    const window = await call(handler, mockReq({ url: '/api/agent/memory?from=2026-11-11&to=2026-11-12T23:59:59Z' }));
    assert.equal(window.data.count, 1, 'projeto sem dueAt fica fora da janela');

    const inclusiveDay = await call(handler, mockReq({ url: '/api/agent/memory?from=2026-11-12&to=2026-11-13' }));
    assert.equal(inclusiveDay.data.count, 2, 'to em data pura inclui o dia inteiro');

    const limited = await call(handler, mockReq({ url: '/api/agent/memory?limit=2' }));
    assert.equal(limited.data.count, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PATCH altera campos editáveis, registra trilha e recusa o resto', async () => {
  const { dir, store, handler } = seeded();
  try {
    const created = (await call(handler, jsonReq('/api/agent/memory', { kind: 'task', title: 'revisar PR' }))).data.record;

    const updated = await call(handler, jsonReq(`/api/agent/memory/${created.id}`, { status: 'done', dueAt: '2026-11-20' }, { method: 'PATCH' }));
    assert.equal(updated.status, 200);
    assert.equal(updated.data.record.status, 'done');
    assert.equal(updated.data.record.dueAt, '2026-11-20');
    assert.deepEqual(updated.data.changed, ['status', 'dueAt']);
    assert.equal(store.get(created.id).status, 'done');

    const blocked = await call(handler, jsonReq(`/api/agent/memory/${created.id}`, { kind: 'commitment' }, { method: 'PATCH' }));
    assert.equal(blocked.status, 400);
    assert.ok(blocked.data.details.some(error => error.includes('patch.kind: campo não editável')));

    const invalid = await call(handler, jsonReq(`/api/agent/memory/${created.id}`, { relevance: 4 }, { method: 'PATCH' }));
    assert.equal(invalid.status, 400);
    assert.equal(store.get(created.id).relevance, 0.5);

    const missing = await call(handler, jsonReq('/api/agent/memory/op-000000000000', { status: 'done' }, { method: 'PATCH' }));
    assert.equal(missing.status, 404);

    const trail = await call(handler, mockReq({ url: '/api/agent/memory/trail?limit=1' }));
    assert.equal(trail.data.trail.length, 1);
    assert.equal(trail.data.trail[0].action, 'update');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('validação: payload inválido, JSON quebrado, Content-Type e filtros', async () => {
  const { dir, handler } = seeded();
  try {
    const invalid = await call(handler, jsonReq('/api/agent/memory', { kind: 'event', title: 'x', relevance: 2 }));
    assert.equal(invalid.status, 400);
    assert.equal(invalid.data.error, 'Registro inválido.');
    assert.ok(invalid.data.details.some(error => error.includes('kind: deve ser um de')));
    assert.ok(invalid.data.details.some(error => error.includes('title: deve ter ao menos 3')));
    assert.ok(invalid.data.details.some(error => error.includes('relevance: deve ser número entre 0 e 1')));

    assert.equal((await call(handler, jsonReq('/api/agent/memory', '{ não é json'))).status, 400);
    assert.equal((await call(handler, jsonReq('/api/agent/memory', '[]'))).status, 400);
    assert.equal((await call(handler, mockReq({ method: 'POST', url: '/api/agent/memory', body: '{}' }))).status, 403);

    const huge = JSON.stringify({ kind: 'task', title: 'a'.repeat(17_000) });
    assert.equal((await call(handler, jsonReq('/api/agent/memory', huge))).status, 413);

    for (const query of ['?status=parado', '?kind=event', '?projectId=nope', '?from=ontem', '?limit=0', '?limit=abc']) {
      assert.equal((await call(handler, mockReq({ url: `/api/agent/memory${query}` }))).status, 400, query);
    }

    assert.equal((await call(handler, mockReq({ url: '/api/agent/memory/op-000000000000' }))).status, 404);
    assert.equal((await call(handler, mockReq({ url: '/api/agent/memory/qualquer' }))).status, 404);
    assert.equal((await call(handler, mockReq({ method: 'DELETE', url: '/api/agent/memory' }))).status, 404);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
