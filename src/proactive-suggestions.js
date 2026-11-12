/**
 * Sugestões proativas contextuais (S12) — separadas do fluxo de execução e do
 * comando `proactive_say` de idle/afinidade.
 *
 * Fontes contextuais (injetáveis, com relógio e dados sob controle do chamador):
 *   - tarefa atrasada (`overdue_task`)
 *   - reunião/compromisso próximo (`upcoming_commitment`)
 *   - projeto parado (`stalled_project`)
 *   - lacuna de skill/ferramenta (`skill_gap`)
 *
 * Persistência atômica (tmp + rename) em `data/suggestions.json`, mantendo o
 * ciclo `suggested -> planned -> authorized -> verified` (e `dismissed`), sem
 * gravar em disco durante `load()` quando o arquivo ainda não existe.
 *
 * Guardas: DND (janela Não Perturbe), teto de uma sugestão não respondida e
 * throttle por relevância + cooldown por `dedupeKey`. Aceitar gera um plano
 * aprovado em `task-planner`, mas nunca executa ferramenta automaticamente.
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { dataDir as resolveDataDir } from './data-paths.js';
import { AGENT_LIMITS } from './agent-contracts.js';

const FILE_NAME = 'suggestions.json';
const FILE_VERSION = 1;
const MAX_SUGGESTIONS = 500;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

export const SUGGESTION_SCHEMA = 'usami.agent.suggestion.v1';
export const SUGGESTION_ID_RE = /^sg-[0-9a-f]{12}$/;
export const SUGGESTION_STATUSES = Object.freeze(['suggested', 'planned', 'authorized', 'verified', 'dismissed']);
export const SUGGESTION_KINDS = Object.freeze(['overdue_task', 'upcoming_commitment', 'stalled_project', 'skill_gap', 'custom']);
export const SUGGESTIONS_DEFAULT_LIMIT = 50;
export const SUGGESTIONS_MAX_LIMIT = 200;

export const DEFAULT_MIN_RELEVANCE = 0.35;
export const DEFAULT_MAX_UNANSWERED_SUGGESTIONS = 1;
export const DEFAULT_UPCOMING_WINDOW_MS = 4 * HOUR_MS;
export const DEFAULT_STALLED_PROJECT_MS = 7 * DAY_MS;
export const DEFAULT_DISMISS_SNOOZE_MS = DAY_MS;
export const DEFAULT_RELEVANCE_COOLDOWNS_MS = Object.freeze({
  high: 15 * MINUTE_MS,
  medium: 60 * MINUTE_MS,
  low: 4 * HOUR_MS,
});

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const PLAN_ID_RE = /^pl-[0-9a-f]{12}$/;
const EXECUTION_ID_RE = /^ex-[0-9a-f]{12}$/;

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isIsoDate = value => typeof value === 'string' && ISO_RE.test(value) && !Number.isNaN(Date.parse(value));
const clamp01 = value => (Number.isFinite(value) ? Math.min(1, Math.max(0, Number(value))) : 0);
const collapse = value => String(value ?? '').trim().replace(/\s+/g, ' ');
const truncate = (text, max) => (text.length <= max ? text : text.slice(0, max));

const KIND_TIE_ORDER = Object.freeze({
  overdue_task: 1,
  upcoming_commitment: 2,
  skill_gap: 3,
  stalled_project: 4,
  custom: 5,
});

function defaultQuietHoursCheck(date = new Date(), startHour = 23.5, endHour = 8.5) {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return false;
  const current = d.getHours() + d.getMinutes() / 60;
  return startHour > endHour ? current >= startHour || current < endHour : current >= startHour && current < endHour;
}

function parseDeadlineMs(dueAt) {
  if (typeof dueAt !== 'string' || !dueAt.trim()) return null;
  const parsed = Date.parse(dueAt);
  if (Number.isNaN(parsed)) return null;
  // Data sem horário vale até o fim do dia correspondente.
  return DATE_ONLY_RE.test(dueAt.trim()) ? parsed + DAY_MS : parsed;
}

function parseStartMs(dueAt) {
  if (typeof dueAt !== 'string' || !dueAt.trim()) return null;
  const parsed = Date.parse(dueAt);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Calcula o intervalo mínimo entre sugestões de acordo com a relevância.
 * Relevância alta (>= 0.8) tem cooldown menor; relevância baixa espera mais.
 */
export function cooldownForRelevance(relevance, cooldowns = DEFAULT_RELEVANCE_COOLDOWNS_MS) {
  const score = clamp01(relevance);
  const high = Number.isFinite(cooldowns?.high) ? Math.max(0, cooldowns.high) : DEFAULT_RELEVANCE_COOLDOWNS_MS.high;
  const medium = Number.isFinite(cooldowns?.medium) ? Math.max(0, cooldowns.medium) : DEFAULT_RELEVANCE_COOLDOWNS_MS.medium;
  const low = Number.isFinite(cooldowns?.low) ? Math.max(0, cooldowns.low) : DEFAULT_RELEVANCE_COOLDOWNS_MS.low;
  if (score >= 0.8) return high;
  if (score >= 0.55) return medium;
  return low;
}

