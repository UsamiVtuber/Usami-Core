import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_SCHEMAS } from '../src/agent-contracts.js';
import { createToolRegistry } from '../src/tool-registry.js';
import { createToolExecutor } from '../src/tool-executor.js';
import { createMemoryStore } from '../src/memory-store.js';
import { createMemorySearchTool } from '../src/memory-search-tool.js';

// O server.mjs cria os depósitos padrão na avaliação do módulo; o diretório é
// trocado ANTES do import para nenhum teste encostar em data/.
const scratchDir = mkdtempSync(join(tmpdir(), 'usami-tools-api-'));
process.env.USAMI_DATA_DIR = scratchDir;
process.env.USAMI_KEYS_FILE = process.env.USAMI_KEYS_FILE || join(scratchDir, 'no-keys.env');

const { createToolHandler } = await import('../server.mjs');

const TEST_TOKEN = 'token-de-teste';

function mockReq({ method = 'GET', url = '/api/agent/executions', headers = {}, body = '' } = {}) {
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

function untrustedTool() {
  return {
    schema: AGENT_SCHEMAS.tool,
    name: 'test.untrusted',
    version: '1.0.0',
    description: 'Ferramenta de teste que reprova a própria verificação.',
    origin: 'runtime',
    permissionLevel: 1,
    timeoutMs: 500,
    parameters: [{ name: 'text', type: 'string', required: true }],
    verify: () => false,
    execute: ({ text }) => ({ ok: true, text }),
  };
}

function seeded() {
  const dir = mkdtempSync(join(tmpdir(), 'usami-tools-api-seed-'));
  const memoryStore = createMemoryStore({ dataDir: dir });
  memoryStore.load();
  memoryStore.addCoreFact('Gosta de café com leite', 'preferences');
  memoryStore.upsertSummary('2026-11-10', 'Conversaram sobre café');

  const registry = createToolRegistry();
  assert.equal(registry.register(createMemorySearchTool({ memoryStore })).ok, true);
  assert.equal(registry.register(untrustedTool()).ok, true);
  const executor = createToolExecutor({ registry, dataDir: dir, onLoadError: () => {} });
  executor.load();
  return { dir, registry, executor, handler: createToolHandler({ registry, executor, apiToken: TEST_TOKEN }) };
}

test('ferramentas exigem token: sem ele 401, sem token no servidor 503', async () => {
  const { dir, registry, executor } = seeded();
  try {
    const handler = createToolHandler({ registry, executor, apiToken: TEST_TOKEN });
    const denied = await call(handler, mockReq({ headers: { 'x-usami-token': '' } }));
    assert.equal(denied.status, 401);
    const closed = await call(createToolHandler({ registry, executor, apiToken: null }), mockReq());
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

test('POST memory.search executa, verifica, grava histórico e GET lista', async () => {
  const { dir, handler } = seeded();
  try {
    const executed = await call(handler, jsonReq('/api/agent/tools/memory.search/execute', { arguments: { query: 'café' } }));
    assert.equal(executed.status, 200);
    assert.equal(executed.data.ok, true);
    assert.equal(executed.data.execution.schema, AGENT_SCHEMAS.execution);
    assert.equal(executed.data.execution.tool, 'memory.search');
    assert.equal(executed.data.execution.status, 'ok');
    assert.equal(executed.data.execution.verified, true);
    assert.equal(executed.data.execution.origin, 'agent');
    assert.equal(executed.data.execution.inputSummary, 'args: query');
    assert.equal(executed.data.result.count, 2);

    const disk = readFileSync(join(dir, 'executions.json'), 'utf8');
    assert.equal(disk.includes('café'), false, 'histórico guarda só nomes de argumentos');

    const history = await call(handler, mockReq());
    assert.equal(history.status, 200);
    assert.equal(history.data.count, 1);
    assert.equal(history.data.executions[0].id, executed.data.execution.id);

    const limited = await call(handler, mockReq({ url: '/api/agent/executions?limit=1' }));
    assert.equal(limited.data.count, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('origem explícita é aceita e chega ao registro', async () => {
  const { dir, handler } = seeded();
  try {
    const res = await call(handler, jsonReq('/api/agent/tools/memory.search/execute', { arguments: { query: 'café' }, origin: 'user' }));
    assert.equal(res.status, 200);
    assert.equal(res.data.execution.origin, 'user');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verify reprovado responde ok:false com execução failed', async () => {
  const { dir, handler } = seeded();
  try {
    const res = await call(handler, jsonReq('/api/agent/tools/test.untrusted/execute', { arguments: { text: 'oi' } }));
    assert.equal(res.status, 200);
    assert.equal(res.data.ok, false);
    assert.equal(res.data.execution.status, 'failed');
    assert.equal(res.data.execution.verified, false);
    assert.match(res.data.execution.reason, /verificação/);
    assert.equal('result' in res.data, false);

    const history = await call(handler, mockReq());
    assert.equal(history.data.count, 1);
    assert.equal(history.data.executions[0].status, 'failed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('validação da rota: ferramenta, argumentos, corpo, origem e Content-Type', async () => {
  const { dir, handler } = seeded();
  try {
    assert.equal((await call(handler, jsonReq('/api/agent/tools/test.none/execute', { arguments: {} }))).status, 404);
    assert.equal((await call(handler, jsonReq('/api/agent/tools/sem-namespace/execute', { arguments: {} }))).status, 404);
    assert.equal((await call(handler, jsonReq('/api/agent/executions', { arguments: {} }))).status, 404);

    const badArgs = await call(handler, jsonReq('/api/agent/tools/memory.search/execute', { arguments: { query: '   ' } }));
    assert.equal(badArgs.status, 400);
    assert.equal(badArgs.data.error, 'Argumentos inválidos.');
    assert.ok(badArgs.data.details.some(error => error.includes('arguments.query')));

    const missingArgs = await call(handler, jsonReq('/api/agent/tools/memory.search/execute', {}));
    assert.equal(missingArgs.status, 400);
    assert.ok(missingArgs.data.details.some(error => error.includes('obrigatório')));

    const unknownKey = await call(handler, jsonReq('/api/agent/tools/memory.search/execute', { arguments: { query: 'café' }, extra: true }));
    assert.equal(unknownKey.status, 400);
    assert.ok(unknownKey.data.details.some(error => error.includes('payload.extra')));

    const badOrigin = await call(handler, jsonReq('/api/agent/tools/memory.search/execute', { arguments: { query: 'café' }, origin: 'admin' }));
    assert.equal(badOrigin.status, 400);
    assert.match(badOrigin.data.error, /origin inválido/);

    assert.equal((await call(handler, jsonReq('/api/agent/tools/memory.search/execute', '{ não é json'))).status, 400);
    assert.equal((await call(handler, jsonReq('/api/agent/tools/memory.search/execute', '[]'))).status, 400);
    assert.equal((await call(handler, mockReq({ method: 'POST', url: '/api/agent/tools/memory.search/execute', body: '{}' }))).status, 403);
    assert.equal((await call(handler, jsonReq('/api/agent/tools/memory.search/execute', { arguments: { query: 'a'.repeat(17_000) } }))).status, 413);

    assert.equal((await call(handler, mockReq({ method: 'DELETE', url: '/api/agent/executions' }))).status, 404);
    assert.equal((await call(handler, mockReq({ method: 'GET', url: '/api/agent/tools/memory.search/execute' }))).status, 404);
    assert.equal((await call(handler, mockReq({ url: '/api/agent/executions?limit=0' }))).status, 400);
    assert.equal((await call(handler, mockReq({ url: '/api/agent/executions?limit=abc' }))).status, 400);
    assert.equal(existsSync(join(dir, 'executions.json')), false, 'nada executado, nada gravado');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
