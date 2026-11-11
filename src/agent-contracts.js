// Contratos puros do domínio agêntico do USAMI 2.0.
//
// O runtime de companion continua sendo o caminho ativo: este módulo não toca
// `server.mjs`, não persiste nada e não chama LLM. Ele define a forma dos
// objetos que o Core, o Planner, o Tool Executor, o Skill Manager e o
// Self-Introspection vão trocar, no mesmo estilo de `technique-schema.js`:
// validação estrita devolve `{ ok, errors, value }` e quem chama decide o que
// fazer. Nenhum validador normaliza criativamente: entrada inválida é erro.
//
// Campos obrigatórios padronizados:
//   - `schema`: versão do contrato (`usami.agent.*.v1`);
//   - `origin`: quem produziu o objeto (nunca inferido do conteúdo);
//   - `createdAt`/`startedAt`: data ISO-8601 com fuso;
//   - `status`/`state`: só em objetos com ciclo de vida (Plan, SkillManifest,
//     ExecutionRecord). ToolSpec é descritor estático: tem `version` semver e
//     `origin`, mas não data nem estado.
//
// Namespace HTTP do domínio: `/api/agent/*`. `/api/plan` continua sendo o
// planner de ANIMAÇÃO; plano de tarefas mora em `/api/agent/plans`.

/**
 * @typedef {Object} Intent
 * @property {string} schema
 * @property {string} id `int-<12 hex>`
 * @property {'conversation'|'operational'|'complex'} kind
 * @property {string} goal
 * @property {number} confidence 0..1
 * @property {'user'|'classifier'|'llm'} origin
 * @property {string} createdAt ISO-8601
 */

/**
 * @typedef {Object} PlanStep
 * @property {string} id `st-<12 hex>`
 * @property {string} title
 * @property {'pending'|'running'|'done'|'failed'|'skipped'} status
 * @property {string[]} dependsOn ids de outros passos
 * @property {string} [tool] nome de ferramenta (`namespace.nome`)
 * @property {1|2|3|4} [permissionLevel]
 * @property {'low'|'medium'|'high'} [effort]
 * @property {number} [priority] 1 (mais alta) .. 5
 */

/**
 * @typedef {Object} Plan
 * @property {string} schema
 * @property {string} id `pl-<12 hex>`
 * @property {string} goal
 * @property {number} version revisão >= 1
 * @property {'draft'|'awaiting_approval'|'approved'|'running'|'done'|'failed'|'cancelled'} status
 * @property {'user'|'planner'|'llm'} origin
 * @property {string} createdAt
 * @property {string} [updatedAt]
 * @property {PlanStep[]} steps
 * @property {{summary: string, missingInfo: string[], risks: string[]}} [briefing]
 */

/**
 * @typedef {Object} ToolSpec
 * @property {string} schema
 * @property {string} name `namespace.nome`
 * @property {string} version semver
 * @property {string} description
 * @property {'runtime'|'skill'} origin
 * @property {1|2|3|4} permissionLevel
 * @property {number} timeoutMs
 * @property {Array<{name: string, type: string, required: boolean, description?: string, enum?: Array<string|number>}>} parameters
 * @property {(result: unknown) => boolean} verify
 * @property {Function} [execute]
 */

/**
 * @typedef {Object} SkillManifest
 * @property {string} schema
 * @property {string} id slug
 * @property {string} name
 * @property {string} version semver
 * @property {string} description
 * @property {'installed'|'available'|'pending'|'disabled'} state
 * @property {'dev'|'imported'|'model'} origin
 * @property {string} createdAt
 * @property {string} [updatedAt]
 * @property {string[]} tools nomes de ferramentas declaradas
 * @property {Array<1|2|3|4>} permissions níveis solicitados
 * @property {string[]} dependencies ids de outras skills
 * @property {Array<{name: string, type: string, required: boolean, description?: string}>} parameters
 * @property {string} instructions
 * @property {{files: string[], timeoutMs?: number}} tests
 */

