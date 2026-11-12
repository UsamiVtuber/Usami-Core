/**
 * Núcleo determinístico da skill Daily Briefing (S13).
 *
 * Monta compromissos, tarefas prioritárias, pendências (itens atrasados,
 * bloqueados, planos abertos e falhas de execução) e projetos em andamento a
 * partir exclusivamente dos dados locais fornecidos. Zero rede, zero escrita em
 * disco e nenhuma invenção de compromissos quando a base está vazia.
 */

export const BRIEFING_SCHEMA = 'usami.agent.briefing.v1';
export const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
export const DEFAULT_SECTION_LIMIT = 15;

const DAY_MS = 86_400_000;
const ACTIVE_RECORD_STATUSES = new Set(['open', 'in_progress', 'blocked']);
const ACTIVE_PLAN_STATUSES = new Set(['draft', 'awaiting_approval', 'approved', 'running']);
const ALERT_EXECUTION_STATUSES = new Set(['failed', 'denied', 'timeout']);

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export function isValidCalendarDate(value) {
  if (typeof value !== 'string' || !DATE_ONLY_RE.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day));
  return utc.getUTCFullYear() === year && utc.getUTCMonth() === month - 1 && utc.getUTCDate() === day;
}

function parseDueMs(dueAt) {
  if (typeof dueAt !== 'string' || !dueAt.trim()) return null;
  const trimmed = dueAt.trim();
  if (DATE_ONLY_RE.test(trimmed)) {
    const parsed = Date.parse(`${trimmed}T23:59:59.999Z`);
    return Number.isNaN(parsed) ? null : parsed;
  }
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? null : parsed;
}

function toPriority(score) {
  if (score >= 0.85) return 1;
  if (score >= 0.65) return 2;
  if (score >= 0.45) return 3;
  if (score >= 0.25) return 4;
  return 5;
}

function scoreTask(record, { nowMs, targetDate, overdue, blocked }) {
  let score = Number.isFinite(record.relevance) ? Math.min(1, Math.max(0, record.relevance)) : 0.5;
  if (overdue) score += 0.35;
  else if (typeof record.dueAt === 'string' && record.dueAt.slice(0, 10) === targetDate) score += 0.2;
  else if (typeof record.dueAt === 'string') {
    const dueMs = parseDueMs(record.dueAt);
    if (dueMs !== null && dueMs - nowMs <= 2 * DAY_MS) score += 0.1;
  }
  if (blocked) score += 0.12;
  if (record.status === 'in_progress') score += 0.05;
  return Number(Math.min(1, score).toFixed(4));
}

function sortByDueThenCreated(a, b) {
  const dueA = parseDueMs(a.dueAt) ?? Number.POSITIVE_INFINITY;
  const dueB = parseDueMs(b.dueAt) ?? Number.POSITIVE_INFINITY;
  if (dueA !== dueB) return dueA - dueB;
  return String(a.id || '').localeCompare(String(b.id || ''));
}

function formatDueBadge(dueAt, targetDate) {
  if (!dueAt) return 'sem prazo';
  if (dueAt.length > 10 && dueAt.slice(0, 10) === targetDate) return dueAt.slice(11, 16);
  return dueAt.length > 10 ? `${dueAt.slice(0, 10)} ${dueAt.slice(11, 16)}` : dueAt;
}

