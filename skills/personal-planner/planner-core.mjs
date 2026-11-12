/**
 * Núcleo determinístico da skill Personal Planner.
 *
 * Calcula prioridade de tarefas/compromissos, detecta conflitos de horário e
 * monta o resumo verificável do cronograma sem tocar o sistema de arquivos nem
 * dependências externas (compartilhado entre runtime e pacote isolado da skill).
 */

export const DEFAULT_DURATION_MINUTES = 60;
export const MIN_DURATION_MINUTES = 5;
export const MAX_DURATION_MINUTES = 480;

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const ACTIVE_STATUSES = new Set(['open', 'in_progress', 'blocked']);
const SCHEDULABLE_KINDS = new Set(['task', 'commitment']);
const PRIORITY_TO_RELEVANCE = Object.freeze({ 1: 1.0, 2: 0.8, 3: 0.6, 4: 0.4, 5: 0.2 });

export function isDateTimeDueAt(dueAt) {
  if (typeof dueAt !== 'string') return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(dueAt)) return false;
  return !Number.isNaN(Date.parse(dueAt));
}

export function toDateKey(dueAt) {
  if (typeof dueAt !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(dueAt)) return null;
  return dueAt.slice(0, 10);
}

export function clampDurationMinutes(value, fallback = DEFAULT_DURATION_MINUTES) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.round(value), MIN_DURATION_MINUTES), MAX_DURATION_MINUTES);
}

export function priorityToRelevance(priority) {
  if (!Number.isInteger(priority) || priority < 1 || priority > 5) return null;
  return PRIORITY_TO_RELEVANCE[priority];
}

function scoreToPriority(score) {
  if (score >= 0.85) return 1;
  if (score >= 0.65) return 2;
  if (score >= 0.45) return 3;
  if (score >= 0.25) return 4;
  return 5;
}

function scoreToTier(priority) {
  if (priority === 1) return 'critica';
  if (priority === 2) return 'alta';
  if (priority === 3) return 'media';
  return 'baixa';
}

function parseDueMs(dueAt) {
  if (typeof dueAt !== 'string' || !dueAt) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(dueAt)) {
    // Data sem hora vale até o fim do dia UTC para não marcar como atrasada cedo demais.
    const parsed = Date.parse(`${dueAt}T23:59:59.999Z`);
    return Number.isNaN(parsed) ? null : parsed;
  }
  const parsed = Date.parse(dueAt);
  return Number.isNaN(parsed) ? null : parsed;
}

function formatClock(dueAt) {
  return isDateTimeDueAt(dueAt) ? dueAt.slice(11, 16) : null;
}

/**
 * Detecta sobreposições de horário entre tarefas e compromissos ativos com
 * timestamp (`YYYY-MM-DDTHH:MM...`). Itens apenas com data (`YYYY-MM-DD`) não
 * geram conflito falso de hora exata.
 */
export function detectScheduleConflicts(
  records,
  { durations = {}, defaultDurationMinutes = DEFAULT_DURATION_MINUTES } = {},
) {
  if (!Array.isArray(records)) return [];
  const timed = [];
  for (const record of records) {
    if (!record || !ACTIVE_STATUSES.has(record.status) || !SCHEDULABLE_KINDS.has(record.kind)) continue;
    if (!isDateTimeDueAt(record.dueAt)) continue;
    const startMs = Date.parse(record.dueAt);
    const durationMinutes = clampDurationMinutes(durations[record.id], defaultDurationMinutes);
    timed.push({
      record,
      startMs,
      endMs: startMs + durationMinutes * 60_000,
      durationMinutes,
    });
  }

  timed.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || a.record.id.localeCompare(b.record.id));

  const conflicts = [];
  for (let i = 0; i < timed.length; i += 1) {
    const first = timed[i];
    for (let j = i + 1; j < timed.length; j += 1) {
      const second = timed[j];
      if (second.startMs >= first.endMs) break;
      const overlapMs = Math.min(first.endMs, second.endMs) - second.startMs;
      const overlapMinutes = Math.max(1, Math.round(overlapMs / 60_000));
      conflicts.push({
        type: 'overlap',
        date: toDateKey(first.record.dueAt),
        overlapMinutes,
        a: {
          id: first.record.id,
          kind: first.record.kind,
          title: first.record.title,
          dueAt: first.record.dueAt,
        },
        b: {
          id: second.record.id,
          kind: second.record.kind,
          title: second.record.title,
          dueAt: second.record.dueAt,
        },
        summary: `${first.record.dueAt.slice(0, 16).replace('T', ' ')}: "${first.record.title}" sobrepõe "${second.record.title}" (${overlapMinutes} min)`,
      });
    }
  }
  return conflicts;
}

