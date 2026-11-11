import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_API_PREFIX,
  AGENT_LIMITS,
  AGENT_SCHEMAS,
  EXECUTION_ORIGINS,
  EXECUTION_STATUSES,
  INTENT_KINDS,
  PERMISSION_LEVELS,
  PLAN_STATUSES,
  PLAN_STEP_STATUSES,
  SKILL_STATES,
  isPermissionLevel,
  permissionLevelInfo,
  permissionRequiresConfirmation,
  validateExecutionRecord,
  validateIntent,
  validatePlan,
  validatePlanStep,
  validateSkillManifest,
  validateToolSpec,
} from '../src/agent-contracts.js';

const NOW = '2026-11-11T12:00:00.000Z';

const intent = (overrides = {}) => ({
  schema: AGENT_SCHEMAS.intent,
  id: 'int-0123456789ab',
  kind: 'operational',
  goal: 'criar tarefa de revisão amanhã',
  confidence: 0.82,
  origin: 'classifier',
  createdAt: NOW,
  ...overrides,
});

const step = (overrides = {}) => ({
  id: 'st-111111111111',
  title: 'consultar memória operacional',
  status: 'pending',
  dependsOn: [],
  tool: 'memory.search',
  permissionLevel: 1,
  effort: 'low',
  priority: 2,
  ...overrides,
});

const plan = (overrides = {}) => ({
  schema: AGENT_SCHEMAS.plan,
  id: 'pl-aaaaaaaaaaaa',
  goal: 'planejar a semana',
  version: 1,
  status: 'draft',
  origin: 'planner',
  createdAt: NOW,
  steps: [step()],
  ...overrides,
});

const tool = (overrides = {}) => ({
  schema: AGENT_SCHEMAS.tool,
  name: 'memory.search',
  version: '1.0.0',
  description: 'busca fatos e memória operacional',
  origin: 'runtime',
  permissionLevel: 1,
  timeoutMs: 5000,
  parameters: [
    { name: 'query', type: 'string', required: true, description: 'texto da busca' },
    { name: 'limit', type: 'number', required: false, enum: [5, 10, 20] },
  ],
  verify: result => Array.isArray(result),
  ...overrides,
});

const skill = (overrides = {}) => ({
  schema: AGENT_SCHEMAS.skill,
  id: 'personal-planner',
  name: 'Personal Planner',
  version: '0.1.0',
  description: 'organiza tarefas locais e cronograma',
  state: 'available',
  origin: 'dev',
  createdAt: NOW,
  tools: ['memory.search'],
  permissions: [3, 2],
  dependencies: [],
  parameters: [{ name: 'weekStart', type: 'string', required: false }],
  instructions: 'Use a memória operacional.\nNunca invente compromissos.',
  tests: { files: ['test/personal-planner.test.mjs'], timeoutMs: 30000 },
  ...overrides,
});

const execution = (overrides = {}) => ({
  schema: AGENT_SCHEMAS.execution,
  id: 'ex-bbbbbbbbbbbb',
  tool: 'memory.search',
  status: 'ok',
  permissionLevel: 1,
  origin: 'agent',
  startedAt: NOW,
  finishedAt: '2026-11-11T12:00:01.500Z',
  durationMs: 1500,
  verified: true,
  ...overrides,
});

const hasError = (result, fragment) => result.errors.some(error => error.includes(fragment));

// --- vocabulário e versionamento ------------------------------------------

test('contratos têm versão própria e o namespace do domínio é /api/agent', () => {
  assert.equal(AGENT_API_PREFIX, '/api/agent');
  assert.equal(AGENT_SCHEMAS.intent, 'usami.agent.intent.v1');
  assert.equal(AGENT_SCHEMAS.plan, 'usami.agent.plan.v1');
  assert.equal(AGENT_SCHEMAS.tool, 'usami.agent.tool.v1');
  assert.equal(AGENT_SCHEMAS.skill, 'usami.agent.skill.v1');
  assert.equal(AGENT_SCHEMAS.execution, 'usami.agent.execution.v1');
  assert.ok(INTENT_KINDS.includes('operational'));
  assert.ok(PLAN_STATUSES.includes('awaiting_approval'));
  assert.ok(PLAN_STEP_STATUSES.includes('skipped'));
  assert.ok(SKILL_STATES.includes('pending'));
  assert.ok(EXECUTION_STATUSES.includes('denied'));
  assert.ok(EXECUTION_ORIGINS.includes('suggestion'));
});

