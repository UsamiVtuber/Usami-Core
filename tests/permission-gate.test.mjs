import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_SCHEMAS } from '../src/agent-contracts.js';
import { createToolRegistry } from '../src/tool-registry.js';
import { createToolExecutor } from '../src/tool-executor.js';
import { createPermissionGate, DEFAULT_CONFIRMATION_TTL_MS } from '../src/permission-gate.js';

function makeTool({ name, permissionLevel = 1, onExecute } = {}) {
  return {
    schema: AGENT_SCHEMAS.tool,
    name,
    version: '1.0.0',
    description: `Ferramenta de teste ${name}.`,
    origin: 'runtime',
    permissionLevel,
    timeoutMs: 500,
    parameters: [{ name: 'text', type: 'string', required: true }],
    verify: result => result?.ok === true,
    execute: ({ text }) => {
      if (onExecute) onExecute();
      return { ok: true, text };
    },
  };
}

function setup({ ttlMs } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'usami-gate-'));
  const registry = createToolRegistry();
  const calls = { external: 0, external2: 0, read: 0 };
  assert.equal(registry.register(makeTool({ name: 'test.read', onExecute: () => { calls.read += 1; } })).ok, true);
  assert.equal(registry.register(makeTool({ name: 'test.external', permissionLevel: 4, onExecute: () => { calls.external += 1; } })).ok, true);
  assert.equal(registry.register(makeTool({ name: 'test.external2', permissionLevel: 4, onExecute: () => { calls.external2 += 1; } })).ok, true);
  let clock = Date.parse('2026-11-11T12:00:00.000Z');
  const gate = createPermissionGate({ registry, dataDir: dir, now: () => clock, ...(ttlMs ? { ttlMs } : {}), onLoadError: () => {} });
  gate.load();
  const executor = createToolExecutor({ registry, gate, dataDir: dir, now: () => clock, onLoadError: () => {} });
  executor.load();
  return { dir, registry, gate, executor, calls, advance: ms => { clock += ms; } };
}