/**
 * @typedef {Object} OperationalRecord
 * @property {string} schema
 * @property {string} id `op-<12 hex>`
 * @property {'project'|'task'|'commitment'} kind
 * @property {string} title
 * @property {'open'|'in_progress'|'done'|'cancelled'|'blocked'} status
 * @property {string} [dueAt] ISO-8601 (com fuso) ou data YYYY-MM-DD
 * @property {string} [projectId] `op-<12 hex>` do projeto
 * @property {'user'|'agent'|'planner'|'suggestion'} origin
 * @property {number} relevance 0..1
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/**
 * @typedef {Object} ExecutionRecord
 * @property {string} schema
 * @property {string} id `ex-<12 hex>`
 * @property {string} tool
 * @property {'ok'|'failed'|'denied'|'timeout'} status
 * @property {1|2|3|4} permissionLevel
 * @property {'user'|'agent'|'planner'|'suggestion'} origin
 * @property {string} startedAt
 * @property {string} [finishedAt]
 * @property {number} [durationMs]
 * @property {boolean} verified
 * @property {string} [reason] obrigatório em denied/failed/timeout
 * @property {string} [planId]
 * @property {string} [stepId]
 * @property {string} [inputSummary]
 */

export const AGENT_API_PREFIX = '/api/agent';

export const AGENT_SCHEMAS = Object.freeze({
  intent: 'usami.agent.intent.v1',
  plan: 'usami.agent.plan.v1',
  tool: 'usami.agent.tool.v1',
  skill: 'usami.agent.skill.v1',
  execution: 'usami.agent.execution.v1',
  operational: 'usami.agent.operational.v1',
});

export const AGENT_LIMITS = Object.freeze({
  maxGoalChars: 300,
  maxSteps: 30,
  maxStepTitleChars: 120,
  maxDescriptionChars: 400,
  maxInstructionsChars: 4000,
  maxParameterDescriptionChars: 200,
  maxParameters: 20,
  maxTools: 20,
  maxDependencies: 20,
  maxTestFiles: 10,
  maxBriefingSummaryChars: 600,
  maxBriefingItems: 10,
  maxBriefingItemChars: 200,
  minToolTimeoutMs: 100,
  maxToolTimeoutMs: 120000,
  maxSkillTestTimeoutMs: 300000,
  maxReasonChars: 500,
  maxInputSummaryChars: 200,
  maxDurationMs: 3600000,
  maxOperationalTitleChars: 200,
});

export const INTENT_KINDS = Object.freeze(['conversation', 'operational', 'complex']);
export const INTENT_ORIGINS = Object.freeze(['user', 'classifier', 'llm']);
export const PLAN_STATUSES = Object.freeze(['draft', 'awaiting_approval', 'approved', 'running', 'done', 'failed', 'cancelled']);
export const PLAN_STEP_STATUSES = Object.freeze(['pending', 'running', 'done', 'failed', 'skipped']);
export const PLAN_ORIGINS = Object.freeze(['user', 'planner', 'llm']);
export const TOOL_ORIGINS = Object.freeze(['runtime', 'skill']);
export const SKILL_STATES = Object.freeze(['installed', 'available', 'pending', 'disabled']);
export const SKILL_ORIGINS = Object.freeze(['dev', 'imported', 'model']);
export const EXECUTION_STATUSES = Object.freeze(['ok', 'failed', 'denied', 'timeout']);
export const EXECUTION_ORIGINS = Object.freeze(['user', 'agent', 'planner', 'suggestion']);
export const OPERATIONAL_KINDS = Object.freeze(['project', 'task', 'commitment']);
export const OPERATIONAL_STATUSES = Object.freeze(['open', 'in_progress', 'done', 'cancelled', 'blocked']);
export const OPERATIONAL_ORIGINS = Object.freeze(['user', 'agent', 'planner', 'suggestion']);
export const PARAMETER_TYPES = Object.freeze(['string', 'number', 'boolean', 'object', 'array']);
export const EFFORTS = Object.freeze(['low', 'medium', 'high']);

// Nível 1–4 é o vocabulário de autorização do agente. Só o 4 exige confirmação
// humana de uso único; o gate em si é S5, aqui só existe a classificação.
export const PERMISSION_LEVELS = Object.freeze({
  1: Object.freeze({ level: 1, label: 'leitura local', external: false, requiresConfirmation: false }),
  2: Object.freeze({ level: 2, label: 'escrita local', external: false, requiresConfirmation: false }),
  3: Object.freeze({ level: 3, label: 'ação externa reversível', external: true, requiresConfirmation: false }),
  4: Object.freeze({ level: 4, label: 'ação externa irreversível', external: true, requiresConfirmation: true }),
});

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const TOOL_NAME_RE = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_-]*)+$/;
const SKILL_ID_RE = /^[a-z][a-z0-9-]{2,39}$/;
const PARAM_NAME_RE = /^[a-z][a-zA-Z0-9]{0,39}$/;
const DUE_DATE_RE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/;
const ID_RES = Object.freeze({
  intent: /^int-[0-9a-f]{12}$/,
  plan: /^pl-[0-9a-f]{12}$/,
  step: /^st-[0-9a-f]{12}$/,
  execution: /^ex-[0-9a-f]{12}$/,
  operational: /^op-[0-9a-f]{12}$/,
});
const ID_PREFIXES = Object.freeze({ intent: 'int', plan: 'pl', step: 'st', execution: 'ex', operational: 'op' });

