/**
 * Motor de proatividade da Usami (<开口> / idle rhythm / proactive triggers).
 *
 * Inspirado na arquitetura do OpenAmika:
 * - Janela de inatividade (idle threshold: 3 a 5 min)
 * - Janela de silêncio / Não Perturbe (DND: 23:30 às 08:30)
 * - Proteção de orçamento: máx 1 tentativa não respondida consecutiva
 * - Requer afinidade >= 20 (estágio interesse_genuíno ou superior)
 * - Emite comando `{ type: 'proactive_say', message, emotion, gesture }`
 */

import { getDailyScene } from './scenes.js';
import {
  DEFAULT_DISMISS_SNOOZE_MS,
  DEFAULT_MAX_UNANSWERED_SUGGESTIONS,
  DEFAULT_MIN_RELEVANCE,
  DEFAULT_RELEVANCE_COOLDOWNS_MS,
  evaluateContextualSuggestions,
} from './proactive-suggestions.js';

export const IDLE_TRIGGER_DEFAULT_MS = 180 * 1000; // 3 minutos
export const DND_START_HOUR = 23.5; // 23:30
export const DND_END_HOUR = 8.5;    // 08:30
export const MIN_AFFINITY_FOR_PROACTIVE = 20;
export const VOICE_PENDING_MAX_MS = 180 * 1000; // 3 minutos de teto se speech_done não vier
export const SILENCE_REMARK_MODES = Object.freeze(['normal', 'rare', 'off']);

export function normalizeSilenceRemarks(mode) {
  const m = String(mode ?? 'normal').trim().toLowerCase();
  return SILENCE_REMARK_MODES.includes(m) ? m : 'normal';
}

/**
 * Verifica se o horário atual cai na janela Não Perturbe (DND).
 * @param {Date} [date]
 * @param {number} [startHour] default 23.5
 * @param {number} [endHour] default 8.5
 * @returns {boolean}
 */
export function isQuietHours(date = new Date(), startHour = DND_START_HOUR, endHour = DND_END_HOUR) {
  const d = new Date(date);
  if (isNaN(d.getTime())) return false;
  const current = d.getHours() + d.getMinutes() / 60;
  if (startHour > endHour) {
    // Janela que cruza meia-noite (ex.: 23:30 até 08:30)
    return current >= startHour || current < endHour;
  }
  return current >= startHour && current < endHour;
}

/**
 * Avalia se o gatilho de proatividade pode disparar.
 *
 * @param {Object} params
 * @param {number} params.lastUserActivityMs
 * @param {number} [params.now]
 * @param {number} [params.unansweredCount]
 * @param {number} [params.affinity]
 * @param {boolean} [params.isBusy]
 * @param {number} [params.idleThresholdMs]
 * @param {boolean} [params.enforceQuietHours]
 * @param {number} [params.quietStartHour]
 * @param {number} [params.quietEndHour]
 * @returns {{ allowed: boolean, reason?: string, idleMs?: number }}
 */
export function shouldTriggerProactive({
  lastUserActivityMs,
  now = Date.now(),
  unansweredCount = 0,
  affinity = 0,
  isBusy = false,
  voicePlaying = false,
  silenceRemarks = 'normal',
  idleThresholdMs = IDLE_TRIGGER_DEFAULT_MS,
  enforceQuietHours = true,
  quietStartHour = DND_START_HOUR,
  quietEndHour = DND_END_HOUR,
}) {
  const mode = normalizeSilenceRemarks(silenceRemarks);
  if (mode === 'off') {
    return { allowed: false, reason: 'silence_remarks_off' };
  }

  if (isBusy) {
    return { allowed: false, reason: 'busy' };
  }

  if (voicePlaying) {
    return { allowed: false, reason: 'voice_playing' };
  }

  if (affinity < MIN_AFFINITY_FOR_PROACTIVE) {
    return { allowed: false, reason: 'low_affinity' };
  }

  if (unansweredCount >= 1) {
    return { allowed: false, reason: 'max_unanswered' };
  }

  if (enforceQuietHours && isQuietHours(new Date(now), quietStartHour, quietEndHour)) {
    return { allowed: false, reason: 'quiet_hours' };
  }

  const effectiveThresholdMs = mode === 'rare' ? idleThresholdMs * 3 : idleThresholdMs;
  const idleMs = now - (lastUserActivityMs || 0);
  if (idleMs < effectiveThresholdMs) {
    return { allowed: false, reason: 'not_idle', idleMs, effectiveThresholdMs };
  }

  return { allowed: true, idleMs, effectiveThresholdMs };
}

/**
 * Extrai conteúdo da tag <开口>...</开口> se existir (contrato OpenAmika).
 * @param {string} text
 * @returns {string}
 */
export function parseOpenAmikaTag(text) {
  if (!text || typeof text !== 'string') return '';
  const match = text.match(/<开口>([\s\S]*?)<\/开口>/i) ||
                text.match(/\[开口\]([\s\S]*?)\[\/开口\]/i);
  if (match && match[1]) {
    return match[1].trim();
  }
  return text.trim();
}