export function validateSuggestion(raw) {
  const errors = [];
  if (!isPlainObject(raw)) return { ok: false, errors: ['suggestion: deve ser um objeto'] };
  if (raw.schema !== SUGGESTION_SCHEMA) errors.push(`suggestion.schema: esperado ${SUGGESTION_SCHEMA}`);
  if (typeof raw.id !== 'string' || !SUGGESTION_ID_RE.test(raw.id)) errors.push('suggestion.id: formato esperado sg-<12 hex>');
  if (!SUGGESTION_KINDS.includes(raw.kind)) errors.push(`suggestion.kind: deve ser um de ${SUGGESTION_KINDS.join('|')}`);
  if (!SUGGESTION_STATUSES.includes(raw.status)) errors.push(`suggestion.status: deve ser um de ${SUGGESTION_STATUSES.join('|')}`);

  const title = typeof raw.title === 'string' ? collapse(raw.title) : '';
  if (!title || title.length > 200) errors.push('suggestion.title: obrigatório (1..200 caracteres)');

  const summary = typeof raw.summary === 'string' ? collapse(raw.summary) : '';
  if (raw.summary !== undefined && typeof raw.summary !== 'string') errors.push('suggestion.summary: deve ser texto');
  if (summary.length > 500) errors.push('suggestion.summary: excede 500 caracteres');

  const recommendedGoal = typeof raw.recommendedGoal === 'string' ? collapse(raw.recommendedGoal) : '';
  if (!recommendedGoal || recommendedGoal.length > AGENT_LIMITS.maxGoalChars) {
    errors.push(`suggestion.recommendedGoal: obrigatório (1..${AGENT_LIMITS.maxGoalChars} caracteres)`);
  }

  if (typeof raw.relevance !== 'number' || !Number.isFinite(raw.relevance) || raw.relevance < 0 || raw.relevance > 1) {
    errors.push('suggestion.relevance: deve ser número entre 0 e 1');
  }

  const dedupeKey = typeof raw.dedupeKey === 'string' ? raw.dedupeKey.trim() : '';
  if (!dedupeKey || dedupeKey.length > 160) errors.push('suggestion.dedupeKey: obrigatório (1..160 caracteres)');

  if (!isIsoDate(raw.createdAt)) errors.push('suggestion.createdAt: deve ser ISO-8601 com fuso');
  if (!isIsoDate(raw.updatedAt)) errors.push('suggestion.updatedAt: deve ser ISO-8601 com fuso');
  if (raw.plannedAt !== undefined && !isIsoDate(raw.plannedAt)) errors.push('suggestion.plannedAt: deve ser ISO-8601 com fuso');
  if (raw.authorizedAt !== undefined && !isIsoDate(raw.authorizedAt)) errors.push('suggestion.authorizedAt: deve ser ISO-8601 com fuso');
  if (raw.verifiedAt !== undefined && !isIsoDate(raw.verifiedAt)) errors.push('suggestion.verifiedAt: deve ser ISO-8601 com fuso');
  if (raw.dismissedAt !== undefined && !isIsoDate(raw.dismissedAt)) errors.push('suggestion.dismissedAt: deve ser ISO-8601 com fuso');
  if (raw.planId !== undefined && (typeof raw.planId !== 'string' || !PLAN_ID_RE.test(raw.planId))) {
    errors.push('suggestion.planId: formato inválido');
  }
  if (raw.executionId !== undefined && (typeof raw.executionId !== 'string' || !EXECUTION_ID_RE.test(raw.executionId))) {
    errors.push('suggestion.executionId: formato inválido');
  }
  if (raw.sourceId !== undefined && (typeof raw.sourceId !== 'string' || !raw.sourceId.trim() || raw.sourceId.length > 100)) {
    errors.push('suggestion.sourceId: inválido');
  }
  if (raw.dismissReason !== undefined && (typeof raw.dismissReason !== 'string' || raw.dismissReason.length > 200)) {
    errors.push('suggestion.dismissReason: inválido');
  }
  if (raw.history !== undefined && !Array.isArray(raw.history)) {
    errors.push('suggestion.history: deve ser lista');
  }

  if (errors.length) return { ok: false, errors };

  const history = (raw.history || [])
    .filter(item => isPlainObject(item) && SUGGESTION_STATUSES.includes(item.status) && isIsoDate(item.at))
    .slice(-20)
    .map(item => ({
      status: item.status,
      at: item.at,
      ...(typeof item.planId === 'string' && PLAN_ID_RE.test(item.planId) ? { planId: item.planId } : {}),
      ...(typeof item.executionId === 'string' && EXECUTION_ID_RE.test(item.executionId) ? { executionId: item.executionId } : {}),
      ...(typeof item.note === 'string' && item.note.trim() ? { note: truncate(collapse(item.note), 200) } : {}),
    }));

  const normalized = {
    schema: SUGGESTION_SCHEMA,
    id: raw.id,
    kind: raw.kind,
    title: truncate(title, 200),
    summary: truncate(summary, 500),
    recommendedGoal: truncate(recommendedGoal, AGENT_LIMITS.maxGoalChars),
    status: raw.status,
    relevance: Number(raw.relevance.toFixed(4)),
    dedupeKey,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    history,
  };
  if (raw.sourceId) normalized.sourceId = raw.sourceId.trim();
  if (raw.plannedAt) normalized.plannedAt = raw.plannedAt;
  if (raw.authorizedAt) normalized.authorizedAt = raw.authorizedAt;
  if (raw.verifiedAt) normalized.verifiedAt = raw.verifiedAt;
  if (raw.dismissedAt) normalized.dismissedAt = raw.dismissedAt;
  if (raw.planId) normalized.planId = raw.planId;
  if (raw.executionId) normalized.executionId = raw.executionId;
  if (raw.dismissReason) normalized.dismissReason = truncate(collapse(raw.dismissReason), 200);

  return { ok: true, value: normalized };
}

