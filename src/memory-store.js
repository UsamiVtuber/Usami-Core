/**
 * Memória local da Usami — um único JSON por instalação em `data/memory.json`.
 *
 * Tudo é síncrono e a escrita é atômica (tmp + rename, padrão do
 * `tts-cache.js`): um crash no meio da gravação nunca corrompe o arquivo
 * anterior. O relógio é injetável (`now`/`today`) para os testes.
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const MEMORY_FILE = 'memory.json';
const HISTORY_LIMIT = 8;    // últimas mensagens do dia que entram no prompt
const HISTORY_DAYS = 7;     // dias de histórico mantidos no arquivo
const MAX_CORE_FACTS = 50;  // FIFO: núcleo não cresce sem limite
const MAX_RECENT_FACTS = 30;
const MAX_FACT_LENGTH = 300;
const MAX_MESSAGE_LENGTH = 2000;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clampScore(score) {
  const value = Number.isFinite(score) ? score : 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

// Soma dias a uma data "YYYY-MM-DD" sem depender de fuso local.
function addDays(dateStr, days) {
  const date = new Date(dateStr + 'T00:00:00.000Z');
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * @param {{ dataDir: string, now?: () => string, today?: () => string }} options
 * `today` não passado deriva de `now` — injetar um relógio basta.
 */