test('só o nível 4 de permissão exige confirmação de uso único', () => {
  for (const level of [1, 2, 3, 4]) {
    assert.equal(isPermissionLevel(level), true);
    assert.equal(permissionLevelInfo(level).level, level);
  }
  for (const invalid of [0, 5, 1.5, '1', null]) assert.equal(isPermissionLevel(invalid), false);
  assert.equal(permissionLevelInfo(4).requiresConfirmation, true);
  assert.equal(permissionLevelInfo(4).external, true);
  assert.equal(permissionLevelInfo(3).requiresConfirmation, false);
  assert.equal(permissionLevelInfo(5), null);
  assert.equal(permissionRequiresConfirmation(4), true);
  assert.equal(permissionRequiresConfirmation(3), false);
  assert.deepEqual(Object.keys(PERMISSION_LEVELS), ['1', '2', '3', '4']);
});

// --- Intent ---------------------------------------------------------------

test('intent válida é normalizada e preserva origem e data', () => {
  const result = validateIntent(intent({ goal: '  criar   tarefa  de revisão  ' }));
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.value.goal, 'criar tarefa de revisão');
  assert.equal(result.value.schema, AGENT_SCHEMAS.intent);
  assert.equal(result.value.origin, 'classifier');
  assert.equal(result.value.createdAt, NOW);
});

test('intent rejeita tipo desconhecido, confiança fora da faixa e origem ausente', () => {
  const result = validateIntent(intent({ kind: 'chat', confidence: 1.5, origin: undefined }));
  assert.equal(result.ok, false);
  assert.ok(hasError(result, 'kind: deve ser um de'));
  assert.ok(hasError(result, 'confidence: deve ser número entre 0 e 1'));
  assert.ok(hasError(result, 'origin: deve ser um de'));
});

test('intent exige id, data ISO com fuso e schema correto', () => {
  const result = validateIntent(intent({ id: 'int-1', createdAt: '2026-11-11', schema: 'usami.agent.v0' }));
  assert.equal(result.ok, false);
  assert.ok(hasError(result, 'id: formato esperado int-<12 hex>'));
  assert.ok(hasError(result, 'createdAt: deve ser data ISO-8601'));
  assert.ok(hasError(result, 'schema: deve ser'));
});

test('intent não aceita objeto que não é JSON de objeto', () => {
  assert.equal(validateIntent([]).ok, false);
  assert.equal(validateIntent(null).ok, false);
});

// --- Plan / PlanStep ------------------------------------------------------

test('plano válido normaliza passos, dependências e status padrão', () => {
  const second = step({ id: 'st-222222222222', title: 'montar cronograma', dependsOn: ['st-111111111111'], tool: undefined });
  const result = validatePlan(plan({ steps: [step({ status: undefined }), second] }));
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.value.steps.length, 2);
  assert.equal(result.value.steps[0].status, 'pending');
  assert.deepEqual(result.value.steps[0].dependsOn, []);
  assert.deepEqual(result.value.steps[1].dependsOn, ['st-111111111111']);
  assert.equal(result.value.status, 'draft');
});

test('plano rejeita ids de passo duplicados', () => {
  const result = validatePlan(plan({ steps: [step(), step({ title: 'outro título' })] }));
  assert.equal(result.ok, false);
  assert.ok(hasError(result, 'duplicado (st-111111111111)'));
});

test('plano rejeita dependência de passo inexistente', () => {
  const result = validatePlan(plan({ steps: [step({ dependsOn: ['st-999999999999'] })] }));
  assert.equal(result.ok, false);
  assert.ok(hasError(result, 'depende de passo inexistente'));
});

test('plano rejeita dependência circular', () => {
  const a = step({ id: 'st-111111111111', dependsOn: ['st-222222222222'] });
  const b = step({ id: 'st-222222222222', title: 'segundo', dependsOn: ['st-111111111111'] });
  const result = validatePlan(plan({ steps: [a, b] }));
  assert.equal(result.ok, false);
  assert.ok(hasError(result, 'dependências formam ciclo'));
});

