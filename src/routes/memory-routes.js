/**
 * @fileoverview Rotas de Memória, Vínculo, Personalidade, Humor e Memória Operacional.
 * @module routes/memory-routes
 */

import { readRagContext, resolveVaultDir } from '../rag.js';
import { TRAITS, CUSTOM_PROMPT_MAX, normalizePersonality } from '../personality-store.js';
import { MEMORY_SECTIONS } from '../memory-store.js';
import { summarizePendingDays } from '../memory-summaries.js';
import { consolidateFacts } from '../memory-consolidation.js';
import { createVaultIndex } from '../vault-index.js';
import { LanceMemoryStore } from '../lancedb-store.js';
import { dataDir as resolveDataDir } from '../data-paths.js';
import { summarizeDay } from '../llm-router.js';
import { OPERATIONAL_KINDS, OPERATIONAL_STATUSES } from '../agent-contracts.js';
import { extractRequestCharacterId } from '../character-context.js';
import {
  OPERATIONAL_DEFAULT_LIMIT,
  OPERATIONAL_MAX_LIMIT,
} from '../operational-memory-store.js';
import {
  DEFAULT_ALLOWED_ORIGINS,
  isAllowedOrigin,
  denyWithoutToken,
  readRequestBody,
  sendJsonResponse,
} from './http-helpers.js';

let sharedVaultIndex = null;
export function getVaultIndex() {
  if (!sharedVaultIndex) {
    sharedVaultIndex = createVaultIndex({
      vaultDir: resolveVaultDir(process.env.USAMI_RAG_VAULT),
      dataDir: resolveDataDir(),
    });
  }
  return sharedVaultIndex;
}

const FORGET_CONFIRMATION = 'APAGAR';
const FORGET_KINDS = new Set(['fact', 'recent', 'section', 'summary', 'history', 'all']);
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const OPERATIONAL_RECORD_PATH_RE = /^\/api\/agent\/memory\/(op-[0-9a-f]{12})$/;

function resolveTenantContext(req, options, hasExplicitStore = false) {
  const registry = options.characterRegistry;
  if (!registry) {
    const charReq = extractRequestCharacterId(req);
    if (!charReq.ok) return { errorStatus: charReq.status, errorMessage: charReq.error };
    return { ctx: null, characterId: charReq.characterId };
  }
  const charReq = extractRequestCharacterId(req, registry.getActiveCharacterId?.() || 'usami-classic');
  if (!charReq.ok) return { errorStatus: charReq.status, errorMessage: charReq.error };
  if (hasExplicitStore && !charReq.explicit && charReq.characterId === 'usami-classic') {
    return { ctx: null, characterId: charReq.characterId };
  }
  try {
    const ctx = registry.getOrCreate(charReq.characterId);
    return { ctx, characterId: charReq.characterId };
  } catch (error) {
    return {
      errorStatus: error?.status || 404,
      errorMessage: error?.message || 'Personagem não encontrado.',
    };
  }
}

/**
 * Normaliza e restringe números de cabeçalho do RAG.
 * @param {string|number|undefined} value
 * @param {number} fallback
 * @param {number} max
 * @returns {number}
 */
export function clampRagNumber(value, fallback, max) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number) || number < 1) return fallback;
  return Math.min(number, max);
}

/**
 * Monta o snapshot serializável para a interface de memória.
 * @param {any} store
 * @param {string} [nowIso]
 * @returns {Record<string, unknown>}
 */
export function memorySnapshot(store, nowIso = new Date().toISOString()) {
  const data = store.getAll();
  return {
    version: data.version,
    user: { name: data.user.name, nickname: data.user.nickname, createdAt: data.user.createdAt },
    sections: store.getSections(),
    recentFacts: data.recentFacts.map((item) => ({ ...item, expired: item.expiresAt <= nowIso })),
    summaries: store.getSummaries(),
    history: Object.entries(data.dailyHistory)
      .filter(([, messages]) => messages.length)
      .map(([date, messages]) => ({ date, count: messages.length }))
      .sort((a, b) => (a.date < b.date ? -1 : 1)),
    affinity: store.getAffinity(),
    bond: store.getBondMirror(),
  };
}

