/**
 * Memória local da Usami — um único JSON por instalação em `data/memory.json`.
 *
 * v2: os fatos duráveis vivem em seções (user, preferences, hobbies,
 * relationship, dates, other). O arquivo v1 (coreFacts plano) é migrado para
 * `other` na leitura, sem perder fato; o disco só muda no próximo save.
 *
 * Tudo é síncrono e a escrita é atômica (tmp + rename, padrão do
 * `tts-cache.js`): um crash no meio da gravação nunca corrompe o arquivo
 * anterior. O relógio é injetável (`now`/`today`) para os testes.
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const MEMORY_FILE = 'memory.json';
const MEMORY_VERSION = 2;
const HISTORY_LIMIT = 8;    // últimas mensagens do dia que entram no prompt
const HISTORY_DAYS = 7;     // dias de histórico mantidos no arquivo
const MAX_RECENT_FACTS = 30;
const MAX_SUMMARIES = 14;   // resumos diários mantidos (Fase 1)
const MAX_FACT_LENGTH = 300;
const MAX_SUMMARY_LENGTH = 1200;
const MAX_MESSAGE_LENGTH = 2000;

export const MEMORY_SECTIONS = ['user', 'preferences', 'hobbies', 'relationship', 'dates', 'other'];

// Teto por seção: o núcleo inteiro não cresce sem limite nem inunda o prompt.
const SECTION_LIMITS = { user: 12, preferences: 12, hobbies: 10, relationship: 10, dates: 8, other: 8 };

const FALLBACK_SECTION = 'other';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clampScore(score) {
  const value = Number.isFinite(score) ? score : 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function cleanText(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : null;
}

function normalizeSection(value) {
  return MEMORY_SECTIONS.includes(value) ? value : FALLBACK_SECTION;
}

function isDateString(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

// Soma dias a uma data "YYYY-MM-DD" sem depender de fuso local.
function addDays(dateStr, days) {
  const date = new Date(dateStr + 'T00:00:00.000Z');
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

const emptySections = () => Object.fromEntries(MEMORY_SECTIONS.map((section) => [section, []]));

/**
 * @param {{ dataDir: string, now?: () => string, today?: () => string }} options
 * `today` não passado deriva de `now` — injetar um relógio basta.
 */
