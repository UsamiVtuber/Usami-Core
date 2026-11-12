import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_SCHEMAS } from '../src/agent-contracts.js';
import { createOperationalMemoryStore } from '../src/operational-memory-store.js';
import { createToolRegistry } from '../src/tool-registry.js';
import { createPermissionGate } from '../src/permission-gate.js';
import { createToolExecutor } from '../src/tool-executor.js';
import { createTaskPlanner } from '../src/task-planner.js';
import { createSkillCatalog } from '../src/skill-catalog.js';
import { defaultRunSkillTests } from '../src/skill-manager.js';
import { createAgentCore } from '../src/agent-core.js';
import {
  BRIEFING_SCHEMA,
  createDailyBriefingService,
  createDailyBriefingTool,
  DAILY_BRIEFING_SKILL_ID,
  publishDailyBriefingSkill,
} from '../src/daily-briefing-skill.js';

// Isola USAMI_DATA_DIR e USAMI_KEYS_FILE antes de importar server.mjs para nunca encostar em data/.
const scratchServerDir = mkdtempSync(join(tmpdir(), 'usami-briefing-srv-'));
process.env.USAMI_DATA_DIR = scratchServerDir;
process.env.USAMI_KEYS_FILE = process.env.USAMI_KEYS_FILE || join(scratchServerDir, 'no-keys.env');
test.after(() => rmSync(scratchServerDir, { recursive: true, force: true }));

const { createBriefingHandler } = await import('../server.mjs');

const TEST_TOKEN = 'token-briefing-teste';

