import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOperationalMemoryStore } from '../src/operational-memory-store.js';
import { createTaskPlanner } from '../src/task-planner.js';
import { createToolRegistry } from '../src/tool-registry.js';
import { createSkillCatalog } from '../src/skill-catalog.js';
import { createProactiveEngine } from '../src/proactive-engine.js';
import {
  collectOverdueTaskSuggestions,
  collectSkillGapSuggestions,
  collectStalledProjectSuggestions,
  collectUpcomingCommitmentSuggestions,
  cooldownForRelevance,
  createDefaultSuggestionSources,
  createSuggestionStore,
  SUGGESTION_SCHEMA,
} from '../src/proactive-suggestions.js';

// Isola USAMI_DATA_DIR e USAMI_KEYS_FILE antes de importar server.mjs para nunca encostar em data/.
const scratchServerDir = mkdtempSync(join(tmpdir(), 'usami-suggestions-srv-'));
process.env.USAMI_DATA_DIR = scratchServerDir;
process.env.USAMI_KEYS_FILE = process.env.USAMI_KEYS_FILE || join(scratchServerDir, 'no-keys.env');
test.after(() => rmSync(scratchServerDir, { recursive: true, force: true }));

const { createSuggestionsHandler } = await import('../server.mjs');

const TEST_TOKEN = 'token-sugestoes-teste';

