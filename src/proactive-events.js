/**
 * Store persistente de eventos proativos da Usami (<proactive-events.json>).
 *
 * Implementa o contrato aprovado em docs/planning/proactivity-contract.md:
 * - Persistência atômica (tmp + rename)
 * - Idempotência por (source, dedupeKey) com tombstones de 24h
 * - Tetos diários: reminders até 6/dia (máx 3/h), social 6/dia, global 12/dia
 * - Reentrega a cada 5 min de eventos não confirmados
 * - Ingestão resiliente de lembretes do vault (Inbox/Automations/reminders.pending.json)
 */

import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const STORE_FILE = 'proactive-events.json';
const STORE_VERSION = 1;
const MAX_STORE_EVENTS = 200;
const MAX_TOMBSTONES = 200;
const TOMBSTONE_TTL_MS = 24 * 60 * 60 * 1000; // 24 horas
const REDELIVERY_TIMEOUT_MS = 5 * 60 * 1000;   // 5 minutos
const MAX_SOCIAL_REDELIVERIES = 2;

// Tetos acordados no contrato (M1)
export const QUOTAS = {
  REMINDER_DAILY_MAX: 6,
  REMINDER_HOURLY_MAX: 3,
  SOCIAL_DAILY_MAX: 6,      // greetings + idle_nudges
  GLOBAL_DAILY_MAX: 12,     // teto de contenção geral
};

export const VALID_EVENT_TYPES = ['greeting', 'reminder', 'daily_digest', 'idle_nudge'];
export const VALID_PRIORITIES = ['low', 'normal', 'high'];
export const VALID_OUTCOMES = ['shown', 'spoken', 'suppressed', 'expired'];

function getTodayKey(date = new Date()) {
  const d = new Date(date);
  return isNaN(d.getTime()) ? new Date().toISOString().slice(0, 10) : d.toISOString().slice(0, 10);
}

function getHourKey(date = new Date()) {
  const d = new Date(date);
  return String(isNaN(d.getTime()) ? new Date().getHours() : d.getHours());
}

