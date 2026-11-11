import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_SCHEMAS } from '../src/agent-contracts.js';
import { createToolRegistry, validateToolArguments } from '../src/tool-registry.js';
import { createToolExecutor } from '../src/tool-executor.js';
import { createMemoryStore } from '../src/memory-store.js';
import { createMemorySearchTool } from '../src/memory-search-tool.js';

function echoTool(overrides = {}) {
  return {
    schema: AGENT_SCHEMAS.tool,
    name: 'test.echo',
    version: '1.0.0',
    description: 'Ferramenta de teste que ecoa o texto.',
    origin: 'runtime',
    permissionLevel: 1,
    timeoutMs: 500,
    parameters: [{ name: 'text', type: 'string', required: true }],
    verify: result => result?.ok === true,
    execute: ({ text }) => ({ ok: true, text }),
    ...overrides,
  };
}

function setup({ limit } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'usami-tools-'));
  const registry = createToolRegistry();
  let clock = Date.parse('2026-11-11T12:00:00.000Z');
  const executor = createToolExecutor({ registry, dataDir: dir, now: () => clock, limit, onLoadError: () => {} });
  executor.load();
  return { dir, registry, executor, advance: ms => { clock += ms; } };
}

test('registry registra spec válida, recusa duplicata e spec sem execute', () => {
  const registry = createToolRegistry();
  const created = registry.register(echoTool());
  assert.equal(created.ok, true, JSON.stringify(created.errors));
  assert.equal(registry.has('test.echo'), true);
  assert.equal(registry.get('test.echo').name, 'test.echo');

  assert.equal(registry.register(echoTool()).ok, false, 'nome duplicado');
  const noExecute = echoTool({ name: 'test.spec', execute: undefined });
  const rejected = registry.register(noExecute);
  assert.equal(rejected.ok, false);
  assert.ok(rejected.errors.some(error => error.includes('execute')));

  const listed = registry.list()[0];
  assert.equal('execute' in listed, false, 'list não vaza funções');
  assert.equal('verify' in listed, false);
});

test('validateToolArguments cobre obrigatório, tipo, enum, vazio e tamanho', () => {
  const tool = echoTool({
    parameters: [
      { name: 'text', type: 'string', required: true },
      { name: 'mode', type: 'string', required: false, enum: ['fast', 'slow'] },
      { name: 'count', type: 'number', required: false },
    ],
  });
  assert.equal(validateToolArguments(tool, { text: 'oi' }).ok, true);
  assert.equal(validateToolArguments(tool, { text: 'oi', mode: 'fast' }).ok, true);
  assert.equal(validateToolArguments(tool, { text: 'oi', mode: 'turbo' }).ok, false);
  assert.equal(validateToolArguments(tool, { text: 'oi', count: '2' }).ok, false);
  assert.equal(validateToolArguments(tool, {}).ok, false);
  assert.equal(validateToolArguments(tool, { text: '   ' }).ok, false);
  assert.equal(validateToolArguments(tool, { text: 'a'.repeat(501) }).ok, false);
  assert.equal(validateToolArguments(tool, { text: 'oi', extra: 1 }).ok, false);
  assert.equal(validateToolArguments(tool, []).ok, false);
});