function mockReq({ method = 'GET', url = '/api/agent/briefing', headers = {} } = {}) {
  return {
    method,
    url,
    headers: { host: '127.0.0.1:8787', 'x-usami-token': TEST_TOKEN, ...headers },
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

function setupRuntime(t, { isoNow = '2026-11-11T15:00:00.000Z', rewriteWithLlm = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'usami-s13-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const nowMs = Date.parse(isoNow);
  const now = () => nowMs;

  const operationalStore = createOperationalMemoryStore({ dataDir: dir, now });
  operationalStore.load();
  const taskPlanner = createTaskPlanner({ dataDir: dir, now });
  taskPlanner.load();
  const registry = createToolRegistry();
  const gate = createPermissionGate({ registry, dataDir: dir, now });
  gate.load();
  const executor = createToolExecutor({ registry, gate, dataDir: dir, now });
  executor.load();

  publishDailyBriefingSkill({ dataDir: dir });
  const tool = createDailyBriefingTool({
    operationalStore,
    taskPlanner,
    toolExecutor: executor,
    rewriteWithLlm,
    now,
  });
  const reg = registry.register(tool);
  assert.equal(reg.ok, true);

  const skillCatalog = createSkillCatalog({ dataDir: dir, registry });
  skillCatalog.load();

  const core = createAgentCore({
    registry,
    executor,
    planner: taskPlanner,
    skillCatalog,
    now,
  });

  const handler = createBriefingHandler({
    toolExecutor: executor,
    skillCatalog,
    apiToken: TEST_TOKEN,
  });

  return {
    dir,
    now,
    operationalStore,
    taskPlanner,
    registry,
    gate,
    executor,
    skillCatalog,
    core,
    handler,
    tool,
  };
}

test('manifesto daily-briefing tem permissão nível 1, ativa no catálogo e passa no teste isolado', async t => {
  const ctx = setupRuntime(t);
  const found = ctx.skillCatalog.get(DAILY_BRIEFING_SKILL_ID);
  assert.equal(found.ok, true);
  assert.equal(found.skill.valid, true);
  assert.equal(found.skill.state, 'installed');
  assert.equal(found.skill.maxPermissionLevel, 1);
  assert.equal(found.skill.activation.canActivate, true);
  assert.deepEqual(found.skill.manifest.tools, ['briefing.build']);
  assert.deepEqual(found.skill.manifest.tests.files, ['test/daily-briefing.test.mjs']);

  // Republica quando já existe não sobrescreve customizações nem manifesto.
  const manifestPath = join(ctx.dir, 'skills', DAILY_BRIEFING_SKILL_ID, 'skill.json');
  assert.equal(existsSync(manifestPath), true);
  const again = publishDailyBriefingSkill({ dataDir: ctx.dir });
  assert.equal(again.published, false);
  assert.equal(again.alreadyPresent, true);

  const rawManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const sandboxResult = await defaultRunSkillTests({
    skillDir: join(ctx.dir, 'skills', DAILY_BRIEFING_SKILL_ID),
    manifest: rawManifest,
  });
  assert.equal(sandboxResult.ok, true);
});

test('base vazia gera briefing sem inventar compromissos nem tarefas via tool e GET /api/agent/briefing', async t => {
  const ctx = setupRuntime(t);

  const res = await call(ctx.handler, mockReq());
  assert.equal(res.status, 200);
  assert.equal(res.data.ok, true);
  assert.equal(res.data.execution.tool, 'briefing.build');
  assert.equal(res.data.execution.verified, true);
  assert.equal(res.data.execution.permissionLevel, 1);

  const briefing = res.data.briefing;
  assert.equal(briefing.schema, BRIEFING_SCHEMA);
  assert.equal(briefing.date, '2026-11-11');
  assert.equal(briefing.empty, true);
  assert.deepEqual(briefing.commitments, []);
  assert.deepEqual(briefing.priorityTasks, []);
  assert.deepEqual(briefing.projects, []);
  assert.equal(briefing.pending.totalCount, 0);
  assert.equal(briefing.narrativeSource, 'deterministic');
  assert.match(briefing.text, /Base operacional vazia/);
});

test('base parcial lista apenas dados existentes sem preencher compromissos vazios', async t => {
  const ctx = setupRuntime(t);
  ctx.operationalStore.create({
    kind: 'task',
    title: 'Revisar notas de estudo',
    status: 'open',
    relevance: 0.6,
  });

  const outcome = await ctx.executor.execute('briefing.build', {}, { origin: 'user' });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.result.empty, false);
  assert.equal(outcome.result.commitments.length, 0);
  assert.equal(outcome.result.priorityTasks.length, 1);
  assert.equal(outcome.result.priorityTasks[0].title, 'Revisar notas de estudo');
  assert.equal(outcome.result.pending.unscheduledTasks.length, 1);
  assert.match(outcome.result.text, /Nenhum compromisso registrado/);
  assert.match(outcome.result.text, /Revisar notas de estudo/);
});

test('base completa com pendências lista compromissos, tarefas, planos, falhas e projetos sem teto de 220 caracteres', async t => {
  const ctx = setupRuntime(t);

  const proj = ctx.operationalStore.create({
    kind: 'project',
    title: 'Usami Core Release',
    status: 'in_progress',
    dueAt: '2026-11-20',
    relevance: 0.9,
  });
  ctx.operationalStore.create({
    kind: 'task',
    title: 'Entregar relatório trimestral de métricas para a equipe',
    status: 'open',
    dueAt: '2026-11-10T18:00:00.000Z',
    projectId: proj.record.id,
    relevance: 0.85,
  });
  ctx.operationalStore.create({
    kind: 'task',
    title: 'Desbloquear acesso ao ambiente de testes',
    status: 'blocked',
    projectId: proj.record.id,
    relevance: 0.7,
  });
  ctx.operationalStore.create({
    kind: 'commitment',
    title: 'Reunião de revisão com design',
    status: 'open',
    dueAt: '2026-11-11T17:00:00.000Z',
    relevance: 0.8,
  });
  ctx.operationalStore.create({
    kind: 'task',
    title: 'Tarefa concluída não deve entrar como pendente',
    status: 'done',
    projectId: proj.record.id,
    relevance: 0.9,
  });

  ctx.taskPlanner.create({ goal: 'Publicar pacote S13 no repositório' });

  // Registra uma execução negada real para aparecer nas pendências.
  const extReg = ctx.registry.register({
    schema: AGENT_SCHEMAS.tool,
    name: 'external.notify',
    version: '1.0.0',
    description: 'Envio externo requer confirmação',
    origin: 'runtime',
    permissionLevel: 4,
    timeoutMs: 1000,
    parameters: [],
    verify: () => true,
    execute: () => ({ ok: true }),
  });
  assert.equal(extReg.ok, true);
  const denied = await ctx.executor.execute('external.notify', {}, { origin: 'agent' });
  assert.equal(denied.ok, false);
  assert.equal(denied.record.status, 'denied');

  const res = await call(ctx.handler, mockReq({ url: '/api/agent/briefing?date=2026-11-11' }));
  assert.equal(res.status, 200);
  const b = res.data.briefing;

  assert.equal(b.empty, false);
  assert.equal(b.commitments.length, 1);
  assert.equal(b.commitments[0].onTargetDate, true);
  assert.equal(b.priorityTasks.length, 2);
  assert.equal(b.priorityTasks[0].overdue, true);
  assert.equal(b.projects.length, 1);
  assert.equal(b.projects[0].openTasksCount, 2);
  assert.equal(b.projects[0].doneTasksCount, 1);
  assert.equal(b.pending.overdueRecords.length, 1);
  assert.equal(b.pending.blockedRecords.length, 1);
  assert.equal(b.pending.plans.length, 1);
  assert.equal(b.pending.executionAlerts.length, 1);
  assert.ok(b.text.length > 220, 'briefing não fica preso ao teto de 220 caracteres do chat');
  assert.match(b.text, /ATRASAD/);
  assert.match(b.text, /BLOQUEAD/);
  assert.match(b.text, /Usami Core Release/);
  assert.match(b.text, /Publicar pacote S13/);
  assert.doesNotMatch(b.text, /Tarefa concluída não deve entrar como pendente/);
});

test('LLM opcional só altera a redação mantendo dados determinísticos e faz fallback em erro', async t => {
  const operationalRecords = [
    {
      id: 'op-111111111111',
      kind: 'commitment',
      title: 'Daily às 16h',
      status: 'open',
      dueAt: '2026-11-11T16:00:00.000Z',
      relevance: 0.8,
    },
  ];
  const fakeStore = { list: () => operationalRecords };

  const llmService = createDailyBriefingService({
    operationalStore: fakeStore,
    now: () => Date.parse('2026-11-11T10:00:00.000Z'),
    rewriteWithLlm: async ({ date, briefing }) => `Resumo amigável de ${date}: hoje você tem ${briefing.commitments[0].title}.`,
  });

  const withLlm = await llmService.build({ useLlm: true });
  assert.equal(withLlm.narrativeSource, 'llm');
  assert.equal(withLlm.commitments.length, 1);
  assert.match(withLlm.text, /Resumo amigável de 2026-11-11/);
  assert.match(withLlm.deterministicText, /Briefing diário \(2026-11-11\)/);

  const brokenLlmService = createDailyBriefingService({
    operationalStore: fakeStore,
    now: () => Date.parse('2026-11-11T10:00:00.000Z'),
    rewriteWithLlm: async () => { throw new Error('provedor indisponível'); },
  });

  const fallback = await brokenLlmService.build({ useLlm: true });
  assert.equal(fallback.narrativeSource, 'deterministic');
  assert.equal(fallback.llmFallback, true);
  assert.equal(fallback.text, fallback.deterministicText);
});

test('AgentCore encaminha pedido de briefing para briefing.build e registra execução verificada', async t => {
  const ctx = setupRuntime(t);
  ctx.operationalStore.create({
    kind: 'task',
    title: 'Preparar pauta da semana',
    status: 'open',
    dueAt: '2026-11-11T18:00:00.000Z',
    relevance: 0.75,
  });

  const outcome = await ctx.core.processTurn('Qual é o meu briefing do dia?');
  assert.equal(outcome.ok, true);
  assert.equal(outcome.turn.intent.kind, 'operational');
  assert.equal(outcome.turn.route, 'tool');
  assert.equal(outcome.turn.status, 'executed');
  assert.equal(outcome.turn.execution.tool, 'briefing.build');
  assert.equal(outcome.turn.execution.verified, true);
  assert.match(outcome.turn.result.text, /Briefing diário \(2026-11-11\)/);
  assert.match(outcome.turn.result.text, /Preparar pauta da semana/);
});

test('borda HTTP de /api/agent/briefing valida token, origem, parâmetros e revogação', async t => {
  const ctx = setupRuntime(t);

  const noToken = await call(ctx.handler, { ...mockReq(), headers: { host: '127.0.0.1:8787' } });
  assert.equal(noToken.status, 401);

  const failClosed = await call(
    createBriefingHandler({ toolExecutor: ctx.executor, skillCatalog: ctx.skillCatalog, apiToken: null }),
    mockReq(),
  );
  assert.equal(failClosed.status, 503);

  const badOrigin = await call(ctx.handler, mockReq({ headers: { host: 'evil.example' } }));
  assert.equal(badOrigin.status, 403);

  const badDate = await call(ctx.handler, mockReq({ url: '/api/agent/briefing?date=2026-02-31' }));
  assert.equal(badDate.status, 400);

  const badFlag = await call(ctx.handler, mockReq({ url: '/api/agent/briefing?useLlm=talvez' }));
  assert.equal(badFlag.status, 400);

  // Revogar a ferramenta bloqueia a rota com 403 e registra negativa.
  ctx.gate.revoke('briefing.build', 'manutenção');
  const revoked = await call(ctx.handler, mockReq());
  assert.equal(revoked.status, 403);
  assert.equal(revoked.data.execution.status, 'denied');

  // Skill desativada bloqueia a rota com 409.
  ctx.gate.restore('briefing.build');
  const manifestPath = join(ctx.dir, 'skills', DAILY_BRIEFING_SKILL_ID, 'skill.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.state = 'disabled';
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  ctx.skillCatalog.load();

  const disabled = await call(ctx.handler, mockReq());
  assert.equal(disabled.status, 409);
});
