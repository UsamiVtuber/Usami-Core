import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_SCHEMAS } from '../src/agent-contracts.js';
import { createToolRegistry } from '../src/tool-registry.js';
import { createToolExecutor } from '../src/tool-executor.js';
import { createMemoryStore } from '../src/memory-store.js';
import { createMemorySearchTool } from '../src/memory-search-tool.js';
import { createPermissionGate } from '../src/permission-gate.js';

// O server.mjs cria os depósitos padrão na avaliação do módulo; o diretório é
// trocado ANTES do import para nenhum teste encostar em data/.
const scratchDir = mkdtempSync(join(tmpdir(), 'usami-perm-api-'));
process.env.USAMI_DATA_DIR = scratchDir;
process.env.USAMI_KEYS_FILE = process.env.USAMI_KEYS_FILE || join(scratchDir, 'no-keys.env');

const { createToolHandler } = await import('../server.mjs');

const TEST_TOKEN = 'token-de-teste';

function mockReq({ method = 'GET', url = '/api/agent/permissions', headers = {}, body = '' } = {}) {
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

function externalTool(calls) {
  return {
    schema: AGENT_SCHEMAS.tool,
    name: 'test.external',
    version: '1.0.0',
    description: 'Ferramenta de teste de nível 4.',
    origin: 'runtime',
    permissionLevel: 4,
    timeoutMs: 500,
    parameters: [{ name: 'text', type: 'string', required: true }],
    verify: result => result?.ok === true,
    execute: ({ text }) => {
      calls.external += 1;
      return { ok: true, text };
    },
  };
}

function seeded() {
  const dir = mkdtempSync(join(tmpdir(), 'usami-perm-api-seed-'));
  const memoryStore = createMemoryStore({ dataDir: dir });
  memoryStore.load();
  memoryStore.addCoreFact('Gosta de café com leite', 'preferences');

  const calls = { external: 0 };
  const registry = createToolRegistry();
  assert.equal(registry.register(createMemorySearchTool({ memoryStore })).ok, true);
  assert.equal(registry.register(externalTool(calls)).ok, true);

  const gate = createPermissionGate({ registry, dataDir: dir, onLoadError: () => {} });
  gate.load();
  const executor = createToolExecutor({ registry, gate, dataDir: dir, onLoadError: () => {} });
  executor.load();
  return { dir, registry, gate, executor, calls, handler: createToolHandler({ registry, executor, gate, apiToken: TEST_TOKEN }) };
}

async function confirm(handler, tool = 'test.external', confirmWord = 'confirmar') {
  return call(handler, jsonReq('/api/agent/confirmations', { tool, confirm: confirmWord }));
}

test('confirmações e permissões exigem token e borda de origem', async () => {
  const { dir, registry, executor, gate } = seeded();
  try {
    const handler = createToolHandler({ registry, executor, gate, apiToken: TEST_TOKEN });
    assert.equal((await call(handler, mockReq({ headers: { 'x-usami-token': '' } }))).status, 401);
    assert.equal((await call(createToolHandler({ registry, executor, gate, apiToken: null }), mockReq())).status, 503);

    const evil = await call(handler, mockReq({ headers: { host: 'evil.com', origin: 'http://evil.com' } }));
    assert.equal(evil.status, 403);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('confirmação exige palavra escrita, ferramenta nível 4 e devolve token de uso único', async () => {
  const { dir, handler } = seeded();
  try {
    const noWord = await confirm(handler, 'test.external', 'sim');
    assert.equal(noWord.status, 403);
    assert.match(noWord.data.error, /CONFIRMAR/);

    assert.equal((await confirm(handler, 'test.none')).status, 404);
    assert.equal((await confirm(handler, 'memory.search')).status, 400);

    const created = await confirm(handler);
    assert.equal(created.status, 201);
    assert.equal(created.data.ok, true);
    assert.match(created.data.confirmation.token, /^[0-9a-f]{32}$/);
    assert.equal(created.data.confirmation.tool, 'test.external');
    assert.equal(created.data.confirmation.permissionLevel, 4);
    assert.equal(Number.isNaN(Date.parse(created.data.confirmation.expiresAt)), false);

    const invalid = await confirm(handler, '');
    assert.equal(invalid.status, 400);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('execução de nível 4 é negada até a confirmação e passa uma única vez', async () => {
  const { dir, handler, calls } = seeded();
  try {
    const blocked = await call(handler, jsonReq('/api/agent/tools/test.external/execute', { arguments: { text: 'oi' } }));
    assert.equal(blocked.status, 403);
    assert.equal(blocked.data.ok, false);
    assert.equal(blocked.data.execution.status, 'denied');
    assert.match(blocked.data.execution.reason, /confirmação/);
    assert.equal(calls.external, 0);

    const created = await confirm(handler);
    const allowed = await call(handler, jsonReq('/api/agent/tools/test.external/execute', {
      arguments: { text: 'oi' },
      confirmation: created.data.confirmation.token,
    }));
    assert.equal(allowed.status, 200);
    assert.equal(allowed.data.ok, true);
    assert.equal(allowed.data.execution.status, 'ok');
    assert.equal(allowed.data.execution.verified, true);
    assert.equal(calls.external, 1);

    const replay = await call(handler, jsonReq('/api/agent/tools/test.external/execute', {
      arguments: { text: 'oi' },
      confirmation: created.data.confirmation.token,
    }));
    assert.equal(replay.status, 403);
    assert.equal(replay.data.execution.status, 'denied');
    assert.match(replay.data.execution.reason, /já usada/);

    const history = await call(handler, mockReq({ url: '/api/agent/executions' }));
    assert.deepEqual(history.data.executions.map(record => record.status), ['denied', 'ok', 'denied']);
    assert.equal(history.data.executions[0].tool, 'test.external');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('revogar nega execução e confirmação até restaurar', async () => {
  const { dir, handler } = seeded();
  try {
    const before = await call(handler, mockReq());
    assert.deepEqual(before.data.revocations, []);

    const revoked = await call(handler, jsonReq('/api/agent/permissions', {
      tool: 'test.external',
      action: 'revoke',
      reason: 'integração em manutenção',
    }));
    assert.equal(revoked.status, 200);
    assert.equal(revoked.data.revocations.length, 1);
    assert.equal(revoked.data.revocations[0].tool, 'test.external');
    assert.equal(revoked.data.revocations[0].reason, 'integração em manutenção');

    const listed = await call(handler, mockReq());
    assert.equal(listed.data.revocations.length, 1);

    const blocked = await call(handler, jsonReq('/api/agent/tools/test.external/execute', { arguments: { text: 'oi' } }));
    assert.equal(blocked.status, 403);
    assert.match(blocked.data.execution.reason, /revogada/);
    assert.equal((await confirm(handler)).status, 403);

    const restored = await call(handler, jsonReq('/api/agent/permissions', { tool: 'test.external', action: 'restore' }));
    assert.equal(restored.status, 200);
    assert.deepEqual(restored.data.revocations, []);

    const created = await confirm(handler);
    const allowed = await call(handler, jsonReq('/api/agent/tools/test.external/execute', {
      arguments: { text: 'oi' },
      confirmation: created.data.confirmation.token,
    }));
    assert.equal(allowed.status, 200);
    assert.equal(allowed.data.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('validação: campos desconhecidos, Content-Type, JSON, tamanho e action', async () => {
  const { dir, handler } = seeded();
  try {
    assert.equal((await call(handler, jsonReq('/api/agent/confirmations', { tool: 'test.external', confirm: 'confirmar', extra: 1 }))).status, 400);
    assert.equal((await call(handler, jsonReq('/api/agent/permissions', { tool: 'test.external', action: 'revoke', extra: 1 }))).status, 400);
    assert.equal((await call(handler, jsonReq('/api/agent/permissions', { tool: 'test.external', action: 'apagar' }))).status, 400);
    assert.equal((await call(handler, jsonReq('/api/agent/permissions', { action: 'revoke' }))).status, 400);

    assert.equal((await call(handler, mockReq({ method: 'POST', url: '/api/agent/confirmations', body: '{}' }))).status, 403);
    assert.equal((await call(handler, jsonReq('/api/agent/confirmations', '{ não é json'))).status, 400);
    assert.equal((await call(handler, jsonReq('/api/agent/confirmations', '[]'))).status, 400);

    const huge = JSON.stringify({ arguments: { query: 'a'.repeat(17_000) } });
    assert.equal((await call(handler, jsonReq('/api/agent/tools/memory.search/execute', huge))).status, 413);

    assert.equal((await call(handler, jsonReq('/api/agent/tools/memory.search/execute', { arguments: { query: 'café' }, confirmation: 42 }))).status, 400);

    assert.equal((await call(handler, mockReq({ url: '/api/agent/confirmations' }))).status, 404);
    assert.equal((await call(handler, mockReq({ method: 'DELETE', url: '/api/agent/permissions' }))).status, 404);
    assert.equal((await call(handler, mockReq({ url: '/api/agent/permissions?qualquer=1' }))).status, 200);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('nível 1 continua funcionando sem confirmação e não cria permissions.json', async () => {
  const { dir, handler, gate } = seeded();
  try {
    const res = await call(handler, jsonReq('/api/agent/tools/memory.search/execute', { arguments: { query: 'café' } }));
    assert.equal(res.status, 200);
    assert.equal(res.data.ok, true);
    assert.equal(res.data.execution.permissionLevel, 1);

    await confirm(handler);
    assert.deepEqual(gate.list().revocations, []);
    assert.equal(res.data.execution.status, 'ok');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