/**
 * Cria o handler para leitura de contexto RAG: GET /api/rag/context.
 * @param {Object} [options]
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createRagContextHandler(options = {}) {
  const allowedOrigins = options.allowedOrigins || DEFAULT_ALLOWED_ORIGINS;
  const vaultRelative = options.vaultRelative || process.env.USAMI_RAG_VAULT;

  return async function handleRagContext(req, res) {
    const send = (status, data) => sendJsonResponse(res, status, data);

    const origin = req.headers.origin;
    const host = req.headers.host;
    if (!isAllowedOrigin(origin, host, allowedOrigins)) {
      return send(403, { error: 'Origem não autorizada.' });
    }
    if (denyWithoutToken(req, options, send)) return;

    if (req.method !== 'GET' || req.url !== '/api/rag/context') {
      return send(404, { error: 'Não encontrado.' });
    }

    const maxFiles = clampRagNumber(req.headers['x-rag-max-files'], 10, 50);
    const maxCharsPerFile = clampRagNumber(req.headers['x-rag-max-chars'], 2000, 20000);
    const maxTotalChars = clampRagNumber(req.headers['x-rag-max-total'], 6000, 60000);

    let context;
    try {
      context = await readRagContext({
        vaultRelative,
        maxFiles,
        maxCharsPerFile,
        maxTotalChars,
      });
    } catch (error) {
      return send(500, { error: 'Erro ao ler contexto RAG: ' + error.message });
    }

    return send(200, {
      ok: true,
      context: context || '',
      hasContext: Boolean(context),
      source: 'vault-obsidian',
    });
  };
}

/**
 * Cria o handler para gerenciar personalidade: GET/POST /api/personality.
 * @param {Object} [options]
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createPersonalityHandler(options = {}) {
  const allowedOrigins = options.allowedOrigins || DEFAULT_ALLOWED_ORIGINS;
  const fallbackStore = options.personalityStore;
  const hasExplicitStore = Boolean(options.personalityStore && !options.isServerDefaultStore);
  const traits = Object.entries(TRAITS).map(([key, value]) => ({ key, label: value.label }));

  return async function handlePersonality(req, res) {
    const send = (status, data) => sendJsonResponse(res, status, data);

    if (!isAllowedOrigin(req.headers.origin, req.headers.host, allowedOrigins)) {
      return send(403, { error: 'Origem não autorizada.' });
    }
    if (denyWithoutToken(req, options, send)) return;

    if (req.url !== '/api/personality') return send(404, { error: 'Não encontrado.' });

    const resolved = resolveTenantContext(req, options, hasExplicitStore);
    if (resolved.errorStatus) return send(resolved.errorStatus, { error: resolved.errorMessage });
    const store = resolved.ctx?.personalityStore || fallbackStore;
    if (!store) return send(500, { error: 'PersonalityStore não inicializado.' });

    if (req.method === 'GET') {
      return send(200, { ok: true, personality: store.get(), traits, customPromptMax: CUSTOM_PROMPT_MAX });
    }
    if (req.method !== 'POST') return send(404, { error: 'Não encontrado.' });

    const contentType = (req.headers['content-type'] || '').split(';')[0].trim();
    if (contentType !== 'application/json') return send(403, { error: 'Content-Type inválido.' });

    const read = await readRequestBody(req, { limit: 4096 });
    if (!read.ok) return send(413, { error: 'Pedido muito longo.' });
    let payload;
    try {
      payload = JSON.parse(read.body);
    } catch {
      return send(400, { error: 'Corpo da requisição inválido (JSON esperado).' });
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return send(400, { error: 'Corpo inválido.' });
    }

    try {
      const saved = payload.reset === true ? store.reset() : store.save(normalizePersonality(payload));
      return send(200, { ok: true, personality: saved });
    } catch {
      return send(500, { error: 'Não foi possível salvar a personalidade.' });
    }
  };
}

/**
 * Cria o handler para gerenciar memória: GET /api/memory, POST /api/memory/forget, POST /api/memory/maintenance.
 * @param {Object} [options]
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createMemoryHandler(options = {}) {
  const allowedOrigins = options.allowedOrigins || DEFAULT_ALLOWED_ORIGINS;
  const fallbackStore = options.memoryStore;
  const fallbackBond = 'bondStore' in options ? options.bondStore : null;
  const hasExplicitStore = Boolean(options.memoryStore && !options.isServerDefaultStore);
  const useNvidiaFn = options.useNvidia || (() => process.env.USE_NVIDIA !== 'false' && Boolean(process.env.NVIDIA_API_KEY));

  return async function handleMemory(req, res) {
    const send = (status, data) => sendJsonResponse(res, status, data);

    const origin = req.headers.origin;
    const host = req.headers.host;
    if (!isAllowedOrigin(origin, host, allowedOrigins)) {
      return send(403, { error: 'Origem não autorizada.' });
    }
    if (denyWithoutToken(req, options, send)) return;

    const resolved = resolveTenantContext(req, options, hasExplicitStore);
    if (resolved.errorStatus) return send(resolved.errorStatus, { error: resolved.errorMessage });
    const store = resolved.ctx?.memoryStore || fallbackStore;
    const bond = resolved.ctx?.bondStore ?? fallbackBond;
    if (!store) return send(500, { error: 'MemoryStore não inicializado.' });

    if (req.method === 'GET' && req.url === '/api/memory') {
      return send(200, { ok: true, memory: memorySnapshot(store) });
    }

    if (req.method === 'POST' && req.url === '/api/memory/maintenance') {
      const today = new Date().toISOString().slice(0, 10);
      try {
        await summarizePendingDays({
          store,
          today,
          summarize: useNvidiaFn() ? summarizeDay : undefined,
        });
      } catch (err) {
        console.warn('[maintenance] summarizePendingDays falhou:', err?.message || err);
      }

      try {
        await consolidateFacts({ store, today });
      } catch (err) {
        console.warn('[maintenance] consolidateFacts falhou:', err?.message || err);
      }

      try {
        getVaultIndex().refresh();
      } catch (err) {
        console.warn('[maintenance] getVaultIndex refresh falhou:', err?.message || err);
      }

      let lanceDbCount = 0;
      const provider = resolved.ctx?.memoryProvider || null;
      if (!provider || provider.isEnabled()) {
        try {
          const lanceStore = options.lanceStore
            || provider?.lanceStore
            || new LanceMemoryStore({
              dataDir: resolveDataDir(),
              characterId: resolved.characterId !== 'usami-classic' ? resolved.characterId : null,
            });
          await lanceStore.init();
          lanceDbCount = await lanceStore.count();
        } catch (err) {
          console.warn('[maintenance] LanceDB check falhou:', err?.message || err);
        }
      }

      return send(200, {
        ok: true,
        maintenanceAt: new Date().toISOString(),
        today,
        lanceDbChunks: lanceDbCount,
        memory: memorySnapshot(store),
      });
    }

    if (req.method !== 'POST' || req.url !== '/api/memory/forget') {
      return send(404, { error: 'Não encontrado.' });
    }

    const contentType = (req.headers['content-type'] || '').split(';')[0].trim();
    if (contentType !== 'application/json') {
      return send(403, { error: 'Content-Type inválido.' });
    }

    const read = await readRequestBody(req, { limit: 8192 });
    if (!read.ok) return send(413, { error: 'Pedido muito longo.' });

    let payload;
    try {
      payload = JSON.parse(read.body);
    } catch {
      return send(400, { error: 'Corpo da requisição inválido (JSON esperado).' });
    }

    const kind = payload?.kind;
    if (!FORGET_KINDS.has(kind)) {
      return send(400, { error: 'Tipo inválido. Use fact, recent, section, summary, history ou all.' });
    }
    if (String(payload.confirm ?? '').trim().toUpperCase() !== FORGET_CONFIRMATION) {
      return send(403, { error: 'Confirmação escrita necessária: envie confirm: "APAGAR".' });
    }

    let removed = 0;
    switch (kind) {
      case 'fact': {
        if (!MEMORY_SECTIONS.includes(payload.section)) return send(400, { error: 'Seção inválida.' });
        if (typeof payload.fact !== 'string' || !payload.fact.trim()) return send(400, { error: 'Fato ausente.' });
        removed = store.deleteFact(payload.section, payload.fact) ? 1 : 0;
        break;
      }
      case 'recent': {
        if (typeof payload.fact !== 'string' || !payload.fact.trim()) return send(400, { error: 'Fato ausente.' });
        removed = store.deleteRecentFact(payload.fact) ? 1 : 0;
        break;
      }
      case 'section': {
        if (!MEMORY_SECTIONS.includes(payload.section)) return send(400, { error: 'Seção inválida.' });
        removed = store.clearSection(payload.section);
        break;
      }
      case 'summary': {
        if (!DATE_PATTERN.test(String(payload.date ?? ''))) return send(400, { error: 'Data inválida (YYYY-MM-DD).' });
        removed = store.deleteSummary(payload.date) ? 1 : 0;
        break;
      }
      case 'history': {
        if (payload.date !== undefined) {
          if (!DATE_PATTERN.test(String(payload.date))) return send(400, { error: 'Data inválida (YYYY-MM-DD).' });
          removed = (store.getAll().dailyHistory[payload.date] || []).length;
          store.clearTodayHistory(payload.date);
        } else {
          removed = store.clearAllHistory();
        }
        break;
      }
      case 'all': {
        store.reset();
        if (bond) {
          try {
            store.setBondMirror(bond.getAll());
          } catch (error) {
            console.error('Aviso: espelho do vínculo falhou após limpar a memória:', error?.message || error);
          }
        }
        break;
      }
    }

    return send(200, { ok: true, forgotten: kind, removed, memory: memorySnapshot(store) });
  };
}

/**
 * Cria o handler para vínculo (VN): /api/bond.
 * @param {Object} [options]
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createBondHandler(options = {}) {
  const allowedOrigins = options.allowedOrigins || DEFAULT_ALLOWED_ORIGINS;
  const fallbackStore = options.bondStore;
  const fallbackMemory = 'memoryStore' in options ? options.memoryStore : null;
  const hasExplicitStore = Boolean(options.bondStore && !options.isServerDefaultStore);
  const mirrorBond = (memory, snapshot) => {
    if (!memory || typeof memory.setBondMirror !== 'function') return;
    try {
      memory.setBondMirror(snapshot);
    } catch (error) {
      console.error('Aviso: espelho do vínculo na memória falhou:', error?.message || error);
    }
  };
  const fallbackAchievements = 'achievementsStore' in options ? options.achievementsStore : null;
  const reevaluateAchievements = (store, achievements) => {
    if (!achievements) return;
    try {
      achievements.reevaluate(store.getAll());
    } catch (error) {
      console.error('Aviso: reavaliação de conquistas falhou:', error?.message || error);
    }
  };

  return async function handleBond(req, res) {
    const send = (status, data) => sendJsonResponse(res, status, data);

    const origin = req.headers.origin;
    const host = req.headers.host;
    if (!isAllowedOrigin(origin, host, allowedOrigins)) {
      return send(403, { error: 'Origem não autorizada.' });
    }
    if (denyWithoutToken(req, options, send)) return;

    const resolved = resolveTenantContext(req, options, hasExplicitStore);
    if (resolved.errorStatus) return send(resolved.errorStatus, { error: resolved.errorMessage });
    const store = resolved.ctx?.bondStore || fallbackStore;
    const memory = resolved.ctx?.memoryStore ?? fallbackMemory;
    const achievements = resolved.ctx?.achievementsStore ?? fallbackAchievements;
    if (!store) return send(500, { error: 'BondStore não inicializado.' });

    const route = new URL(req.url || '/api/bond', 'http://127.0.0.1:8787').pathname;

    if (req.method === 'GET' && route === '/api/bond') {
      return send(200, { ok: true, bond: store.getAll() });
    }

    if (req.method !== 'POST') return send(404, { error: 'Não encontrado.' });

    const contentType = (req.headers['content-type'] || '').split(';')[0].trim();
    if (contentType !== 'application/json') {
      return send(403, { error: 'Content-Type inválido.' });
    }

    const read = await readRequestBody(req, { limit: 16384 });
    if (!read.ok) return send(413, { error: 'Pedido muito longo.' });

    let payload;
    try {
      payload = JSON.parse(read.body);
    } catch {
      return send(400, { error: 'Corpo da requisição inválido (JSON esperado).' });
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return send(400, { error: 'Corpo inválido.' });
    }

    if (route === '/api/bond/event') {
      if (payload.kind === 'call') {
        const minutes = Number(payload.minutes);
        if (!Number.isFinite(minutes) || minutes < 1) {
          return send(400, { error: 'Minutos inválidos.' });
        }
        const called = store.awardCall(minutes);
        if (called.changed) {
          reevaluateAchievements(store, achievements);
          mirrorBond(memory, called);
        }
        return send(200, { ok: true, bond: called });
      }
      if (typeof payload.content !== 'string' || !payload.content.trim()) {
        return send(400, { error: 'Conteúdo ausente.' });
      }
      const spoken = payload.spoken === true;
      const awarded = store.awardChat(payload.content, { spoken });
      if (awarded.changed) {
        reevaluateAchievements(store, achievements);
        mirrorBond(memory, awarded);
      }
      return send(200, { ok: true, bond: awarded });
    }

    if (route === '/api/bond/import') {
      const imported = store.importState({ intimacy: payload.intimacy, log: payload.log });
      if (imported.imported) {
        reevaluateAchievements(store, achievements);
        mirrorBond(memory, imported);
      }
      return send(200, { ok: true, bond: imported });
    }

    if (route === '/api/bond/reset') {
      if (String(payload.confirm ?? '').trim().toUpperCase() !== FORGET_CONFIRMATION) {
        return send(403, { error: 'Confirmação escrita necessária: envie confirm: "APAGAR".' });
      }
      const reset = store.reset();
      mirrorBond(memory, reset);
      return send(200, { ok: true, bond: reset });
    }

    return send(404, { error: 'Não encontrado.' });
  };
}

/**
 * Cria o handler para humor contínuo: /api/mood.
 * @param {Object} [options]
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createMoodHandler(options = {}) {
  const allowedOrigins = options.allowedOrigins || DEFAULT_ALLOWED_ORIGINS;
  const fallbackStore = options.moodStore;
  const fallbackMemoryStore = 'memoryStore' in options ? options.memoryStore : null;
  const hasExplicitStore = Boolean(options.moodStore && !options.isServerDefaultStore);

  const currentAffinity = (memStore) => {
    try {
      return memStore?.getAll?.()?.affinity?.score ?? 0;
    } catch {
      return 0;
    }
  };

  return async function handleMood(req, res) {
    const send = (status, data) => sendJsonResponse(res, status, data);

    if (!isAllowedOrigin(req.headers.origin, req.headers.host, allowedOrigins)) {
      return send(403, { error: 'Origem não autorizada.' });
    }
    if (denyWithoutToken(req, options, send)) return;

    const resolved = resolveTenantContext(req, options, hasExplicitStore);
    if (resolved.errorStatus) return send(resolved.errorStatus, { error: resolved.errorMessage });
    const store = resolved.ctx?.moodStore || fallbackStore;
    const memoryStore = resolved.ctx?.memoryStore ?? fallbackMemoryStore;
    if (!store) return send(500, { error: 'MoodStore não inicializado.' });

    const route = new URL(req.url || '/api/mood', 'http://127.0.0.1:8787').pathname;

    if (req.method === 'GET' && route === '/api/mood') {
      return send(200, { ok: true, mood: store.getAll(currentAffinity(memoryStore)) });
    }

    if (req.method !== 'POST') return send(404, { error: 'Não encontrado.' });

    const contentType = (req.headers['content-type'] || '').split(';')[0].trim();
    if (contentType !== 'application/json') {
      return send(403, { error: 'Content-Type inválido.' });
    }

    const read = await readRequestBody(req, { limit: 4096 });
    if (!read.ok) return send(413, { error: 'Pedido muito longo.' });

    let payload = {};
    if (read.body.trim()) {
      try {
        payload = JSON.parse(read.body);
      } catch {
        return send(400, { error: 'JSON inválido.' });
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return send(400, { error: 'Corpo inválido.' });
      }
    }

    if (route === '/api/mood/event') {
      const mood = store.recordEvent({
        emotion: typeof payload.emotion === 'string' ? payload.emotion : 'neutral',
        gesture: typeof payload.gesture === 'string' ? payload.gesture : '',
        reason: typeof payload.reason === 'string' ? payload.reason : '',
        affinity: currentAffinity(memoryStore),
      });
      return send(200, { ok: true, mood });
    }

    if (route === '/api/mood/reset') {
      const mood = store.reset(currentAffinity(memoryStore));
      return send(200, { ok: true, mood });
    }

    return send(404, { error: 'Não encontrado.' });
  };
}

function parseOperationalQuery(searchParams, { forList }) {
  const limitValue = searchParams.get('limit');
  let limit = forList ? OPERATIONAL_DEFAULT_LIMIT : 100;
  if (limitValue !== null) {
    const parsed = Number(limitValue);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > OPERATIONAL_MAX_LIMIT) {
      return { ok: false, error: `limit inválido (inteiro entre 1 e ${OPERATIONAL_MAX_LIMIT}).` };
    }
    limit = parsed;
  }
  if (!forList) return { ok: true, limit };

  const filters = { limit };
  const status = searchParams.get('status');
  if (status !== null) {
    if (!OPERATIONAL_STATUSES.includes(status)) {
      return { ok: false, error: `status inválido (use ${OPERATIONAL_STATUSES.join('|')}).` };
    }
    filters.status = status;
  }
  const kind = searchParams.get('kind');
  if (kind !== null) {
    if (!OPERATIONAL_KINDS.includes(kind)) {
      return { ok: false, error: `kind inválido (use ${OPERATIONAL_KINDS.join('|')}).` };
    }
    filters.kind = kind;
  }
  const projectId = searchParams.get('projectId');
  if (projectId !== null) {
    if (!/^op-[0-9a-f]{12}$/.test(projectId)) return { ok: false, error: 'projectId inválido.' };
    filters.projectId = projectId;
  }
  for (const key of ['from', 'to']) {
    const value = searchParams.get(key);
    if (value === null) continue;
    if (Number.isNaN(Date.parse(value))) return { ok: false, error: `${key} inválido (data ISO-8601).` };
    filters[key] = value;
  }
  return { ok: true, filters };
}

/**
 * Cria o handler para memória operacional: /api/agent/memory.
 * @param {Object} [options]
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createOperationalMemoryHandler(options = {}) {
  const allowedOrigins = options.allowedOrigins || DEFAULT_ALLOWED_ORIGINS;
  const fallbackStore = options.operationalStore;
  const hasExplicitStore = Boolean(options.operationalStore && !options.isServerDefaultStore);

  return async function handleOperationalMemory(req, res) {
    const send = (status, data) => sendJsonResponse(res, status, data);

    if (!isAllowedOrigin(req.headers.origin, req.headers.host, allowedOrigins)) {
      return send(403, { error: 'Origem não autorizada.' });
    }
    if (denyWithoutToken(req, options, send)) return;

    const resolved = resolveTenantContext(req, options, hasExplicitStore);
    if (resolved.errorStatus) return send(resolved.errorStatus, { error: resolved.errorMessage });
    const store = resolved.ctx?.operationalStore || fallbackStore;
    if (!store) return send(500, { error: 'OperationalStore não inicializado.' });

    const url = new URL(req.url || '/api/agent/memory', 'http://127.0.0.1:8787');
    const path = url.pathname;

    if (req.method === 'GET') {
      if (path === '/api/agent/memory/trail') {
        const query = parseOperationalQuery(url.searchParams, { forList: false });
        if (!query.ok) return send(400, { error: query.error });
        const trail = store.trail({ limit: query.limit });
        return send(200, { ok: true, trail, count: trail.length });
      }
      if (path === '/api/agent/memory') {
        const query = parseOperationalQuery(url.searchParams, { forList: true });
        if (!query.ok) return send(400, { error: query.error });
        const records = store.list(query.filters);
        return send(200, { ok: true, records, count: records.length });
      }
      const match = path.match(OPERATIONAL_RECORD_PATH_RE);
      if (!match) return send(404, { error: 'Não encontrado.' });
      const record = store.get(match[1]);
      if (!record) return send(404, { error: 'Registro não encontrado.' });
      return send(200, { ok: true, record });
    }

    if (req.method !== 'POST' && req.method !== 'PATCH') {
      return send(404, { error: 'Não encontrado.' });
    }

    const contentType = (req.headers['content-type'] || '').split(';')[0].trim();
    if (contentType !== 'application/json') return send(403, { error: 'Content-Type inválido.' });

    const read = await readRequestBody(req, { limit: 16384 });
    if (!read.ok) return send(413, { error: 'Pedido muito longo.' });

    let payload;
    try {
      payload = JSON.parse(read.body);
    } catch {
      return send(400, { error: 'Corpo da requisição inválido (JSON esperado).' });
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return send(400, { error: 'Corpo inválido.' });
    }

    if (req.method === 'POST') {
      if (path !== '/api/agent/memory') return send(404, { error: 'Não encontrado.' });
      let created;
      try {
        created = store.create({ ...payload, origin: payload.origin ?? 'user' });
      } catch {
        return send(500, { error: 'Não foi possível salvar o registro.' });
      }
      if (!created.ok) return send(400, { error: 'Registro inválido.', details: created.errors });
      return send(201, { ok: true, record: created.record });
    }

    const match = path.match(OPERATIONAL_RECORD_PATH_RE);
    if (!match) return send(404, { error: 'Não encontrado.' });
    let updated;
    try {
      updated = store.update(match[1], payload);
    } catch {
      return send(500, { error: 'Não foi possível atualizar o registro.' });
    }
    if (!updated.ok) {
      if (updated.notFound) return send(404, { error: 'Registro não encontrado.' });
      return send(400, { error: 'Atualização inválida.', details: updated.errors });
    }
    return send(200, { ok: true, record: updated.record, changed: updated.changed });
  };
}
