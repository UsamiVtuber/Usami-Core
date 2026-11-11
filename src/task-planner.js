/**
 * Planner Engine de tarefas do domínio agêntico — distinto do planner de
 * animação (`animation-planner.js` / `/api/plan`).
 *
 * Um objetivo vira plano com passos, dependências, esforço, prioridade e
 * informações ausentes. O núcleo é determinístico: `generatePlan` é injetável
 * e o default não usa rede. Um adapter de LLM pode substituí-lo sem mudar a
 * validação — todo plano passa por `validatePlan` antes de ser gravado.
 *
 * Persistência: um arquivo por plano em `data/plans/<pl-id>.json`, com todas
 * as versões (`plans[]`). Replanejar acrescenta uma versão; progresso edita a
 * corrente. Escrita atômica (tmp + rename). Arquivo inválido deixa apenas
 * aquele plano indisponível — os demais continuam legíveis e graváveis.
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { dataDir as resolveDataDir } from './data-paths.js';
import {
  AGENT_LIMITS,
  AGENT_SCHEMAS,
  PLAN_ORIGINS,
  PLAN_STATUSES,
  PLAN_STEP_STATUSES,
  validatePlan,
} from './agent-contracts.js';

const DIR_NAME = 'plans';
const FILE_VERSION = 1;
const PLAN_ID_RE = /^pl-[0-9a-f]{12}$/;
const PLAN_FILE_RE = /^(pl-[0-9a-f]{12})\.json$/;
export const DEFAULT_BRIEFING_THRESHOLD = 4;
export const PLAN_LIST_DEFAULT_LIMIT = 50;
export const PLAN_LIST_MAX_LIMIT = 200;
const LONG_PLAN_STEPS = 10;

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const truncate = (text, max) => (text.length <= max ? text : text.slice(0, max));

// Regras explícitas em vez de "interpretação" do objetivo: o núcleo
// determinístico aponta o que falta, não finge entender o que foi dito.
const MISSING_INFO_RULES = Object.freeze([
  {
    pattern: /\b(enviar|publicar|agendar|comprar|pagar|email|e-mail|whatsapp|ligar)\b/,
    item: 'autorização, canal e destinatário da ação externa',
  },
  {
    // Sem `\b` no fim: acento não é caractere de palavra em regex JS, então
    // "amanhã" nunca fecharia a fronteira.
    pattern: /\b(hoje|amanh[aã]|ontem|semana|m[eê]s|prazo|depois)/,
    item: 'data ou prazo explícito',
  },
]);

export function parseBriefingThreshold(raw, fallback = DEFAULT_BRIEFING_THRESHOLD) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 && value <= AGENT_LIMITS.maxSteps ? value : fallback;
}

export function analyzeGoal(goal) {
  const text = typeof goal === 'string' ? goal.trim() : '';
  const lower = text.toLowerCase();
  const items = [];
  for (const rule of MISSING_INFO_RULES) {
    if (rule.pattern.test(lower)) items.push(rule.item);
  }
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length > 0 && words.length < 3) items.push('escopo e critério de conclusão do objetivo');
  return [...new Set(items)].map(item => truncate(item, AGENT_LIMITS.maxBriefingItemChars)).slice(0, AGENT_LIMITS.maxBriefingItems);
}

export function risksForSteps(steps) {
  const risks = [];
  if (steps.some(step => step.permissionLevel === 4)) risks.push('há passos de ação externa irreversível (nível 4)');
  if (steps.some(step => step.effort === 'high')) risks.push('há passos de esforço alto');
  if (steps.some(step => typeof step.tool === 'string')) risks.push('passos dependem de ferramentas; falha de ferramenta interrompe o fluxo');
  if (steps.length > LONG_PLAN_STEPS) risks.push(`plano longo: mais de ${LONG_PLAN_STEPS} passos`);
  return risks.map(risk => truncate(risk, AGENT_LIMITS.maxBriefingItemChars)).slice(0, AGENT_LIMITS.maxBriefingItems);
}

const stepId = () => `st-${randomBytes(6).toString('hex')}`;
const planId = () => `pl-${randomBytes(6).toString('hex')}`;

/**
 * Gerador default. Contrato do adapter injetável:
 *   generatePlan({ goal, planId, version, now }) =>
 *     { steps: GeneratedStep[], missingInfo?: string[], risks?: string[] }
 * `steps[].id`/`dependsOn` são ids `st-…`; o adapter é responsável por
 * ligá-los. `missingInfo` do adapter substitui as regras locais; os riscos
 * derivados dos passos são sempre somados.
 */