export function createProactiveStore(options = {}) {
  const dataDir = options.dataDir || process.env.USAMI_DATA_DIR || join(process.cwd(), 'data');
  const vaultDir = options.vaultDir || process.env.USAMI_PROACTIVE_VAULT || process.env.USAMI_RAG_VAULT || '';
  const nowFn = typeof options.now === 'function' ? options.now : () => Date.now();

  const filePath = join(dataDir, STORE_FILE);
  const tmpPath = join(dataDir, `${STORE_FILE}.tmp`);

  let state = {
    version: STORE_VERSION,
    events: [],
    tombstones: {},       // key -> timestamp
    dailyCounts: {},      // dateStr -> { reminder: N, social: N, total: N, hourlyReminder: { "14": N } }
  };

  let lastVaultMtimeMs = 0;

  function load() {
    try {
      const content = readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === 'object') {
        state = {
          version: parsed.version || STORE_VERSION,
          events: Array.isArray(parsed.events) ? parsed.events : [],
          tombstones: parsed.tombstones && typeof parsed.tombstones === 'object' ? parsed.tombstones : {},
          dailyCounts: parsed.dailyCounts && typeof parsed.dailyCounts === 'object' ? parsed.dailyCounts : {},
        };
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.warn('[proactive-store] Falha ao ler proactive-events.json:', err.message);
      }
      state = { version: STORE_VERSION, events: [], tombstones: {}, dailyCounts: {} };
    }
  }

  function save() {
    mkdirSync(dataDir, { recursive: true });
    prune();
    const payload = JSON.stringify(state, null, 2);
    try {
      writeFileSync(tmpPath, payload, 'utf8');
      renameSync(tmpPath, filePath);
    } catch (err) {
      try { unlinkSync(tmpPath); } catch {}
      console.warn('[proactive-store] Falha ao salvar proactive-events.json:', err.message);
    }
  }

  function prune() {
    const now = nowFn();
    // Limpa tombstones expiradas (> 24h)
    for (const [key, timestamp] of Object.entries(state.tombstones)) {
      if (now - timestamp > TOMBSTONE_TTL_MS) {
        delete state.tombstones[key];
      }
    }

    // Se ainda houver excesso de tombstones, corta os mais antigos
    const tombstoneEntries = Object.entries(state.tombstones);
    if (tombstoneEntries.length > MAX_TOMBSTONES) {
      tombstoneEntries.sort((a, b) => a[1] - b[1]);
      const toRemove = tombstoneEntries.slice(0, tombstoneEntries.length - MAX_TOMBSTONES);
      for (const [key] of toRemove) {
        delete state.tombstones[key];
      }
    }

    // Poda eventos expirados por expiresAt
    state.events = state.events.filter((ev) => {
      if (!ev.expiresAt) return true;
      const expTime = new Date(ev.expiresAt).getTime();
      return isNaN(expTime) || expTime > now;
    });

    // Poda limite máximo de eventos no store (FIFO)
    if (state.events.length > MAX_STORE_EVENTS) {
      state.events = state.events.slice(state.events.length - MAX_STORE_EVENTS);
    }
  }

  function checkQuotas(type, nowMs) {
    const today = getTodayKey(new Date(nowMs));
    const hour = getHourKey(new Date(nowMs));

    if (!state.dailyCounts[today]) {
      state.dailyCounts[today] = { reminder: 0, social: 0, total: 0, hourlyReminder: {} };
    }
    const dayRecord = state.dailyCounts[today];
    if (!dayRecord.hourlyReminder) dayRecord.hourlyReminder = {};
    if (!dayRecord.hourlyReminder[hour]) dayRecord.hourlyReminder[hour] = 0;

    // Teto global
    if (dayRecord.total >= QUOTAS.GLOBAL_DAILY_MAX) {
      return { allowed: false, reason: 'global_daily_quota_exceeded' };
    }

    if (type === 'reminder') {
      if (dayRecord.reminder >= QUOTAS.REMINDER_DAILY_MAX) {
        return { allowed: false, reason: 'reminder_daily_quota_exceeded' };
      }
      if (dayRecord.hourlyReminder[hour] >= QUOTAS.REMINDER_HOURLY_MAX) {
        return { allowed: false, reason: 'reminder_hourly_quota_exceeded' };
      }
    } else if (type === 'greeting' || type === 'idle_nudge') {
      if (dayRecord.social >= QUOTAS.SOCIAL_DAILY_MAX) {
        return { allowed: false, reason: 'social_daily_quota_exceeded' };
      }
    }

    return { allowed: true };
  }

  function recordQuotaUsage(type, nowMs) {
    const today = getTodayKey(new Date(nowMs));
    const hour = getHourKey(new Date(nowMs));

    if (!state.dailyCounts[today]) {
      state.dailyCounts[today] = { reminder: 0, social: 0, total: 0, hourlyReminder: {} };
    }
    const dayRecord = state.dailyCounts[today];
    if (!dayRecord.hourlyReminder) dayRecord.hourlyReminder = {};
    if (!dayRecord.hourlyReminder[hour]) dayRecord.hourlyReminder[hour] = 0;

    dayRecord.total += 1;
    if (type === 'reminder') {
      dayRecord.reminder += 1;
      dayRecord.hourlyReminder[hour] += 1;
    } else if (type === 'greeting' || type === 'idle_nudge') {
      dayRecord.social += 1;
    }
  }

  function addEvent(rawEvent) {
    if (!rawEvent || typeof rawEvent !== 'object') {
      return { ok: false, status: 400, error: 'Evento inválido.' };
    }

    const type = String(rawEvent.type || '').trim().toLowerCase();
    if (!VALID_EVENT_TYPES.includes(type)) {
      return { ok: false, status: 400, error: `Tipo desconhecido: "${type}". Esperado um de: ${VALID_EVENT_TYPES.join(', ')}` };
    }

    const text = typeof rawEvent.text === 'string' ? rawEvent.text.trim() : '';
    if (!text || text.length > 300) {
      return { ok: false, status: 400, error: 'Texto obrigatório, 1-300 caracteres.' };
    }

    const source = String(rawEvent.source || 'chat').trim().slice(0, 64);
    const dedupeKey = rawEvent.dedupeKey ? String(rawEvent.dedupeKey).trim().slice(0, 128) : null;
    const compoundKey = dedupeKey ? `${source}:${dedupeKey}` : null;
    const now = nowFn();

    // 1. Checagem de Tombstone (evento já confirmou ack nas últimas 24h)
    if (compoundKey && state.tombstones[compoundKey]) {
      if (now - state.tombstones[compoundKey] <= TOMBSTONE_TTL_MS) {
        return { ok: true, deduped: true, message: 'Evento já confirmado anteriormente dentro da janela de 24h.' };
      }
    }

    // 2. Se já existe pendente com mesma dedupeKey, atualiza em vez de duplicar
    if (compoundKey) {
      const existingIdx = state.events.findIndex((e) => e.source === source && e.dedupeKey === dedupeKey);
      if (existingIdx >= 0) {
        const existing = state.events[existingIdx];
        existing.text = text;
        if (rawEvent.priority && VALID_PRIORITIES.includes(rawEvent.priority)) existing.priority = rawEvent.priority;
        if (rawEvent.notBefore) existing.notBefore = new Date(rawEvent.notBefore).toISOString();
        if (rawEvent.expiresAt) existing.expiresAt = new Date(rawEvent.expiresAt).toISOString();
        if (rawEvent.speak !== undefined) existing.speak = Boolean(rawEvent.speak);
        if (rawEvent.emotion) existing.emotion = String(rawEvent.emotion).slice(0, 64);
        if (rawEvent.gesture) existing.gesture = String(rawEvent.gesture).slice(0, 64);
        existing.deliveredAt = null; // reseta entrega para o próximo poll
        save();
        return { ok: true, updated: true, id: existing.id };
      }
    }

    // 3. Checagem de cotas e tetos
    const quotaCheck = checkQuotas(type, now);
    if (!quotaCheck.allowed) {
      return { ok: false, status: 429, error: `Cota de proatividade excedida: ${quotaCheck.reason}` };
    }

    // 4. Criação do evento novo
    const id = `evt_${randomUUID().replace(/-/g, '')}`;
    const createdAt = new Date(now).toISOString();
    const notBefore = rawEvent.notBefore ? new Date(rawEvent.notBefore).toISOString() : createdAt;
    const expiresAt = rawEvent.expiresAt ? new Date(rawEvent.expiresAt).toISOString() : null;

    if ((type === 'reminder' || type === 'daily_digest') && !expiresAt) {
      return { ok: false, status: 400, error: 'expiresAt é obrigatório para reminder e daily_digest.' };
    }

    const priority = VALID_PRIORITIES.includes(rawEvent.priority) ? rawEvent.priority : 'normal';
    const speak = rawEvent.speak !== undefined ? Boolean(rawEvent.speak) : true;
    const emotion = rawEvent.emotion ? String(rawEvent.emotion).slice(0, 64) : null;
    const gesture = rawEvent.gesture ? String(rawEvent.gesture).slice(0, 64) : null;

    const eventObj = {
      id,
      type,
      text,
      priority,
      createdAt,
      notBefore,
      expiresAt,
      dedupeKey,
      source,
      speak,
      emotion,
      gesture,
      deliveredAt: null,
      deliveryAttempts: 0,
    };

    state.events.push(eventObj);
    recordQuotaUsage(type, now);
    save();

    return { ok: true, id, event: eventObj };
  }

  function getPendingEvents({ now = nowFn() } = {}) {
    prune();
    const dueEvents = [];

    for (const ev of state.events) {
      const notBeforeTime = new Date(ev.notBefore).getTime();
      if (!isNaN(notBeforeTime) && notBeforeTime > now) {
        continue; // Ainda não chegou a hora
      }

      // Verificação de reentrega:
      // Se nunca foi entregue OU se foi entregue há mais de 5 minutos sem ack
      const deliveredTime = ev.deliveredAt ? new Date(ev.deliveredAt).getTime() : 0;
      const isRedelivery = deliveredTime > 0 && (now - deliveredTime >= REDELIVERY_TIMEOUT_MS);

      if (!ev.deliveredAt || isRedelivery) {
        // Se for social e já foi entregue muitas vezes sem ack, consideramos descartado
        if (ev.type !== 'reminder' && ev.deliveryAttempts >= MAX_SOCIAL_REDELIVERIES) {
          continue;
        }

        ev.deliveredAt = new Date(now).toISOString();
        ev.deliveryAttempts = (ev.deliveryAttempts || 0) + 1;
        dueEvents.push({ ...ev });
      }
    }

    if (dueEvents.length > 0) {
      save();
    }

    return dueEvents;
  }

  function ackEvents(acks = []) {
    if (!Array.isArray(acks)) return { ok: false, error: 'acks deve ser um array.' };
    const now = nowFn();
    let ackedCount = 0;

    for (const ack of acks) {
      if (!ack || typeof ack !== 'object') continue;
      const id = String(ack.id || '').trim();
      const outcome = String(ack.outcome || 'shown').trim().toLowerCase();
      if (!id) continue;

      const idx = state.events.findIndex((e) => e.id === id);
      if (idx >= 0) {
        const ev = state.events[idx];
        if (ev.dedupeKey) {
          const compKey = `${ev.source}:${ev.dedupeKey}`;
          state.tombstones[compKey] = now;
        }
        state.events.splice(idx, 1);
        ackedCount += 1;
      }
    }

    if (ackedCount > 0) {
      save();
    }

    return { ok: true, acked: ackedCount };
  }

  function ingestVaultReminders() {
    if (!vaultDir) return { ingested: 0, skipped: 0 };
    const remindersFile = join(vaultDir, 'Inbox', 'Automations', 'reminders.pending.json');

    try {
      const stat = statSync(remindersFile);
      if (stat.mtimeMs <= lastVaultMtimeMs) {
        return { ingested: 0, skipped: 0, unchaged: true };
      }

      const content = readFileSync(remindersFile, 'utf8');
      if (!content || !content.trim()) {
        lastVaultMtimeMs = stat.mtimeMs;
        return { ingested: 0, skipped: 0 };
      }

      let parsed;
      try {
        parsed = JSON.parse(content);
      } catch (jsonErr) {
        console.warn('[proactive-store] Arquivo reminders.pending.json com JSON malformado. Ignorando.');
        return { ingested: 0, skipped: 0, error: 'malformed_json' };
      }

      const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.reminders) ? parsed.reminders : []);
      let ingested = 0;
      let skipped = 0;

      for (const item of list) {
        if (!item || typeof item !== 'object' || !item.text) {
          skipped += 1;
          continue;
        }

        const res = addEvent({
          type: 'reminder',
          source: 'vault_ingest',
          dedupeKey: item.id || `${item.date || ''}:${item.slug || item.text.slice(0, 30)}`,
          text: item.text,
          priority: item.priority || 'normal',
          notBefore: item.notBefore || (item.date && item.time ? `${item.date}T${item.time}:00` : null),
          expiresAt: item.expiresAt || (item.date ? `${item.date}T23:59:59` : new Date(nowFn() + 24 * 3600 * 1000).toISOString()),
          speak: item.speak !== false,
          emotion: item.emotion || null,
          gesture: item.gesture || null,
        });

        if (res.ok) {
          ingested += 1;
        } else {
          skipped += 1;
        }
      }

      lastVaultMtimeMs = stat.mtimeMs;
      return { ingested, skipped };
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.warn('[proactive-store] Erro ao ler reminders.pending.json do vault:', err.message);
      }
      return { ingested: 0, skipped: 0 };
    }
  }

  // Inicializa carregando do disco
  load();

  return {
    load,
    save,
    addEvent,
    getPendingEvents,
    ackEvents,
    ingestVaultReminders,
    getState: () => ({
      eventCount: state.events.length,
      tombstoneCount: Object.keys(state.tombstones).length,
      todayCounts: state.dailyCounts[getTodayKey(new Date(nowFn()))] || { reminder: 0, social: 0, total: 0 },
    }),
  };
}
