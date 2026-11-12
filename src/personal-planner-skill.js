/**
 * Skill operacional Personal Planner (S10).
 *
 * Publica o manifesto `personal-planner` em `dataDir/skills/personal-planner`
 * quando ausente, registra as ferramentas `planner.upsert_task`,
 * `planner.prioritize` e `planner.schedule` (níveis 2–3) no Tool Registry e
 * conecta a memória operacional (S3) ao Task Planner (S6) passando sempre pelo
 * Tool Executor (S4) e pelo gate de permissões (S5) — sem acessar `data/` direto.
 */
import { randomBytes } from 'node:crypto';
import { publishSkillPackage } from './skill-package.js';
import {
  AGENT_LIMITS,
  AGENT_SCHEMAS,
  OPERATIONAL_KINDS,
  OPERATIONAL_ORIGINS,
  OPERATIONAL_STATUSES,
} from './agent-contracts.js';
import {
  buildScheduleSummary,
  DEFAULT_DURATION_MINUTES,
  detectScheduleConflicts,
  prioritizeRecords,
  priorityToRelevance,
} from '../skills/personal-planner/planner-core.mjs';

export const PLANNER_SKILL_ID = 'personal-planner';
export const PLANNER_TOOLS = Object.freeze([
  'planner.upsert_task',
  'planner.prioritize',
  'planner.schedule',
]);

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const stepId = () => `st-${randomBytes(6).toString('hex')}`;
const truncate = (text, max) => (text.length <= max ? text : text.slice(0, max));

/**
 * Publica o pacote versionado `skills/personal-planner` dentro de `dataDir/skills`
 * apenas quando o destino ainda não existe (preservando `disabled`/`pending` do
 * operador entre reinícios e mantendo testes isolados via `dataDir` próprio).
 */
export function publishPersonalPlannerSkill({
  dataDir,
  bundledDir,
} = {}) {
  return publishSkillPackage({ skillId: PLANNER_SKILL_ID, dataDir, bundledDir });
}

function buildPlanSteps({ prioritized, conflicts }) {
  if (prioritized.length === 0) {
    const collectId = stepId();
    const organizeId = stepId();
    return [
      {
        id: collectId,
        title: 'Registrar tarefas e compromissos da semana na memória operacional',
        status: 'pending',
        dependsOn: [],
        tool: 'planner.upsert_task',
        permissionLevel: 2,
        effort: 'low',
        priority: 1,
      },
      {
        id: organizeId,
        title: 'Gerar cronograma e checar conflitos após cadastro',
        status: 'pending',
        dependsOn: [collectId],
        tool: 'planner.schedule',
        permissionLevel: 3,
        effort: 'low',
        priority: 2,
      },
    ];
  }

  const steps = [];
  const auditId = stepId();
  steps.push({
    id: auditId,
    title: 'Priorizar pendências e conferir prazos na memória operacional',
    status: 'pending',
    dependsOn: [],
    tool: 'planner.prioritize',
    permissionLevel: 2,
    effort: 'low',
    priority: 1,
  });

  let blockerStepId = auditId;
  if (conflicts.length > 0) {
    blockerStepId = stepId();
    const first = conflicts[0];
    steps.push({
      id: blockerStepId,
      title: truncate(
        `Resolver ${conflicts.length} conflito(s) de horário (ex.: "${first.a.title}" vs "${first.b.title}")`,
        AGENT_LIMITS.maxStepTitleChars,
      ),
      status: 'pending',
      dependsOn: [auditId],
      tool: 'planner.upsert_task',
      permissionLevel: 2,
      effort: 'medium',
      priority: 1,
    });
  }

  const maxTaskSteps = Math.min(prioritized.length, 6);
  const taskStepIds = [];
  for (let i = 0; i < maxTaskSteps; i += 1) {
    const item = prioritized[i];
    const id = stepId();
    const prefix = item.kind === 'commitment' ? 'Confirmar compromisso' : 'Executar tarefa';
    steps.push({
      id,
      title: truncate(`${prefix}: ${item.title}`, AGENT_LIMITS.maxStepTitleChars),
      status: 'pending',
      dependsOn: [blockerStepId],
      effort: item.kind === 'commitment' ? 'low' : 'medium',
      priority: item.priority,
    });
    taskStepIds.push(id);
  }

  if (steps.length < 4) {
    const verifyWindowId = stepId();
    steps.push({
      id: verifyWindowId,
      title: 'Conferir folgas de horário e bloqueios do cronograma',
      status: 'pending',
      dependsOn: [taskStepIds[taskStepIds.length - 1]],
      effort: 'low',
      priority: 3,
    });
    taskStepIds.push(verifyWindowId);
  }

  const reviewId = stepId();
  steps.push({
    id: reviewId,
    title: 'Revisar prioridades e atualizar status das pendências na memória operacional',
    status: 'pending',
    dependsOn: [taskStepIds[0]],
    tool: 'planner.prioritize',
    permissionLevel: 2,
    effort: 'low',
    priority: 4,
  });

  return steps;
}

