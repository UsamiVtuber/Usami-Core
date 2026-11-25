/**
 * Habit Garden Skill Core
 * Gerencia hábitos com streaks, heatmap e sugestão de micro-hábitos via store dedicado.
 */
import { createHabitStore } from './habit-store.mjs';
import { dataDir as resolveDataDir } from '../../src/data-paths.js';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const HABIT_TAG = 'habit';
const MICRO_HABIT_TAG = 'micro-habit';

function generateId(prefix = 'hab') {
  return `${prefix}-${randomBytes(6).toString('hex')}`;
}

function nowIso() {
  return new Date().toISOString();
}

function startOfDay(date = new Date()) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function endOfDay(date = new Date()) {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function daysBetween(date1, date2) {
  const d1 = startOfDay(date1);
  const d2 = startOfDay(date2);
  return Math.round((d2 - d1) / 86400000);
}

function formatDateKey(date) {
  return startOfDay(date).toISOString().split('T')[0];
}

function parseDateKey(dateKey) {
  // dateKey is "YYYY-MM-DD" - parse as local date to avoid UTC shift
  const [year, month, day] = dateKey.split('-').map(Number);
  return new Date(year, month - 1, day);
}

function parseFrequency(freq) {
  if (freq === 'daily') return { type: 'daily', interval: 1 };
  if (freq === 'weekly') return { type: 'weekly', interval: 7 };
  if (freq?.startsWith('every:')) {
    const n = parseInt(freq.split(':')[1], 10);
    if (Number.isFinite(n) && n > 0) return { type: 'custom', interval: n };
  }
  return { type: 'daily', interval: 1 };
}

function isDueToday(habit, referenceDate = new Date()) {
  const { frequency, lastLoggedAt } = habit;
  const freq = parseFrequency(frequency);
  const today = startOfDay(referenceDate);

  if (!lastLoggedAt) return true;

  const lastLog = startOfDay(new Date(lastLoggedAt));
  const daysSince = daysBetween(lastLog, today);

  if (freq.type === 'daily') return daysSince >= 1;
  if (freq.type === 'weekly') return daysSince >= 7;
  return daysSince >= freq.interval;
}

function calculateStreak(habit, referenceDate = new Date()) {
  const { frequency, logHistory = [] } = habit;
  if (logHistory.length === 0) return { current: 0, longest: 0 };

  const freq = parseFrequency(frequency);
  const sortedLogs = [...logHistory].map(d => startOfDay(parseDateKey(d))).sort((a, b) => b - a);
  const today = startOfDay(referenceDate);

  let current = 0;
  let longest = 0;
  let tempStreak = 0;
  let expectedDate = today;

  const lastLog = sortedLogs[0];
  const daysSinceLastLog = daysBetween(lastLog, today);

  const gracePeriod = freq.type === 'daily' ? 1 : freq.type === 'weekly' ? 7 : freq.interval;
  if (daysSinceLastLog > gracePeriod) {
    current = 0;
  } else {
    current = 1;
    expectedDate = addDays(lastLog, -freq.interval);

    for (let i = 1; i < sortedLogs.length; i++) {
      const logDate = sortedLogs[i];
      if (daysBetween(logDate, expectedDate) === 0) {
        current++;
        expectedDate = addDays(expectedDate, -freq.interval);
      } else {
        break;
      }
    }
  }

  let checkDate = sortedLogs[0];
  tempStreak = 1;
  longest = 1;

  for (let i = 1; i < sortedLogs.length; i++) {
    const logDate = sortedLogs[i];
    const expectedPrev = addDays(checkDate, -freq.interval);
    if (daysBetween(logDate, expectedPrev) === 0) {
      tempStreak++;
      longest = Math.max(longest, tempStreak);
    } else {
      tempStreak = 1;
    }
    checkDate = logDate;
  }

  return { current, longest };
}

function calculateHeatmap(habit, weeks = 4) {
  const { logHistory = [] } = habit;
  const heatmap = {};
  const today = startOfDay();
  const startDate = addDays(today, -weeks * 7 + 1);

  for (let d = new Date(startDate); d <= today; d = addDays(d, 1)) {
    heatmap[formatDateKey(d)] = 0;
  }

  for (const log of logHistory) {
    const key = formatDateKey(parseDateKey(log));
    if (key in heatmap) heatmap[key] = 1;
  }

  return heatmap;
}

function suggestMicroHabits(existingHabits, thresholdMinutes = 5) {
  const suggestions = [];
  const habitTitles = existingHabits.map(h => h.title.toLowerCase());

  const patterns = [
    { trigger: 'água', suggestion: 'Beber 1 copo d\'água ao acordar', duration: 1 },
    { trigger: 'alongamento', suggestion: 'Alongar por 2 minutos a cada hora', duration: 2 },
    { trigger: 'leitura', suggestion: 'Ler 1 página antes de dormir', duration: 3 },
    { trigger: 'meditação', suggestion: 'Respirar consciente por 1 minuto', duration: 1 },
    { trigger: 'caminhada', suggestion: 'Dar 100 passos após o almoço', duration: 2 },
    { trigger: 'gratidão', suggestion: 'Escrever 1 coisa pela qual é grato', duration: 1 },
    { trigger: 'planejamento', suggestion: 'Definir 3 prioridades do dia', duration: 3 },
    { trigger: 'organização', suggestion: 'Guardar 1 item fora do lugar', duration: 1 },
  ];

  for (const pattern of patterns) {
    const hasRelated = habitTitles.some(t => t.includes(pattern.trigger));
    if (!hasRelated && pattern.duration <= thresholdMinutes) {
      suggestions.push({
        title: pattern.suggestion,
        category: pattern.trigger,
        estimatedMinutes: pattern.duration,
        reason: `Complementa seus hábitos de ${pattern.trigger}`,
      });
    }
  }

  if (existingHabits.length < 3) {
    suggestions.push(
      { title: 'Beber 1 copo d\'água ao acordar', category: 'hidratação', estimatedMinutes: 1, reason: 'Base para energia' },
      { title: 'Alongar por 2 minutos', category: 'movimento', estimatedMinutes: 2, reason: 'Reduz tensão' },
      { title: 'Definir 1 prioridade do dia', category: 'foco', estimatedMinutes: 1, reason: 'Direciona atenção' }
    );
  }

  return suggestions.slice(0, 5);
}

export function createHabitGardenCore({
  dataDir = resolveDataDir(),
  defaultFrequency = 'daily',
  microHabitThreshold = 5,
} = {}) {
  const habitStore = createHabitStore({ dataDir });

  // --- Tools ---

  /**
   * Cria ou atualiza um hábito.
   * @param {{id?:string, title:string, frequency?:'daily'|'weekly'|'custom', category?:string, targetMinutes?:number, color?:string}} params
   */
  async function upsertHabit({ id, title, frequency = defaultFrequency, category, targetMinutes, color }) {
    if (!title?.trim()) throw new Error('title: obrigatório');

    const now = nowIso();

    if (id) {
      const existing = habitStore.get(id);
      if (!existing) throw new Error(`hábito não encontrado (${id})`);

      const patch = { updatedAt: now };
      if (title) patch.title = title;
      if (category !== undefined) patch.category = category;
      if (targetMinutes !== undefined) patch.targetMinutes = targetMinutes;
      if (color !== undefined) patch.color = color;
      if (frequency !== undefined) patch.frequency = frequency;

      const updated = habitStore.update(id, patch);
      if (!updated.ok) throw new Error(updated.errors?.join('; ') || 'falha ao atualizar');
      return { ok: true, action: 'updated', habit: updated.habit };
    }

    const habit = {
      id: generateId(),
      title: title.trim(),
      status: 'open',
      frequency,
      category: category || 'geral',
      targetMinutes: targetMinutes || 0,
      color: color || '#FF5E7E',
      logHistory: [],
      streak: { current: 0, longest: 0 },
      createdAt: now,
      updatedAt: now,
    };

    const created = habitStore.create(habit);
    if (!created.ok) throw new Error(created.errors?.join('; ') || 'falha ao criar');
    return { ok: true, action: 'created', habit: created.habit };
  }

  /**
   * Registra conclusão de um hábito (log).
   * @param {{habitId:string, date?:string, notes?:string}} params
   */
  async function logHabit({ habitId, date, notes }) {
    const habit = habitStore.get(habitId);
    if (!habit) throw new Error(`hábito não encontrado (${habitId})`);

    const logDate = date ? startOfDay(new Date(date)) : startOfDay();
    const logKey = formatDateKey(logDate);

    const logHistory = [...(habit.logHistory || [])];

    // Evita duplicata no mesmo dia
    if (!logHistory.includes(logKey)) {
      logHistory.push(logKey);
      logHistory.sort();
    }

    // Recalcula streak
    const streak = calculateStreak({ ...habit, logHistory }, logDate);

    const updated = habitStore.update(habitId, {
      logHistory,
      streak,
      lastLoggedAt: logDate.toISOString(),
      updatedAt: nowIso(),
    });

    if (!updated.ok) throw new Error(updated.errors?.join('; ') || 'falha ao atualizar');

    return {
      ok: true,
      habit: updated.habit,
      logged: true,
      streak: streak.current,
      isNewLog: !habit.logHistory?.includes(logKey),
    };
  }

  /**
   * Retorna streak atual e histórico de um hábito.
   * @param {{habitId:string}} params
   */
  function getStreak({ habitId }) {
    const habit = habitStore.get(habitId);
    if (!habit) throw new Error(`hábito não encontrado (${habitId})`);

    const streak = calculateStreak(habit);
    const heatmap = calculateHeatmap(habit, 4);
    const isDue = isDueToday(habit);

    return {
      ok: true,
      habitId,
      title: habit.title,
      streak: streak.current,
      longestStreak: streak.longest,
      heatmap,
      isDueToday: isDue,
      frequency: habit.frequency || defaultFrequency,
      totalLogs: habit.logHistory?.length || 0,
    };
  }

  /**
   * Retorna heatmap consolidado de todos os hábitos.
   * @param {{weeks?:number}} params
   */
  function getHeatmap({ weeks = 4 } = {}) {
    const habits = habitStore.list({ limit: 500 });
    const today = startOfDay();
    const startDate = addDays(today, -weeks * 7 + 1);

    const consolidated = {};
    for (let d = new Date(startDate); d <= today; d = addDays(d, 1)) {
      consolidated[formatDateKey(d)] = { count: 0, habits: [] };
    }

    for (const habit of habits) {
      const heatmap = calculateHeatmap(habit, weeks);
      for (const [date, value] of Object.entries(heatmap)) {
        if (value === 1) {
          consolidated[date].count++;
          consolidated[date].habits.push({ id: habit.id, title: habit.title, color: habit.color });
        }
      }
    }

    return {
      ok: true,
      weeks,
      range: { start: startDate.toISOString(), end: today.toISOString() },
      heatmap: consolidated,
      summary: {
        totalHabits: habits.length,
        activeDays: Object.values(consolidated).filter(d => d.count > 0).length,
        totalLogs: Object.values(consolidated).reduce((sum, d) => sum + d.count, 0),
      },
    };
  }

  /**
   * Sugere micro-hábitos baseados nos hábitos existentes.
   * @param {{thresholdMinutes?:number}} params
   */
  function suggestMicroHabitsTool({ thresholdMinutes = microHabitThreshold } = {}) {
    const habits = habitStore.list({ limit: 500 });
    const suggestions = suggestMicroHabits(habits, thresholdMinutes);

    return {
      ok: true,
      suggestions,
      basedOn: habits.map(h => h.title),
      thresholdMinutes,
    };
  }

  /**
   * Lista todos os hábitos com status resumido.
   * @param {{status?:'open'|'done'|'all', category?:string}} params
   */
  function listHabits({ status = 'open', category } = {}) {
    let habits = habitStore.list({ limit: 500 });

    if (status !== 'all') {
      habits = habits.filter(h => h.status === status);
    }
    if (category) {
      habits = habits.filter(h => h.category === category);
    }

    const enriched = habits.map(h => {
      const streak = calculateStreak(h);
      const isDue = isDueToday(h);
      return {
        id: h.id,
        title: h.title,
        status: h.status,
        category: h.category,
        frequency: h.frequency || defaultFrequency,
        targetMinutes: h.targetMinutes,
        color: h.color,
        streak: streak.current,
        longestStreak: streak.longest,
        totalLogs: h.logHistory?.length || 0,
        isDueToday: isDue,
        lastLoggedAt: h.lastLoggedAt,
        createdAt: h.createdAt,
      };
    });

    return {
      ok: true,
      habits: enriched,
      count: enriched.length,
    };
  }

  // --- Tool Specs ---
  const toolSpecs = [
    {
      schema: 'usami.agent.tool.v1',
      name: 'habit.upsert',
      version: '1.0.0',
      description: 'Cria ou atualiza um hábito (frequência, categoria, meta de minutos, cor).',
      origin: 'skill',
      permissionLevel: 2,
      timeoutMs: 3000,
      parameters: [
        { name: 'id', type: 'string', required: false, description: 'ID hab-… para atualização' },
        { name: 'title', type: 'string', required: true, description: 'Título do hábito' },
        { name: 'frequency', type: 'string', required: false, description: 'Frequência: daily, weekly ou custom', enum: ['daily', 'weekly', 'custom'] },
        { name: 'category', type: 'string', required: false, description: 'Categoria (ex.: saúde, produtividade, aprendizado)' },
        { name: 'targetMinutes', type: 'number', required: false, description: 'Meta de minutos por sessão' },
        { name: 'color', type: 'string', required: false, description: 'Cor hex para visualização (padrão: #FF5E7E)' },
      ],
      verify: (result) => result && result.ok === true && result.habit && typeof result.habit.id === 'string',
    },
    {
      schema: 'usami.agent.tool.v1',
      name: 'habit.log',
      version: '1.0.0',
      description: 'Registra conclusão de um hábito (log) para o dia atual ou data específica.',
      origin: 'skill',
      permissionLevel: 2,
      timeoutMs: 3000,
      parameters: [
        { name: 'habitId', type: 'string', required: true, description: 'ID do hábito (hab-…)' },
        { name: 'date', type: 'string', required: false, description: 'Data do log (YYYY-MM-DD ou ISO-8601), padrão: hoje' },
        { name: 'notes', type: 'string', required: false, description: 'Observações opcionais' },
      ],
      verify: (result) => result && result.ok === true && result.habit && typeof result.streak === 'number',
    },
    {
      schema: 'usami.agent.tool.v1',
      name: 'habit.streak',
      version: '1.0.0',
      description: 'Retorna streak atual, maior streak, heatmap 4 semanas e se é devido hoje.',
      origin: 'skill',
      permissionLevel: 1,
      timeoutMs: 2000,
      parameters: [
        { name: 'habitId', type: 'string', required: true, description: 'ID do hábito (hab-…)' },
      ],
      verify: (result) => result && result.ok === true && typeof result.streak === 'number' && typeof result.heatmap === 'object',
    },
    {
      schema: 'usami.agent.tool.v1',
      name: 'habit.heatmap',
      version: '1.0.0',
      description: 'Retorna heatmap consolidado de todos os hábitos (últimas N semanas).',
      origin: 'skill',
      permissionLevel: 1,
      timeoutMs: 3000,
      parameters: [
        { name: 'weeks', type: 'number', required: false, description: 'Número de semanas (padrão: 4)' },
      ],
      verify: (result) => result && result.ok === true && typeof result.heatmap === 'object' && typeof result.summary === 'object',
    },
    {
      schema: 'usami.agent.tool.v1',
      name: 'habit.suggest',
      version: '1.0.0',
      description: 'Sugere micro-hábitos atômicos baseados nos hábitos existentes.',
      origin: 'skill',
      permissionLevel: 1,
      timeoutMs: 2000,
      parameters: [
        { name: 'thresholdMinutes', type: 'number', required: false, description: 'Tempo máximo em minutos para micro-hábito (padrão: 5)' },
      ],
      verify: (result) => result && result.ok === true && Array.isArray(result.suggestions),
    },
    {
      schema: 'usami.agent.tool.v1',
      name: 'habit.list',
      version: '1.0.0',
      description: 'Lista hábitos com streak, status e se são devidos hoje.',
      origin: 'skill',
      permissionLevel: 1,
      timeoutMs: 2000,
      parameters: [
        { name: 'status', type: 'string', required: false, description: 'Filtrar por status: open, done, all', enum: ['open', 'done', 'all'] },
        { name: 'category', type: 'string', required: false, description: 'Filtrar por categoria' },
      ],
      verify: (result) => result && result.ok === true && Array.isArray(result.habits) && typeof result.count === 'number',
    },
  ];

  return {
    // API interna
    upsertHabit,
    logHabit,
    getStreak,
    getHeatmap,
    suggestMicroHabitsTool,
    listHabits,
    // Store
    habitStore,
    // Para registro no tool-registry
    toolSpecs,
    // Config
    config: { defaultFrequency, microHabitThreshold },
  };
}