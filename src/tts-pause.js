// Tabela de pausas emocionais entre balões de fala (portado de OpenAmika `speech/tts_pause.py`).
//
// Cada uma das 69 emoções canônicas `<registro>_<emoção>` (mais chaves legadas)
// define a pausa respiratória ideal em milissegundos após um balão:
// - Emoções rápidas/eufóricas (`laughing`, `very_happy`, `playful`, `surprise`): 100–150 ms
// - Conversa casual neutra (`casual_neutral`, `neutral`): 200 ms
// - Emoções contemplativas, tímidas, tristes ou sussurradas (`shy`, `sad`, `sleepy`, `whisper_*`): 300–450 ms

import { VALID_EMOTIONS, normalizeEmotionTag, resolveEmotion } from './emotion-resolver.js';

export const DEFAULT_PAUSE_MS = 200;

export const PAUSE_TABLE_MS = Object.freeze({
  // ── polite (11) ──────────────────────────────────────────────────
  polite_neutral: 220,
  polite_smile: 200,
  polite_happy: 180,
  polite_caring: 250,
  polite_sad: 350,
  polite_worried: 280,
  polite_cold: 300,
  polite_angry: 180,
  polite_embarrassed: 280,
  polite_surprise: 150,
  polite_fear: 250,

  // ── casual (19) ──────────────────────────────────────────────────
  casual_neutral: 200,
  casual_smile: 180,
  casual_happy: 150,
  casual_very_happy: 120,
  casual_playful: 150,
  casual_laughing: 100,
  casual_relieved: 280,
  casual_shy: 320,
  casual_embarrassed: 280,
  casual_mumbling: 350,
  casual_jealous: 250,
  casual_caring: 250,
  casual_surprise: 120,
  casual_angry: 150,
  casual_frustrated: 200,
  casual_sad: 380,
  casual_tired: 400,
  casual_fear: 220,
  casual_worried: 280,

  // ── serious (11) ─────────────────────────────────────────────────
  serious_neutral: 250,
  serious_cold: 320,
  serious_disappointed: 350,
  serious_surprise: 180,
  serious_angry: 150,
  serious_very_angry: 120,
  serious_protective: 220,
  serious_worried: 280,
  serious_anxious: 220,
  serious_sad: 380,
  serious_fear: 250,

  // ── intimate (18) ────────────────────────────────────────────────
  intimate_neutral: 280,
  intimate_happy: 220,
  intimate_very_happy: 180,
  intimate_smile: 250,
  intimate_playful: 200,
  intimate_shy: 350,
  intimate_very_shy: 400,
  intimate_caring: 300,
  intimate_very_caring: 320,
  intimate_jealous: 280,
  intimate_mumbling: 380,
  intimate_relieved: 320,
  intimate_tearful: 420,
  intimate_sad: 400,
  intimate_very_sad: 450,
  intimate_sleepy: 450,
  intimate_tired: 420,
  intimate_worried: 300,

  // ── whisper (10) ─────────────────────────────────────────────────
  whisper_neutral: 350,
  whisper_happy: 300,
  whisper_smile: 320,
  whisper_caring: 350,
  whisper_relieved: 380,
  whisper_shy: 400,
  whisper_sad: 450,
  whisper_worried: 380,
  whisper_tearful: 450,
  whisper_sleepy: 450,

  // ── chaves legadas / coarse (13) ─────────────────────────────────
  neutral: 200,
  happy: 150,
  hype: 120,
  surprised: 120,
  angry: 150,
  pout: 220,
  tsundere: 200,
  doubtful: 240,
  clingy: 250,
  soft: 280,
  relaxed: 300,
  shy: 320,
  sad: 380,
  whisper: 400,
});

/**
 * Retorna a pausa pós-balão em milissegundos para uma emoção V2 ou chave legada.
 */
export function getEmotionPauseMs(emotionKey, { quiet = false } = {}) {
  const norm = normalizeEmotionTag(emotionKey);
  let baseMs = DEFAULT_PAUSE_MS;

  if (norm && Object.hasOwn(PAUSE_TABLE_MS, norm)) {
    baseMs = PAUSE_TABLE_MS[norm];
  } else if (norm) {
    const resolved = resolveEmotion(norm);
    if (VALID_EMOTIONS.has(resolved) && Object.hasOwn(PAUSE_TABLE_MS, resolved)) {
      baseMs = PAUSE_TABLE_MS[resolved];
    }
  }

  if (quiet) {
    return Math.min(600, Math.round(baseMs * 1.25));
  }
  return baseMs;
}

/**
 * Compatível com `pause_after(emotion)` do OpenAmika (em segundos).
 */
export function pauseAfterSeconds(emotionKey, options) {
  return getEmotionPauseMs(emotionKey, options) / 1000;
}