test('load sem arquivo começa vazio e não cria data/permissions.json', () => {
  const { dir, gate } = setup();
  try {
    assert.deepEqual(gate.list().revocations, []);
    assert.equal(existsSync(join(dir, 'permissions.json')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('níveis 1–3 executam sem confirmação; nível 4 sem token é negado e registrado', async () => {
  const { dir, gate, executor, calls } = setup();
  try {
    const readable = await executor.execute('test.read', { text: 'oi' });
    assert.equal(readable.ok, true);
    assert.equal(gate.check({ name: 'test.read', permissionLevel: 1 }).ok, true);
    assert.equal(gate.authorize({ name: 'test.read', permissionLevel: 1 }, undefined).ok, true);

    const denied = await executor.execute('test.external', { text: 'apagar tudo' });
    assert.equal(denied.ok, false);
    assert.equal(denied.denied, true);
    assert.equal(denied.record.schema, AGENT_SCHEMAS.execution);
    assert.equal(denied.record.status, 'denied');
    assert.equal(denied.record.verified, false);
    assert.equal(denied.record.permissionLevel, 4);
    assert.match(denied.record.reason, /confirmação/);
    assert.equal(calls.external, 0, 'ferramenta negada não executa');
    assert.equal(executor.list()[0].status, 'denied');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('confirmação de uso único autoriza uma execução e não serve de novo', async () => {
  const { dir, gate, executor, calls } = setup();
  try {
    const created = gate.createConfirmation('test.external');
    assert.equal(created.ok, true);
    assert.match(created.confirmation.token, /^[0-9a-f]{32}$/);
    assert.equal(created.confirmation.tool, 'test.external');
    assert.equal(created.confirmation.permissionLevel, 4);
    assert.equal(
      created.confirmation.expiresAt,
      new Date(Date.parse('2026-11-11T12:00:00.000Z') + DEFAULT_CONFIRMATION_TTL_MS).toISOString(),
    );

    const allowed = await executor.execute('test.external', { text: 'oi' }, { confirmation: created.confirmation.token });
    assert.equal(allowed.ok, true);
    assert.equal(allowed.record.status, 'ok');
    assert.equal(calls.external, 1);

    const replay = await executor.execute('test.external', { text: 'oi' }, { confirmation: created.confirmation.token });
    assert.equal(replay.ok, false);
    assert.equal(replay.record.status, 'denied');
    assert.match(replay.record.reason, /já usada/);
    assert.equal(calls.external, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('confirmação expira pelo TTL e argumento inválido não queima o token', async () => {
  const { dir, gate, executor, advance, calls } = setup({ ttlMs: 5000 });
  try {
    const created = gate.createConfirmation('test.external');
    const invalidArgs = await executor.execute('test.external', { text: '' }, { confirmation: created.confirmation.token });
    assert.equal(invalidArgs.ok, false);
    assert.equal(invalidArgs.invalidArguments, true);

    advance(5001);
    const expired = await executor.execute('test.external', { text: 'oi' }, { confirmation: created.confirmation.token });
    assert.equal(expired.ok, false);
    assert.equal(expired.record.status, 'denied');
    assert.match(expired.record.reason, /expirada/);

    const fresh = gate.createConfirmation('test.external');
    const allowed = await executor.execute('test.external', { text: 'oi' }, { confirmation: fresh.confirmation.token });
    assert.equal(allowed.ok, true);
    assert.equal(calls.external, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('confirmação emitida para outra ferramenta é recusada e consumida', async () => {
  const { dir, gate, executor, calls } = setup();
  try {
    const created = gate.createConfirmation('test.external');
    const wrongTool = await executor.execute('test.external2', { text: 'oi' }, { confirmation: created.confirmation.token });
    assert.equal(wrongTool.ok, false);
    assert.equal(wrongTool.record.status, 'denied');
    assert.match(wrongTool.record.reason, /outra ferramenta/);

    const reused = await executor.execute('test.external', { text: 'oi' }, { confirmation: created.confirmation.token });
    assert.equal(reused.ok, false);
    assert.match(reused.record.reason, /já usada/);
    assert.equal(calls.external, 0);
    assert.equal(calls.external2, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('revogação vence confirmação válida; restore volta a permitir', async () => {
  const { dir, gate, executor, calls } = setup();
  try {
    const created = gate.createConfirmation('test.external');
    const revoked = gate.revoke('test.external', 'teste de revogação');
    assert.equal(revoked.ok, true);
    assert.equal(revoked.revocation.reason, 'teste de revogação');

    const blocked = await executor.execute('test.external', { text: 'oi' }, { confirmation: created.confirmation.token });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.record.status, 'denied');
    assert.match(blocked.record.reason, /revogada/);
    assert.equal(gate.createConfirmation('test.external').denied, true);
    assert.equal(calls.external, 0);

    assert.equal(gate.restore('test.external').removed, true);
    const fresh = gate.createConfirmation('test.external');
    assert.equal(fresh.ok, true);
    const allowed = await executor.execute('test.external', { text: 'oi' }, { confirmation: fresh.confirmation.token });
    assert.equal(allowed.ok, true);
    assert.equal(calls.external, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('revogação por integração (namespace.*) atinge todas as ferramentas do namespace', async () => {
  const { dir, gate, executor } = setup();
  try {
    assert.equal(gate.revoke('test.*', 'integração desligada').ok, true);
    assert.equal(gate.check({ name: 'test.read', permissionLevel: 1 }).ok, false);
    assert.equal(gate.check({ name: 'test.external', permissionLevel: 4 }).ok, false);
    const denied = await executor.execute('test.read', { text: 'oi' });
    assert.equal(denied.denied, true);
    assert.match(denied.record.reason, /test\.\*/);

    assert.equal(gate.revoke('memory.search').ok, true);
    assert.equal(gate.check({ name: 'memory.search', permissionLevel: 1 }).ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('revogações persistem no disco e sobrevivem a um novo gate', () => {
  const { dir, registry, gate } = setup();
  try {
    gate.revoke('test.external', 'motivo curto');
    const filePath = join(dir, 'permissions.json');
    const stored = JSON.parse(readFileSync(filePath, 'utf8'));
    assert.equal(stored.version, 1);
    assert.equal(stored.revocations[0].tool, 'test.external');
    assert.equal(stored.revocations[0].reason, 'motivo curto');

    const reloaded = createPermissionGate({ registry, dataDir: dir, onLoadError: () => {} });
    reloaded.load();
    assert.equal(reloaded.list().revocations.length, 1);
    assert.equal(reloaded.check({ name: 'test.external', permissionLevel: 4 }).ok, false);

    reloaded.restore('test.external');
    const cleared = createPermissionGate({ registry, dataDir: dir, onLoadError: () => {} });
    cleared.load();
    assert.deepEqual(cleared.list().revocations, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('revoke valida escopo e motivo; repetição é idempotente', () => {
  const { dir, gate } = setup();
  try {
    assert.equal(gate.revoke('sem-namespace').ok, false);
    assert.equal(gate.revoke('test.external', 42).ok, false);

    const first = gate.revoke('test.external');
    assert.equal(first.ok, true);
    assert.equal(first.unchanged, false);
    const again = gate.revoke('test.external', 'outro motivo');
    assert.equal(again.ok, true);
    assert.equal(again.unchanged, true);
    assert.equal(gate.list().revocations[0].reason, undefined, 'motivo original preservado');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createConfirmation recusa ferramenta desconhecida e nível sem confirmação', () => {
  const { dir, gate } = setup();
  try {
    assert.equal(gate.createConfirmation('test.none').notFound, true);
    const notRequired = gate.createConfirmation('test.read');
    assert.equal(notRequired.ok, false);
    assert.equal(notRequired.notRequired, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('arquivo de permissões inválido falha fechado: nega execuções e recusa escrita', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'usami-gate-corrupt-'));
  try {
    const filePath = join(dir, 'permissions.json');
    writeFileSync(filePath, '{ não é json', 'utf8');
    const registry = createToolRegistry();
    assert.equal(registry.register(makeTool({ name: 'test.read' })).ok, true);
    const gate = createPermissionGate({ registry, dataDir: dir, onLoadError: () => {} });
    assert.throws(() => gate.load(), /JSON|Unexpected/);
    assert.equal(readFileSync(filePath, 'utf8'), '{ não é json', 'arquivo original preservado');

    const executor = createToolExecutor({ registry, gate, dataDir: dir, onLoadError: () => {} });
    executor.load();
    const denied = await executor.execute('test.read', { text: 'oi' });
    assert.equal(denied.denied, true);
    assert.match(denied.record.reason, /permissões indisponíveis/);
    assert.throws(() => gate.revoke('test.read'), /escrita recusada/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('executor sem gate nega nível 4 em vez de executar sem confirmação', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'usami-gate-nogate-'));
  try {
    const registry = createToolRegistry();
    let executed = 0;
    registry.register(makeTool({ name: 'test.external', permissionLevel: 4, onExecute: () => { executed += 1; } }));
    const executor = createToolExecutor({ registry, dataDir: dir, onLoadError: () => {} });
    executor.load();

    const denied = await executor.execute('test.external', { text: 'oi' });
    assert.equal(denied.ok, false);
    assert.equal(denied.record.status, 'denied');
    assert.match(denied.record.reason, /gate de permissões indisponível/);
    assert.equal(executed, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
