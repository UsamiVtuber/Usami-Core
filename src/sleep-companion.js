/**
 * Módulo de Companhia para Dormir (Modo Sono) da Usami.
 *
 * Gerencia o ciclo de vida do Companion de Sono (sessão de 30 minutos),
 * adaptação de prosódia do TTS (fala lenta, sussurrada e baixinha),
 * detecção de intenção do usuário e controle de volume/cadência no áudio.
 */

export const DEFAULT_SLEEP_DURATION_MINUTES = 30;
export const DEFAULT_SLEEP_PLAYBACK_RATE = 0.8;
export const DEFAULT_SLEEP_VOLUME = 0.4;
export const DEFAULT_SLEEP_EMOTION = 'whisper_caring';

export const SLEEP_TRIGGER_RE = /\b(?:(?:ativar?|colocar?|iniciar?|entrar\s+no|bota[r]?)\s+(?:o\s+)?(?:modo\s+)?(?:de\s+)?(?:sono|dormir|mimir|descanso|companion\s+de\s+sono)|vamos\s+dormir|vamos\s+mimir|hora\s+de\s+(?:dormir|mimir|descansar)|me\s+ajuda\s+a\s+dormir|quero\s+dormir|vou\s+dormir|modo\s+sono|modo\s+dormir)\b/i;

export const WAKE_UP_TRIGGER_RE = /\b(?:(?:desativar?|cancelar?|sair\s+do|para[r]?)\s+(?:o\s+)?(?:modo\s+)?(?:de\s+)?(?:sono|dormir|mimir)|acorda\w*|j[áa]\s+acord\w*|bom\s+dia)\b/i;

/**
 * Verifica se a mensagem expressa o desejo de iniciar o modo sono.
 * @param {string} text
 * @returns {boolean}
 */
export function isSleepCompanionTrigger(text) {
  if (typeof text !== 'string') return false;
  return SLEEP_TRIGGER_RE.test(text.trim());
}

/**
 * Verifica se a mensagem expressa o desejo de sair do modo sono.
 * @param {string} text
 * @returns {boolean}
 */
export function isWakeUpTrigger(text) {
  if (typeof text !== 'string') return false;
  return WAKE_UP_TRIGGER_RE.test(text.trim());
}

/**
 * Adapta as instruções de prosódia para modos de sono / sussurro.
 * Suprime marcadores de fala rápida, saltitante e eufórica, substituindo por
 * cadência lenta, calma, timbre íntimo e acolhedor.
 * @param {string} inner Instrução base sem colchetes
 * @param {string} styleId Identificador de emoção/estilo
 * @returns {string}
 */
export function adaptProsodyForSleep(inner, styleId) {
  let text = String(inner || '').trim();
  const lower = String(styleId || '').toLowerCase();
  const isSleepy = /(whisper|sleep|sono|mimir|ninar|dormir|tired|relax)/i.test(lower);

  if (isSleepy) {
    text = text
      .replace(/dicção rápida e nítida/gi, 'dicção lenta, calma, suave e pausada')
      .replace(/muito aguda e brilhante/gi, 'voz suave, aconchegante, baixa e aveludada')
      .replace(/saltitante/gi, 'serena e tranquila')
      .replace(/sorriso na voz/gi, 'tom sereno e acolhedor')
      .replace(/super animada e hiperexpressiva/gi, 'muito calma e reconfortante')
      .replace(/timbre leve e expressivo/gi, 'timbre doce, íntimo e baixinho')
      .replace(/travessa/gi, '')
      .replace(/,\s*,/g, ',')
      .replace(/[,\s]+$/, '')
      .trim();
  }

  return text;
}

/**
 * Fábrica do serviço de companion de sono para o runtime da Usami.
 */
export function createSleepCompanionService({
  defaultDurationMinutes = DEFAULT_SLEEP_DURATION_MINUTES,
  now = () => Date.now(),
} = {}) {
  let active = false;
  let startedAt = null;
  let durationMinutes = defaultDurationMinutes;

  function isActive() {
    if (!active) return false;
    const elapsed = now() - startedAt;
    if (elapsed >= durationMinutes * 60 * 1000) {
      active = false;
      startedAt = null;
      return false;
    }
    return true;
  }

  function start({ minutes = defaultDurationMinutes } = {}) {
    active = true;
    startedAt = now();
    durationMinutes = Number(minutes) > 0 ? Number(minutes) : defaultDurationMinutes;
    return getStatus();
  }

  function stop() {
    active = false;
    startedAt = null;
    return getStatus();
  }

  function getStatus() {
    const activeNow = isActive();
    const elapsed = startedAt ? Math.max(0, now() - startedAt) : 0;
    const totalMs = durationMinutes * 60 * 1000;
    const remainingMs = activeNow ? Math.max(0, totalMs - elapsed) : 0;
    const minutesLeft = activeNow ? Math.ceil(remainingMs / 60000) : 0;

    return {
      active: activeNow,
      startedAt: activeNow ? new Date(startedAt).toISOString() : null,
      durationMinutes,
      minutesLeft,
      remainingMs,
      playbackRate: activeNow ? DEFAULT_SLEEP_PLAYBACK_RATE : 1.0,
      volume: activeNow ? DEFAULT_SLEEP_VOLUME : 1.0,
      defaultEmotion: DEFAULT_SLEEP_EMOTION,
    };
  }

  return {
    isActive,
    start,
    stop,
    getStatus,
  };
}
