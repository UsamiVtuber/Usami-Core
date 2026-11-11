import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTaskPlanner } from '../src/task-planner.js';

// O server.mjs cria os depósitos padrão na avaliação do módulo; o diretório é
// trocado ANTES do import para nenhum teste encostar em data/.
const scratchDir = mkdtempSync(join(tmpdir(), 'usami-plans-api-'));
process.env.USAMI_DATA_DIR = scratchDir;
process.env.USAMI_KEYS_FILE = process.env.USAMI_KEYS_FILE || join(scratchDir, 'no-keys.env');

const { createPlansHandler } = await import('../server.mjs');

const TEST_TOKEN = 'token-de-teste';

function mockReq({ method = 'GET', url = '/api/agent/plans', headers = {}, body = '' } = {}) {
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

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'usami-plans-api-seed-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const planner = createTaskPlanner({ dataDir: dir });
  planner.load();
  return { dir, planner, handler: createPlansHandler({ planner, apiToken: TEST_TOKEN }) };
}

test('borda: token e Host/Origin', async t => {
  const { planner, handler } = setup(t);

  const noToken = await call(createPlansHandler({ planner, apiToken: TEST_TOKEN }), {
    ...mockReq(),
    headers: { host: '127.0.0.1:8787' },
  });
  assert.equal(noToken.status, 401);

  const closed = await call(createPlansHandler({ planner, apiToken: null }), mockReq());
  assert.equal(closed.status, 503);

  const badHost = await call(handler, mockReq({ headers: { host: 'evil.example' } }));
  assert.equal(badHost.status, 403);
});

test('POST cria plano com passos e briefing; GET lista e busca', async t => {
  const { handler } = setup(t);
  const created = await call(handler, jsonReq('/api/agent/plans', { goal: 'Enviar o relatório amanhã' }));
  assert.equal(created.status, 201);
  assert.equal(created.data.ok, true);
  assert.equal(created.data.version, 1);
  assert.equal(created.data.plan.steps.length, 5);
  assert.ok(created.data.plan.briefing);
  assert.ok(created.data.plan.briefing.missingInfo.length >= 2);

  const list = await call(handler, mockReq({ url: '/api/agent/plans?limit=10' }));
  assert.equal(list.status, 200);
  assert.equal(list.data.count, 1);
  assert.deepEqual(list.data.unavailable, []);

  const fetched = await call(handler, mockReq({ url: `/api/agent/plans/${created.data.plan.id}` }));
  assert.equal(fetched.status, 200);
  assert.equal(fetched.data.versions.length, 1);

  const missing = await call(handler, mockReq({ url: '/api/agent/plans/pl-ffffffffffff' }));
  assert.equal(missing.status, 404);
});

test('PATCH avança progresso e recusa plano concluído', async t => {
  const { handler } = setup(t);
  const { data } = await call(handler, jsonReq('/api/agent/plans', { goal: 'Organizar a viagem de fim de ano' }));
  const { plan } = data;

  const blocked = await call(handler, jsonReq(`/api/agent/plans/${plan.id}`, {
    steps: [{ id: plan.steps[1].id, status: 'done' }],
  }, { method: 'PATCH' }));
  assert.equal(blocked.status, 400);
  assert.match(blocked.data.details[0], /dependência/);

  for (const step of plan.steps) {
    const updated = await call(handler, jsonReq(`/api/agent/plans/${plan.id}`, {
      steps: [{ id: step.id, status: 'done' }],
    }, { method: 'PATCH' }));
    assert.equal(updated.status, 200);
  }
  const done = await call(handler, jsonReq(`/api/agent/plans/${plan.id}`, { status: 'done' }, { method: 'PATCH' }));
  assert.equal(done.status, 200);

  const locked = await call(handler, jsonReq(`/api/agent/plans/${plan.id}`, {
    steps: [{ id: plan.steps[0].id, status: 'pending' }],
  }, { method: 'PATCH' }));
  assert.equal(locked.status, 409);
});

test('POST com replanOf devolve versão nova e preserva histórico', async t => {
  const { handler } = setup(t);
  const first = await call(handler, jsonReq('/api/agent/plans', { goal: 'Organizar a viagem de fim de ano' }));
  const replanned = await call(handler, jsonReq('/api/agent/plans', {
    goal: 'Organizar a viagem de fim de ano',
    replanOf: first.data.plan.id,
  }));
  assert.equal(replanned.status, 200);
  assert.equal(replanned.data.plan.version, 2);

  const fetched = await call(handler, mockReq({ url: `/api/agent/plans/${first.data.plan.id}` }));
  assert.deepEqual(fetched.data.versions.map(version => version.version), [1, 2]);
});

test('validação de corpo e rotas', async t => {
  const { handler } = setup(t);

  assert.equal((await call(handler, jsonReq('/api/agent/plans', { goal: 'a', extra: true }))).status, 400);
  assert.equal((await call(handler, jsonReq('/api/agent/plans', { goal: 'Organizar a viagem', origin: 'robô' }))).status, 400);
  assert.equal((await call(handler, jsonReq('/api/agent/plans', { goal: 'Organizar a viagem', replanOf: 'nada' }))).status, 400);
  assert.equal((await call(handler, jsonReq('/api/agent/plans', { goal: 'Organizar a viagem' }, { headers: { 'content-type': 'text/plain' } }))).status, 403);
  assert.equal((await call(handler, jsonReq('/api/agent/plans', '{ não é json'))).status, 400);
  assert.equal((await call(handler, jsonReq('/api/agent/plans', JSON.stringify({ goal: 'x'.repeat(20000) })))).status, 413);
  assert.equal((await call(handler, mockReq({ method: 'DELETE' }))).status, 404);
  assert.equal((await call(handler, jsonReq('/api/agent/plans/pl-ffffffffffff', { status: 'running' }, { method: 'PATCH' }))).status, 404);
  assert.equal((await call(handler, mockReq({ url: '/api/agent/plans/pl-ffffffffffff/extra' }))).status, 404);
});

test('arquivo corrompido responde 500 e não derruba os outros planos', async t => {
  const { dir, planner } = setup(t);
  const created = planner.create({ goal: 'Organizar a viagem de fim de ano' });
  planner.create({ goal: 'Revisar as anotações do projeto' });
  writeFileSync(join(dir, 'plans', `${created.plan.id}.json`), 'quebrado', 'utf8');

  const reloaded = createTaskPlanner({ dataDir: dir, onLoadError: () => {} });
  reloaded.load();
  const handler = createPlansHandler({ planner: reloaded, apiToken: TEST_TOKEN });

  const list = await call(handler, mockReq());
  assert.equal(list.status, 200);
  assert.equal(list.data.count, 1);
  assert.deepEqual(list.data.unavailable, [created.plan.id]);

  const fetched = await call(handler, mockReq({ url: `/api/agent/plans/${created.plan.id}` }));
  assert.equal(fetched.status, 500);

  const updated = await call(handler, jsonReq(`/api/agent/plans/${created.plan.id}`, { status: 'running' }, { method: 'PATCH' }));
  assert.equal(updated.status, 500);
});