export function createMemoryStore({ dataDir, now = () => new Date().toISOString(), today } = {}) {
  if (!dataDir || typeof dataDir !== 'string') throw new Error('createMemoryStore: dataDir é obrigatório.');
  const todayFn = today || (() => now().slice(0, 10));
  const filePath = join(dataDir, MEMORY_FILE);

  const defaultData = () => ({
    version: MEMORY_VERSION,
    user: { name: null, nickname: null, createdAt: now() },
    sections: emptySections(),
    recentFacts: [],
    dailyHistory: {},
    summaries: [],
    affinity: { score: 0, lastDailyGainDate: null, totalDailyGainToday: 0 },
  });

  // Rebuilda qualquer entrada (disco, default, payload de save) sobre a forma
  // completa — tolera arquivo parcial de versões antigas sem perder campos.
  function normalize(input) {
    const base = defaultData();
    if (!isPlainObject(input)) return base;

    const sections = emptySections();
    const seenFacts = new Set();
    const pushFact = (section, fact) => {
      const clean = cleanText(fact, MAX_FACT_LENGTH);
      if (!clean) return;
      const key = clean.toLowerCase();
      if (seenFacts.has(key)) return;
      const bucket = sections[normalizeSection(section)];
      const limit = SECTION_LIMITS[normalizeSection(section)];
      bucket.push(clean);
      // FIFO: o arquivo mantém os mais recentes quando estoura o teto.
      if (bucket.length > limit) bucket.shift();
      seenFacts.add(key);
    };

    if (isPlainObject(input.sections)) {
      for (const [section, facts] of Object.entries(input.sections)) {
        if (!Array.isArray(facts)) continue;
        for (const fact of facts) pushFact(section, fact);
      }
    }
    // Migração v1: coreFacts vira "other" sem perder nada.
    if (Array.isArray(input.coreFacts)) {
      for (const fact of input.coreFacts) pushFact(FALLBACK_SECTION, fact);
    }

    const recentFacts = [];
    const seenRecent = new Set();
    for (const item of Array.isArray(input.recentFacts) ? input.recentFacts : []) {
      if (!isPlainObject(item)) continue;
      const fact = cleanText(item.fact, MAX_FACT_LENGTH);
      if (!fact) continue;
      const key = fact.toLowerCase();
      if (seenFacts.has(key) || seenRecent.has(key)) continue;
      seenRecent.add(key);
      recentFacts.push({
        fact,
        section: normalizeSection(item.section),
        date: isDateString(item.date) ? item.date : todayFn(),
        expiresAt: isDateString(item.expiresAt) ? item.expiresAt : todayFn(),
      });
    }
    if (recentFacts.length > MAX_RECENT_FACTS) recentFacts.splice(0, recentFacts.length - MAX_RECENT_FACTS);

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

    const summaries = [];
    if (Array.isArray(input.summaries)) {
      for (const item of input.summaries) {
        if (!isPlainObject(item) || !isDateString(item.date)) continue;
        const summary = cleanText(item.summary, MAX_SUMMARY_LENGTH);
        if (!summary) continue;
        summaries.push({ date: item.date, summary });
      }
      summaries.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
      if (summaries.length > MAX_SUMMARIES) summaries.splice(0, summaries.length - MAX_SUMMARIES);
    }

    const affinity = isPlainObject(input.affinity) ? input.affinity : {};
    return {
      version: MEMORY_VERSION,
      user: { ...base.user, ...(isPlainObject(input.user) ? input.user : {}) },
      sections,
      recentFacts,
      dailyHistory: history,
      summaries,
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

  function findFact(fact) {
    const key = fact.toLowerCase();
    for (const section of MEMORY_SECTIONS) {
      const index = data.sections[section].findIndex((existing) => existing.toLowerCase() === key);
      if (index >= 0) return { section, index };
    }
    return null;
  }

  function removeRecentFact(fact) {
    const key = fact.toLowerCase();
    data.recentFacts = data.recentFacts.filter((item) => item.fact.toLowerCase() !== key);
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

    /** Fatos por seção, como cópia (o prompt e a UI não mutam o depósito). */
    getSections() {
      return Object.fromEntries(MEMORY_SECTIONS.map((section) => [section, [...data.sections[section]]]));
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

    /** Resumos diários em ordem cronológica (mais antigo primeiro). */
    getSummaries() {
      return data.summaries.map((item) => ({ ...item }));
    },

    /** Cria/atualiza o resumo de um dia; mantém só os MAX_SUMMARIES mais novos. */
    upsertSummary(date, summary) {
      if (!isDateString(date)) throw new Error('upsertSummary: data inválida (YYYY-MM-DD).');
      const clean = cleanText(summary, MAX_SUMMARY_LENGTH);
      if (!clean) return data;
      data.summaries = data.summaries.filter((item) => item.date !== date);
      data.summaries.push({ date, summary: clean });
      data.summaries.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
      if (data.summaries.length > MAX_SUMMARIES) data.summaries.splice(0, data.summaries.length - MAX_SUMMARIES);
      return persist();
    },

    /** Remove o resumo de um dia. Devolve true se algo saiu. */
    deleteSummary(date) {
      const before = data.summaries.length;
      data.summaries = data.summaries.filter((item) => item.date !== date);
      if (data.summaries.length === before) return false;
      persist();
      return true;
    },

    clearSummaries() {
      if (!data.summaries.length) return data;
      data.summaries = [];
      return persist();
    },

    /** Fato duradouro na seção pedida; dedupe case-insensitive; move de seção. */
    addCoreFact(fact, section = FALLBACK_SECTION) {
      const clean = cleanText(fact, MAX_FACT_LENGTH);
      if (!clean) return data;
      const target = normalizeSection(section);
      const existing = findFact(clean);
      if (existing) {
        if (existing.section === target) return data;
        data.sections[existing.section].splice(existing.index, 1);
      }
      const bucket = data.sections[target];
      bucket.push(clean);
      if (bucket.length > SECTION_LIMITS[target]) bucket.shift();
      removeRecentFact(clean);
      return persist();
    },

    /** Fato com TTL (padrão 7 dias); renova o TTL se já existir; ignora se já é núcleo. */
    addRecentFact(fact, ttlDays = 7, section = FALLBACK_SECTION) {
      const clean = cleanText(fact, MAX_FACT_LENGTH);
      if (!clean) return data;
      if (findFact(clean)) return data;
      const key = clean.toLowerCase();
      const entry = {
        fact: clean,
        section: normalizeSection(section),
        date: todayFn(),
        expiresAt: addDays(todayFn(), ttlDays),
      };
      const existingIndex = data.recentFacts.findIndex((item) => item.fact.toLowerCase() === key);
      if (existingIndex >= 0) data.recentFacts[existingIndex] = entry;
      else {
        data.recentFacts.push(entry);
        if (data.recentFacts.length > MAX_RECENT_FACTS) data.recentFacts.shift();
      }
      return persist();
    },

    /** Remove um fato de uma seção. Devolve true se algo saiu. */
    deleteFact(section, fact) {
      const clean = cleanText(fact, MAX_FACT_LENGTH);
      if (!clean || !MEMORY_SECTIONS.includes(section)) return false;
      const bucket = data.sections[section];
      const index = bucket.findIndex((existing) => existing.toLowerCase() === clean.toLowerCase());
      if (index < 0) return false;
      bucket.splice(index, 1);
      persist();
      return true;
    },

    /** Esvazia uma seção inteira. Devolve quantos fatos saíram. */
    clearSection(section) {
      if (!MEMORY_SECTIONS.includes(section)) return 0;
      const removed = data.sections[section].length;
      if (!removed) return 0;
      data.sections[section] = [];
      persist();
      return removed;
    },

    /** Remove um fato recente. Devolve true se algo saiu. */
    deleteRecentFact(fact) {
      const clean = cleanText(fact, MAX_FACT_LENGTH);
      if (!clean) return false;
      const key = clean.toLowerCase();
      const before = data.recentFacts.length;
      data.recentFacts = data.recentFacts.filter((item) => item.fact.toLowerCase() !== key);
      if (data.recentFacts.length === before) return false;
      persist();
      return true;
    },

    clearRecentFacts() {
      const removed = data.recentFacts.length;
      if (!removed) return 0;
      data.recentFacts = [];
      persist();
      return removed;
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

    /** Zera o histórico de todos os dias. Devolve quantos dias tinham mensagens. */
    clearAllHistory() {
      const days = Object.values(data.dailyHistory).filter((messages) => messages.length).length;
      if (!days) return 0;
      data.dailyHistory = {};
      persist();
      return days;
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

    /** Apaga tudo e grava o padrão (novo createdAt). */
    reset() {
      data = defaultData();
      return persist();
    },
  };
}