function mockReq({ method = 'GET', url = '/api/agent/suggestions', headers = {}, body = '' } = {}) {
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

function setupRuntime(t, initialIso = '2026-11-11T15:00:00') {
  const dir = mkdtempSync(join(tmpdir(), 'usami-s12-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  let clock = new Date(initialIso).getTime();
  const now = () => clock;
  const advance = ms => { clock += ms; return clock; };
  const setClock = iso => { clock = new Date(iso).getTime(); return clock; };

  const operationalStore = createOperationalMemoryStore({ dataDir: dir, now });
  operationalStore.load();
  const taskPlanner = createTaskPlanner({ dataDir: dir, now });
  taskPlanner.load();
  const registry = createToolRegistry();
  const skillCatalog = createSkillCatalog({ dataDir: dir, registry });
  skillCatalog.load();
  const suggestionsStore = createSuggestionStore({ dataDir: dir, now });
  suggestionsStore.load();

  const sayCalls = [];
  const engine = createProactiveEngine({
    affinityProvider: () => 50,
    usernameProvider: () => 'Amari',
    idleThresholdMs: 60_000,
    now,
    onProactiveSay: cmd => sayCalls.push(cmd),
    suggestionsStore,
    suggestionSources: createDefaultSuggestionSources({
      operationalProvider: () => operationalStore.getAll().records,
      plansProvider: () => taskPlanner.list({ limit: 200 }),
      skillsProvider: () => skillCatalog.list(),
      toolsProvider: () => registry.list(),
    }),
  });

  const handler = createSuggestionsHandler({
    suggestionsStore,
    taskPlanner,
    proactiveEngine: engine,
    apiToken: TEST_TOKEN,
  });

  return {
    dir,
    now,
    advance,
    setClock,
    operationalStore,
    taskPlanner,
    registry,
    skillCatalog,
    suggestionsStore,
    sayCalls,
    engine,
    handler,
  };
}

test('DND (23:30–08:30) bloqueia sugestões contextuais e libera fora da janela sem emitir proactive_say', t => {
  const ctx = setupRuntime(t, '2026-11-11T23:45:00');

  ctx.operationalStore.create({
    kind: 'task',
    title: 'Enviar prestação de contas',
    dueAt: '2026-11-11T10:00:00.000Z',
    relevance: 0.9,
  });

  // Em DND às 23:45 -> bloqueado e sem gravar arquivo em disco.
  const atNight = ctx.engine.checkSuggestions();
  assert.equal(atNight.suggested, false);
  assert.equal(atNight.reason, 'quiet_hours');
  assert.equal(ctx.suggestionsStore.list().length, 0);
  assert.equal(existsSync(join(ctx.dir, 'suggestions.json')), false);

  // Às 03:00 continua em DND.
  ctx.setClock('2026-11-12T03:00:00');
  assert.equal(ctx.engine.checkSuggestions().reason, 'quiet_hours');

  // Às 09:00 fora do DND -> cria sugestão única e NÃO dispara fala proativa.
  ctx.setClock('2026-11-12T09:00:00');
  const atMorning = ctx.engine.checkSuggestions();
  assert.equal(atMorning.suggested, true);
  assert.equal(atMorning.suggestion.kind, 'overdue_task');
  assert.equal(atMorning.suggestion.status, 'suggested');
  assert.equal(ctx.sayCalls.length, 0);
  assert.equal(existsSync(join(ctx.dir, 'suggestions.json')), true);
});

test('preserva o comportamento de proactive_say e respeita o teto de 1 sugestão não respondida', async t => {
  const ctx = setupRuntime(t, '2026-11-11T14:00:00');

  ctx.operationalStore.create({
    kind: 'task',
    title: 'Tarefa vencida 1',
    dueAt: '2026-11-10T10:00:00.000Z',
    relevance: 0.9,
  });
  ctx.operationalStore.create({
    kind: 'task',
    title: 'Tarefa vencida 2',
    dueAt: '2026-11-10T11:00:00.000Z',
    relevance: 0.7,
  });

  // 1ª avaliação gera apenas a mais relevante.
  const first = ctx.engine.checkSuggestions();
  assert.equal(first.suggested, true);
  assert.match(first.suggestion.title, /Tarefa vencida 1/);
  assert.equal(ctx.engine.getState().unansweredSuggestions, 1);

  // 2ª avaliação enquanto há sugestão não respondida é bloqueada pelo teto de 1.
  ctx.advance(2 * 60 * 60_000);
  const second = ctx.engine.checkSuggestions();
  assert.equal(second.suggested, false);
  assert.equal(second.reason, 'max_unanswered');
  assert.equal(ctx.suggestionsStore.list().length, 1);

  // Motor clássico de idle/afinidade segue emitindo `proactive_say` normalmente.
  const speech = await ctx.engine.checkAndTrigger();
  assert.equal(speech.triggered, true);
  assert.equal(ctx.sayCalls.length, 1);
  assert.equal(ctx.sayCalls[0].type, 'proactive_say');
});

test('throttle por relevância, filtro mínimo e snooze após descarte', t => {
  const ctx = setupRuntime(t, '2026-11-11T14:00:00');

  const candidates = [];
  ctx.engine.setSuggestionSources([() => candidates]);

  // Abaixo da relevância mínima não entra.
  candidates.push({
    kind: 'custom',
    dedupeKey: 'low-noise',
    relevance: 0.2,
    title: 'Ruído irrelevante',
    recommendedGoal: 'Ignorar ruído',
  });
  assert.equal(ctx.engine.checkSuggestions().reason, 'low_relevance');

  // Sugestão inicial entra e marca lastSuggestedAt.
  candidates.length = 0;
  candidates.push({
    kind: 'custom',
    dedupeKey: 'first-suggestion',
    relevance: 0.9,
    title: 'Primeira sugestão',
    recommendedGoal: 'Executar primeira sugestão',
  });
  const first = ctx.engine.checkSuggestions();
  assert.equal(first.suggested, true);
  assert.equal(ctx.suggestionsStore.dismiss(first.suggestion.id, { reason: 'agora não' }).ok, true);

  // A mesma dedupeKey continua em snooze mesmo após 1 hora.
  ctx.advance(60 * 60_000);
  assert.equal(ctx.engine.checkSuggestions().reason, 'deduped');

  // Nova sugestão de relevância baixa (cooldown 4h) sofre throttle aos 60 min...
  assert.equal(cooldownForRelevance(0.45), 4 * 60 * 60_000);
  candidates.push({
    kind: 'custom',
    dedupeKey: 'low-priority',
    relevance: 0.45,
    title: 'Sugestão baixa',
    recommendedGoal: 'Organizar arquivos antigos',
  });
  const throttled = ctx.engine.checkSuggestions();
  assert.equal(throttled.suggested, false);
  assert.equal(throttled.reason, 'throttled');
  assert.ok(throttled.retryAfterMs > 0);

  // ...mas uma sugestão de alta relevância (cooldown 15 min) passa imediatamente!
  candidates.push({
    kind: 'custom',
    dedupeKey: 'high-priority',
    relevance: 0.9,
    title: 'Urgência real',
    recommendedGoal: 'Resolver urgência real',
  });
  const urgent = ctx.engine.checkSuggestions();
  assert.equal(urgent.suggested, true);
  assert.equal(urgent.suggestion.dedupeKey, 'high-priority');
});

test('quatro fontes contextuais: tarefa atrasada, reunião próxima, projeto parado e lacuna de skill', t => {
  const dir = mkdtempSync(join(tmpdir(), 'usami-s12-sources-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const nowMs = new Date('2026-11-11T15:00:00.000Z').getTime();

  const records = [
    {
      id: 'op-111111111111',
      kind: 'task',
      title: 'Fechar relatório fiscal',
      status: 'open',
      dueAt: '2026-11-11T12:00:00.000Z',
      relevance: 0.8,
      updatedAt: '2026-11-10T12:00:00.000Z',
    },
    {
      id: 'op-222222222222',
      kind: 'commitment',
      title: 'Sync semanal de produto',
      status: 'open',
      dueAt: '2026-11-11T16:30:00.000Z',
      relevance: 0.7,
      updatedAt: '2026-11-11T10:00:00.000Z',
    },
    {
      id: 'op-333333333333',
      kind: 'project',
      title: 'Migração v2',
      status: 'in_progress',
      relevance: 0.6,
      createdAt: '2026-10-20T10:00:00.000Z',
      updatedAt: '2026-11-01T10:00:00.000Z',
    },
    {
      id: 'op-444444444444',
      kind: 'project',
      title: 'Projeto ativo',
      status: 'in_progress',
      relevance: 0.9,
      createdAt: '2026-11-01T10:00:00.000Z',
      updatedAt: '2026-11-01T10:00:00.000Z',
    },
    {
      id: 'op-555555555555',
      kind: 'task',
      title: 'Subtarefa recente',
      projectId: 'op-444444444444',
      status: 'in_progress',
      relevance: 0.5,
      updatedAt: '2026-11-10T10:00:00.000Z',
    },
  ];

  const overdue = collectOverdueTaskSuggestions({ now: nowMs, operationalRecords: records });
  assert.equal(overdue.length, 1);
  assert.equal(overdue[0].kind, 'overdue_task');

  const upcoming = collectUpcomingCommitmentSuggestions({ now: nowMs, operationalRecords: records });
  assert.equal(upcoming.length, 1);
  assert.equal(upcoming[0].kind, 'upcoming_commitment');

  // Apenas o projeto sem atividade nem subtarefa recente é apontado como parado.
  const stalled = collectStalledProjectSuggestions({ now: nowMs, operationalRecords: records });
  assert.equal(stalled.length, 1);
  assert.equal(stalled[0].sourceId, 'op-333333333333');

  const skillGaps = collectSkillGapSuggestions({
    skills: [
      {
        id: 'calendar-helper',
        name: 'Calendar Helper',
        valid: true,
        state: 'installed',
        activation: { canActivate: false, reasons: ['ferramenta ausente: calendar.sync'] },
        missing: { tools: ['calendar.sync'], dependencies: [] },
      },
    ],
    tools: [{ name: 'memory.search' }],
    plans: [
      {
        id: 'pl-aaaaaaaaaaaa',
        status: 'approved',
        steps: [{ id: 'st-111111111111', tool: 'mail.send' }],
      },
    ],
  });
  assert.equal(skillGaps.length, 2);
  assert.ok(skillGaps.some(item => item.sourceId === 'calendar-helper'));
  assert.ok(skillGaps.some(item => item.sourceId === 'mail.send'));
});

test('ciclo persistido suggested -> planned -> authorized -> verified e aceite HTTP gerando plano aprovado', async t => {
  const ctx = setupRuntime(t, '2026-11-11T15:00:00');
  const firedExecutions = [];
  ctx.registry.register({
    name: 'danger.wipe',
    version: '1.0.0',
    description: 'Teste de não execução automática',
    origin: 'runtime',
    permissionLevel: 4,
    timeoutMs: 1000,
    parameters: [],
    verify: () => true,
    execute: () => { firedExecutions.push(true); return { ok: true }; },
  });

  ctx.operationalStore.create({
    kind: 'task',
    title: 'Revisar backup do servidor',
    dueAt: '2026-11-10T18:00:00.000Z',
    relevance: 0.9,
  });

  const produced = ctx.engine.checkSuggestions();
  assert.equal(produced.suggested, true);
  const suggestionId = produced.suggestion.id;

  // GET /api/agent/suggestions lista a sugestão pendente.
  const listed = await call(ctx.handler, mockReq());
  assert.equal(listed.status, 200);
  assert.equal(listed.data.ok, true);
  assert.equal(listed.data.unansweredCount, 1);
  assert.equal(listed.data.pending.id, suggestionId);
  assert.equal(listed.data.suggestions[0].schema, SUGGESTION_SCHEMA);

  // POST /api/agent/suggestions/:id/accept cria plano autorizado e muda estado.
  const accepted = await call(ctx.handler, jsonReq(`/api/agent/suggestions/${suggestionId}/accept`, {}));
  assert.equal(accepted.status, 200);
  assert.equal(accepted.data.ok, true);
  assert.equal(accepted.data.suggestion.status, 'authorized');
  assert.equal(accepted.data.plan.status, 'approved');
  assert.equal(accepted.data.plan.origin, 'planner');
  assert.equal(accepted.data.suggestion.planId, accepted.data.plan.id);
  assert.deepEqual(
    accepted.data.suggestion.history.map(item => item.status),
    ['suggested', 'planned', 'authorized'],
  );
  // Aceitar gera plano autorizado, mas não executa ferramentas automaticamente.
  assert.equal(firedExecutions.length, 0);

  // Segunda tentativa de aceitar ou descartar a mesma sugestão retorna 409.
  const repeat = await call(ctx.handler, jsonReq(`/api/agent/suggestions/${suggestionId}/dismiss`, {}));
  assert.equal(repeat.status, 409);

  // Teto libera após resposta, mas mesma tarefa aceita não duplica sugestão.
  assert.equal(ctx.engine.getState().unansweredSuggestions, 0);
  ctx.advance(60 * 60_000);
  assert.equal(ctx.engine.checkSuggestions().reason, 'deduped');

  // Completa o ciclo para verified e confere persistência em data/suggestions.json.
  const verified = ctx.suggestionsStore.markVerified(suggestionId, {
    executionId: 'ex-1234567890ab',
    note: 'concluído após autorização',
  });
  assert.equal(verified.ok, true);
  assert.equal(verified.suggestion.status, 'verified');

  const reloadedSuggestions = createSuggestionStore({ dataDir: ctx.dir, now: ctx.now });
  assert.equal(reloadedSuggestions.load().ok, true);
  const persisted = reloadedSuggestions.get(suggestionId);
  assert.equal(persisted.ok, true);
  assert.deepEqual(
    persisted.suggestion.history.map(item => item.status),
    ['suggested', 'planned', 'authorized', 'verified'],
  );

  const reloadedPlans = createTaskPlanner({ dataDir: ctx.dir, now: ctx.now });
  reloadedPlans.load();
  const persistedPlan = reloadedPlans.get(accepted.data.plan.id);
  assert.equal(persistedPlan.ok, true);
  assert.equal(persistedPlan.plan.status, 'approved');
});

test('borda HTTP: token obrigatório, fail-closed, validação de corpo e arquivo corrompido', async t => {
  const ctx = setupRuntime(t, '2026-11-11T15:00:00');
  const created = ctx.suggestionsStore.create({
    kind: 'custom',
    dedupeKey: 'http-edge',
    relevance: 0.7,
    title: 'Conferir logs de erro',
    recommendedGoal: 'Inspecionar erros recentes',
  });
  assert.equal(created.ok, true);
  const id = created.suggestion.id;

  const noToken = await call(ctx.handler, {
    ...mockReq(),
    headers: { host: '127.0.0.1:8787' },
  });
  assert.equal(noToken.status, 401);

  const failClosed = await call(
    createSuggestionsHandler({ suggestionsStore: ctx.suggestionsStore, taskPlanner: ctx.taskPlanner, apiToken: null }),
    mockReq(),
  );
  assert.equal(failClosed.status, 503);

  const badOrigin = await call(ctx.handler, mockReq({ headers: { host: 'evil.example' } }));
  assert.equal(badOrigin.status, 403);

  const badContentType = await call(
    ctx.handler,
    mockReq({ method: 'POST', url: `/api/agent/suggestions/${id}/dismiss`, body: '{}' }),
  );
  assert.equal(badContentType.status, 403);

  const badField = await call(
    ctx.handler,
    jsonReq(`/api/agent/suggestions/${id}/accept`, { executeNow: true }),
  );
  assert.equal(badField.status, 400);

  const dismissed = await call(
    ctx.handler,
    jsonReq(`/api/agent/suggestions/${id}/dismiss`, { reason: 'já resolvi manualmente' }),
  );
  assert.equal(dismissed.status, 200);
  assert.equal(dismissed.data.suggestion.status, 'dismissed');
  assert.equal(dismissed.data.suggestion.dismissReason, 'já resolvi manualmente');

  // Arquivo corrompido trava escritas sem sobrescrever o disco.
  const corruptDir = mkdtempSync(join(tmpdir(), 'usami-s12-corrupt-'));
  t.after(() => rmSync(corruptDir, { recursive: true, force: true }));
  const corruptFile = join(corruptDir, 'suggestions.json');
  writeFileSync(corruptFile, '{broken-json', 'utf8');
  const brokenStore = createSuggestionStore({ dataDir: corruptDir, onLoadError: () => {} });
  const loaded = brokenStore.load();
  assert.equal(loaded.ok, false);
  assert.equal(brokenStore.unavailable(), true);
  assert.throws(() => brokenStore.create({ title: 'x', dedupeKey: 'x', recommendedGoal: 'x', relevance: 0.9 }));
  assert.equal(readFileSync(corruptFile, 'utf8'), '{broken-json');
});