export function collectOverdueTaskSuggestions({ now, operationalRecords = [] } = {}) {
  if (!Array.isArray(operationalRecords)) return [];
  const currentNow = Number.isFinite(now) ? now : Date.now();
  const candidates = [];
  for (const record of operationalRecords) {
    if (!isPlainObject(record) || record.kind !== 'task') continue;
    if (record.status !== 'open' && record.status !== 'in_progress' && record.status !== 'blocked') continue;
    const deadlineMs = parseDeadlineMs(record.dueAt);
    if (deadlineMs === null || currentNow <= deadlineMs) continue;

    const overdueHours = (currentNow - deadlineMs) / HOUR_MS;
    const baseRel = Number.isFinite(record.relevance) ? clamp01(record.relevance) : 0.5;
    const relevance = clamp01(0.55 + baseRel * 0.4 + Math.min(0.15, overdueHours * 0.01));
    candidates.push({
      kind: 'overdue_task',
      sourceId: record.id,
      dedupeKey: `overdue_task:${record.id}:${record.dueAt}`,
      relevance,
      title: truncate(`Tarefa vencida: ${record.title}`, 200),
      summary: truncate(`Prazo ${record.dueAt} já passou; deseja montar um plano para concluir ou replanejar?`, 500),
      recommendedGoal: truncate(`Retomar e concluir a tarefa atrasada: ${record.title}`, AGENT_LIMITS.maxGoalChars),
    });
  }
  return candidates;
}

export function collectUpcomingCommitmentSuggestions({
  now,
  operationalRecords = [],
  upcomingWindowMs = DEFAULT_UPCOMING_WINDOW_MS,
} = {}) {
  if (!Array.isArray(operationalRecords)) return [];
  const currentNow = Number.isFinite(now) ? now : Date.now();
  const windowMs = Number.isFinite(upcomingWindowMs) && upcomingWindowMs > 0 ? upcomingWindowMs : DEFAULT_UPCOMING_WINDOW_MS;
  const candidates = [];

  for (const record of operationalRecords) {
    if (!isPlainObject(record) || record.kind !== 'commitment') continue;
    if (record.status !== 'open' && record.status !== 'in_progress') continue;
    const startMs = parseStartMs(record.dueAt);
    if (startMs === null) continue;
    const leadMs = startMs - currentNow;
    if (leadMs < 0 || leadMs > windowMs) continue;

    const proximity = 1 - leadMs / windowMs;
    const baseRel = Number.isFinite(record.relevance) ? clamp01(record.relevance) : 0.5;
    const relevance = clamp01(0.55 + proximity * 0.3 + baseRel * 0.15);
    const minutesLeft = Math.max(1, Math.round(leadMs / MINUTE_MS));
    const leadLabel = minutesLeft >= 60 ? `${Math.round(minutesLeft / 60)}h` : `${minutesLeft} min`;

    candidates.push({
      kind: 'upcoming_commitment',
      sourceId: record.id,
      dedupeKey: `upcoming_commitment:${record.id}:${record.dueAt}`,
      relevance,
      title: truncate(`Compromisso próximo (${leadLabel}): ${record.title}`, 200),
      summary: truncate(`Marcado para ${record.dueAt}; posso organizar os preparativos antes do horário.`, 500),
      recommendedGoal: truncate(`Preparar pauta e lembretes para o compromisso: ${record.title}`, AGENT_LIMITS.maxGoalChars),
    });
  }
  return candidates;
}