export function formatDeterministicBriefingText(briefing) {
  const lines = [`Briefing diário (${briefing.date})`];
  if (briefing.empty) {
    lines.push('Base operacional vazia: nenhum compromisso, tarefa, pendência ou projeto ativo registrado.');
    return lines.join('\n');
  }

  lines.push('');
  lines.push(`Compromissos (${briefing.commitments.length}):`);
  if (briefing.commitments.length === 0) {
    lines.push('- Nenhum compromisso registrado.');
  } else {
    for (const item of briefing.commitments) {
      const tags = [];
      if (item.overdue) tags.push('ATRASADO');
      else if (item.onTargetDate) tags.push('HOJE');
      if (item.status === 'blocked') tags.push('BLOQUEADO');
      const badge = tags.length ? `[${tags.join(', ')}] ` : '';
      lines.push(`- ${badge}${item.title} (${formatDueBadge(item.dueAt, briefing.date)})`);
    }
  }

  lines.push('');
  lines.push(`Tarefas prioritárias (${briefing.priorityTasks.length}):`);
  if (briefing.priorityTasks.length === 0) {
    lines.push('- Nenhuma tarefa ativa.');
  } else {
    for (const task of briefing.priorityTasks) {
      const tags = [`P${task.priority}`];
      if (task.overdue) tags.push('ATRASADA');
      if (task.blocked) tags.push('BLOQUEADA');
      else if (task.status === 'in_progress') tags.push('EM ANDAMENTO');
      lines.push(`- [${tags.join(' | ')}] ${task.title} (${formatDueBadge(task.dueAt, briefing.date)})`);
    }
  }

  lines.push('');
  lines.push(`Pendências (${briefing.pending.totalCount}):`);
  if (briefing.pending.totalCount === 0) {
    lines.push('- Nenhuma pendência em aberto.');
  } else {
    for (const item of briefing.pending.overdueRecords) {
      lines.push(`- [ATRASADO] ${item.title} (prazo: ${item.dueAt})`);
    }
    for (const item of briefing.pending.blockedRecords) {
      lines.push(`- [BLOQUEADO] ${item.title}`);
    }
    for (const item of briefing.pending.unscheduledTasks) {
      lines.push(`- [SEM PRAZO] ${item.title}`);
    }
    for (const plan of briefing.pending.plans) {
      lines.push(`- [PLANO ${plan.status.toUpperCase()}] ${plan.goal} (${plan.pendingStepsCount}/${plan.totalStepsCount} passos pendentes)`);
    }
    for (const alert of briefing.pending.executionAlerts) {
      lines.push(`- [EXECUÇÃO ${alert.status.toUpperCase()}] ${alert.tool}: ${alert.reason || 'sem detalhe'}`);
    }
  }

  lines.push('');
  lines.push(`Projetos em andamento (${briefing.projects.length}):`);
  if (briefing.projects.length === 0) {
    lines.push('- Nenhum projeto ativo.');
  } else {
    for (const project of briefing.projects) {
      const duePart = project.dueAt ? `, prazo ${project.dueAt.slice(0, 10)}` : '';
      lines.push(`- ${project.title} (${project.status}; ${project.openTasksCount} aberta(s), ${project.doneTasksCount} concluída(s)${duePart})`);
    }
  }

  return lines.join('\n');
}

/**
 * Monta o Daily Briefing determinístico a partir dos registros locais.
 */