function buildVerifyConflictsShape(conflicts) {
  return Array.isArray(conflicts) && conflicts.every(conflict => (
    isPlainObject(conflict)
    && conflict.type === 'overlap'
    && Number.isFinite(conflict.overlapMinutes)
    && isPlainObject(conflict.a) && typeof conflict.a.id === 'string'
    && isPlainObject(conflict.b) && typeof conflict.b.id === 'string'
    && typeof conflict.summary === 'string' && conflict.summary.length > 0
  ));
}

/**
 * Instancia as três ToolSpecs da skill `personal-planner` ligadas aos stores
 * injetados (`operationalStore` e `taskPlanner`).
 */
export function createPersonalPlannerTools({
  operationalStore,
  taskPlanner,
  now = () => Date.now(),
} = {}) {
  if (!operationalStore || typeof operationalStore.list !== 'function' || typeof operationalStore.create !== 'function' || typeof operationalStore.update !== 'function') {
    throw new Error('createPersonalPlannerTools: operationalStore válido é obrigatório.');
  }
  if (!taskPlanner || typeof taskPlanner.create !== 'function') {
    throw new Error('createPersonalPlannerTools: taskPlanner válido é obrigatório.');
  }

  function resolveRelevance({ priority, relevance }) {
    if (relevance !== undefined) return relevance;
    if (priority !== undefined) {
      const mapped = priorityToRelevance(priority);
      if (mapped === null) throw new Error('priority: deve ser inteiro entre 1 e 5');
      return mapped;
    }
    return undefined;
  }

  function upsertSingleRecord(input, { defaultOrigin = 'agent' } = {}) {
    if (!isPlainObject(input)) throw new Error('tarefa: deve ser um objeto JSON');
    const resolvedRelevance = resolveRelevance(input);

    if (input.id !== undefined) {
      if (typeof input.id !== 'string' || !/^op-[0-9a-f]{12}$/.test(input.id)) {
        throw new Error('id: formato esperado op-<12 hex>');
      }
      const patch = {};
      if (input.title !== undefined) patch.title = input.title;
      if (input.status !== undefined) patch.status = input.status;
      if (input.dueAt !== undefined) patch.dueAt = input.dueAt;
      if (input.projectId !== undefined) patch.projectId = input.projectId;
      if (resolvedRelevance !== undefined) patch.relevance = resolvedRelevance;
      const updated = operationalStore.update(input.id, patch);
      if (!updated.ok) {
        if (updated.notFound) throw new Error(`registro não encontrado (${input.id})`);
        throw new Error(updated.errors.join('; '));
      }
      return { action: 'updated', record: updated.record };
    }

    if (typeof input.title !== 'string' || !input.title.trim()) {
      throw new Error('title: obrigatório ao criar uma tarefa ou compromisso');
    }
    const payload = {
      kind: input.kind ?? 'task',
      title: input.title,
      status: input.status ?? 'open',
      origin: input.origin ?? defaultOrigin,
      relevance: resolvedRelevance ?? 0.5,
    };
    if (input.dueAt !== undefined) payload.dueAt = input.dueAt;
    if (input.projectId !== undefined) payload.projectId = input.projectId;
    const created = operationalStore.create(payload);
    if (!created.ok) throw new Error(created.errors.join('; '));
    return { action: 'created', record: created.record };
  }

  const upsertTaskTool = {
    schema: AGENT_SCHEMAS.tool,
    name: 'planner.upsert_task',
    version: '1.0.0',
    description: 'Cria ou atualiza tarefa/compromisso na memória operacional local e aponta conflitos de horário.',
    origin: 'skill',
    permissionLevel: 2,
    timeoutMs: 2000,
    parameters: [
      { name: 'id', type: 'string', required: false, description: 'Id op-… quando for atualização de item existente.' },
      { name: 'title', type: 'string', required: false, description: 'Título da tarefa ou compromisso.' },
      { name: 'kind', type: 'string', required: false, enum: [...OPERATIONAL_KINDS], description: 'Tipo do registro operacional.' },
      { name: 'status', type: 'string', required: false, enum: [...OPERATIONAL_STATUSES], description: 'Status atual.' },
      { name: 'dueAt', type: 'string', required: false, description: 'Data/hora ISO-8601 com fuso ou YYYY-MM-DD.' },
      { name: 'priority', type: 'number', required: false, description: 'Prioridade 1 (maior) a 5 (menor), convertida em relevância.' },
      { name: 'relevance', type: 'number', required: false, description: 'Relevância explícita entre 0 e 1.' },
      { name: 'projectId', type: 'string', required: false, description: 'Id op-… do projeto relacionado.' },
      { name: 'origin', type: 'string', required: false, enum: [...OPERATIONAL_ORIGINS], description: 'Origem do registro.' },
    ],
    verify(result) {
      return isPlainObject(result)
        && result.ok === true
        && (result.action === 'created' || result.action === 'updated')
        && isPlainObject(result.record)
        && typeof result.record.id === 'string'
        && /^op-[0-9a-f]{12}$/.test(result.record.id)
        && buildVerifyConflictsShape(result.conflicts)
        && result.hasConflicts === (result.conflicts.length > 0);
    },
    execute(args) {
      const { action, record } = upsertSingleRecord(args);
      const records = operationalStore.list({ limit: 500 });
      const conflicts = detectScheduleConflicts(records);
      return {
        ok: true,
        action,
        record,
        conflicts,
        hasConflicts: conflicts.length > 0,
      };
    },
  };

  const prioritizeTool = {
    schema: AGENT_SCHEMAS.tool,
    name: 'planner.prioritize',
    version: '1.0.0',
    description: 'Ordena tarefas e compromissos ativos por urgência, relevância e conflitos na memória operacional.',
    origin: 'skill',
    permissionLevel: 2,
    timeoutMs: 2000,
    parameters: [
      { name: 'kind', type: 'string', required: false, enum: [...OPERATIONAL_KINDS], description: 'Filtrar por tipo operacional.' },
      { name: 'projectId', type: 'string', required: false, description: 'Filtrar por projeto op-….' },
      { name: 'applyRelevance', type: 'boolean', required: false, description: 'Quando true, grava o score calculado em relevance na memória operacional.' },
      { name: 'defaultDurationMinutes', type: 'number', required: false, description: 'Duração padrão em minutos para detecção de conflito (padrão 60).' },
    ],
    verify(result) {
      return isPlainObject(result)
        && result.ok === true
        && Array.isArray(result.prioritized)
        && result.prioritized.every(item => (
          isPlainObject(item)
          && Number.isInteger(item.rank)
          && typeof item.id === 'string'
          && Number.isInteger(item.priority)
        ))
        && buildVerifyConflictsShape(result.conflicts)
        && typeof result.summary === 'string'
        && result.summary.length > 0;
    },
    execute(args = {}) {
      const duration = args.defaultDurationMinutes ?? DEFAULT_DURATION_MINUTES;
      const records = operationalStore.list({ limit: 500 });
      const conflicts = detectScheduleConflicts(records, { defaultDurationMinutes: duration });
      let prioritized = prioritizeRecords(records, {
        nowMs: now(),
        conflicts,
        kind: args.kind,
        projectId: args.projectId,
      });

      let updatedCount = 0;
      if (args.applyRelevance === true) {
        for (const item of prioritized) {
          const targetRelevance = Number(item.score.toFixed(2));
          if (Math.abs((item.relevance ?? 0) - targetRelevance) >= 0.01) {
            const res = operationalStore.update(item.id, { relevance: targetRelevance });
            if (res.ok && res.changed?.length) updatedCount += 1;
          }
        }
        if (updatedCount > 0) {
          const refreshed = operationalStore.list({ limit: 500 });
          prioritized = prioritizeRecords(refreshed, {
            nowMs: now(),
            conflicts,
            kind: args.kind,
            projectId: args.projectId,
          });
        }
      }

      const summary = prioritized.length === 0
        ? 'Nenhuma tarefa ou compromisso ativo encontrado para priorizar.'
        : `Priorizados ${prioritized.length} item(ns); topo: #1 "${prioritized[0].title}" (${prioritized[0].tier}, score ${prioritized[0].score}).${conflicts.length ? ` ${conflicts.length} conflito(s) de horário encontrado(s).` : ''}`;

      return {
        ok: true,
        prioritized,
        conflicts,
        updatedCount,
        summary,
      };
    },
  };

  const scheduleTool = {
    schema: AGENT_SCHEMAS.tool,
    name: 'planner.schedule',
    version: '1.0.0',
    description: 'Monta cronograma priorizado a partir da memória operacional, detecta conflitos e registra plano no Task Planner.',
    origin: 'skill',
    permissionLevel: 3,
    timeoutMs: 3000,
    parameters: [
      { name: 'goal', type: 'string', required: false, description: 'Objetivo ou período do cronograma (ex.: Organizar minha semana).' },
      { name: 'from', type: 'string', required: false, description: 'Data inicial da janela (YYYY-MM-DD ou ISO-8601).' },
      { name: 'to', type: 'string', required: false, description: 'Data final da janela (YYYY-MM-DD ou ISO-8601).' },
      { name: 'tasks', type: 'array', required: false, description: 'Lista opcional de tarefas/compromissos a persistir antes de organizar.' },
      { name: 'persistPlan', type: 'boolean', required: false, description: 'Cria plano correspondente no Task Planner (padrão true).' },
      { name: 'applyRelevance', type: 'boolean', required: false, description: 'Atualiza relevance das tarefas com o score priorizado.' },
      { name: 'defaultDurationMinutes', type: 'number', required: false, description: 'Duração padrão por compromisso em minutos (padrão 60).' },
    ],
    verify(result) {
      if (!isPlainObject(result) || result.ok !== true) return false;
      if (typeof result.summary !== 'string' || !result.summary.trim()) return false;
      if (!isPlainObject(result.schedule) || !Array.isArray(result.schedule.days) || !Array.isArray(result.schedule.unscheduled)) {
        return false;
      }
      if (!Array.isArray(result.prioritized) || !buildVerifyConflictsShape(result.conflicts)) return false;
      if (result.conflictCount !== result.conflicts.length) return false;
      if (!Array.isArray(result.tasks)) return false;
      if (result.plan !== null && result.plan !== undefined) {
        if (!isPlainObject(result.plan) || typeof result.plan.id !== 'string' || !Array.isArray(result.plan.steps) || result.plan.steps.length === 0) {
          return false;
        }
      }
      return true;
    },
    execute(args = {}) {
      const goal = typeof args.goal === 'string' && args.goal.trim().length >= 3
        ? args.goal.trim().slice(0, AGENT_LIMITS.maxGoalChars)
        : 'Organizar minha semana';

      let persistedCount = 0;
      const durations = {};
      if (Array.isArray(args.tasks)) {
        if (args.tasks.length > 25) throw new Error('tasks: máximo de 25 itens por execução');
        for (const rawTask of args.tasks) {
          const { record } = upsertSingleRecord(rawTask, { defaultOrigin: 'planner' });
          persistedCount += 1;
          if (typeof rawTask.durationMinutes === 'number' && Number.isFinite(rawTask.durationMinutes)) {
            durations[record.id] = rawTask.durationMinutes;
          }
        }
      }

      const defaultDurationMinutes = args.defaultDurationMinutes ?? DEFAULT_DURATION_MINUTES;
      let records = operationalStore.list({ limit: 500 });
      let report = buildScheduleSummary({
        records,
        nowMs: now(),
        from: args.from ?? null,
        to: args.to ?? null,
        goal,
        durations,
        defaultDurationMinutes,
      });

      if (args.applyRelevance === true && report.prioritized.length > 0) {
        let changed = 0;
        for (const item of report.prioritized) {
          const nextRel = Number(item.score.toFixed(2));
          if (Math.abs((item.relevance ?? 0) - nextRel) >= 0.01) {
            const res = operationalStore.update(item.id, { relevance: nextRel });
            if (res.ok && res.changed?.length) changed += 1;
          }
        }
        if (changed > 0) {
          records = operationalStore.list({ limit: 500 });
          report = buildScheduleSummary({
            records,
            nowMs: now(),
            from: args.from ?? null,
            to: args.to ?? null,
            goal,
            durations,
            defaultDurationMinutes,
          });
        }
      }

      let plan = null;
      if (args.persistPlan !== false) {
        const steps = buildPlanSteps({
          prioritized: report.prioritized,
          conflicts: report.conflicts,
        });
        const missingInfo = [];
        if (report.counts.total === 0) {
          missingInfo.push('nenhuma tarefa ou compromisso ativo cadastrado na memória operacional');
        } else if (report.counts.unscheduled > 0) {
          missingInfo.push(`${report.counts.unscheduled} tarefa(s) sem prazo ou horário definido`);
        }
        const risks = [];
        for (const conflict of report.conflicts.slice(0, 5)) {
          risks.push(truncate(`conflito de horário: ${conflict.summary}`, AGENT_LIMITS.maxBriefingItemChars));
        }
        if (report.counts.overdue > 0) {
          risks.push(`${report.counts.overdue} item(ns) atrasado(s) exigem replanejamento`);
        }
        if (report.counts.blocked > 0) {
          risks.push(`${report.counts.blocked} item(ns) bloqueado(s) no período`);
        }

        const createdPlan = taskPlanner.create({
          goal,
          origin: 'planner',
          steps,
          missingInfo,
          risks,
        });
        if (!createdPlan.ok) {
          throw new Error(`falha ao registrar plano no Task Planner: ${createdPlan.errors.join('; ')}`);
        }
        plan = createdPlan.plan;
      }

      const persistedTasks = records
        .filter(r => r.kind === 'task' || r.kind === 'commitment')
        .map(r => ({ ...r }));

      return {
        ok: true,
        goal,
        summary: report.summary,
        schedule: {
          days: report.days,
          unscheduled: report.unscheduled,
          window: report.window,
          counts: report.counts,
        },
        prioritized: report.prioritized,
        conflicts: report.conflicts,
        conflictCount: report.conflicts.length,
        tasks: persistedTasks,
        persistedCount,
        plan,
        ...(plan?.briefing ? { briefing: plan.briefing } : {}),
      };
    },
  };

  return [upsertTaskTool, prioritizeTool, scheduleTool];
}