export function createDeterministicGenerator() {
  return ({ goal }) => {
    const shortGoal = truncate(String(goal).trim(), 80) || 'objetivo';
    const clarify = stepId();
    const gather = stepId();
    const execute = stepId();
    const verify = stepId();
    const record = stepId();
    return {
      steps: [
        { id: clarify, title: `Clarificar o objetivo: ${shortGoal}`, effort: 'low', priority: 1 },
        { id: gather, title: 'Levantar informações ausentes e restrições', effort: 'low', priority: 2, dependsOn: [clarify] },
        { id: execute, title: `Executar: ${shortGoal}`, effort: 'medium', priority: 3, dependsOn: [gather] },
        { id: verify, title: 'Verificar o resultado contra o objetivo', effort: 'low', priority: 4, dependsOn: [execute] },
        { id: record, title: 'Registrar resultado e pendências', effort: 'low', priority: 5, dependsOn: [verify] },
      ],
    };
  };
}

export function createTaskPlanner({
  dataDir = resolveDataDir(),
  plansDir = join(dataDir, DIR_NAME),
  generatePlan = createDeterministicGenerator(),
  briefingThreshold = DEFAULT_BRIEFING_THRESHOLD,
  now = () => Date.now(),
  onLoadError = message => console.error(message),
} = {}) {
  if (!dataDir || typeof dataDir !== 'string') throw new Error('createTaskPlanner: dataDir é obrigatório.');
  if (typeof generatePlan !== 'function') throw new Error('createTaskPlanner: generatePlan deve ser uma função.');
  if (!Number.isInteger(briefingThreshold) || briefingThreshold < 0 || briefingThreshold > AGENT_LIMITS.maxSteps) {
    throw new Error('createTaskPlanner: briefingThreshold inválido.');
  }
  const isoNow = () => new Date(now()).toISOString();
  const entries = new Map();
  const unavailablePlans = new Map();

  const clone = value => JSON.parse(JSON.stringify(value));
  const currentPlan = entry => entry.plans[entry.plans.length - 1];
  const filePathFor = id => join(plansDir, `${id}.json`);

  function persistEntry(entry) {
    mkdirSync(dirname(filePathFor(entry.planId)), { recursive: true });
    const payload = {
      fileVersion: FILE_VERSION,
      planId: entry.planId,
      plans: entry.plans,
      updatedAt: isoNow(),
    };
    const target = filePathFor(entry.planId);
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temporary, JSON.stringify(payload, null, 2), 'utf8');
    try {
      renameSync(temporary, target);
    } catch (error) {
      try { unlinkSync(temporary); } catch {}
      if (error?.code !== 'EEXIST' && error?.code !== 'EPERM') throw error;
    }
  }

  function normalizeFile(planId_, raw) {
    if (!isPlainObject(raw)) throw new Error('arquivo deve ser um objeto JSON');
    if (raw.fileVersion !== FILE_VERSION) throw new Error(`versão de arquivo ${JSON.stringify(raw.fileVersion)} não suportada`);
    if (raw.planId !== planId_) throw new Error('planId não corresponde ao nome do arquivo');
    if (!Array.isArray(raw.plans) || raw.plans.length === 0) throw new Error('plans deve ser uma lista não vazia');
    const plans = [];
    for (const [index, candidate] of raw.plans.entries()) {
      const result = validatePlan(candidate);
      if (!result.ok) throw new Error(`versão ${index + 1} inválida (${result.errors.join('; ')})`);
      if (result.value.id !== planId_) throw new Error(`versão ${index + 1} pertence a outro plano`);
      const previous = plans[plans.length - 1];
      if (previous && result.value.version !== previous.version + 1) {
        throw new Error(`versão ${result.value.version} fora de sequência`);
      }
      plans.push(result.value);
    }
    return { planId: planId_, plans };
  }

  function buildBriefing(goal, steps, generated) {
    const summary = truncate(`Plano em ${steps.length} passos para: ${String(goal).trim()}`, AGENT_LIMITS.maxBriefingSummaryChars);
    const missingInfo = generated.missingInfo === undefined
      ? analyzeGoal(goal)
      : generated.missingInfo.map(item => truncate(String(item), AGENT_LIMITS.maxBriefingItemChars)).slice(0, AGENT_LIMITS.maxBriefingItems);
    const risks = [...new Set([
      ...(Array.isArray(generated.risks) ? generated.risks.map(item => String(item)) : []),
      ...risksForSteps(steps),
    ])].map(risk => truncate(risk, AGENT_LIMITS.maxBriefingItemChars)).slice(0, AGENT_LIMITS.maxBriefingItems);
    return { summary, missingInfo, risks };
  }

  function create({ goal, origin = 'user', replanOf } = {}) {
    let existing = [];
    let nextVersion = 1;
    let id;

    if (replanOf !== undefined) {
      if (typeof replanOf !== 'string' || !PLAN_ID_RE.test(replanOf)) {
        return { ok: false, errors: ['replanOf: id de plano inválido'] };
      }
      if (unavailablePlans.has(replanOf)) return { ok: false, unavailable: true };
      const entry = entries.get(replanOf);
      if (!entry) return { ok: false, notFound: true };
      id = replanOf;
      existing = entry.plans;
      nextVersion = currentPlan(entry).version + 1;
    } else {
      do {
        id = planId();
      } while (entries.has(id) || unavailablePlans.has(id));
    }

    let generated;
    try {
      generated = generatePlan({ goal, planId: id, version: nextVersion, now: now() });
    } catch (error) {
      return { ok: false, errors: [`generatePlan: ${error?.message || error}`] };
    }
    if (!isPlainObject(generated) || !Array.isArray(generated.steps)) {
      return { ok: false, errors: ['generatePlan: deve devolver { steps: [...] }'] };
    }
    if (!PLAN_ORIGINS.includes(origin)) {
      return { ok: false, errors: [`origin: inválido (use ${PLAN_ORIGINS.join('|')})`] };
    }

    const createdAt = isoNow();
    const candidate = {
      schema: AGENT_SCHEMAS.plan,
      id,
      goal: typeof goal === 'string' ? goal.trim() : goal,
      version: nextVersion,
      status: 'draft',
      origin,
      createdAt,
      steps: generated.steps,
    };
    if (generated.steps.length > briefingThreshold) {
      candidate.briefing = buildBriefing(goal, generated.steps, generated);
    }

    const validated = validatePlan(candidate);
    if (!validated.ok) return { ok: false, errors: validated.errors };

    const entry = { planId: id, plans: [...existing, validated.value] };
    persistEntry(entry);
    entries.set(id, entry);
    return { ok: true, plan: clone(validated.value), version: nextVersion, replanned: replanOf !== undefined };
  }

  function updateProgress(id, patch) {
    if (unavailablePlans.has(id)) return { ok: false, unavailable: true };
    const entry = entries.get(id);
    if (!entry) return { ok: false, notFound: true };
    const current = currentPlan(entry);
    if (current.status === 'done' || current.status === 'cancelled') return { ok: false, locked: true };
    if (!isPlainObject(patch)) return { ok: false, errors: ['patch: deve ser um objeto'] };

    const unknown = Object.keys(patch).filter(key => key !== 'steps' && key !== 'status');
    if (unknown.length) return { ok: false, errors: unknown.map(key => `patch.${key}: campo não editável`) };

    const next = clone(current);
    const changed = [];

    if (patch.status !== undefined) {
      if (!PLAN_STATUSES.includes(patch.status)) {
        return { ok: false, errors: [`status: inválido (use ${PLAN_STATUSES.join('|')})`] };
      }
      if (next.status !== patch.status) {
        next.status = patch.status;
        changed.push('status');
      }
    }

    const updatedSteps = [];
    if (patch.steps !== undefined) {
      if (!Array.isArray(patch.steps) || patch.steps.length === 0) {
        return { ok: false, errors: ['patch.steps: deve ser uma lista não vazia'] };
      }
      const seen = new Set();
      for (const [index, update] of patch.steps.entries()) {
        if (!isPlainObject(update)) return { ok: false, errors: [`patch.steps[${index}]: deve ser um objeto`] };
        const stepUnknown = Object.keys(update).filter(key => key !== 'id' && key !== 'status');
        if (stepUnknown.length) {
          return { ok: false, errors: stepUnknown.map(key => `patch.steps[${index}].${key}: campo desconhecido`) };
        }
        if (typeof update.id !== 'string' || !/^st-[0-9a-f]{12}$/.test(update.id)) {
          return { ok: false, errors: [`patch.steps[${index}].id: inválido`] };
        }
        if (seen.has(update.id)) return { ok: false, errors: [`patch.steps[${index}].id: duplicado (${update.id})`] };
        seen.add(update.id);
        if (!PLAN_STEP_STATUSES.includes(update.status)) {
          return { ok: false, errors: [`patch.steps[${index}].status: inválido (use ${PLAN_STEP_STATUSES.join('|')})`] };
        }
        const target = next.steps.find(step => step.id === update.id);
        if (!target) return { ok: false, errors: [`patch.steps[${index}].id: passo inexistente (${update.id})`] };
        if (target.status !== update.status) {
          target.status = update.status;
          changed.push(`step:${update.id}`);
        }
        updatedSteps.push(target);
      }
      // Dependência pendente trava execução: marcar como em andamento ou
      // concluído um passo cuja base ainda não terminou esconde trabalho.
      for (const step of updatedSteps) {
        if (step.status !== 'running' && step.status !== 'done') continue;
        for (const dependencyId of step.dependsOn) {
          const dependency = next.steps.find(item => item.id === dependencyId);
          if (dependency && dependency.status !== 'done') {
            return { ok: false, errors: [`step ${step.id}: dependência ${dependencyId} ainda não concluída`] };
          }
        }
      }
    }

    if (!changed.length) return { ok: true, plan: clone(current), changed: [] };

    next.updatedAt = isoNow();
    const validated = validatePlan(next);
    if (!validated.ok) return { ok: false, errors: validated.errors };

    entry.plans[entry.plans.length - 1] = validated.value;
    persistEntry(entry);
    return { ok: true, plan: clone(validated.value), changed };
  }

  function list({ limit = PLAN_LIST_DEFAULT_LIMIT } = {}) {
    const max = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), PLAN_LIST_MAX_LIMIT) : PLAN_LIST_DEFAULT_LIMIT;
    const ordered = [...entries.values()]
      .map(entry => currentPlan(entry))
      .sort((a, b) => (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt))
      .slice(0, max);
    return ordered.map(clone);
  }

  function unavailable() {
    return [...unavailablePlans.keys()];
  }

  function get(id) {
    if (unavailablePlans.has(id)) return { ok: false, unavailable: true };
    const entry = entries.get(id);
    if (!entry) return { ok: false, notFound: true };
    return {
      ok: true,
      plan: clone(currentPlan(entry)),
      versions: entry.plans.map(plan => ({
        version: plan.version,
        status: plan.status,
        createdAt: plan.createdAt,
        updatedAt: plan.updatedAt,
      })),
    };
  }

  /**
   * Carrega `data/plans/`. Diretório ausente começa vazio sem criar nada.
   * Arquivo inválido não derruba os demais: fica registrado como
   * indisponível e novas tentativas naquele plano são recusadas.
   */
  function load() {
    entries.clear();
    unavailablePlans.clear();
    let names;
    try {
      names = readdirSync(plansDir);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      return { plans: [], unavailable: [] };
    }
    for (const name of names) {
      const match = name.match(PLAN_FILE_RE);
      if (!match) continue;
      const id = match[1];
      try {
        const entry = normalizeFile(id, JSON.parse(readFileSync(join(plansDir, name), 'utf8')));
        entries.set(id, entry);
      } catch (error) {
        unavailablePlans.set(id, true);
        onLoadError(`Aviso: plano ${id} inválido (${error?.message || error}); este plano fica indisponível.`);
      }
    }
    return { plans: list(), unavailable: unavailable() };
  }

  return { load, list, unavailable, get, create, updateProgress };
}