const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isIsoDate = value => typeof value === 'string' && ISO_RE.test(value) && !Number.isNaN(Date.parse(value));
const isIntegerBetween = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
const trimText = value => String(value ?? '').trim();
const collapseText = value => trimText(value).replace(/\s+/g, ' ');

export function isPermissionLevel(value) {
  return Number.isInteger(value) && value >= 1 && value <= 4;
}

export function permissionLevelInfo(level) {
  return PERMISSION_LEVELS[level] ?? null;
}

export function permissionRequiresConfirmation(level) {
  return PERMISSION_LEVELS[level]?.requiresConfirmation === true;
}

function requireEnum(value, allowed, field, errors) {
  if (!allowed.includes(value)) {
    errors.push(`${field}: deve ser um de ${allowed.join('|')}`);
    return allowed[0];
  }
  return value;
}

function requireText(value, { min = 0, max = Infinity }, field, errors) {
  if (typeof value !== 'string') {
    errors.push(`${field}: deve ser texto`);
    return '';
  }
  const clean = collapseText(value);
  if (clean.length < min) errors.push(`${field}: deve ter ao menos ${min} caracteres`);
  else if (clean.length > max) errors.push(`${field}: excede ${max} caracteres`);
  return clean;
}

function requireMultilineText(value, { min = 0, max = Infinity }, field, errors) {
  if (typeof value !== 'string') {
    errors.push(`${field}: deve ser texto`);
    return '';
  }
  const clean = trimText(value);
  if (clean.length < min) errors.push(`${field}: deve ter ao menos ${min} caracteres`);
  else if (clean.length > max) errors.push(`${field}: excede ${max} caracteres`);
  return clean;
}

function requireIsoDate(value, field, errors) {
  if (!isIsoDate(value)) errors.push(`${field}: deve ser data ISO-8601 com fuso (ex.: 2026-11-11T12:00:00.000Z)`);
  return value;
}

function requireId(value, kind, field, errors) {
  if (typeof value !== 'string' || !ID_RES[kind].test(value)) {
    errors.push(`${field}: formato esperado ${ID_PREFIXES[kind]}-<12 hex>`);
  }
  return value;
}

function requireToolName(value, field, errors) {
  if (typeof value !== 'string' || !TOOL_NAME_RE.test(value) || value.length > 60) {
    errors.push(`${field}: nome de ferramenta inválido (use namespace.nome, minúsculas)`);
  }
  return value;
}

function requireSkillId(value, field, errors) {
  if (typeof value !== 'string' || !SKILL_ID_RE.test(value)) {
    errors.push(`${field}: id de skill inválido (slug de 3 a 40 caracteres)`);
  }
  return value;
}

function requireSemver(value, field, errors) {
  if (typeof value !== 'string' || !SEMVER_RE.test(value)) errors.push(`${field}: versão deve ser semver (ex.: 1.0.0)`);
  return value;
}