/**
 * Ordena tarefas e compromissos ativos por relevância, urgência, status e
 * envolvimento em conflitos de horário.
 */
export function prioritizeRecords(
  records,
  { nowMs = Date.now(), conflicts = [], kind, projectId } = {},
) {
  if (!Array.isArray(records)) return [];
  const conflictIds = new Set();
  for (const conflict of conflicts) {
    if (conflict?.a?.id) conflictIds.add(conflict.a.id);
    if (conflict?.b?.id) conflictIds.add(conflict.b.id);
  }

  const scored = [];
  for (const record of records) {
    if (!record || !ACTIVE_STATUSES.has(record.status)) continue;
    if (!kind && !SCHEDULABLE_KINDS.has(record.kind)) continue;
    if (kind && record.kind !== kind) continue;
    if (projectId && record.projectId !== projectId) continue;

    const reasons = [];
    const relevance = typeof record.relevance === 'number' && Number.isFinite(record.relevance)
      ? Math.min(Math.max(record.relevance, 0), 1)
      : 0.5;
    let score = relevance * 0.45;
    if (relevance >= 0.75) reasons.push('alta relevância');

    const dueMs = parseDueMs(record.dueAt);
    let overdue = false;
    if (dueMs !== null) {
      const delta = dueMs - nowMs;
      if (delta < 0) {
        score += 0.4;
        overdue = true;
        reasons.push('atrasada');
      } else if (delta <= 24 * HOUR_MS) {
        score += 0.32;
        reasons.push('vence em 24h');
      } else if (delta <= 3 * DAY_MS) {
        score += 0.24;
        reasons.push('curto prazo');
      } else if (delta <= 7 * DAY_MS) {
        score += 0.16;
        reasons.push('nesta semana');
      } else {
        score += 0.08;
      }
    } else {
      reasons.push('sem prazo');
    }

    if (record.status === 'in_progress') {
      score += 0.08;
      reasons.push('em andamento');
    } else if (record.status === 'blocked') {
      score -= 0.05;
      reasons.push('bloqueada');
    }

    if (record.kind === 'commitment') {
      score += 0.07;
      reasons.push('compromisso');
    }

    const inConflict = conflictIds.has(record.id);
    if (inConflict) {
      score += 0.05;
      reasons.push('conflito de horário');
    }

    const clampedScore = Number(Math.min(1, Math.max(0, score)).toFixed(3));
    const priority = scoreToPriority(clampedScore);
    scored.push({
      id: record.id,
      kind: record.kind,
      title: record.title,
      status: record.status,
      ...(record.dueAt ? { dueAt: record.dueAt } : {}),
      ...(record.projectId ? { projectId: record.projectId } : {}),
      relevance,
      score: clampedScore,
      priority,
      tier: scoreToTier(priority),
      overdue,
      inConflict,
      reasons,
      createdAt: record.createdAt || '',
    });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const dueA = parseDueMs(a.dueAt) ?? Number.POSITIVE_INFINITY;
    const dueB = parseDueMs(b.dueAt) ?? Number.POSITIVE_INFINITY;
    if (dueA !== dueB) return dueA - dueB;
    return String(a.createdAt).localeCompare(String(b.createdAt)) || a.id.localeCompare(b.id);
  });

  return scored.map((item, index) => {
    const { createdAt, ...rest } = item;
    return { rank: index + 1, ...rest };
  });
}

