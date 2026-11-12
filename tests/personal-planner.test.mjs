import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOperationalMemoryStore } from '../src/operational-memory-store.js';
import { createMemoryStore } from '../src/memory-store.js';
import { createToolRegistry } from '../src/tool-registry.js';
import { createPermissionGate } from '../src/permission-gate.js';
import { createToolExecutor } from '../src/tool-executor.js';
import { createTaskPlanner } from '../src/task-planner.js';
import { createSkillCatalog } from '../src/skill-catalog.js';
import { createSkillManager } from '../src/skill-manager.js';
import { createAgentCore } from '../src/agent-core.js';
import {
  createPersonalPlannerTools,
  PLANNER_SKILL_ID,
  PLANNER_TOOLS,
  publishPersonalPlannerSkill,
} from '../src/personal-planner-skill.js';

// Isola USAMI_DATA_DIR antes de importar server.mjs para nunca encostar em data/.
const scratchServerDir = mkdtempSync(join(tmpdir(), 'usami-pp-srv-'));
process.env.USAMI_DATA_DIR = scratchServerDir;
process.env.USAMI_KEYS_FILE = process.env.USAMI_KEYS_FILE || join(scratchServerDir, 'no-keys.env');
test.after(() => rmSync(scratchServerDir, { recursive: true, force: true }));

const { createAgentTurnHandler, createChatHandler, createSkillsHandler } = await import('../server.mjs');

const TEST_TOKEN = 'token-personal-planner';