export function createMemoryStore({ dataDir, now = () => new Date().toISOString(), today } = {}) {
  if (!dataDir || typeof dataDir !== 'string') throw new Error('createMemoryStore: dataDir é obrigatório.');
  const todayFn = today || (() => now().slice(0, 10));
  const filePath = join(dataDir, MEMORY_FILE);

  const defaultData = () => ({
    version: 1,
    user: { name: null, nickname: null, createdAt: now() },
    coreFacts: [],
    recentFacts: [],
    dailyHistory: {},
    affinity: { score: 0, lastDailyGainDate: null, totalDailyGainToday: 0 },
  });

  // Rebuilda qualquer entrada (disco, default, payload de save) sobre a forma
  // completa — tolera arquivo parcial de versões antigas sem perder campos.
  function normalize(input) {
    const base = defaultData();
    if (!isPlainObject(input)) return base;
    const cleanFact = (fact) => (typeof fact === 'string' ? fact.trim().slice(0, MAX_FACT_LENGTH) : null);
    const history = {};
    if (isPlainObject(input.dailyHistory)) {
      for (const [day, messages] of Object.entries(input.dailyHistory)) {
        if (!Array.isArray(messages)) continue;
        history[day] = messages.filter(isPlainObject).map((message) => ({
          role: message.role === 'assistant' ? 'assistant' : 'user',
          content: typeof message.content === 'string' ? message.content.slice(0, MAX_MESSAGE_LENGTH) : '',
          timestamp: typeof message.timestamp === 'string' ? message.timestamp : now(),
        })).filter((message) => message.content);
      }
    }
    const affinity = isPlainObject(input.affinity) ? input.affinity : {};
    return {
      version: Number.isFinite(input.version) ? input.version : base.version,
      user: { ...base.user, ...(isPlainObject(input.user) ? input.user : {}) },
      coreFacts: (Array.isArray(input.coreFacts) ? input.coreFacts : []).map(cleanFact).filter(Boolean),
      recentFacts: (Array.isArray(input.recentFacts) ? input.recentFacts : []).filter(isPlainObject).map((item) => ({
        fact: cleanFact(item.fact),
        date: typeof item.date === 'string' ? item.date : todayFn(),
        expiresAt: typeof item.expiresAt === 'string' ? item.expiresAt : todayFn(),
      })).filter((item) => item.fact),
      dailyHistory: history,
      affinity: {
        score: clampScore(affinity.score),
        lastDailyGainDate: typeof affinity.lastDailyGainDate === 'string' ? affinity.lastDailyGainDate : null,
        totalDailyGainToday: Number.isFinite(affinity.totalDailyGainToday) ? affinity.totalDailyGainToday : 0,
      },
    };
  }

  let data = defaultData();

  function ensureDataDir() {
    mkdirSync(dataDir, { recursive: true });
    return dataDir;
  }

  // Escrita atômica: grava num tmp único e renama por cima do alvo.
  function save(next) {
    data = normalize(next);
    ensureDataDir();
    const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temporary, JSON.stringify(data, null, 2), 'utf8');
    try {
      renameSync(temporary, filePath);
    } catch (error) {
      try { unlinkSync(temporary); } catch {}
      if (error?.code !== 'EEXIST' && error?.code !== 'EPERM') throw error;
    }
    return data;
  }

  function persist() {
    return save(data);
  }

  // Mantém só os últimos HISTORY_DAYS dias de histórico no arquivo.
  function pruneHistory() {
    const days = Object.keys(data.dailyHistory).sort();
    while (days.length > HISTORY_DAYS) {
      delete data.dailyHistory[days.shift()];
    }
  }

  return {
    ensureDataDir,

    /** Carrega o arquivo; se não existe, cria o padrão (score 0, createdAt hoje). */
    load() {
      ensureDataDir();
      try {
        data = normalize(JSON.parse(readFileSync(filePath, 'utf8')));
      } catch (error) {
        // corrompido/ilegível: segue com o padrão em memória, SEM sobrescrever
        // o disco (o JSON antigo ainda pode ser recuperado à mão)
        data = defaultData();
        if (error?.code === 'ENOENT') persist();
      }
      pruneHistory();
      return data;
    },

    /** Substitui todo o estado e grava atomicamente. */
    save,

    /** Estado completo (para debug/testes). */
    getAll() {
      return data;
    },

    getCoreFacts() {
      return [...data.coreFacts];
    },

    /** Fatos recentes ainda válidos (expiresAt > now), como strings para a persona. */
    getRecentFacts(nowIso = now()) {
      return data.recentFacts.filter((item) => item.expiresAt > nowIso).map((item) => item.fact);
    },

    /** Mensagens do dia (no máx. as 8 mais recentes). */
    getTodayHistory(day = todayFn()) {
      const messages = Array.isArray(data.dailyHistory[day]) ? data.dailyHistory[day] : [];
      return messages.slice(-HISTORY_LIMIT);
    },

    /** Fato duradouro; dedupe case-insensitive; promove (remove duplicado recente). */
    addCoreFact(fact) {
      const clean = typeof fact === 'string' ? fact.trim().slice(0, MAX_FACT_LENGTH) : null;
      if (!clean) return data;
      const key = clean.toLowerCase();
      if (data.coreFacts.some((existing) => existing.toLowerCase() === key)) return data;
      data.coreFacts.push(clean);
      if (data.coreFacts.length > MAX_CORE_FACTS) data.coreFacts.shift();
      data.recentFacts = data.recentFacts.filter((item) => item.fact.toLowerCase() !== key);
      return persist();
    },

    /** Fato com TTL (padrão 7 dias); renova o TTL se já existir; ignora se já é núcleo. */
    addRecentFact(fact, ttlDays = 7) {
      const clean = typeof fact === 'string' ? fact.trim().slice(0, MAX_FACT_LENGTH) : null;
      if (!clean) return data;
      const key = clean.toLowerCase();
      if (data.coreFacts.some((existing) => existing.toLowerCase() === key)) return data;
      const entry = { fact: clean, date: todayFn(), expiresAt: addDays(todayFn(), ttlDays) };
      const existingIndex = data.recentFacts.findIndex((item) => item.fact.toLowerCase() === key);
      if (existingIndex >= 0) data.recentFacts[existingIndex] = entry;
      else {
        data.recentFacts.push(entry);
        if (data.recentFacts.length > MAX_RECENT_FACTS) data.recentFacts.shift();
      }
      return persist();
    },

    /** Push no histórico do dia; mantém só as últimas 8 mensagens. */
    appendHistory(role, content, timestamp = now()) {
      const day = todayFn();
      const messages = Array.isArray(data.dailyHistory[day]) ? data.dailyHistory[day] : [];
      messages.push({
        role: role === 'assistant' ? 'assistant' : 'user',
        content: typeof content === 'string' ? content.slice(0, MAX_MESSAGE_LENGTH) : String(content ?? '').slice(0, MAX_MESSAGE_LENGTH),
        timestamp,
      });
      data.dailyHistory[day] = messages.slice(-HISTORY_LIMIT);
      pruneHistory();
      return persist();
    },

    /** Zera o array de um dia. */
    clearTodayHistory(day = todayFn()) {
      data.dailyHistory[day] = [];
      return persist();
    },

    getAffinity() {
      return { ...data.affinity };
    },

    /** Score clamp 0–100; virada de dia zera totalDailyGainToday. */
    setAffinity(score, day = todayFn()) {
      data.affinity.score = clampScore(score);
      if (data.affinity.lastDailyGainDate !== day) {
        data.affinity.lastDailyGainDate = day;
        data.affinity.totalDailyGainToday = 0;
      }
      return persist();
    },
  };
}