test('plano rejeita passo que depende de si mesmo', () => {
  const result = validatePlan(plan({ steps: [step({ dependsOn: ['st-111111111111'] })] }));
  assert.equal(result.ok, false);
  assert.ok(hasError(result, 'não pode depender de si mesmo'));
});

test('plano vazio, versão e estados inválidos são recusados', () => {
  const empty = validatePlan(plan({ steps: [] }));
  assert.equal(empty.ok, false);
  assert.ok(hasError(empty, 'ao menos um passo'));

  const badVersion = validatePlan(plan({ version: 0 }));
  assert.ok(hasError(badVersion, 'version: deve ser inteiro >= 1'));

  const badStatus = validatePlan(plan({ status: 'executando', origin: 'modelo' }));
  assert.ok(hasError(badStatus, 'status: deve ser um de'));
  assert.ok(hasError(badStatus, 'origin: deve ser um de'));
});

test('briefing opcional é validado e updatedAt não pode retroceder', () => {
  const ok = validatePlan(plan({
    status: 'awaiting_approval',
    briefing: { summary: 'duas tarefas dependem do horário', missingInfo: ['horário do compromisso'], risks: ['conflito com almoço'] },
  }));
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
  assert.deepEqual(ok.value.briefing.missingInfo, ['horário do compromisso']);

  const badBriefing = validatePlan(plan({ briefing: { summary: 'ok', missingInfo: 'nada', risks: [42] } }));
  assert.equal(badBriefing.ok, false);
  assert.ok(hasError(badBriefing, 'briefing.missingInfo: deve ser uma lista'));
  assert.ok(hasError(badBriefing, 'briefing.risks[0]: deve ser texto'));

  const backwards = validatePlan(plan({ updatedAt: '2026-11-10T12:00:00.000Z' }));
  assert.equal(backwards.ok, false);
  assert.ok(hasError(backwards, 'updatedAt: não pode ser anterior'));
});

test('validatePlanStep isolado confere prioridade, esforço e nível', () => {
  const result = validatePlanStep(step({ priority: 0, effort: 'huge', permissionLevel: 9 }));
  assert.equal(result.ok, false);
  assert.ok(hasError(result, 'priority: deve ser inteiro'));
  assert.ok(hasError(result, 'effort: deve ser um de'));
  assert.ok(hasError(result, 'permissionLevel: nível inválido'));
});

// --- ToolSpec -------------------------------------------------------------

test('ToolSpec válido preserva verify e normaliza parâmetros', () => {
  const verify = result => Array.isArray(result);
  const result = validateToolSpec(tool({ verify }));
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.value.verify, verify);
  assert.equal(result.value.name, 'memory.search');
  assert.deepEqual(result.value.parameters[1].enum, [5, 10, 20]);
  assert.equal(result.value.parameters[1].required, false);
});

test('ToolSpec exige verify e timeout dentro da faixa', () => {
  const noVerify = validateToolSpec(tool({ verify: undefined }));
  assert.equal(noVerify.ok, false);
  assert.ok(hasError(noVerify, 'verify: ferramenta precisa de verify'));

  const slow = validateToolSpec(tool({ timeoutMs: AGENT_LIMITS.maxToolTimeoutMs + 1 }));
  assert.ok(hasError(slow, 'timeoutMs: deve ser inteiro entre'));

  const badName = validateToolSpec(tool({ name: 'Memory Search', permissionLevel: 0 }));
  assert.ok(hasError(badName, 'name: nome de ferramenta inválido'));
  assert.ok(hasError(badName, 'permissionLevel: nível inválido'));
});

test('ToolSpec rejeita parâmetro duplicado e enum incompatível', () => {
  const result = validateToolSpec(tool({
    parameters: [
      { name: 'query', type: 'string', required: true },
      { name: 'query', type: 'string', required: false },
      { name: 'limit', type: 'number', enum: ['5', '10'] },
    ],
  }));
  assert.equal(result.ok, false);
  assert.ok(hasError(result, 'duplicado (query)'));
  assert.ok(hasError(result, 'enum: valores devem ser number'));
});

