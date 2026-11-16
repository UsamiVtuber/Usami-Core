import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyWorkspacePath,
  createMetaAgentTools,
  createMetaTransactionManager,
  validateDeclarativeFlow,
  WORKSPACE_FLOW_SCHEMA,
  WORKSPACE_ROUTE_SCHEMA,
} from '../src/meta-workspace.js';

test('Ring 0 protection: bloqueia server.mjs, src/, .env, vault/ e path traversal', () => {
  for (const forbidden of [
    'server.mjs',
    'src/agent-core.js',
    '.env',
    'vault/notes.md',
    '../outside.json',
    'flows/../../server.mjs',
  ]) {
    const res = classifyWorkspacePath(forbidden);
    assert.equal(res.allowed, false, `deveria bloquear ${forbidden}`);
  }

  const allowed = classifyWorkspacePath('flows/morning-briefing.flow.json');
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.ring, 'ring2');
});

test('validateDeclarativeFlow: aceita DAG válido e rejeita ciclos ou nós proibidos', () => {
  const valid = validateDeclarativeFlow({
    schema: WORKSPACE_FLOW_SCHEMA,
    id: 'briefing-flow',
    nodes: [
      { id: 'n1', type: 'trigger' },
      { id: 'n2', type: 'tool_call' },
      { id: 'n3', type: 'reply' },
    ],
    edges: [
      { from: 'n1', to: 'n2' },
      { from: 'n2', to: 'n3' },
    ],
  });
  assert.equal(valid.ok, true);
  assert.deepEqual(valid.order, ['n1', 'n2', 'n3']);

  const cyclic = validateDeclarativeFlow({
    schema: WORKSPACE_FLOW_SCHEMA,
    id: 'bad-cycle',
    nodes: [
      { id: 'a', type: 'trigger' },
      { id: 'b', type: 'condition' },
    ],
    edges: [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'a' },
    ],
  });
  assert.equal(cyclic.ok, false);
  assert.match(cyclic.errors.join(' '), /Ciclo/);

  const badNode = validateDeclarativeFlow({
    schema: WORKSPACE_FLOW_SCHEMA,
    id: 'bad-eval',
    nodes: [{ id: 'a', type: 'arbitrary_js_eval' }],
    edges: [],
  });
  assert.equal(badNode.ok, false);
});

test('MetaTransactionManager: snapshot + canary 60s + rollback automático em falha e commit saudável', () => {
  const dir = mkdtempSync(join(tmpdir(), 'usami-meta-ws-'));
  let fakeNow = 1_000_000;
  try {
    const manager = createMetaTransactionManager({
      workspaceRoot: dir,
      canaryWindowMs: 60_000,
      now: () => fakeNow,
    });
    const tools = createMetaAgentTools({ manager });
    const applyTool = tools.find(t => t.name === 'meta.workspace.apply');

    // Mutação 1: aplica flow + route válidos e promove após 60s saudáveis
    const res1 = applyTool.execute({
      description: 'adiciona fluxo matinal',
      files: [
        {
          path: 'flows/morning.json',
          content: {
            schema: WORKSPACE_FLOW_SCHEMA,
            id: 'morning',
            nodes: [
              { id: 'start', type: 'trigger' },
              { id: 'end', type: 'reply' },
            ],
            edges: [{ from: 'start', to: 'end' }],
          },
        },
        {
          path: 'routes/morning.json',
          content: {
            schema: WORKSPACE_ROUTE_SCHEMA,
            path: '/workspace/morning',
            method: 'POST',
            flowId: 'morning',
          },
        },
      ],
    });
    assert.equal(res1.status, 'canary');
    assert.ok(existsSync(join(dir, 'flows/morning.json')));

    fakeNow += 60_001;
    const promoted = manager.reportCanaryHealth(res1.txId, { ok: true });
    assert.equal(promoted.status, 'committed');

    // Mutação 2: altera overrides.json, falha no canary e faz rollback automático
    const res2 = applyTool.execute({
      description: 'ajusta override',
      files: [{ path: 'overrides.json', content: { maxSilenceMs: 400 } }],
    });
    assert.equal(res2.status, 'canary');
    assert.ok(existsSync(join(dir, 'overrides.json')));

    const rolled = manager.reportCanaryHealth(res2.txId, { ok: false, error: 'runtime_crash' });
    assert.equal(rolled.status, 'rolled_back');
    assert.equal(existsSync(join(dir, 'overrides.json')), false);
    assert.ok(readFileSync(join(dir, 'flows/morning.json'), 'utf8').includes('morning'));

    // Tentativa de tocar Ring 0 falha com E_RING0_PROTECTED
    assert.throws(
      () => applyTool.execute({ files: [{ path: 'server.mjs', content: '{}' }] }),
      err => err.code === 'E_RING0_PROTECTED',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