export function buildDailyBriefing({
  nowMs = Date.now(),
  date = null,
  operationalRecords = [],
  plans = [],
  executions = [],
  sectionLimit = DEFAULT_SECTION_LIMIT,
} = {}) {
  const safeNowMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  const targetDate = date ?? new Date(safeNowMs).toISOString().slice(0, 10);
  if (!isValidCalendarDate(targetDate)) {
    throw new Error(`date inválido (esperado YYYY-MM-DD): ${String(date)}`);
  }

  const limit = Number.isInteger(sectionLimit) && sectionLimit >= 1 && sectionLimit <= 100
    ? sectionLimit
    : DEFAULT_SECTION_LIMIT;

  const records = Array.isArray(operationalRecords) ? operationalRecords.filter(isPlainObject) : [];
  const planList = Array.isArray(plans) ? plans.filter(isPlainObject) : [];
  const executionList = Array.isArray(executions) ? executions.filter(isPlainObject) : [];

  const childrenByProject = new Map();
  for (const record of records) {
    if (!record.projectId) continue;
    if (!childrenByProject.has(record.projectId)) childrenByProject.set(record.projectId, []);
    childrenByProject.get(record.projectId).push(record);
  }

  const commitments = [];
  const priorityTasks = [];
  const projects = [];
  const overdueRecords = [];
  const blockedRecords = [];
  const unscheduledTasks = [];

  for (const record of records) {
    if (!ACTIVE_RECORD_STATUSES.has(record.status)) continue;
    const dueMs = parseDueMs(record.dueAt);
    const overdue = dueMs !== null && dueMs < safeNowMs;
    const blocked = record.status === 'blocked';

    if (overdue) {
      overdueRecords.push({
        id: record.id,
        kind: record.kind,
        title: record.title,
        status: record.status,
        dueAt: record.dueAt,
      });
    }
    if (blocked) {
      blockedRecords.push({
        id: record.id,
        kind: record.kind,
        title: record.title,
        dueAt: record.dueAt || null,
      });
    }

    if (record.kind === 'commitment') {
      const onTargetDate = typeof record.dueAt === 'string' && record.dueAt.slice(0, 10) === targetDate;
      commitments.push({
        id: record.id,
        title: record.title,
        status: record.status,
        dueAt: record.dueAt || null,
        overdue,
        onTargetDate,
        relevance: record.relevance ?? 0.5,
      });
    } else if (record.kind === 'task') {
      const score = scoreTask(record, { nowMs: safeNowMs, targetDate, overdue, blocked });
      priorityTasks.push({
        id: record.id,
        title: record.title,
        status: record.status,
        dueAt: record.dueAt || null,
        projectId: record.projectId || null,
        overdue,
        blocked,
        score,
        priority: toPriority(score),
      });
      if (!record.dueAt && !blocked) {
        unscheduledTasks.push({
          id: record.id,
          title: record.title,
          status: record.status,
        });
      }
    } else if (record.kind === 'project') {
      const children = childrenByProject.get(record.id) || [];
      const openTasksCount = children.filter(item => ACTIVE_RECORD_STATUSES.has(item.status)).length;
      const doneTasksCount = children.filter(item => item.status === 'done').length;
      projects.push({
        id: record.id,
        title: record.title,
        status: record.status,
        dueAt: record.dueAt || null,
        relevance: record.relevance ?? 0.5,
        openTasksCount,
        doneTasksCount,
        updatedAt: record.updatedAt || null,
      });
    }
  }

  commitments.sort((a, b) => {
    if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
    if (a.onTargetDate !== b.onTargetDate) return a.onTargetDate ? -1 : 1;
    return sortByDueThenCreated(a, b);
  });

  priorityTasks.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return sortByDueThenCreated(a, b);
  });

  projects.sort((a, b) => {
    if (b.relevance !== a.relevance) return b.relevance - a.relevance;
    return String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')) || String(a.id || '').localeCompare(String(b.id || ''));
  });

  const pendingPlans = [];
  for (const plan of planList) {
    if (!ACTIVE_PLAN_STATUSES.has(plan.status)) continue;
    const steps = Array.isArray(plan.steps) ? plan.steps : [];
    const pendingStepsCount = steps.filter(step => step?.status === 'pending' || step?.status === 'running' || step?.status === 'failed').length;
    pendingPlans.push({
      id: plan.id,
      goal: plan.goal,
      status: plan.status,
      pendingStepsCount,
      totalStepsCount: steps.length,
      updatedAt: plan.updatedAt || plan.createdAt || null,
    });
  }

  const executionAlerts = [];
  const executionCounts = { total: executionList.length, ok: 0, failed: 0, denied: 0, timeout: 0 };
  for (const ex of executionList) {
    if (ex.status === 'ok') executionCounts.ok += 1;
    else if (ex.status === 'failed') executionCounts.failed += 1;
    else if (ex.status === 'denied') executionCounts.denied += 1;
    else if (ex.status === 'timeout') executionCounts.timeout += 1;

    if (ALERT_EXECUTION_STATUSES.has(ex.status)) {
      executionAlerts.push({
        id: ex.id,
        tool: ex.tool,
        status: ex.status,
        reason: ex.reason || null,
        startedAt: ex.startedAt || null,
      });
    }
  }
  executionAlerts.sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')));

  const pendingTotalCount = overdueRecords.length
    + blockedRecords.length
    + unscheduledTasks.length
    + pendingPlans.length
    + executionAlerts.length;

  const empty = commitments.length === 0
    && priorityTasks.length === 0
    && projects.length === 0
    && pendingTotalCount === 0
    && executionCounts.total === 0;

  const trimmed = {
    schema: BRIEFING_SCHEMA,
    date: targetDate,
    generatedAt: new Date(safeNowMs).toISOString(),
    empty,
    commitments: commitments.slice(0, limit),
    priorityTasks: priorityTasks.slice(0, limit),
    projects: projects.slice(0, limit),
    pending: {
      totalCount: pendingTotalCount,
      overdueRecords: overdueRecords.slice(0, limit),
      blockedRecords: blockedRecords.slice(0, limit),
      unscheduledTasks: unscheduledTasks.slice(0, limit),
      plans: pendingPlans.slice(0, limit),
      executionAlerts: executionAlerts.slice(0, limit),
    },
    executionsSummary: {
      ...executionCounts,
      recent: [...executionList]
        .sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')))
        .slice(0, 5)
        .map(item => ({
          id: item.id,
          tool: item.tool,
          status: item.status,
          verified: item.verified === true,
          startedAt: item.startedAt || null,
        })),
    },
    counts: {
      commitments: commitments.length,
      priorityTasks: priorityTasks.length,
      projects: projects.length,
      pending: pendingTotalCount,
      pendingPlans: pendingPlans.length,
      executions: executionCounts.total,
    },
  };

  const deterministicText = formatDeterministicBriefingText(trimmed);
  return {
    ...trimmed,
    text: deterministicText,
    deterministicText,
    narrativeSource: 'deterministic',
  };
}

