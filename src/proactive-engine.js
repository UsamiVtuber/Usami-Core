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

export const IDLE_TRIGGER_DEFAULT_MS = 180 * 1000; // 3 minutos
export const DND_START_HOUR = 23.5; // 23:30
export const DND_END_HOUR = 8.5;    // 08:30
export const MIN_AFFINITY_FOR_PROACTIVE = 20;

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
  idleThresholdMs = IDLE_TRIGGER_DEFAULT_MS,
  enforceQuietHours = true,
  quietStartHour = DND_START_HOUR,
  quietEndHour = DND_END_HOUR,
}) {
  if (isBusy) {
    return { allowed: false, reason: 'busy' };
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

  const idleMs = now - (lastUserActivityMs || 0);
  if (idleMs < idleThresholdMs) {
    return { allowed: false, reason: 'not_idle', idleMs };
  }

  return { allowed: true, idleMs };
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
  enforceQuietHours = true,
  router = null,
  onProactiveSay = null,
} = {}) {
  let lastUserActivityMs = Date.now();
  let unansweredCount = 0;
  let isBusy = false;
  let intervalTimer = null;

  function markUserActivity() {
    lastUserActivityMs = Date.now();
    unansweredCount = 0;
  }

  function setBusy(busy) {
    isBusy = Boolean(busy);
  }

  function getState() {
    return {
      lastUserActivityMs,
      unansweredCount,
      isBusy,
      idleMs: Date.now() - lastUserActivityMs,
    };
  }

  async function checkAndTrigger() {
    const affinity = typeof affinityProvider === 'function' ? affinityProvider() : Number(affinityProvider) || 0;
    const username = typeof usernameProvider === 'function' ? usernameProvider() : String(usernameProvider || 'você');

    const check = shouldTriggerProactive({
      lastUserActivityMs,
      now: Date.now(),
      unansweredCount,
      affinity,
      isBusy,
      idleThresholdMs,
      enforceQuietHours,
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
    setBusy,
    getState,
    checkAndTrigger,
    start,
    stop,
  };
}