export function collectStalledProjectSuggestions({
  now,
  operationalRecords = [],
  stalledProjectMs = DEFAULT_STALLED_PROJECT_MS,
} = {}) {
  if (!Array.isArray(operationalRecords)) return [];
  const currentNow = Number.isFinite(now) ? now : Date.now();
  const thresholdMs = Number.isFinite(stalledProjectMs) && stalledProjectMs > 0 ? stalledProjectMs : DEFAULT_STALLED_PROJECT_MS;
  const candidates = [];

  for (const project of operationalRecords) {
    if (!isPlainObject(project) || project.kind !== 'project') continue;
    if (project.status !== 'open' && project.status !== 'in_progress' && project.status !== 'blocked') continue;

    let lastTouchMs = Date.parse(project.updatedAt || project.createdAt || '');
    if (Number.isNaN(lastTouchMs)) continue;
    for (const child of operationalRecords) {
      if (!isPlainObject(child) || child.projectId !== project.id) continue;
      const childMs = Date.parse(child.updatedAt || child.createdAt || '');
      if (!Number.isNaN(childMs) && childMs > lastTouchMs) lastTouchMs = childMs;
    }

    const idleMs = currentNow - lastTouchMs;
    if (idleMs < thresholdMs) continue;

    const daysStalled = Math.max(1, Math.floor(idleMs / DAY_MS));
    const baseRel = Number.isFinite(project.relevance) ? clamp01(project.relevance) : 0.5;
    const relevance = clamp01(0.45 + baseRel * 0.25 + Math.min(0.15, (daysStalled - 7) * 0.01));

    candidates.push({
      kind: 'stalled_project',
      sourceId: project.id,
      dedupeKey: `stalled_project:${project.id}:${new Date(lastTouchMs).toISOString().slice(0, 10)}`,
      relevance,
      title: truncate(`Projeto parado há ${daysStalled} dias: ${project.title}`, 200),
      summary: truncate(`Sem movimentação recente neste projeto; vale definir um próximo passo simples.`, 500),
      recommendedGoal: truncate(`Revisar o projeto parado ${project.title} e definir próximo passo`, AGENT_LIMITS.maxGoalChars),
    });
  }
  return candidates;
}

export function collectSkillGapSuggestions({ skills = [], tools = [], plans = [] } = {}) {
  const candidates = [];
  const registeredTools = new Set(
    Array.isArray(tools) ? tools.map(tool => (typeof tool === 'string' ? tool : tool?.name)).filter(Boolean) : [],
  );

  if (Array.isArray(skills)) {
    for (const skill of skills) {
      if (!isPlainObject(skill) || typeof skill.id !== 'string') continue;
      if (skill.valid === false) {
        candidates.push({
          kind: 'skill_gap',
          sourceId: skill.id,
          dedupeKey: `skill_gap:invalid:${skill.id}`,
          relevance: 0.65,
          title: truncate(`Skill com manifesto inválido: ${skill.id}`, 200),
          summary: truncate((skill.errors || ['manifesto inválido']).slice(0, 2).join('; '), 500),
          recommendedGoal: truncate(`Corrigir manifesto inválido da skill ${skill.id}`, AGENT_LIMITS.maxGoalChars),
        });
        continue;
      }

      const missingTools = Array.isArray(skill.missing?.tools) ? skill.missing.tools : [];
      const missingDeps = Array.isArray(skill.missing?.dependencies) ? skill.missing.dependencies : [];
      const hasMissing = missingTools.length > 0 || missingDeps.length > 0;
      const isBrokenInstalled = skill.state === 'installed' && skill.activation?.canActivate === false;
      const isPending = skill.state === 'pending';

      if (!hasMissing && !isBrokenInstalled && !isPending) continue;

      const gapParts = [];
      if (missingTools.length) gapParts.push(`ferramentas: ${missingTools.join(', ')}`);
      if (missingDeps.length) gapParts.push(`dependências: ${missingDeps.join(', ')}`);
      if (!gapParts.length && isPending) gapParts.push('aguardando aprovação e teste isolado');
      if (!gapParts.length && Array.isArray(skill.activation?.reasons)) {
        gapParts.push(skill.activation.reasons.slice(0, 2).join('; '));
      }

      const reasonSummary = gapParts.join('; ') || 'requisito ausente';
      const relevance = isBrokenInstalled ? 0.78 : hasMissing ? 0.7 : 0.58;
      candidates.push({
        kind: 'skill_gap',
        sourceId: skill.id,
        dedupeKey: `skill_gap:${skill.id}:${missingTools.join(',')}|${missingDeps.join(',')}|${skill.state}`,
        relevance,
        title: truncate(`Lacuna na skill ${skill.name || skill.id}`, 200),
        summary: truncate(`Pendência detectada (${reasonSummary}).`, 500),
        recommendedGoal: truncate(`Resolver lacuna da skill ${skill.id}: ${reasonSummary}`, AGENT_LIMITS.maxGoalChars),
      });
    }
  }

  if (Array.isArray(plans) && tools !== null && tools !== undefined) {
    const seenMissingTools = new Set();
    for (const plan of plans) {
      if (!isPlainObject(plan)) continue;
      if (!['draft', 'awaiting_approval', 'approved', 'running'].includes(plan.status)) continue;
      for (const step of plan.steps || []) {
        if (!isPlainObject(step) || typeof step.tool !== 'string' || !step.tool) continue;
        if (registeredTools.has(step.tool) || seenMissingTools.has(step.tool)) continue;
        seenMissingTools.add(step.tool);
        candidates.push({
          kind: 'skill_gap',
          sourceId: step.tool,
          dedupeKey: `skill_gap:tool:${step.tool}`,
          relevance: 0.76,
          title: truncate(`Ferramenta ausente em plano ativo: ${step.tool}`, 200),
          summary: truncate(`O plano ${plan.id || ''} depende de ${step.tool}, que não está registrada.`, 500),
          recommendedGoal: truncate(`Disponibilizar a ferramenta ${step.tool} para destravar o plano`, AGENT_LIMITS.maxGoalChars),
        });
      }
    }
  }

  return candidates;
}