/**
 * Monta o prompt de reflexão para o pensamento proativo.
 */
export function buildProactivePrompt({ username = 'você', currentScene = '', dailyContext = '' } = {}) {
  return `=== REFLEXÃO DE INATIVIDADE ===
O ${username} está em silêncio há alguns minutos.
Contexto do seu dia: ${dailyContext}
Cena atual: ${currentScene}

Decida uma fala curta (máximo 1 ou 2 frases curtas, até 100 caracteres) para puxar assunto ou checar como ele está.
Mantenha seu charme tsundere afetuoso. Responda dentro da tag <开口>sua fala aqui</开口>.`;
}

/**
 * Gera a fala proativa da Usami (via LLM router ou fallback determinístico das cenas).
 *
 * @param {Object} params
 * @param {number} [params.affinity]
 * @param {string} [params.username]
 * @param {Date} [params.date]
 * @param {Object} [params.router]
 * @param {boolean} [params.fallbackOnly]
 * @returns {Promise<{ message: string, source: 'router'|'fallback', scene: Object }>}
 */
export function generateProactiveSpeech({
  affinity = 0,
  username = 'você',
  date = new Date(),
  router = null,
  fallbackOnly = false,
} = {}) {
  const scene = getDailyScene({ date, username });

  if (fallbackOnly || !router || typeof router.generateReplyWithActions !== 'function') {
    return Promise.resolve({
      message: scene.fallbackProactive,
      source: 'fallback',
      scene,
    });
  }

  const prompt = buildProactivePrompt({
    username,
    currentScene: scene.currentScene,
    dailyContext: scene.dailyContext,
  });

  return router.generateReplyWithActions({
    messages: [
      { role: 'user', content: prompt }
    ],
    temperature: 0.7,
    maxTokens: 120,
  })
  .then(res => {
    const rawReply = res?.reply || '';
    const cleanSpeech = parseOpenAmikaTag(rawReply);
    if (!cleanSpeech) {
      return {
        message: scene.fallbackProactive,
        source: 'fallback',
        scene,
      };
    }
    return {
      message: cleanSpeech,
      source: 'router',
      scene,
    };
  })
  .catch(() => {
    return {
      message: scene.fallbackProactive,
      source: 'fallback',
      scene,
    };
  });
}

/**
 * Cria uma instância do motor de proatividade com estado em memória.
 */