function withinWindow(dueAt, fromMs, toMs) {
  if (fromMs === null && toMs === null) return true;
  const dueMs = parseDueMs(dueAt);
  if (dueMs === null) return false;
  if (fromMs !== null && dueMs < fromMs) return false;
  if (toMs !== null && dueMs > toMs) return false;
  return true;
}

/**
 * Monta cronograma diário, lista priorizada, conflitos de horário e resumo
 * verificável a partir dos registros operacionais ativos.
 */
export function buildScheduleSummary({
  records,
  nowMs = Date.now(),
  from = null,
  to = null,
  goal = 'Organizar minha semana',
  durations = {},
  defaultDurationMinutes = DEFAULT_DURATION_MINUTES,
} = {}) {
  const fromMs = from ? Date.parse(from) : null;
  const endOfDayRe = /^\d{4}-\d{2}-\d{2}$/;
  const rawToMs = to ? Date.parse(to) : null;
  const toMs = rawToMs !== null && !Number.isNaN(rawToMs) && endOfDayRe.test(to)
    ? rawToMs + DAY_MS - 1
    : rawToMs;

  const active = Array.isArray(records)
    ? records.filter(r => r && ACTIVE_STATUSES.has(r.status) && SCHEDULABLE_KINDS.has(r.kind))
    : [];

  const inScope = active.filter(r => !r.dueAt || withinWindow(r.dueAt, fromMs, toMs));
  const conflicts = detectScheduleConflicts(inScope, { durations, defaultDurationMinutes });
  const prioritized = prioritizeRecords(inScope, { nowMs, conflicts });
  const prioritizedById = new Map(prioritized.map(item => [item.id, item]));

  const daysMap = new Map();
  const unscheduled = [];
  let overdue = 0;
  let blocked = 0;

  for (const item of prioritized) {
    if (item.overdue) overdue += 1;
    if (item.status === 'blocked') blocked += 1;
    const dateKey = toDateKey(item.dueAt);
    if (!dateKey) {
      unscheduled.push(item);
      continue;
    }
    if (!daysMap.has(dateKey)) daysMap.set(dateKey, []);
    daysMap.get(dateKey).push({
      ...item,
      time: formatClock(item.dueAt),
    });
  }

  const days = [...daysMap.entries()]
    .sort(([dayA], [dayB]) => dayA.localeCompare(dayB))
    .map(([date, items]) => ({
      date,
      items: [...items].sort((a, b) => {
        const msA = parseDueMs(a.dueAt) ?? Number.POSITIVE_INFINITY;
        const msB = parseDueMs(b.dueAt) ?? Number.POSITIVE_INFINITY;
        if (msA !== msB) return msA - msB;
        return a.rank - b.rank;
      }),
    }));

  const scheduled = prioritized.length - unscheduled.length;
  const counts = {
    total: prioritized.length,
    scheduled,
    unscheduled: unscheduled.length,
    overdue,
    blocked,
    conflicts: conflicts.length,
  };

  const parts = [];
  if (counts.total === 0) {
    parts.push('Nenhuma tarefa ou compromisso ativo encontrado na memória operacional.');
  } else {
    parts.push(
      `Cronograma para "${goal}": ${counts.total} ${counts.total === 1 ? 'item ativo' : 'itens ativos'} (${scheduled} agendado(s) em ${days.length} dia(s), ${unscheduled.length} sem data).`,
    );
    if (overdue > 0) parts.push(`${overdue} item(ns) atrasado(s).`);
    if (blocked > 0) parts.push(`${blocked} item(ns) bloqueado(s).`);
    if (conflicts.length > 0) {
      parts.push(`${conflicts.length} conflito(s) de horário: ${conflicts.map(c => c.summary).join('; ')}.`);
    } else {
      parts.push('Sem conflitos de horário detectados.');
    }
    const top = prioritized[0];
    if (top) {
      parts.push(`Prioridade #1: ${top.title} (nível ${top.priority}/${top.tier}).`);
    }
  }

  return {
    goal,
    window: { from, to },
    counts,
    days,
    unscheduled,
    prioritized: prioritized.map(item => ({ ...prioritizedById.get(item.id) })),
    conflicts,
    summary: parts.join(' '),
  };
}