/**
 * Monta as quatro fontes padrão de sugestão usando providers injetáveis.
 */
export function createDefaultSuggestionSources({
  operationalProvider = () => [],
  plansProvider = () => [],
  skillsProvider = () => [],
  toolsProvider = () => [],
  upcomingWindowMs = DEFAULT_UPCOMING_WINDOW_MS,
  stalledProjectMs = DEFAULT_STALLED_PROJECT_MS,
} = {}) {
  const readList = provider => {
    try {
      const value = typeof provider === 'function' ? provider() : provider;
      return Array.isArray(value) ? value : [];
    } catch {
      return [];
    }
  };

  return [
    ({ now }) => collectOverdueTaskSuggestions({ now, operationalRecords: readList(operationalProvider) }),
    ({ now }) => collectUpcomingCommitmentSuggestions({
      now,
      operationalRecords: readList(operationalProvider),
      upcomingWindowMs,
    }),
    ({ now }) => collectStalledProjectSuggestions({
      now,
      operationalRecords: readList(operationalProvider),
      stalledProjectMs,
    }),
    () => collectSkillGapSuggestions({
      skills: readList(skillsProvider),
      tools: readList(toolsProvider),
      plans: readList(plansProvider),
    }),
  ];
}

export function createSuggestionStore({
  dataDir = resolveDataDir(),
  filePath = join(dataDir, FILE_NAME),
  now = () => Date.now(),
  onLoadError = message => console.error(message),
} = {}) {
  if (!dataDir || typeof dataDir !== 'string') throw new Error('createSuggestionStore: dataDir é obrigatório.');
  const isoNow = () => new Date(now()).toISOString();
  const clone = value => JSON.parse(JSON.stringify(value));
  const defaultData = () => ({ fileVersion: FILE_VERSION, suggestions: [], lastSuggestedAt: null, updatedAt: isoNow() });

  let data = defaultData();
  let loadFailed = false;

  function assertWritable() {
    if (loadFailed) throw new Error('sugestões proativas: arquivo inválido não foi carregado; escrita recusada');
  }

  function persist() {
    mkdirSync(dirname(filePath), { recursive: true });
    data.updatedAt = isoNow();
    if (data.suggestions.length > MAX_SUGGESTIONS) {
      data.suggestions.splice(0, data.suggestions.length - MAX_SUGGESTIONS);
    }
    const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temporary, JSON.stringify(data, null, 2), 'utf8');
    try {
      renameSync(temporary, filePath);
    } catch (error) {
      try { unlinkSync(temporary); } catch {}
      if (error?.code !== 'EEXIST' && error?.code !== 'EPERM') throw error;
    }
  }

  function normalize(raw) {
    if (!isPlainObject(raw)) throw new Error('arquivo deve ser um objeto JSON');
    if (raw.fileVersion !== FILE_VERSION) throw new Error(`versão ${JSON.stringify(raw.fileVersion)} não suportada`);
    if (!Array.isArray(raw.suggestions)) throw new Error('campo suggestions deve ser lista');
    if (raw.lastSuggestedAt !== null && raw.lastSuggestedAt !== undefined && !isIsoDate(raw.lastSuggestedAt)) {
      throw new Error('campo lastSuggestedAt inválido');
    }

    const suggestions = [];
    const seenIds = new Set();
    for (const [index, entry] of raw.suggestions.entries()) {
      const checked = validateSuggestion(entry);
      if (!checked.ok) throw new Error(`sugestão ${index} inválida (${checked.errors.join('; ')})`);
      if (seenIds.has(checked.value.id)) throw new Error(`id duplicado (${checked.value.id})`);
      seenIds.add(checked.value.id);
      suggestions.push(checked.value);
    }
    return {
      fileVersion: FILE_VERSION,
      suggestions,
      lastSuggestedAt: raw.lastSuggestedAt ?? null,
      updatedAt: typeof raw.updatedAt === 'string' && isIsoDate(raw.updatedAt) ? raw.updatedAt : isoNow(),
    };
  }

  function findIndex(id) {
    return data.suggestions.findIndex(item => item.id === id);
  }

  function generateId() {
    let candidate;
    do {
      candidate = `sg-${randomBytes(6).toString('hex')}`;
    } while (findIndex(candidate) >= 0);
    return candidate;
  }

  return {
    /**
     * Carrega `data/suggestions.json`. Se ainda não existe, começa vazio sem
     * criar o arquivo em disco; JSON inválido trava escritas até reparo.
     */
    load() {
      loadFailed = false;
      try {
        data = normalize(JSON.parse(readFileSync(filePath, 'utf8')));
      } catch (error) {
        if (error?.code === 'ENOENT') {
          data = defaultData();
          return { ok: true, count: 0 };
        }
        loadFailed = true;
        data = defaultData();
        onLoadError(`Aviso: sugestões proativas indisponíveis (${error?.message || error}).`);
        return { ok: false, error: error?.message || String(error) };
      }
      return { ok: true, count: data.suggestions.length };
    },

    unavailable() {
      return loadFailed;
    },

    list({ status, limit = SUGGESTIONS_DEFAULT_LIMIT } = {}) {
      if (status !== undefined && !SUGGESTION_STATUSES.includes(status)) {
        return [];
      }
      const filtered = status ? data.suggestions.filter(item => item.status === status) : data.suggestions;
      const ordered = [...filtered].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const max = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), SUGGESTIONS_MAX_LIMIT) : SUGGESTIONS_DEFAULT_LIMIT;
      return ordered.slice(0, max).map(clone);
    },

    get(id) {
      if (loadFailed) return { ok: false, unavailable: true };
      const item = data.suggestions.find(entry => entry.id === id);
      return item ? { ok: true, suggestion: clone(item) } : { ok: false, notFound: true };
    },

    getPending() {
      const item = data.suggestions.find(entry => entry.status === 'suggested');
      return item ? clone(item) : null;
    },

    countUnanswered() {
      return data.suggestions.reduce((acc, entry) => acc + (entry.status === 'suggested' ? 1 : 0), 0);
    },

    getLastSuggestedAt() {
      return data.lastSuggestedAt;
    },

    findLatestByDedupeKey(dedupeKey) {
      if (!dedupeKey) return null;
      for (let i = data.suggestions.length - 1; i >= 0; i -= 1) {
        if (data.suggestions[i].dedupeKey === dedupeKey) return clone(data.suggestions[i]);
      }
      return null;
    },

    create(candidate) {
      assertWritable();
      if (!isPlainObject(candidate)) return { ok: false, errors: ['suggestion: deve ser um objeto'] };
      const createdAt = isoNow();
      const raw = {
        schema: SUGGESTION_SCHEMA,
        id: generateId(),
        kind: candidate.kind || 'custom',
        title: candidate.title,
        summary: candidate.summary ?? '',
        recommendedGoal: candidate.recommendedGoal || candidate.title,
        status: 'suggested',
        relevance: Number.isFinite(candidate.relevance) ? clamp01(candidate.relevance) : 0.5,
        dedupeKey: candidate.dedupeKey,
        ...(candidate.sourceId ? { sourceId: candidate.sourceId } : {}),
        createdAt,
        updatedAt: createdAt,
        history: [{ status: 'suggested', at: createdAt }],
      };
      const checked = validateSuggestion(raw);
      if (!checked.ok) return { ok: false, errors: checked.errors };

      data.suggestions.push(checked.value);
      data.lastSuggestedAt = createdAt;
      persist();
      return { ok: true, suggestion: clone(checked.value) };
    },

    markPlanned(id, { planId, note } = {}) {
      assertWritable();
      const index = findIndex(id);
      if (index < 0) return { ok: false, notFound: true };
      const current = data.suggestions[index];
      if (current.status !== 'suggested') {
        return { ok: false, wrongState: true, error: `Sugestão no estado ${current.status} não pode ir para planned.` };
      }
      if (!planId || !PLAN_ID_RE.test(planId)) {
        return { ok: false, errors: ['planId inválido (esperado pl-<12 hex>)'] };
      }
      const at = isoNow();
      const next = clone(current);
      next.status = 'planned';
      next.planId = planId;
      next.plannedAt = at;
      next.updatedAt = at;
      next.history.push({ status: 'planned', at, planId, ...(note ? { note: truncate(collapse(note), 200) } : {}) });
      const checked = validateSuggestion(next);
      if (!checked.ok) return { ok: false, errors: checked.errors };
      data.suggestions[index] = checked.value;
      persist();
      return { ok: true, suggestion: clone(checked.value) };
    },

    markAuthorized(id, { planId, note } = {}) {
      assertWritable();
      const index = findIndex(id);
      if (index < 0) return { ok: false, notFound: true };
      const current = data.suggestions[index];
      if (current.status !== 'planned') {
        return { ok: false, wrongState: true, error: `Sugestão no estado ${current.status} não pode ser autorizada.` };
      }
      const resolvedPlanId = planId || current.planId;
      const at = isoNow();
      const next = clone(current);
      next.status = 'authorized';
      if (resolvedPlanId) next.planId = resolvedPlanId;
      next.authorizedAt = at;
      next.updatedAt = at;
      next.history.push({
        status: 'authorized',
        at,
        ...(resolvedPlanId ? { planId: resolvedPlanId } : {}),
        ...(note ? { note: truncate(collapse(note), 200) } : {}),
      });
      const checked = validateSuggestion(next);
      if (!checked.ok) return { ok: false, errors: checked.errors };
      data.suggestions[index] = checked.value;
      persist();
      return { ok: true, suggestion: clone(checked.value) };
    },

    markVerified(id, { executionId, note } = {}) {
      assertWritable();
      const index = findIndex(id);
      if (index < 0) return { ok: false, notFound: true };
      const current = data.suggestions[index];
      if (current.status !== 'authorized') {
        return { ok: false, wrongState: true, error: `Sugestão no estado ${current.status} não pode ser marcada como verified.` };
      }
      const at = isoNow();
      const next = clone(current);
      next.status = 'verified';
      next.verifiedAt = at;
      next.updatedAt = at;
      if (executionId) next.executionId = executionId;
      next.history.push({
        status: 'verified',
        at,
        ...(executionId ? { executionId } : {}),
        ...(note ? { note: truncate(collapse(note), 200) } : {}),
      });
      const checked = validateSuggestion(next);
      if (!checked.ok) return { ok: false, errors: checked.errors };
      data.suggestions[index] = checked.value;
      persist();
      return { ok: true, suggestion: clone(checked.value) };
    },

    /**
     * Aceita a sugestão: cria o plano em `taskPlanner` (origin `planner`),
     * registra `planned`, aprova o plano e promove a sugestão para `authorized`.
     * Não executa nenhuma ferramenta diretamente.
     */
    accept(id, { taskPlanner, goal, note } = {}) {
      assertWritable();
      const index = findIndex(id);
      if (index < 0) return { ok: false, notFound: true };
      const current = data.suggestions[index];
      if (current.status !== 'suggested') {
        return { ok: false, wrongState: true, error: `Sugestão no estado ${current.status} não aceita aceite.` };
      }
      if (!taskPlanner || typeof taskPlanner.create !== 'function' || typeof taskPlanner.updateProgress !== 'function') {
        return { ok: false, plannerUnavailable: true, error: 'Planner de tarefas indisponível.' };
      }

      const resolvedGoal = typeof goal === 'string' && goal.trim()
        ? truncate(collapse(goal), AGENT_LIMITS.maxGoalChars)
        : current.recommendedGoal;

      const created = taskPlanner.create({ goal: resolvedGoal, origin: 'planner' });
      if (!created.ok) {
        return { ok: false, errors: created.errors || ['Falha ao criar plano para a sugestão.'] };
      }

      const approved = taskPlanner.updateProgress(created.plan.id, { status: 'approved' });
      if (!approved.ok) {
        return { ok: false, errors: approved.errors || ['Falha ao autorizar o plano gerado.'] };
      }

      const at = isoNow();
      const next = clone(current);
      next.status = 'authorized';
      next.planId = approved.plan.id;
      next.plannedAt = at;
      next.authorizedAt = at;
      next.updatedAt = at;
      next.history.push(
        { status: 'planned', at, planId: approved.plan.id },
        {
          status: 'authorized',
          at,
          planId: approved.plan.id,
          note: truncate(collapse(note || 'sugestão aceita e plano autorizado'), 200),
        },
      );

      const checked = validateSuggestion(next);
      if (!checked.ok) return { ok: false, errors: checked.errors };
      data.suggestions[index] = checked.value;
      persist();
      return { ok: true, suggestion: clone(checked.value), plan: approved.plan };
    },

    dismiss(id, { reason } = {}) {
      assertWritable();
      const index = findIndex(id);
      if (index < 0) return { ok: false, notFound: true };
      const current = data.suggestions[index];
      if (current.status !== 'suggested') {
        return { ok: false, wrongState: true, error: `Sugestão no estado ${current.status} não pode ser descartada.` };
      }
      const at = isoNow();
      const cleanReason = typeof reason === 'string' && reason.trim() ? truncate(collapse(reason), 200) : '';
      const next = clone(current);
      next.status = 'dismissed';
      next.dismissedAt = at;
      next.updatedAt = at;
      if (cleanReason) next.dismissReason = cleanReason;
      next.history.push({ status: 'dismissed', at, ...(cleanReason ? { note: cleanReason } : {}) });

      const checked = validateSuggestion(next);
      if (!checked.ok) return { ok: false, errors: checked.errors };
      data.suggestions[index] = checked.value;
      persist();
      return { ok: true, suggestion: clone(checked.value) };
    },
  };
}