function setup(t, { nowIso = '2026-11-11T10:00:00.000Z' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'usami-personal-planner-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let clock = Date.parse(nowIso);
  const now = () => clock;

  const operationalStore = createOperationalMemoryStore({ dataDir: root, now });
  operationalStore.load();

  const taskPlanner = createTaskPlanner({ dataDir: root, now, onLoadError: () => {} });
  taskPlanner.load();

  const registry = createToolRegistry();
  for (const tool of createPersonalPlannerTools({ operationalStore, taskPlanner, now })) {
    const res = registry.register(tool);
    assert.equal(res.ok, true, res.errors?.join('; '));
  }

  const gate = createPermissionGate({ registry, dataDir: root, now, onLoadError: () => {} });
  gate.load();

  const executor = createToolExecutor({ registry, gate, dataDir: root, now, onLoadError: () => {} });
  executor.load();

  const published = publishPersonalPlannerSkill({ dataDir: root });
  assert.equal(published.published, true);

  const catalog = createSkillCatalog({ dataDir: root, registry, onLoadError: () => {} });
  catalog.load();

  const manager = createSkillManager({ catalog, gate, dataDir: root, now, onLoadError: () => {} });
  manager.load();

  const agentCore = createAgentCore({
    registry,
    executor,
    planner: taskPlanner,
    skillCatalog: catalog,
    now,
    onError: () => {},
  });

  return {
    root,
    operationalStore,
    taskPlanner,
    registry,
    gate,
    executor,
    catalog,
    manager,
    agentCore,
    advance: ms => { clock += ms; },
  };
}

function mockReq({ method = 'POST', url = '/api/agent/turn', headers = {}, body = '' } = {}) {
  const chunks = body ? [Buffer.from(body)] : [];
  return {
    method,
    url,
    headers: { host: '127.0.0.1:8787', 'content-type': 'application/json', 'x-usami-token': TEST_TOKEN, ...headers },
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

async function call(handler, req) {
  const res = mockRes();
  await handler(req, res);
  return { status: res.statusCode, data: JSON.parse(res.body) };
}

test('manifesto personal-planner publica ferramentas nível 2–3 e passa no teste isolado S8', async t => {
  const { root, catalog, manager, registry } = setup(t);

  const entry = catalog.get(PLANNER_SKILL_ID);
  assert.equal(entry.ok, true);
  assert.equal(entry.skill.valid, true);
  assert.equal(entry.skill.state, 'installed');
  assert.equal(entry.skill.maxPermissionLevel, 3);
  assert.deepEqual(entry.skill.manifest.permissions, [2, 3]);
  assert.deepEqual(entry.skill.manifest.tools, [...PLANNER_TOOLS]);
  assert.equal(entry.skill.activation.canActivate, true);

  for (const toolName of PLANNER_TOOLS) {
    const spec = registry.get(toolName);
    assert.ok(spec, `ferramenta ausente: ${toolName}`);
    assert.equal(spec.origin, 'skill');
    assert.equal(spec.permissionLevel >= 2 && spec.permissionLevel <= 3, true);
  }

  // Publicação é idempotente e não sobrescreve pacote existente.
  const secondPublish = publishPersonalPlannerSkill({ dataDir: root });
  assert.equal(secondPublish.published, false);
  assert.equal(secondPublish.alreadyPresent, true);

  // Desativar e reativar executa os testes declarados no manifesto dentro do sandbox S8.
  const disabled = await manager.disable(PLANNER_SKILL_ID);
  assert.equal(disabled.ok, true);
  assert.equal(disabled.skill.state, 'disabled');
  assert.equal(disabled.skill.activation.canActivate, false);

  const enabled = await manager.enable(PLANNER_SKILL_ID);
  assert.equal(enabled.ok, true, enabled.testResult?.summary);
  assert.equal(enabled.testResult.ok, true);
  assert.equal(enabled.skill.state, 'installed');
  assert.equal(enabled.skill.activation.canActivate, true);
});

test('upsert_task, priorização e detecção de conflito de horário persistem na memória operacional', async t => {
  const { operationalStore, executor } = setup(t);

  const a = await executor.execute('planner.upsert_task', {
    title: 'Reunião de alinhamento',
    kind: 'commitment',
    dueAt: '2026-11-12T14:00:00.000Z',
    priority: 2,
  });
  assert.equal(a.ok, true);
  assert.equal(a.result.action, 'created');
  assert.equal(a.result.hasConflicts, false);

  const b = await executor.execute('planner.upsert_task', {
    title: 'Consulta médica',
    kind: 'commitment',
    dueAt: '2026-11-12T14:30:00.000Z',
    priority: 1,
  });
  assert.equal(b.ok, true);
  assert.equal(b.result.hasConflicts, true);
  assert.equal(b.result.conflicts.length, 1);
  assert.equal(b.result.conflicts[0].overlapMinutes, 30);

  const low = await executor.execute('planner.upsert_task', {
    title: 'Arrumar pasta de downloads',
    kind: 'task',
    priority: 5,
  });
  assert.equal(low.ok, true);

  const overdue = await executor.execute('planner.upsert_task', {
    title: 'Enviar relatório atrasado',
    kind: 'task',
    dueAt: '2026-11-11T08:00:00.000Z',
    priority: 1,
  });
  assert.equal(overdue.ok, true);

  // Atualiza item conflitante para horário livre (16:00) e verifica desaparecimento do conflito.
  const prioritized = await executor.execute('planner.prioritize', { applyRelevance: true });
  assert.equal(prioritized.ok, true);
  assert.equal(prioritized.result.prioritized[0].id, overdue.result.record.id);
  assert.equal(prioritized.result.conflicts.length, 1);

  const moved = await executor.execute('planner.upsert_task', {
    id: b.result.record.id,
    dueAt: '2026-11-12T16:00:00.000Z',
  });
  assert.equal(moved.ok, true);
  assert.equal(moved.result.action, 'updated');
  assert.equal(moved.result.hasConflicts, false);
  assert.equal(operationalStore.get(b.result.record.id).dueAt, '2026-11-12T16:00:00.000Z');
  assert.equal(executor.list().every(item => item.status === 'ok' && item.verified === true), true);
});

test('fluxo ponta a ponta: "organize minha semana" devolve cronograma, conflitos, plano e respeita gate S5', async t => {
  const { executor, gate, taskPlanner, agentCore, catalog } = setup(t);

  // Semeia dois compromissos conflitantes e uma tarefa na memória operacional.
  await executor.execute('planner.upsert_task', {
    title: 'Daily com equipe',
    kind: 'commitment',
    dueAt: '2026-11-13T10:00:00.000Z',
    priority: 2,
  });
  await executor.execute('planner.upsert_task', {
    title: 'Call com cliente',
    kind: 'commitment',
    dueAt: '2026-11-13T10:20:00.000Z',
    priority: 1,
  });

  const turnRes = await agentCore.processTurn('Organize minha semana');
  assert.equal(turnRes.ok, true);
  assert.equal(turnRes.turn.route, 'plan');
  assert.equal(turnRes.turn.status, 'planned');
  assert.equal(turnRes.turn.tool, 'planner.schedule');
  assert.equal(turnRes.turn.conflicts.length, 1);
  assert.equal(turnRes.turn.conflicts[0].overlapMinutes, 40);
  assert.equal(turnRes.turn.tasks.length, 2);
  assert.equal(turnRes.turn.schedule.days.length, 1);
  assert.match(turnRes.turn.summary, /conflito\(s\) de horário/i);
  assert.ok(turnRes.turn.plan);
  assert.equal(taskPlanner.get(turnRes.turn.plan.id).ok, true);
  assert.ok(turnRes.turn.briefing);
  assert.equal(turnRes.turn.briefing.risks.some(r => /conflito/i.test(r)), true);
  assert.equal(turnRes.turn.execution.status, 'ok');
  assert.equal(turnRes.turn.execution.verified, true);

  // Gate S5: revogar planner.* bloqueia execução pelo AgentCore e registra recusa.
  gate.revoke('planner.*', 'manutenção do usuário');
  const blockedTurn = await agentCore.processTurn('Organize minha semana');
  assert.equal(blockedTurn.ok, true);
  assert.equal(blockedTurn.turn.route, 'plan');
  assert.equal(blockedTurn.turn.status, 'denied');
  assert.equal(blockedTurn.turn.execution.status, 'denied');

  // Restaura permissão e testa também desativação da skill via catálogo/manager.
  gate.restore('planner.*');
  const restored = await executor.execute('planner.schedule', {
    goal: 'Planejar semana com novas tarefas',
    tasks: [
      { title: 'Revisar entrega final', kind: 'task', dueAt: '2026-11-14', priority: 2 },
    ],
  });
  assert.equal(restored.ok, true);
  assert.equal(restored.result.persistedCount, 1);
  assert.equal(restored.result.tasks.length, 3);
  assert.equal(catalog.get(PLANNER_SKILL_ID).skill.activation.canActivate, true);
});

test('integração HTTP via server.mjs: manifesto publicado no startup, /api/agent/turn e /api/chat sem bloquear', async t => {
  const skillsHandler = createSkillsHandler({ apiToken: TEST_TOKEN });
  const skillRes = await call(skillsHandler, mockReq({ method: 'GET', url: '/api/agent/skills/personal-planner' }));
  assert.equal(skillRes.status, 200);
  assert.equal(skillRes.data.skill.id, 'personal-planner');
  assert.equal(skillRes.data.skill.activation.canActivate, true);

  const turnHandler = createAgentTurnHandler({ apiToken: TEST_TOKEN });
  const turnRes = await call(turnHandler, mockReq({
    url: '/api/agent/turn',
    body: JSON.stringify({ message: 'Organize minha semana' }),
  }));
  assert.equal(turnRes.status, 200);
  assert.equal(turnRes.data.ok, true);
  assert.equal(turnRes.data.turn.route, 'plan');
  assert.equal(turnRes.data.turn.status, 'planned');
  assert.equal(turnRes.data.turn.tool, 'planner.schedule');
  assert.equal(existsSync(join(scratchServerDir, 'skills', 'personal-planner', 'skill.json')), true);

  // /api/chat continua devolvendo o balão imediato com campo opcional agentTurn.
  const scratchChat = mkdtempSync(join(tmpdir(), 'usami-pp-chat-'));
  t.after(() => rmSync(scratchChat, { recursive: true, force: true }));
  const memoryStore = createMemoryStore({ dataDir: scratchChat });
  memoryStore.load();
  const { agentCore } = setup(t);
  const chatHandler = createChatHandler({
    agentCore,
    memoryStore,
    vaultSearch: async () => null,
    getKey: async () => 'fake-openrouter-key',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              reply: 'Já vou organizar a sua semana direitinho!',
              gesture: 'nod',
              actions: [],
              remember: null,
            }),
          },
        }],
      }),
    }),
  });

  const chatRes = await call(chatHandler, mockReq({
    url: '/api/chat',
    body: JSON.stringify({ message: 'Organize minha semana' }),
  }));
  assert.equal(chatRes.status, 200);
  assert.equal(chatRes.data.reply, 'Já vou organizar a sua semana direitinho!');
  assert.equal(chatRes.data.agentTurn.route, 'plan');
  assert.equal(chatRes.data.agentTurn.status, 'queued');

  await new Promise(resolve => setTimeout(resolve, 40));
  const settled = agentCore.getTurn(chatRes.data.agentTurn.id);
  assert.equal(settled.ok, true);
  assert.equal(settled.turn.status, 'planned');
  assert.equal(settled.turn.tool, 'planner.schedule');
});