export function createProactiveEngine({
  affinityProvider = () => 0,
  usernameProvider = () => 'você',
  idleThresholdMs = IDLE_TRIGGER_DEFAULT_MS,
  silenceRemarks: initialSilenceRemarks = 'normal',
  enforceQuietHours = true,
  quietStartHour = DND_START_HOUR,
  quietEndHour = DND_END_HOUR,
  router = null,
  onProactiveSay = null,
  now = () => Date.now(),
  suggestionsStore = null,
  suggestionSources = [],
  minSuggestionRelevance = DEFAULT_MIN_RELEVANCE,
  maxUnansweredSuggestions = DEFAULT_MAX_UNANSWERED_SUGGESTIONS,
  suggestionCooldowns = DEFAULT_RELEVANCE_COOLDOWNS_MS,
  suggestionDismissSnoozeMs = DEFAULT_DISMISS_SNOOZE_MS,
  onSuggestion = null,
} = {}) {
  let lastUserActivityMs = now();
  let unansweredCount = 0;
  let isBusy = false;
  let silenceRemarks = normalizeSilenceRemarks(initialSilenceRemarks);
  let activeSuggestionSources = Array.isArray(suggestionSources) ? [...suggestionSources] : [];
  // Turnos cuja voz ainda está tocando (turnId -> startedAtMs). O relógio de
  // silêncio só começa a contar quando a voz termina (`markSpeechEnded`).
  const voicePending = new Map();
  let intervalTimer = null;

  function pruneExpiredVoice(currentNow = now()) {
    for (const [id, startedAt] of voicePending.entries()) {
      if (currentNow - startedAt > VOICE_PENDING_MAX_MS) {
        voicePending.delete(id);
      }
    }
  }

  function markUserActivity() {
    const currentNow = now();
    lastUserActivityMs = currentNow;
    unansweredCount = 0;
    // Se o usuário falou por cima ou depois dela, encerra o marcador de voz pendente
    voicePending.clear();
  }

  function markSpeechStarted(turnId = 'default') {
    const currentNow = now();
    pruneExpiredVoice(currentNow);
    voicePending.set(String(turnId || 'default'), currentNow);
  }

  function markSpeechEnded(turnId = null) {
    const currentNow = now();
    pruneExpiredVoice(currentNow);
    if (turnId === null || turnId === undefined) {
      voicePending.clear();
    } else {
      const key = String(turnId);
      // Remove este turno e quaisquer turnos anteriores (preservando um posterior na fila)
      for (const existingKey of [...voicePending.keys()]) {
        voicePending.delete(existingKey);
        if (existingKey === key) break;
      }
    }
    // O relógio de silêncio começa quando a VOZ para de tocar (sem zerar unansweredCount)
    lastUserActivityMs = currentNow;
  }

  function markSpeechDropped(turnId = 'default') {
    voicePending.delete(String(turnId || 'default'));
  }

  function setBusy(busy) {
    isBusy = Boolean(busy);
  }

  function setSilenceRemarks(mode) {
    if (!SILENCE_REMARK_MODES.includes(String(mode ?? '').trim().toLowerCase())) {
      return false;
    }
    silenceRemarks = normalizeSilenceRemarks(mode);
    return true;
  }

  function getSilenceRemarks() {
    return silenceRemarks;
  }

  function getState() {
    const currentNow = now();
    pruneExpiredVoice(currentNow);
    const effectiveIntervalMs = silenceRemarks === 'off'
      ? null
      : silenceRemarks === 'rare'
        ? idleThresholdMs * 3
        : idleThresholdMs;
    return {
      lastUserActivityMs,
      unansweredCount,
      isBusy,
      voicePlaying: voicePending.size > 0,
      silenceRemarks,
      intervalMs: effectiveIntervalMs,
      idleMs: currentNow - lastUserActivityMs,
      ...(suggestionsStore
        ? {
            unansweredSuggestions: suggestionsStore.countUnanswered(),
            pendingSuggestionId: suggestionsStore.getPending()?.id || null,
          }
        : {}),
    };
  }

  function setSuggestionSources(sources = []) {
    activeSuggestionSources = Array.isArray(sources) ? [...sources] : [];
  }

  /**
   * Avalia fontes contextuais e persiste no máximo uma sugestão por vez em
   * `suggestionsStore`. Separado de `checkAndTrigger()` e sem emitir
   * `proactive_say` nem executar ferramentas automaticamente.
   */
  function checkSuggestions(overrides = {}) {
    const store = overrides.store ?? suggestionsStore;
    if (!store) {
      return { suggested: false, reason: 'store_unavailable' };
    }
    const evalNow = typeof overrides.now === 'function'
      ? overrides.now()
      : Number.isFinite(overrides.now)
        ? overrides.now
        : now();
    return evaluateContextualSuggestions({
      now: evalNow,
      store,
      sources: overrides.sources ?? activeSuggestionSources,
      enforceQuietHours: overrides.enforceQuietHours ?? enforceQuietHours,
      quietStartHour: overrides.quietStartHour ?? quietStartHour,
      quietEndHour: overrides.quietEndHour ?? quietEndHour,
      isQuiet: isQuietHours,
      minRelevance: overrides.minRelevance ?? minSuggestionRelevance,
      maxUnanswered: overrides.maxUnanswered ?? maxUnansweredSuggestions,
      cooldowns: overrides.cooldowns ?? suggestionCooldowns,
      dismissSnoozeMs: overrides.dismissSnoozeMs ?? suggestionDismissSnoozeMs,
      onSuggestion: overrides.onSuggestion ?? onSuggestion,
    });
  }

  async function checkAndTrigger() {
    const currentNow = now();
    pruneExpiredVoice(currentNow);
    const affinity = typeof affinityProvider === 'function' ? affinityProvider() : Number(affinityProvider) || 0;
    const username = typeof usernameProvider === 'function' ? usernameProvider() : String(usernameProvider || 'você');

    const check = shouldTriggerProactive({
      lastUserActivityMs,
      now: currentNow,
      unansweredCount,
      affinity,
      isBusy,
      voicePlaying: voicePending.size > 0,
      silenceRemarks,
      idleThresholdMs,
      enforceQuietHours,
      quietStartHour,
      quietEndHour,
    });

    if (!check.allowed) {
      return { triggered: false, reason: check.reason };
    }

    isBusy = true;
    try {
      const result = await generateProactiveSpeech({
        affinity,
        username,
        router,
        fallbackOnly: !router,
      });

      unansweredCount += 1;

      if (typeof onProactiveSay === 'function') {
        onProactiveSay({
          type: 'proactive_say',
          message: result.message,
          source: result.source,
          scene: result.scene?.slotKey,
        });
      }

      return {
        triggered: true,
        message: result.message,
        source: result.source,
        scene: result.scene?.slotKey,
      };
    } finally {
      isBusy = false;
    }
  }

  function start(checkIntervalMs = 15000) {
    stop();
    intervalTimer = setInterval(() => {
      checkAndTrigger().catch(() => {});
      if (suggestionsStore) {
        try {
          checkSuggestions();
        } catch {}
      }
    }, checkIntervalMs);
  }

  function stop() {
    if (intervalTimer) {
      clearInterval(intervalTimer);
      intervalTimer = null;
    }
  }

  return {
    markUserActivity,
    markSpeechStarted,
    markSpeechEnded,
    markSpeechDropped,
    setBusy,
    setSilenceRemarks,
    getSilenceRemarks,
    getState,
    setSuggestionSources,
    checkSuggestions,
    checkAndTrigger,
    start,
    stop,
  };
}
