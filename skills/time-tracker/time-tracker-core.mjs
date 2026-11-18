/**
 * Time Tracker Skill Core
 * Gerencia Pomodoro, time-blocking e relatórios via memória operacional + store de sessões.
 */
import { createOperationalMemoryStore } from '../../src/operational-memory-store.js';
import { createTimerSessionStore } from './timer-session-store.mjs';
import { dataDir as resolveDataDir } from '../../src/data-paths.js';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const SCHEMA = 'usami.agent.operational.v1';
const KIND_TASK = 'task';
const KIND_COMMITMENT = 'commitment';

const POMODORO_TAG = 'pomodoro';
const FOCUS_TAG = 'focus';
const BLOCK_TAG = 'time-block';

function generateId(prefix = 'op') {
  return `${prefix}-${randomBytes(6).toString('hex')}`;
}

function nowIso() {
  return new Date().toISOString();
}

function parseDurationMinutes(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function getWeekStart(date, weekStartDay = 1) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = (day - weekStartDay + 7) % 7;
  d.setDate(d.getDate() - diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function formatDurationMs(ms) {
  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return `${hours}h ${minutes}min`;
  return `${minutes}min`;
}

export function createTimeTrackerCore({
  dataDir = resolveDataDir(),
  defaultPomodoroMinutes = 25,
  defaultBreakMinutes = 5,
  weekStartDay = 1,
} = {}) {
  const operationalStore = createOperationalMemoryStore({ dataDir });
  const timerStore = createTimerSessionStore({ dataDir });

  // --- Timer Ativo (em memória, não persistido) ---
  let activeTimer = null; // { id, kind, title, projectId, startedAt, tags, pomodoroConfig, timerSessionId }

  // --- Helpers de persistência ---
  function saveTimerSession(record) {
    const existing = timerStore.get(record.id);
    if (existing) {
      return timerStore.update(record.id, record);
    }
    return timerStore.create(record);
  }

  function createOperationalRecord(record) {
    // Cria registro na memória operacional (schema fixo)
    const { metadata, tags, timerSessionId, ...opRecord } = record;
    return operationalStore.create(opRecord);
  }

  function updateOperationalRecord(id, patch) {
    return operationalStore.update(id, patch);
  }

  // --- Tools ---

  /**
   * Inicia uma sessão de timer (foco, pomodoro ou bloco).
   * @param {{title:string, projectId?:string, kind?:'focus'|'pomodoro'|'block', durationMinutes?:number, tags?:string[]}} params
   */
  async function startTimer({ title, projectId, kind = 'focus', durationMinutes, tags = [] }) {
    if (activeTimer) {
      throw new Error('Já existe um timer ativo. Pare o atual antes de iniciar outro.');
    }

    const timerTags = [FOCUS_TAG, kind, ...tags].filter(Boolean);
    if (kind === 'pomodoro') timerTags.push(POMODORO_TAG);

    const timerSessionId = `ts-${randomBytes(6).toString('hex')}`;
    const startedAt = nowIso();

    // 1. Salva sessão detalhada no timer-store
    const sessionRecord = {
      id: timerSessionId,
      kind,
      title: `[Timer] ${title}`,
      status: 'in_progress',
      projectId,
      tags: timerTags,
      startedAt,
      plannedDurationMinutes: durationMinutes || (kind === 'pomodoro' ? defaultPomodoroMinutes : undefined),
      metadata: {
        timerKind: kind,
      },
    };
    await saveTimerSession(sessionRecord);

    // 2. Cria registro operacional resumido (para listagem via API)
    const opRecord = {
      schema: SCHEMA,
      id: generateId(),
      kind: KIND_TASK,
      title: `[Timer] ${title}`,
      status: 'in_progress',
      projectId,
      origin: 'agent',
      relevance: 0.9,
      createdAt: startedAt,
      updatedAt: startedAt,
    };
    await createOperationalRecord(opRecord);

    activeTimer = {
      operationalId: opRecord.id,
      timerSessionId,
      title: opRecord.title,
      kind,
      projectId,
      startedAt,
      tags: timerTags,
      plannedDurationMinutes: durationMinutes || (kind === 'pomodoro' ? defaultPomodoroMinutes : undefined),
    };

    // Retorna estrutura compatível com testes: id operacional + metadata
    return {
      ok: true,
      timer: {
        id: activeTimer.operationalId,
        title: activeTimer.title,
        kind: activeTimer.kind,
        projectId: activeTimer.projectId,
        startedAt: activeTimer.startedAt,
        tags: activeTimer.tags,
        metadata: {
          timerKind: activeTimer.kind,
          plannedDurationMinutes: activeTimer.plannedDurationMinutes,
        },
      },
    };
  }

  function clearActiveTimer() {
    activeTimer = null;
  }

  /**
   * Para o timer ativo e registra a duração real.
   */
  async function stopTimer() {
    if (!activeTimer) {
      throw new Error('Nenhum timer ativo para parar.');
    }

    const endedAt = nowIso();
    const startedAt = new Date(activeTimer.startedAt);
    const endedAtDate = new Date(endedAt);
    const durationMs = endedAtDate - startedAt;

    // 1. Atualiza sessão detalhada
    await saveTimerSession({
      id: activeTimer.timerSessionId,
      status: 'done',
      endedAt,
      actualDurationMs: durationMs,
      completed: true,
    });

    // 2. Atualiza registro operacional
    await updateOperationalRecord(activeTimer.operationalId, {
      status: 'done',
      updatedAt: endedAt,
    });

    const completedTimer = {
      ...activeTimer,
      endedAt,
      actualDurationMs: durationMs,
      durationHuman: formatDurationMs(durationMs),
    };
    clearActiveTimer();

    // Retorna estrutura compatível com testes
    return {
      ok: true,
      timer: {
        id: completedTimer.operationalId,
        title: completedTimer.title,
        kind: completedTimer.kind,
        projectId: completedTimer.projectId,
        startedAt: completedTimer.startedAt,
        endedAt: completedTimer.endedAt,
        actualDurationMs: completedTimer.actualDurationMs,
        durationHuman: completedTimer.durationHuman,
        tags: completedTimer.tags,
        metadata: {
          timerKind: completedTimer.kind,
          plannedDurationMinutes: completedTimer.plannedDurationMinutes,
          completed: true,
        },
      },
      durationMs,
      durationHuman: formatDurationMs(durationMs),
    };
  }

  /**
   * Retorna status do timer ativo (se houver).
   */
  function getTimerStatus() {
    if (!activeTimer) return { active: false };

    const startedAt = new Date(activeTimer.startedAt);
    const elapsedMs = Date.now() - startedAt.getTime();
    return {
      active: true,
      timer: {
        id: activeTimer.timerSessionId,
        operationalId: activeTimer.operationalId,
        title: activeTimer.title,
        kind: activeTimer.kind,
        projectId: activeTimer.projectId,
        startedAt: activeTimer.startedAt,
        elapsedMs,
        elapsedHuman: formatDurationMs(elapsedMs),
        plannedDurationMinutes: activeTimer.plannedDurationMinutes,
        tags: activeTimer.tags,
      },
    };
  }

  /**
   * Inicia um ciclo Pomodoro (foco + pausa agendada).
   * @param {{title:string, projectId?:string, workMinutes?:number, breakMinutes?:number}} params
   */
  async function startPomodoro({ title, projectId, workMinutes, breakMinutes }) {
    const work = parseDurationMinutes(workMinutes, defaultPomodoroMinutes);
    const brk = parseDurationMinutes(breakMinutes, defaultBreakMinutes);

    // Inicia sessão de trabalho
    const workResult = await startTimer({
      title: `🍅 ${title}`,
      projectId,
      kind: 'pomodoro',
      durationMinutes: work,
      tags: ['work', `pomodoro-${work}min`],
    });

    // Agenda pausa (registro operacional como commitment)
    const breakRecord = {
      schema: SCHEMA,
      id: generateId(),
      kind: KIND_COMMITMENT,
      title: `☕ Pausa Pomodoro (${brk}min)`,
      status: 'open',
      projectId,
      tags: [POMODORO_TAG, 'break', `break-${brk}min`],
      origin: 'agent',
      relevance: 0.7,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      dueAt: new Date(Date.now() + work * 60000).toISOString(),
      metadata: { pomodoroBreak: true, breakMinutes: brk },
    };

    await createOperationalRecord(breakRecord);

    return { ok: true, workSession: workResult.timer, breakScheduled: breakRecord };
  }

  /**
   * Cria um bloco de tempo agendado (time-blocking).
   * @param {{title:string, projectId?:string, startAt:string, endAt:string, tags?:string[]}} params
   */
  async function createTimeBlock({ title, projectId, startAt, endAt, tags = [] }) {
    const start = new Date(startAt);
    const end = new Date(endAt);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      throw new Error('startAt e endAt devem ser datas ISO-8601 válidas.');
    }
    if (end <= start) {
      throw new Error('endAt deve ser posterior a startAt.');
    }

    const durationMinutes = Math.round((end - start) / 60000);
    const timerSessionId = `ts-${randomBytes(6).toString('hex')}`;

    // 1. Sessão detalhada no timer-store
    const sessionRecord = {
      id: timerSessionId,
      kind: 'block',
      title: `📅 ${title}`,
      status: 'open',
      projectId,
      tags: [BLOCK_TAG, ...tags].filter(Boolean),
      blockStart: startAt,
      blockEnd: endAt,
      plannedDurationMinutes: durationMinutes,
      metadata: { timeBlock: true },
    };
    await saveTimerSession(sessionRecord);

    // 2. Registro operacional
    const opRecord = {
      schema: SCHEMA,
      id: generateId(),
      kind: KIND_COMMITMENT,
      title: `📅 ${title}`,
      status: 'open',
      projectId,
      tags: [BLOCK_TAG, ...tags].filter(Boolean),
      origin: 'agent',
      relevance: 0.8,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      dueAt: startAt,
      metadata: { timeBlock: true, blockStart: startAt, blockEnd: endAt, durationMinutes },
    };
    await createOperationalRecord(opRecord);

    return { ok: true, block: opRecord, timerSessionId };
  }

  /**
   * Gera relatório agregado.
   * @param {{period?:'day'|'week'|'all', projectId?:string, date?:string}} params
   */
  async function getReport({ period = 'week', projectId, date } = {}) {
    const referenceDate = date ? new Date(date) : new Date();
    let startDate, endDate;

    if (period === 'day') {
      startDate = new Date(referenceDate);
      startDate.setHours(0, 0, 0, 0);
      endDate = new Date(startDate);
      endDate.setHours(23, 59, 59, 999);
    } else if (period === 'week') {
      startDate = getWeekStart(referenceDate, weekStartDay);
      endDate = new Date(startDate);
      endDate.setDate(endDate.getDate() + 6);
      endDate.setHours(23, 59, 59, 999);
    } else {
      startDate = new Date(0);
      endDate = new Date(8640000000000000);
    }

    // Busca sessões completadas no timer-store (têm duração real)
    const allSessions = timerStore.list({ projectId, status: 'done', limit: 1000 });
    const filtered = allSessions.filter(s => {
      const created = new Date(s.createdAt);
      return created >= startDate && created <= endDate;
    });

    // Agrupa por tipo e projeto
    const byKind = { focus: 0, pomodoro: 0, block: 0 };
    const byProject = {};
    let totalMs = 0;
    let completedCount = 0;

    for (const s of filtered) {
      const dur = s.actualDurationMs ?? 0;
      totalMs += dur;
      if (s.status === 'done') completedCount++;

      const kind = s.kind || 'focus';
      byKind[kind] = (byKind[kind] || 0) + dur;

      const pid = s.projectId || 'sem-projeto';
      byProject[pid] = (byProject[pid] || 0) + dur;
    }

    // Top projetos
    const topProjects = Object.entries(byProject)
      .map(([projectId, ms]) => ({ projectId, durationMs: ms, durationHuman: formatDurationMs(ms) }))
      .sort((a, b) => b.durationMs - a.durationMs)
      .slice(0, 5);

    // Sessões para listagem (inclui em andamento)
    const allSessionsForList = timerStore.list({ projectId, limit: 1000 });
    const sessionsForList = allSessionsForList
      .filter(s => {
        const created = new Date(s.createdAt);
        return created >= startDate && created <= endDate;
      })
      .map(s => ({
        id: s.id,
        title: s.title,
        kind: s.kind,
        status: s.status,
        projectId: s.projectId,
        durationMs: s.actualDurationMs,
        durationHuman: s.actualDurationMs ? formatDurationMs(s.actualDurationMs) : 'em andamento',
        startedAt: s.startedAt,
        endedAt: s.endedAt,
      }));

    return {
      ok: true,
      period,
      range: { start: startDate.toISOString(), end: endDate.toISOString() },
      summary: {
        totalTrackedMs: totalMs,
        totalTrackedHuman: formatDurationMs(totalMs),
        completedSessions: completedCount,
        totalSessions: filtered.length,
        byKind: Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, { ms: v, human: formatDurationMs(v) }])),
      },
      topProjects,
      sessions: sessionsForList,
    };
  }

  // --- Validadores das tools (para o tool-registry) ---
  const toolSpecs = [
    {
      schema: 'usami.agent.tool.v1',
      name: 'timer.start',
      version: '1.0.0',
      description: 'Inicia uma sessão de timer (foco, pomodoro ou bloco de tempo).',
      origin: 'skill',
      permissionLevel: 2,
      timeoutMs: 5000,
      parameters: [
        { name: 'title', type: 'string', required: true, description: 'Título da sessão' },
        { name: 'projectId', type: 'string', required: false, description: 'ID do projeto (opcional)' },
        { name: 'kind', type: 'string', required: false, description: 'Tipo: focus, pomodoro ou block', enum: ['focus', 'pomodoro', 'block'] },
        { name: 'durationMinutes', type: 'number', required: false, description: 'Duração planejada em minutos' },
        { name: 'tags', type: 'array', required: false, description: 'Tags adicionais' },
      ],
      verify: (result) => result && result.ok === true && result.timer && typeof result.timer.id === 'string',
    },
    {
      schema: 'usami.agent.tool.v1',
      name: 'timer.stop',
      version: '1.0.0',
      description: 'Para o timer ativo e registra a duração real.',
      origin: 'skill',
      permissionLevel: 2,
      timeoutMs: 5000,
      parameters: [],
      verify: (result) => result && result.ok === true && result.timer && typeof result.durationMs === 'number',
    },
    {
      schema: 'usami.agent.tool.v1',
      name: 'timer.status',
      version: '1.0.0',
      description: 'Retorna status do timer ativo (se houver).',
      origin: 'skill',
      permissionLevel: 1,
      timeoutMs: 2000,
      parameters: [],
      verify: (result) => result && typeof result.active === 'boolean',
    },
    {
      schema: 'usami.agent.tool.v1',
      name: 'timer.report',
      version: '1.0.0',
      description: 'Gera relatório agregado de tempo (dia/semana/tudo).',
      origin: 'skill',
      permissionLevel: 1,
      timeoutMs: 5000,
      parameters: [
        { name: 'period', type: 'string', required: false, description: 'Período: day, week ou all', enum: ['day', 'week', 'all'] },
        { name: 'projectId', type: 'string', required: false, description: 'Filtrar por projeto' },
        { name: 'date', type: 'string', required: false, description: 'Data de referência (ISO-8601)' },
      ],
      verify: (result) => result && result.ok === true && result.summary && typeof result.summary.totalTrackedMs === 'number',
    },
    {
      schema: 'usami.agent.tool.v1',
      name: 'timer.pomodoro',
      version: '1.0.0',
      description: 'Inicia um ciclo Pomodoro (foco + pausa agendada).',
      origin: 'skill',
      permissionLevel: 2,
      timeoutMs: 5000,
      parameters: [
        { name: 'title', type: 'string', required: true, description: 'Título da tarefa' },
        { name: 'projectId', type: 'string', required: false, description: 'ID do projeto' },
        { name: 'workMinutes', type: 'number', required: false, description: 'Minutos de foco (padrão: 25)' },
        { name: 'breakMinutes', type: 'number', required: false, description: 'Minutos de pausa (padrão: 5)' },
      ],
      verify: (result) => result && result.ok === true && result.workSession && result.breakScheduled,
    },
    {
      schema: 'usami.agent.tool.v1',
      name: 'timer.block',
      version: '1.0.0',
      description: 'Cria um bloco de tempo agendado (time-blocking).',
      origin: 'skill',
      permissionLevel: 2,
      timeoutMs: 5000,
      parameters: [
        { name: 'title', type: 'string', required: true, description: 'Título do bloco' },
        { name: 'projectId', type: 'string', required: false, description: 'ID do projeto' },
        { name: 'startAt', type: 'string', required: true, description: 'Início (ISO-8601)' },
        { name: 'endAt', type: 'string', required: true, description: 'Fim (ISO-8601)' },
        { name: 'tags', type: 'array', required: false, description: 'Tags adicionais' },
      ],
      verify: (result) => result && result.ok === true && result.block && result.block.metadata?.timeBlock === true,
    },
  ];

  return {
    // API interna
    startTimer,
    stopTimer,
    getTimerStatus,
    startPomodoro,
    createTimeBlock,
    getReport,
    // Stores para testes/inspeção
    operationalStore,
    timerStore,
    // Para registro no tool-registry
    toolSpecs,
    // Config
    config: { defaultPomodoroMinutes, defaultBreakMinutes, weekStartDay },
  };
}