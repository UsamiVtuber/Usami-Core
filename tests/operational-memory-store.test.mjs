import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOperationalMemoryStore } from '../src/operational-memory-store.js';
import { AGENT_SCHEMAS } from '../src/agent-contracts.js';

function seeded() {
  const dir = mkdtempSync(join(tmpdir(), 'usami-opmem-'));
  let clock = Date.parse('2026-11-11T12:00:00.000Z');
  const store = createOperationalMemoryStore({ dataDir: dir, now: () => clock });
  store.load();
  return {
    dir,
    store,
    path: join(dir, 'operational-memory.json'),
    advance: ms => { clock += ms; },
  };
}

const readDisk = path => JSON.parse(readFileSync(path, 'utf8'));

test('load sem arquivo não grava nada; o JSON nasce na primeira mutação', () => {
  const { dir, store, path } = seeded();
  try {
    assert.equal(existsSync(path), false, 'importar o app não pode criar arquivo em data/');
    assert.deepEqual(store.getAll().records, []);
    store.create({ kind: 'task', title: 'primeira tarefa' });
    assert.equal(existsSync(path), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cria registro com defaults, id op- e grava arquivo atômico com trilha', () => {
  const { dir, store, path } = seeded();
  try {
    const created = store.create({ kind: 'task', title: 'revisar PR do desktop', dueAt: '2026-11-12' });
    assert.equal(created.ok, true, JSON.stringify(created.errors));
    assert.match(created.record.id, /^op-[0-9a-f]{12}$/);
    assert.equal(created.record.schema, AGENT_SCHEMAS.operational);
    assert.equal(created.record.status, 'open');
    assert.equal(created.record.origin, 'user');
    assert.equal(created.record.relevance, 0.5);
    assert.equal(created.record.createdAt, '2026-11-11T12:00:00.000Z');

    const disk = readDisk(path);
    assert.equal(disk.version, 1);
    assert.equal(disk.records.length, 1);
    assert.equal(disk.records[0].id, created.record.id);
    assert.equal(disk.trail.length, 1);
    assert.equal(disk.trail[0].action, 'create');
    assert.equal(disk.trail[0].id, created.record.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('registro inválido é recusado e não altera o arquivo', () => {
  const { dir, store, path } = seeded();
  try {
    store.create({ kind: 'task', title: 'tarefa válida' });
    const before = readFileSync(path, 'utf8');

    const bad = store.create({ kind: 'event', title: 'x', relevance: 2 });
    assert.equal(bad.ok, false);
    assert.ok(bad.errors.some(error => error.includes('kind: deve ser um de')));
    assert.ok(bad.errors.some(error => error.includes('title: deve ter ao menos 3')));
    assert.ok(bad.errors.some(error => error.includes('relevance: deve ser número entre 0 e 1')));
    assert.equal(readFileSync(path, 'utf8'), before, 'arquivo permanece intacto');
    assert.equal(readDisk(path).records.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('consulta filtra por status, projeto, tipo e janela de dueAt', () => {
  const { dir, store } = seeded();
  try {
    const project = store.create({ kind: 'project', title: 'USAMI 2.0', status: 'in_progress' }).record;
    store.create({ kind: 'task', title: 'preparar briefing', status: 'open', dueAt: '2026-11-12', projectId: project.id });
    store.create({ kind: 'commitment', title: 'reunião com Ezequiel', status: 'done', dueAt: '2026-11-13T15:00:00.000Z', projectId: project.id });
    store.create({ kind: 'task', title: 'revisar contratos', status: 'open', dueAt: '2026-12-01' });

    assert.equal(store.list().length, 4);
    assert.equal(store.list({ status: 'open' }).length, 2);
    assert.equal(store.list({ kind: 'task' }).length, 2);
    assert.equal(store.list({ projectId: project.id }).length, 2);
    assert.equal(store.list({ from: '2026-11-12', to: '2026-11-13' }).length, 2);
    assert.equal(store.list({ from: '2026-11-12' }).length, 3, 'janela exclui registro sem dueAt');
    assert.equal(store.list({ limit: 2 }).length, 2);

    const ordered = store.list();
    assert.equal(ordered[0].title, 'preparar briefing', 'ordena por dueAt');
    assert.equal(ordered[ordered.length - 1].title, 'USAMI 2.0', 'sem dueAt vai para o fim');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('update altera apenas campos editáveis e registra a mudança na trilha', () => {
  const { dir, store, advance } = seeded();
  try {
    const created = store.create({ kind: 'task', title: 'revisar PR', dueAt: '2026-11-12' }).record;
    advance(60_000);
    const updated = store.update(created.id, { title: 'revisar PR do desktop', status: 'in_progress', dueAt: null });
    assert.equal(updated.ok, true, JSON.stringify(updated.errors));
    assert.equal(updated.record.title, 'revisar PR do desktop');
    assert.equal(updated.record.status, 'in_progress');
    assert.equal('dueAt' in updated.record, false, 'null remove o vencimento');
    assert.equal(updated.record.updatedAt, '2026-11-11T12:01:00.000Z');
    assert.deepEqual(updated.changed, ['title', 'status', 'dueAt']);

    const trail = store.trail();
    assert.equal(trail.length, 2);
    assert.equal(trail[1].action, 'update');
    assert.deepEqual(trail[1].changed, ['title', 'status', 'dueAt']);
    assert.equal(JSON.stringify(trail).includes('revisar PR do desktop'), false, 'trilha não guarda o texto do registro');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('update recusa campo fora do contrato e registro inexistente', () => {
  const { dir, store } = seeded();
  try {
    const created = store.create({ kind: 'task', title: 'revisar PR' }).record;
    const blocked = store.update(created.id, { kind: 'commitment' });
    assert.equal(blocked.ok, false);
    assert.ok(blocked.errors.some(error => error.includes('patch.kind: campo não editável')));

    const missing = store.update('op-000000000000', { status: 'done' });
    assert.equal(missing.ok, false);
    assert.equal(missing.notFound, true);

    const invalid = store.update(created.id, { relevance: 3 });
    assert.equal(invalid.ok, false);
    assert.ok(invalid.errors.some(error => error.includes('relevance: deve ser número entre 0 e 1')));
    assert.equal(store.get(created.id).relevance, 0.5, 'registro original permanece');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recarregar do disco preserva registros e trilha', () => {
  const { dir, store, advance } = seeded();
  try {
    const created = store.create({ kind: 'task', title: 'revisar PR' }).record;
    advance(30_000);
    store.update(created.id, { status: 'done' });

    const reloaded = createOperationalMemoryStore({ dataDir: dir });
    reloaded.load();
    assert.equal(reloaded.get(created.id).status, 'done');
    assert.equal(reloaded.trail().length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('arquivo corrompido ou com registro inválido lança sem sobrescrever', () => {
  const { dir, path } = seeded();
  try {
    writeFileSync(path, '{ isto não é json', 'utf8');
    const broken = createOperationalMemoryStore({ dataDir: dir });
    assert.throws(() => broken.load());
    assert.throws(() => broken.create({ kind: 'task', title: 'tarefa nova' }), /escrita recusada/);
    assert.equal(readFileSync(path, 'utf8'), '{ isto não é json', 'falha de load não pode virar sobrescrita');

    writeFileSync(path, JSON.stringify({
      version: 1,
      records: [{ schema: AGENT_SCHEMAS.operational, id: 'op-1', kind: 'task', title: 'x' }],
      trail: [],
    }), 'utf8');
    assert.throws(() => createOperationalMemoryStore({ dataDir: dir }).load(), /registro 0 inválido/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