// --- SkillManifest --------------------------------------------------------

test('manifesto de skill válido ordena permissões e deriva o nível máximo', () => {
  const result = validateSkillManifest(skill());
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.value.permissions, [2, 3]);
  assert.equal(result.value.maxPermissionLevel, 3);
  assert.equal(result.value.state, 'available');
  assert.match(result.value.instructions, /\n/, 'instruções mantêm as quebras de linha');
  assert.deepEqual(result.value.tests.files, ['test/personal-planner.test.mjs']);
});

test('manifesto rejeita estado desconhecido e dependência de si mesmo', () => {
  const result = validateSkillManifest(skill({ state: 'ready', dependencies: ['personal-planner'] }));
  assert.equal(result.ok, false);
  assert.ok(hasError(result, 'state: deve ser um de'));
  assert.ok(hasError(result, 'não pode depender de si mesma'));
});

test('manifesto exige teste declarado e recusa caminho fora do pacote', () => {
  const noTests = validateSkillManifest(skill({ tests: undefined }));
  assert.equal(noTests.ok, false);
  assert.ok(hasError(noTests, 'tests: deve ser um objeto'));

  const escaping = validateSkillManifest(skill({ tests: { files: ['../escape.test.mjs'] } }));
  assert.equal(escaping.ok, false);
  assert.ok(hasError(escaping, 'caminho inválido'));

  const absolute = validateSkillManifest(skill({ tests: { files: ['/tmp/agent.test.mjs'] } }));
  assert.equal(absolute.ok, false);
  assert.ok(hasError(absolute, 'caminho inválido'));
});

test('manifesto rejeita ferramenta duplicada e instruções vazias', () => {
  const result = validateSkillManifest(skill({ tools: ['memory.search', 'memory.search'], instructions: '   ' }));
  assert.equal(result.ok, false);
  assert.ok(hasError(result, 'tools: duplicada (memory.search)'));
  assert.ok(hasError(result, 'instructions: deve ter ao menos 1 caracteres'));
});

// --- ExecutionRecord ------------------------------------------------------

test('registro de execução verificado é aceito', () => {
  const result = validateExecutionRecord(execution({ planId: 'pl-aaaaaaaaaaaa', stepId: 'st-111111111111', inputSummary: 'busca por revisão' }));
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.value.verified, true);
  assert.equal(result.value.durationMs, 1500);
});

test('sucesso só existe com verify aprovado e falha não pode estar verificada', () => {
  const unverified = validateExecutionRecord(execution({ verified: false }));
  assert.equal(unverified.ok, false);
  assert.ok(hasError(unverified, 'execução ok só é registrada com verify() aprovado'));

  const contradictory = validateExecutionRecord(execution({ status: 'failed', verified: true, reason: 'timeout do provedor' }));
  assert.equal(contradictory.ok, false);
  assert.ok(hasError(contradictory, 'status sem sucesso não pode estar verificado'));
});

test('negativa, falha e timeout exigem motivo registrado', () => {
  for (const status of ['denied', 'failed', 'timeout']) {
    const missing = validateExecutionRecord(execution({ status, verified: false }));
    assert.equal(missing.ok, false, status);
    assert.ok(hasError(missing, `reason: obrigatório quando status é ${status}`));

    const withReason = validateExecutionRecord(execution({ status, verified: false, reason: 'permissão revogada pelo usuário' }));
    assert.equal(withReason.ok, true, `${status}: ${JSON.stringify(withReason.errors)}`);
  }
});

test('registro de execução confere ordem das datas e formato dos vínculos', () => {
  const result = validateExecutionRecord(execution({
    finishedAt: '2026-11-11T11:59:00.000Z',
    planId: 'plano-1',
    stepId: 'st-1',
    permissionLevel: 5,
  }));
  assert.equal(result.ok, false);
  assert.ok(hasError(result, 'finishedAt: não pode ser anterior a startedAt'));
  assert.ok(hasError(result, 'planId: formato esperado pl-<12 hex>'));
  assert.ok(hasError(result, 'stepId: formato esperado st-<12 hex>'));
  assert.ok(hasError(result, 'permissionLevel: nível inválido'));
});