test('executa ferramenta, aprova verify e grava execução sem valores sensíveis', () => {
  const { dir, registry, executor } = setup();
  try {
    registry.register(echoTool());
    const text = 'segredo do usuário';
    const outcome = executor.execute('test.echo', { text });
    return outcome.then(result => {
      assert.equal(result.ok, true);
      assert.equal(result.result.text, text);
      assert.equal(result.record.schema, AGENT_SCHEMAS.execution);
      assert.match(result.record.id, /^ex-[0-9a-f]{12}$/);
      assert.equal(result.record.status, 'ok');
      assert.equal(result.record.verified, true);
      assert.equal(result.record.tool, 'test.echo');
      assert.equal(result.record.permissionLevel, 1);
      assert.equal(result.record.origin, 'agent');
      assert.equal(result.record.durationMs, 0);

      const disk = readFileSync(join(dir, 'executions.json'), 'utf8');
      assert.equal(JSON.parse(disk).executions.length, 1);
      assert.equal(disk.includes(text), false, 'histórico guarda só nomes de argumentos');
      assert.equal(result.record.inputSummary, 'args: text');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verify reprovado vira failed sem devolver resultado', async () => {
  const { dir, registry, executor } = setup();
  try {
    registry.register(echoTool({ name: 'test.untrusted', verify: () => false }));
    const outcome = await executor.execute('test.untrusted', { text: 'oi' });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.result, undefined);
    assert.equal(outcome.record.status, 'failed');
    assert.equal(outcome.record.verified, false);
    assert.match(outcome.record.reason, /verificação/);
    assert.equal(executor.getAll().executions.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('erro e timeout viram registros failed/timeout', async () => {
  const { dir, registry, executor } = setup();
  try {
    registry.register(echoTool({ name: 'test.boom', execute: () => { throw new Error('quebrou de propósito'); } }));
    const failed = await executor.execute('test.boom', { text: 'oi' });
    assert.equal(failed.ok, false);
    assert.equal(failed.record.status, 'failed');
    assert.match(failed.record.reason, /quebrou de propósito/);

    registry.register(echoTool({ name: 'test.hang', timeoutMs: 100, execute: () => new Promise(() => {}) }));
    const timedOut = await executor.execute('test.hang', { text: 'oi' });
    assert.equal(timedOut.ok, false);
    assert.equal(timedOut.record.status, 'timeout');
    assert.match(timedOut.record.reason, /tempo esgotado/);

    const executions = executor.list();
    assert.deepEqual(executions.map(record => record.status), ['timeout', 'failed']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('argumento inválido e ferramenta desconhecida não executam nem gravam', async () => {
  const { dir, registry, executor } = setup();
  try {
    registry.register(echoTool());
    const badArgs = await executor.execute('test.echo', { text: '' });
    assert.equal(badArgs.ok, false);
    assert.equal(badArgs.invalidArguments, true);
    const missing = await executor.execute('test.none', { text: 'oi' });
    assert.equal(missing.notFound, true);
    assert.equal(executor.getAll().executions.length, 0);
    assert.equal(existsSync(join(dir, 'executions.json')), false, 'nada executado, nada gravado');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('histórico respeita o teto, lista mais recente primeiro e recarrega do disco', async () => {
  const { dir, registry, executor, advance } = setup({ limit: 2 });
  try {
    registry.register(echoTool());
    for (const text of ['um', 'dois', 'três']) {
      const outcome = await executor.execute('test.echo', { text });
      assert.equal(outcome.ok, true);
      advance(1000);
    }
    assert.equal(executor.getAll().executions.length, 2);
    assert.deepEqual(executor.list().map(record => record.id), executor.getAll().executions.map(record => record.id).reverse());

    const reloaded = createToolExecutor({ registry, dataDir: dir, onLoadError: () => {} });
    reloaded.load();
    assert.equal(reloaded.getAll().executions.length, 2);
    assert.equal(reloaded.getAll().executions[1].finishedAt, '2026-11-11T12:00:02.000Z');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('arquivo ilegível é preservado ao lado e o executor começa vazio', () => {
  const { dir } = setup();
  try {
    const filePath = join(dir, 'executions.json');
    writeFileSync(filePath, '{ não é json', 'utf8');
    const registry = createToolRegistry();
    const executor = createToolExecutor({ registry, dataDir: dir, now: () => Date.parse('2026-11-11T13:00:00.000Z'), onLoadError: () => {} });
    executor.load();
    assert.equal(executor.getAll().executions.length, 0);
    assert.equal(existsSync(filePath), false);
    const quarantined = readdirSync(dir).filter(name => name.startsWith('executions.json.corrupt-'));
    assert.equal(quarantined.length, 1);
    assert.equal(readFileSync(join(dir, quarantined[0]), 'utf8'), '{ não é json');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('memory.search busca seções, recentes e resumos sem caixa/acento', () => {
  const dir = mkdtempSync(join(tmpdir(), 'usami-mem-search-'));
  try {
    const memoryStore = createMemoryStore({ dataDir: dir, now: () => '2026-11-11T12:00:00.000Z' });
    memoryStore.load();
    memoryStore.addCoreFact('Gosta de café com leite', 'preferences');
    memoryStore.addCoreFact('Tem um gato chamado Mochi', 'relationship');
    memoryStore.addRecentFact('Compromisso amanhã às 15h', 7, 'other');
    memoryStore.upsertSummary('2026-11-10', 'Conversaram sobre café e gatos');

    const tool = createMemorySearchTool({ memoryStore });
    const result = tool.execute({ query: 'cafe' });
    assert.equal(result.count, 2);
    assert.equal(result.results.some(item => item.source === 'section'), true);
    assert.equal(result.results.some(item => item.source === 'summary'), true);
    assert.equal(tool.verify(result), true);

    const andTerms = tool.execute({ query: 'gato mochi' });
    assert.equal(andTerms.count, 1);
    assert.match(andTerms.results[0].text, /Mochi/);

    assert.equal(tool.execute({ query: 'compromisso', limit: 1 }).count, 1);
    assert.throws(() => tool.execute({ query: 'cafe', limit: 0 }), /limit/);
    assert.equal(tool.verify({ query: 'x', results: [{ text: '' }], count: 1 }), false);
    assert.equal(tool.verify(null), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