/**
 * Avalia fontes contextuais respeitando DND, teto de 1 sugestão não
 * respondida, deduplicação por `dedupeKey`, snooze após descarte e throttle
 * escalado pela relevância.
 */
export function evaluateContextualSuggestions({
  now = Date.now(),
  store,
  sources = [],
  enforceQuietHours = true,
  quietStartHour = 23.5,
  quietEndHour = 8.5,
  isQuiet = defaultQuietHoursCheck,
  minRelevance = DEFAULT_MIN_RELEVANCE,
  maxUnanswered = DEFAULT_MAX_UNANSWERED_SUGGESTIONS,
  cooldowns = DEFAULT_RELEVANCE_COOLDOWNS_MS,
  dismissSnoozeMs = DEFAULT_DISMISS_SNOOZE_MS,
  onSuggestion = null,
} = {}) {
  const currentNow = Number.isFinite(now) ? now : Date.now();
  if (!store || typeof store.unavailable !== 'function') {
    return { suggested: false, reason: 'store_unavailable' };
  }
  if (store.unavailable()) {
    return { suggested: false, reason: 'store_unavailable' };
  }

  if (enforceQuietHours && isQuiet(new Date(currentNow), quietStartHour, quietEndHour)) {
    return { suggested: false, reason: 'quiet_hours' };
  }

  const unansweredCount = store.countUnanswered();
  if (unansweredCount >= maxUnanswered) {
    return { suggested: false, reason: 'max_unanswered', unansweredCount };
  }

  const rawCandidates = [];
  for (const source of Array.isArray(sources) ? sources : []) {
    if (typeof source !== 'function') continue;
    try {
      const produced = source({ now: currentNow });
      if (Array.isArray(produced)) {
        for (const item of produced) {
          if (isPlainObject(item)) rawCandidates.push(item);
        }
      } else if (isPlainObject(produced)) {
        rawCandidates.push(produced);
      }
    } catch {
      // Uma fonte falha não derruba o ciclo proativo.
    }
  }

  if (!rawCandidates.length) {
    return { suggested: false, reason: 'no_candidates' };
  }

  let sawLowRelevance = false;
  let sawDeduped = false;
  const eligible = [];

  for (const candidate of rawCandidates) {
    const relevance = Number.isFinite(candidate.relevance) ? clamp01(candidate.relevance) : 0;
    if (relevance < minRelevance) {
      sawLowRelevance = true;
      continue;
    }
    const dedupeKey = typeof candidate.dedupeKey === 'string' ? candidate.dedupeKey.trim() : '';
    const title = typeof candidate.title === 'string' ? collapse(candidate.title) : '';
    if (!dedupeKey || !title) continue;

    const previous = store.findLatestByDedupeKey(dedupeKey);
    if (previous) {
      if (previous.status === 'suggested' || previous.status === 'planned' || previous.status === 'authorized') {
        sawDeduped = true;
        continue;
      }
      const refIso = previous.dismissedAt || previous.verifiedAt || previous.updatedAt;
      const refMs = refIso ? Date.parse(refIso) : NaN;
      if (!Number.isNaN(refMs) && currentNow - refMs < dismissSnoozeMs) {
        sawDeduped = true;
        continue;
      }
    }

    eligible.push({ ...candidate, relevance, dedupeKey, title });
  }

  if (!eligible.length) {
    if (sawDeduped) return { suggested: false, reason: 'deduped' };
    if (sawLowRelevance) return { suggested: false, reason: 'low_relevance' };
    return { suggested: false, reason: 'no_candidates' };
  }

  eligible.sort((a, b) => {
    if (b.relevance !== a.relevance) return b.relevance - a.relevance;
    const orderA = KIND_TIE_ORDER[a.kind] ?? 99;
    const orderB = KIND_TIE_ORDER[b.kind] ?? 99;
    if (orderA !== orderB) return orderA - orderB;
    return a.dedupeKey.localeCompare(b.dedupeKey);
  });

  const lastSuggestedAt = store.getLastSuggestedAt();
  const lastMs = lastSuggestedAt ? Date.parse(lastSuggestedAt) : NaN;
  const elapsedMs = Number.isNaN(lastMs) ? Infinity : Math.max(0, currentNow - lastMs);

  let shortestWaitMs = Infinity;
  let chosen = null;
  for (const candidate of eligible) {
    const requiredMs = cooldownForRelevance(candidate.relevance, cooldowns);
    if (elapsedMs >= requiredMs) {
      chosen = candidate;
      break;
    }
    shortestWaitMs = Math.min(shortestWaitMs, requiredMs - elapsedMs);
  }

  if (!chosen) {
    return {
      suggested: false,
      reason: 'throttled',
      retryAfterMs: Number.isFinite(shortestWaitMs) ? shortestWaitMs : 0,
    };
  }

  const created = store.create(chosen);
  if (!created.ok) {
    return { suggested: false, reason: 'invalid_candidate', errors: created.errors };
  }

  if (typeof onSuggestion === 'function') {
    try {
      onSuggestion(created.suggestion);
    } catch {}
  }

  return { suggested: true, suggestion: created.suggestion };
}

