/**
 * Serviço de Temporizadores, Pomodoro e Lembretes da Usami.
 *
 * Gerencia ciclo de vida do Pomodoro (foco/pausa), fila de lembretes com persistência
 * em `data/reminders.json` e despacho multicanal (Windows Toast, Discord, Companion).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { dataDir as resolveDataDir } from './data-paths.js';
import { broadcastNotification } from './notifier.js';

const REMINDERS_FILE = 'reminders.json';

const isPlainObject = val => Boolean(val) && typeof val === 'object' && !Array.isArray(val);
const generateId = prefix => `${prefix}-${randomBytes(6).toString('hex')}`;

export function parseRelativeOrAbsoluteDue(inMinutes, atTime, now = Date.now()) {
  if (Number.isFinite(Number(inMinutes)) && Number(inMinutes) > 0) {
    return now + Math.round(Number(inMinutes) * 60_000);
  }

  if (typeof atTime === 'string' && atTime.trim()) {
    const timeMatch = /^(\d{1,2}):(\d{2})$/.exec(atTime.trim());
    if (timeMatch) {
      const target = new Date(now);
      const hours = parseInt(timeMatch[1], 10);
      const minutes = parseInt(timeMatch[2], 10);
      target.setHours(hours, minutes, 0, 0);
      if (target.getTime() <= now) {
        // Se o horário já passou hoje, agenda para amanhã
        target.setDate(target.getDate() + 1);
      }
      return target.getTime();
    }
  }

  // Padrão de segurança: 10 minutos se nada foi especificado
  return now + 10 * 60_000;
}

export function createTimerService({
  dataDir = resolveDataDir(),
  filePath = join(dataDir, REMINDERS_FILE),
  n8nQueue = null,
  now = () => Date.now(),
  notifier = broadcastNotification,
  fetchImpl = globalThis.fetch,
  execFileImpl = undefined,
} = {}) {
  let reminders = [];
  let activePomodoro = null;
  let intervalId = null;

  function load() {
    try {
      if (existsSync(filePath)) {
        const raw = readFileSync(filePath, 'utf8');
        const data = JSON.parse(raw);
        if (Array.isArray(data?.reminders)) {
          reminders = data.reminders.filter(isPlainObject);
        }
        if (isPlainObject(data?.activePomodoro)) {
          activePomodoro = data.activePomodoro;
        }
      }
    } catch {
      reminders = [];
      activePomodoro = null;
    }
  }

  function save() {
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      const payload = JSON.stringify({ reminders, activePomodoro }, null, 2);
      const tmpPath = `${filePath}.${randomBytes(4).toString('hex')}.tmp`;
      writeFileSync(tmpPath, payload, 'utf8');
      renameSync(tmpPath, filePath);
    } catch (err) {
      console.warn('[timer-service] falha ao persistir reminders.json:', err?.message || err);
    }
  }

  load();

  function startPomodoro({
    task = 'foco',
    focusMinutes = 25,
    breakMinutes = 5,
  } = {}) {
    const fMins = Math.max(1, Number(focusMinutes) || 25);
    const bMins = Math.max(1, Number(breakMinutes) || 5);
    const currentNow = now();

    activePomodoro = {
      id: generateId('pom'),
      task: String(task || 'foco').trim().slice(0, 100),
      phase: 'focus',
      focusMinutes: fMins,
      breakMinutes: bMins,
      phaseStartedAtMs: currentNow,
      phaseEndsAtMs: currentNow + fMins * 60_000,
      completedPomodoros: 0,
      status: 'running',
      createdAt: new Date(currentNow).toISOString(),
    };

    save();
    return { ...activePomodoro };
  }

  function createReminder({
    text = '',
    inMinutes = null,
    atTime = null,
    channels = ['windows', 'discord', 'companion'],
  } = {}) {
    const cleanText = String(text || '').trim().slice(0, 250);
    if (!cleanText) throw new Error('Texto do lembrete é obrigatório.');

    const currentNow = now();
    const dueAtMs = parseRelativeOrAbsoluteDue(inMinutes, atTime, currentNow);

    const reminder = {
      id: generateId('rem'),
      text: cleanText,
      dueAtMs,
      dueAtIso: new Date(dueAtMs).toISOString(),
      createdAt: new Date(currentNow).toISOString(),
      channels: Array.isArray(channels) ? channels : ['windows', 'discord', 'companion'],
      status: 'pending',
    };

    reminders.push(reminder);
    save();
    return { ...reminder };
  }

  function getStatus() {
    const currentNow = now();
    let pomodoroStatus = null;

    if (activePomodoro && activePomodoro.status === 'running') {
      const remainingSec = Math.max(0, Math.ceil((activePomodoro.phaseEndsAtMs - currentNow) / 1000));
      pomodoroStatus = {
        ...activePomodoro,
        remainingSeconds: remainingSec,
        remainingMinutes: Number((remainingSec / 60).toFixed(1)),
      };
    }

    const pendingReminders = reminders
      .filter(r => r.status === 'pending')
      .map(r => ({
        ...r,
        remainingSeconds: Math.max(0, Math.ceil((r.dueAtMs - currentNow) / 1000)),
      }));

    return {
      activePomodoro: pomodoroStatus,
      pendingReminders,
      totalPending: pendingReminders.length,
    };
  }

  function cancel({ target = 'all', id = null } = {}) {
    const cancelled = [];
    const currentNow = now();

    if (target === 'pomodoro' || target === 'all') {
      if (activePomodoro && activePomodoro.status === 'running') {
        activePomodoro.status = 'stopped';
        activePomodoro.stoppedAt = new Date(currentNow).toISOString();
        cancelled.push({ type: 'pomodoro', id: activePomodoro.id });
        activePomodoro = null;
      }
    }

    if (target === 'reminder' || target === 'all') {
      for (const r of reminders) {
        if (r.status === 'pending' && (!id || r.id === id)) {
          r.status = 'cancelled';
          cancelled.push({ type: 'reminder', id: r.id, text: r.text });
        }
      }
    }

    save();
    return { ok: true, cancelled };
  }

  async function tick() {
    const currentNow = now();
    const notificationsToDispatch = [];

    // 1. Processa Lembretes Vencidos
    for (const reminder of reminders) {
      if (reminder.status === 'pending' && currentNow >= reminder.dueAtMs) {
        reminder.status = 'completed';
        reminder.completedAt = new Date(currentNow).toISOString();
        notificationsToDispatch.push({
          title: '🔔 Lembrete da Usami',
          message: reminder.text,
          channels: reminder.channels,
        });
      }
    }

    // 2. Processa Ciclo do Pomodoro
    if (activePomodoro && activePomodoro.status === 'running') {
      if (currentNow >= activePomodoro.phaseEndsAtMs) {
        if (activePomodoro.phase === 'focus') {
          // Concluiu fase de foco -> Inicia pausa
          activePomodoro.completedPomodoros += 1;
          activePomodoro.phase = 'break';
          activePomodoro.phaseStartedAtMs = currentNow;
          activePomodoro.phaseEndsAtMs = currentNow + activePomodoro.breakMinutes * 60_000;
          notificationsToDispatch.push({
            title: '🍅 Pomodoro Concluído!',
            message: `Tempo de foco em "${activePomodoro.task}" finalizado! Hora de uma pausa de ${activePomodoro.breakMinutes} minutos.`,
            channels: ['windows', 'discord', 'companion'],
          });
        } else if (activePomodoro.phase === 'break') {
          // Concluiu fase de pausa -> Encerra ciclo
          notificationsToDispatch.push({
            title: '☕ Pausa Finalizada!',
            message: `A pausa de ${activePomodoro.breakMinutes} minutos em "${activePomodoro.task}" acabou! Pronto para o próximo round?`,
            channels: ['windows', 'discord', 'companion'],
          });
          activePomodoro.status = 'stopped';
          activePomodoro = null;
        }
      }
    }

    if (notificationsToDispatch.length > 0) {
      save();
      for (const notif of notificationsToDispatch) {
        try {
          await notifier({
            title: notif.title,
            message: notif.message,
            channels: notif.channels,
            n8nQueue,
            fetchImpl,
            execFileImpl,
          });
        } catch (err) {
          console.warn('[timer-service] erro ao emitir notificação:', err?.message || err);
        }
      }
    }
  }

  function start(intervalMs = 5000) {
    if (intervalId) return;
    intervalId = setInterval(() => {
      tick().catch(() => {});
    }, intervalMs);
    if (typeof intervalId.unref === 'function') {
      intervalId.unref();
    }
  }

  function stop() {
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
  }

  return {
    startPomodoro,
    createReminder,
    getStatus,
    cancel,
    tick,
    start,
    stop,
    _getRawReminders: () => reminders,
    _getActivePomodoro: () => activePomodoro,
  };
}