function requireStringList(value, { maxItems, maxChars }, field, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${field}: deve ser uma lista`);
    return [];
  }
  if (value.length > maxItems) errors.push(`${field}: excede ${maxItems} itens`);
  const list = [];
  for (const [index, item] of value.slice(0, maxItems).entries()) {
    const clean = requireText(item, { min: 1, max: maxChars }, `${field}[${index}]`, errors);
    if (clean) list.push(clean);
  }
  return list;
}

function validateParameters(raw, errors, field = 'parameters') {
  if (!Array.isArray(raw)) {
    errors.push(`${field}: deve ser uma lista`);
    return [];
  }
  if (raw.length > AGENT_LIMITS.maxParameters) errors.push(`${field}: excede ${AGENT_LIMITS.maxParameters} itens`);
  const names = new Set();
  const list = [];
  for (const [index, parameter] of raw.slice(0, AGENT_LIMITS.maxParameters).entries()) {
    const at = `${field}[${index}]`;
    if (!isObject(parameter)) {
      errors.push(`${at}: deve ser um objeto`);
      continue;
    }
    const name = typeof parameter.name === 'string' ? parameter.name.trim() : '';
    if (!PARAM_NAME_RE.test(name)) errors.push(`${at}.name: formato inválido`);
    if (names.has(name)) errors.push(`${at}.name: duplicado (${name})`);
    names.add(name);
    const type = requireEnum(parameter.type, PARAMETER_TYPES, `${at}.type`, errors);
    const required = parameter.required === undefined ? false : parameter.required;
    if (typeof required !== 'boolean') errors.push(`${at}.required: deve ser booleano`);
    const item = { name, type, required: Boolean(required) };
    if (parameter.description !== undefined) {
      item.description = requireText(parameter.description, { max: AGENT_LIMITS.maxParameterDescriptionChars }, `${at}.description`, errors);
    }
    if (parameter.enum !== undefined) {
      const allowedType = type === 'number' ? 'number' : type === 'string' ? 'string' : null;
      if (!Array.isArray(parameter.enum) || parameter.enum.length === 0) {
        errors.push(`${at}.enum: deve ser uma lista não vazia`);
      } else if (!allowedType) {
        errors.push(`${at}.enum: só se aplica a parâmetros string ou number`);
      } else if (parameter.enum.some(option => typeof option !== allowedType)) {
        errors.push(`${at}.enum: valores devem ser ${allowedType}`);
      } else {
        item.enum = [...parameter.enum];
      }
    }
    list.push(item);
  }
  return list;
}

function validatePermissionList(raw, errors, field = 'permissions') {
  if (!Array.isArray(raw)) {
    errors.push(`${field}: deve ser uma lista de níveis 1..4`);
    return [];
  }
  const seen = new Set();
  const list = [];
  for (const level of raw) {
    if (!isPermissionLevel(level)) {
      errors.push(`${field}: nível inválido ${JSON.stringify(level)} (esperado 1..4)`);
      continue;
    }
    if (seen.has(level)) {
      errors.push(`${field}: nível duplicado ${level}`);
      continue;
    }
    seen.add(level);
    list.push(level);
  }
  return list.sort((a, b) => a - b);
}

// --- Intent ----------------------------------------------------------------

export function validateIntent(input) {
  const errors = [];
  if (!isObject(input)) return { ok: false, errors: ['intent: deve ser um objeto JSON'], value: null };
  if (input.schema !== AGENT_SCHEMAS.intent) errors.push(`schema: deve ser ${AGENT_SCHEMAS.intent}`);
  const id = requireId(input.id, 'intent', 'id', errors);
  const kind = requireEnum(input.kind, INTENT_KINDS, 'kind', errors);
  const goal = requireText(input.goal, { min: 3, max: AGENT_LIMITS.maxGoalChars }, 'goal', errors);
  const confidence = input.confidence;
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    errors.push('confidence: deve ser número entre 0 e 1');
  }
  const origin = requireEnum(input.origin, INTENT_ORIGINS, 'origin', errors);
  const createdAt = requireIsoDate(input.createdAt, 'createdAt', errors);
  if (errors.length) return { ok: false, errors, value: null };
  return { ok: true, errors: [], value: { schema: AGENT_SCHEMAS.intent, id, kind, goal, confidence, origin, createdAt } };
}

// --- Plan / PlanStep -------------------------------------------------------

export function validatePlanStep(input) {
  const errors = [];
  if (!isObject(input)) return { ok: false, errors: ['step: deve ser um objeto'], value: null };
  const id = requireId(input.id, 'step', 'step.id', errors);
  const title = requireText(input.title, { min: 3, max: AGENT_LIMITS.maxStepTitleChars }, 'step.title', errors);
  const status = input.status === undefined ? 'pending' : requireEnum(input.status, PLAN_STEP_STATUSES, 'step.status', errors);

  const dependsOn = [];
  if (input.dependsOn !== undefined) {
    if (!Array.isArray(input.dependsOn)) {
      errors.push('step.dependsOn: deve ser uma lista de ids de passos');
    } else {
      const seen = new Set();
      for (const dependency of input.dependsOn) {
        if (typeof dependency !== 'string' || !ID_RES.step.test(dependency)) {
          errors.push(`step.dependsOn: id inválido ${JSON.stringify(dependency)}`);
          continue;
        }
        if (dependency === id) errors.push('step.dependsOn: um passo não pode depender de si mesmo');
        if (seen.has(dependency)) errors.push(`step.dependsOn: duplicado (${dependency})`);
        seen.add(dependency);
        dependsOn.push(dependency);
      }
    }
  }

  const step = { id, title, status, dependsOn };
  if (input.tool !== undefined) step.tool = requireToolName(input.tool, 'step.tool', errors);
  if (input.permissionLevel !== undefined) {
    if (!isPermissionLevel(input.permissionLevel)) {
      errors.push('step.permissionLevel: nível inválido (esperado 1..4)');
    } else {
      step.permissionLevel = input.permissionLevel;
    }
  }
  if (input.effort !== undefined) step.effort = requireEnum(input.effort, EFFORTS, 'step.effort', errors);
  if (input.priority !== undefined) {
    if (!isIntegerBetween(input.priority, 1, 5)) errors.push('step.priority: deve ser inteiro de 1 (maior) a 5');
    else step.priority = input.priority;
  }
  return errors.length ? { ok: false, errors, value: null } : { ok: true, errors: [], value: step };
}

function hasDependencyCycle(steps) {
  const graph = new Map(steps.map(step => [step.id, step.dependsOn]));
  const visiting = new Set();
  const visited = new Set();
  const visit = id => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dependency of graph.get(id) ?? []) {
      if (graph.has(dependency) && visit(dependency)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return [...graph.keys()].some(id => visit(id));
}

function validateBriefing(raw, errors) {
  if (!isObject(raw)) {
    errors.push('briefing: deve ser um objeto {summary, missingInfo, risks}');
    return null;
  }
  const summary = requireText(raw.summary, { min: 3, max: AGENT_LIMITS.maxBriefingSummaryChars }, 'briefing.summary', errors);
  const missingInfo = raw.missingInfo === undefined
    ? []
    : requireStringList(raw.missingInfo, { maxItems: AGENT_LIMITS.maxBriefingItems, maxChars: AGENT_LIMITS.maxBriefingItemChars }, 'briefing.missingInfo', errors);
  const risks = raw.risks === undefined
    ? []
    : requireStringList(raw.risks, { maxItems: AGENT_LIMITS.maxBriefingItems, maxChars: AGENT_LIMITS.maxBriefingItemChars }, 'briefing.risks', errors);
  return { summary, missingInfo, risks };
}

export function validatePlan(input) {
  const errors = [];
  if (!isObject(input)) return { ok: false, errors: ['plan: deve ser um objeto JSON'], value: null };
  if (input.schema !== AGENT_SCHEMAS.plan) errors.push(`schema: deve ser ${AGENT_SCHEMAS.plan}`);
  const id = requireId(input.id, 'plan', 'id', errors);
  const goal = requireText(input.goal, { min: 3, max: AGENT_LIMITS.maxGoalChars }, 'goal', errors);
  if (!Number.isInteger(input.version) || input.version < 1) errors.push('version: deve ser inteiro >= 1');
  const status = requireEnum(input.status, PLAN_STATUSES, 'status', errors);
  const origin = requireEnum(input.origin, PLAN_ORIGINS, 'origin', errors);
  const createdAt = requireIsoDate(input.createdAt, 'createdAt', errors);
  let updatedAt;
  if (input.updatedAt !== undefined) {
    updatedAt = requireIsoDate(input.updatedAt, 'updatedAt', errors);
    if (isIsoDate(createdAt) && isIsoDate(updatedAt) && Date.parse(updatedAt) < Date.parse(createdAt)) {
      errors.push('updatedAt: não pode ser anterior a createdAt');
    }
  }

  if (!Array.isArray(input.steps) || input.steps.length === 0) {
    errors.push('steps: plano precisa de ao menos um passo');
  } else if (input.steps.length > AGENT_LIMITS.maxSteps) {
    errors.push(`steps: excede ${AGENT_LIMITS.maxSteps} passos`);
  }
  const steps = [];
  const stepIds = new Set();
  for (const [index, rawStep] of (Array.isArray(input.steps) ? input.steps.slice(0, AGENT_LIMITS.maxSteps) : []).entries()) {
    const result = validatePlanStep(rawStep);
    if (!result.ok) {
      errors.push(...result.errors.map(error => `steps[${index}]: ${error}`));
      continue;
    }
    if (stepIds.has(result.value.id)) errors.push(`steps[${index}].id: duplicado (${result.value.id})`);
    stepIds.add(result.value.id);
    steps.push(result.value);
  }
  for (const step of steps) {
    for (const dependency of step.dependsOn) {
      if (!stepIds.has(dependency)) errors.push(`step ${step.id}: depende de passo inexistente ${dependency}`);
    }
  }
  if (hasDependencyCycle(steps)) errors.push('steps: dependências formam ciclo');

  const briefing = input.briefing === undefined ? undefined : validateBriefing(input.briefing, errors);
  if (errors.length) return { ok: false, errors, value: null };
  const value = { schema: AGENT_SCHEMAS.plan, id, goal, version: input.version, status, origin, createdAt, steps };
  if (updatedAt) value.updatedAt = updatedAt;
  if (briefing) value.briefing = briefing;
  return { ok: true, errors: [], value };
}

// --- ToolSpec --------------------------------------------------------------

export function validateToolSpec(input) {
  const errors = [];
  if (!isObject(input)) return { ok: false, errors: ['tool: deve ser um objeto'], value: null };
  if (input.schema !== AGENT_SCHEMAS.tool) errors.push(`schema: deve ser ${AGENT_SCHEMAS.tool}`);
  const name = requireToolName(input.name, 'name', errors);
  const version = requireSemver(input.version, 'version', errors);
  const description = requireText(input.description, { min: 3, max: AGENT_LIMITS.maxDescriptionChars }, 'description', errors);
  const origin = requireEnum(input.origin, TOOL_ORIGINS, 'origin', errors);
  if (!isPermissionLevel(input.permissionLevel)) errors.push('permissionLevel: nível inválido (esperado 1..4)');
  if (!isIntegerBetween(input.timeoutMs, AGENT_LIMITS.minToolTimeoutMs, AGENT_LIMITS.maxToolTimeoutMs)) {
    errors.push(`timeoutMs: deve ser inteiro entre ${AGENT_LIMITS.minToolTimeoutMs} e ${AGENT_LIMITS.maxToolTimeoutMs}`);
  }
  const parameters = validateParameters(input.parameters, errors);
  if (typeof input.verify !== 'function') errors.push('verify: ferramenta precisa de verify(result) → boolean');
  if (input.execute !== undefined && typeof input.execute !== 'function') errors.push('execute: quando presente, deve ser função');
  if (errors.length) return { ok: false, errors, value: null };
  const value = {
    schema: AGENT_SCHEMAS.tool,
    name,
    version,
    description,
    origin,
    permissionLevel: input.permissionLevel,
    timeoutMs: input.timeoutMs,
    parameters,
    verify: input.verify,
  };
  if (input.execute !== undefined) value.execute = input.execute;
  return { ok: true, errors: [], value };
}

// --- SkillManifest ---------------------------------------------------------

function validateTestDeclaration(raw, errors) {
  if (!isObject(raw)) {
    errors.push('tests: deve ser um objeto {files, timeoutMs}');
    return null;
  }
  if (!Array.isArray(raw.files) || raw.files.length === 0) {
    errors.push('tests.files: skill precisa declarar ao menos um arquivo de teste');
    return null;
  }
  if (raw.files.length > AGENT_LIMITS.maxTestFiles) errors.push(`tests.files: excede ${AGENT_LIMITS.maxTestFiles}`);
  const files = [];
  for (const [index, file] of raw.files.slice(0, AGENT_LIMITS.maxTestFiles).entries()) {
    const clean = typeof file === 'string' ? file.trim() : '';
    const segments = clean.split('/');
    if (!clean || clean.includes('\\') || clean.startsWith('/') || segments.includes('..')) {
      errors.push(`tests.files[${index}]: caminho inválido (use caminho relativo dentro do pacote da skill)`);
      continue;
    }
    if (!/^[\w.-]+(?:\/[\w.-]+)*\.test\.mjs$/.test(clean)) {
      errors.push(`tests.files[${index}]: deve apontar para um arquivo .test.mjs`);
      continue;
    }
    files.push(clean);
  }
  const declaration = { files };
  if (raw.timeoutMs !== undefined) {
    if (!isIntegerBetween(raw.timeoutMs, AGENT_LIMITS.minToolTimeoutMs, AGENT_LIMITS.maxSkillTestTimeoutMs)) {
      errors.push(`tests.timeoutMs: deve ser inteiro entre ${AGENT_LIMITS.minToolTimeoutMs} e ${AGENT_LIMITS.maxSkillTestTimeoutMs}`);
    } else {
      declaration.timeoutMs = raw.timeoutMs;
    }
  }
  return declaration;
}

export function validateSkillManifest(input) {
  const errors = [];
  if (!isObject(input)) return { ok: false, errors: ['skill: deve ser um objeto JSON'], value: null };
  if (input.schema !== AGENT_SCHEMAS.skill) errors.push(`schema: deve ser ${AGENT_SCHEMAS.skill}`);
  const id = requireSkillId(input.id, 'id', errors);
  const name = requireText(input.name, { min: 3, max: 80 }, 'name', errors);
  const version = requireSemver(input.version, 'version', errors);
  const description = requireText(input.description, { min: 3, max: AGENT_LIMITS.maxDescriptionChars }, 'description', errors);
  const state = requireEnum(input.state, SKILL_STATES, 'state', errors);
  const origin = requireEnum(input.origin, SKILL_ORIGINS, 'origin', errors);
  const createdAt = requireIsoDate(input.createdAt, 'createdAt', errors);
  let updatedAt;
  if (input.updatedAt !== undefined) {
    updatedAt = requireIsoDate(input.updatedAt, 'updatedAt', errors);
    if (isIsoDate(createdAt) && isIsoDate(updatedAt) && Date.parse(updatedAt) < Date.parse(createdAt)) {
      errors.push('updatedAt: não pode ser anterior a createdAt');
    }
  }

  const tools = [];
  if (!Array.isArray(input.tools)) {
    errors.push('tools: deve ser uma lista de nomes de ferramentas');
  } else {
    if (input.tools.length > AGENT_LIMITS.maxTools) errors.push(`tools: excede ${AGENT_LIMITS.maxTools}`);
    const seen = new Set();
    for (const tool of input.tools.slice(0, AGENT_LIMITS.maxTools)) {
      requireToolName(tool, 'tools', errors);
      if (seen.has(tool)) errors.push(`tools: duplicada (${tool})`);
      seen.add(tool);
      tools.push(tool);
    }
  }

  const permissions = validatePermissionList(input.permissions, errors);

  const dependencies = [];
  if (!Array.isArray(input.dependencies)) {
    errors.push('dependencies: deve ser uma lista de ids de skills');
  } else {
    if (input.dependencies.length > AGENT_LIMITS.maxDependencies) errors.push(`dependencies: excede ${AGENT_LIMITS.maxDependencies}`);
    const seen = new Set();
    for (const dependency of input.dependencies.slice(0, AGENT_LIMITS.maxDependencies)) {
      requireSkillId(dependency, 'dependencies', errors);
      if (dependency === id) errors.push('dependencies: skill não pode depender de si mesma');
      if (seen.has(dependency)) errors.push(`dependencies: duplicada (${dependency})`);
      seen.add(dependency);
      dependencies.push(dependency);
    }
  }

  const parameters = validateParameters(input.parameters, errors);
  const instructions = requireMultilineText(input.instructions, { min: 1, max: AGENT_LIMITS.maxInstructionsChars }, 'instructions', errors);
  const tests = validateTestDeclaration(input.tests, errors);

  if (errors.length) return { ok: false, errors, value: null };
  const value = {
    schema: AGENT_SCHEMAS.skill,
    id,
    name,
    version,
    description,
    state,
    origin,
    createdAt,
    tools,
    permissions,
    maxPermissionLevel: permissions.length ? permissions[permissions.length - 1] : null,
    dependencies,
    parameters,
    instructions,
    tests,
  };
  if (updatedAt) value.updatedAt = updatedAt;
  return { ok: true, errors: [], value };
}

// --- ExecutionRecord -------------------------------------------------------

export function validateExecutionRecord(input) {
  const errors = [];
  if (!isObject(input)) return { ok: false, errors: ['execution: deve ser um objeto JSON'], value: null };
  if (input.schema !== AGENT_SCHEMAS.execution) errors.push(`schema: deve ser ${AGENT_SCHEMAS.execution}`);
  const id = requireId(input.id, 'execution', 'id', errors);
  const tool = requireToolName(input.tool, 'tool', errors);
  const status = requireEnum(input.status, EXECUTION_STATUSES, 'status', errors);
  if (!isPermissionLevel(input.permissionLevel)) errors.push('permissionLevel: nível inválido (esperado 1..4)');
  const origin = requireEnum(input.origin, EXECUTION_ORIGINS, 'origin', errors);
  const startedAt = requireIsoDate(input.startedAt, 'startedAt', errors);
  let finishedAt;
  if (input.finishedAt !== undefined) {
    finishedAt = requireIsoDate(input.finishedAt, 'finishedAt', errors);
    if (isIsoDate(startedAt) && isIsoDate(finishedAt) && Date.parse(finishedAt) < Date.parse(startedAt)) {
      errors.push('finishedAt: não pode ser anterior a startedAt');
    }
  }
  if (input.durationMs !== undefined) {
    if (!isIntegerBetween(input.durationMs, 0, AGENT_LIMITS.maxDurationMs)) {
      errors.push(`durationMs: deve ser inteiro entre 0 e ${AGENT_LIMITS.maxDurationMs}`);
    }
  }
  if (typeof input.verified !== 'boolean') errors.push('verified: deve ser booleano');

  let reason;
  if (input.reason !== undefined) {
    reason = requireText(input.reason, { min: 3, max: AGENT_LIMITS.maxReasonChars }, 'reason', errors);
  }
  if (status !== 'ok' && reason === undefined) errors.push(`reason: obrigatório quando status é ${status}`);
  if (typeof input.verified === 'boolean') {
    if (status === 'ok' && input.verified !== true) errors.push('verified: execução ok só é registrada com verify() aprovado');
    if (status !== 'ok' && input.verified === true) errors.push('verified: status sem sucesso não pode estar verificado');
  }

  const value = {
    schema: AGENT_SCHEMAS.execution,
    id,
    tool,
    status,
    permissionLevel: input.permissionLevel,
    origin,
    startedAt,
    verified: input.verified,
  };
  if (finishedAt) value.finishedAt = finishedAt;
  if (input.durationMs !== undefined) value.durationMs = input.durationMs;
  if (reason !== undefined) value.reason = reason;
  if (input.planId !== undefined) value.planId = requireId(input.planId, 'plan', 'planId', errors);
  if (input.stepId !== undefined) value.stepId = requireId(input.stepId, 'step', 'stepId', errors);
  if (input.inputSummary !== undefined) {
    value.inputSummary = requireText(input.inputSummary, { max: AGENT_LIMITS.maxInputSummaryChars }, 'inputSummary', errors);
  }
  if (errors.length) return { ok: false, errors, value: null };
  return { ok: true, errors: [], value };
}

// --- OperationalRecord -----------------------------------------------------

export function validateOperationalRecord(input) {
  const errors = [];
  if (!isObject(input)) return { ok: false, errors: ['record: deve ser um objeto JSON'], value: null };
  if (input.schema !== AGENT_SCHEMAS.operational) errors.push(`schema: deve ser ${AGENT_SCHEMAS.operational}`);
  const id = requireId(input.id, 'operational', 'id', errors);
  const kind = requireEnum(input.kind, OPERATIONAL_KINDS, 'kind', errors);
  const title = requireText(input.title, { min: 3, max: AGENT_LIMITS.maxOperationalTitleChars }, 'title', errors);
  const status = requireEnum(input.status, OPERATIONAL_STATUSES, 'status', errors);
  const origin = requireEnum(input.origin, OPERATIONAL_ORIGINS, 'origin', errors);
  if (typeof input.relevance !== 'number' || !Number.isFinite(input.relevance) || input.relevance < 0 || input.relevance > 1) {
    errors.push('relevance: deve ser número entre 0 e 1');
  }
  const createdAt = requireIsoDate(input.createdAt, 'createdAt', errors);
  const updatedAt = requireIsoDate(input.updatedAt, 'updatedAt', errors);
  if (isIsoDate(createdAt) && isIsoDate(updatedAt) && Date.parse(updatedAt) < Date.parse(createdAt)) {
    errors.push('updatedAt: não pode ser anterior a createdAt');
  }
  const value = {
    schema: AGENT_SCHEMAS.operational,
    id,
    kind,
    title,
    status,
    origin,
    relevance: input.relevance,
    createdAt,
    updatedAt,
  };
  if (input.dueAt !== undefined) {
    if (typeof input.dueAt !== 'string' || !DUE_DATE_RE.test(input.dueAt) || Number.isNaN(Date.parse(input.dueAt))) {
      errors.push('dueAt: deve ser data ISO-8601 (com fuso) ou YYYY-MM-DD');
    } else {
      value.dueAt = input.dueAt;
    }
  }
  if (input.projectId !== undefined) {
    if (typeof input.projectId !== 'string' || !ID_RES.operational.test(input.projectId)) {
      errors.push('projectId: formato esperado op-<12 hex>');
    } else {
      value.projectId = input.projectId;
    }
  }
  if (errors.length) return { ok: false, errors, value: null };
  return { ok: true, errors: [], value };
}
