// Mapeamento das 69 chaves do contrato de emoções para o avatar VRM Shiro (白ー).
//
// Usa os nomes reais de morph targets expostos pelo expressionManager do VRM:
//   - 01..06: família happy (04 fecha os olhos, 06 piscada)
//   - 07..11: família angry (10 fecha os olhos, 11 contida/fria)
//   - 12..14: família sad (13 choro/lágrimas)
//   - 15..18: família awkward (16 fecha os olhos constrangida)
//   - 19: doubt
//   - 20: startled
//   - 21: emoji (surpresa)
//
// Módulo puro: funciona no Node.js e no browser.

import { resolveEmotion, DEFAULT_EMOTION } from './emotion-resolver.js';

export const VRM_EMOTIONS = Object.freeze({
  // ─── 1. POLITE ───
  polite_neutral:       { expressions: {}, eyesClosed: false, coarse: 'neutral' },
  polite_smile:         { expressions: { '01-prefab_happy01': 0.6 }, eyesClosed: false, coarse: 'happy' },
  polite_happy:         { expressions: { '01-prefab_happy01': 0.8 }, eyesClosed: false, coarse: 'happy' },
  polite_caring:        { expressions: { '01-prefab_happy01': 0.5 }, eyesClosed: false, coarse: 'soft' },
  polite_sad:           { expressions: { '12-prefab_sad01': 0.6 }, eyesClosed: false, coarse: 'sad' },
  polite_worried:       { expressions: { '12-prefab_sad01': 0.5, '19-prefab_doubt': 0.3 }, eyesClosed: false, coarse: 'doubtful' },
  polite_cold:          { expressions: { '11-prefab_angry05': 0.5 }, eyesClosed: false, coarse: 'angry' },
  polite_angry:         { expressions: { '11-prefab_angry05': 0.7 }, eyesClosed: false, coarse: 'angry' },
  polite_embarrassed:   { expressions: { '15-prefab_awkward01': 0.6 }, eyesClosed: false, coarse: 'shy' },
  polite_surprise:      { expressions: { '21-prefab_emoji': 0.7 }, eyesClosed: false, coarse: 'surprised' },
  polite_fear:          { expressions: { '20-prefab_startled': 0.7, '12-prefab_sad01': 0.4 }, eyesClosed: false, coarse: 'surprised' },

  // ─── 2. CASUAL ───
  casual_neutral:       { expressions: {}, eyesClosed: false, coarse: 'neutral' },
  casual_smile:         { expressions: { '01-prefab_happy01': 0.8 }, eyesClosed: false, coarse: 'happy' },
  casual_happy:         { expressions: { '02-prefab_happy02': 1.0 }, eyesClosed: false, coarse: 'happy' },
  casual_very_happy:    { expressions: { '05-prefab_happy05': 1.0 }, eyesClosed: false, coarse: 'happy' },
  casual_playful:       { expressions: { '06-prefab_happy06': 1.0 }, eyesClosed: false, coarse: 'happy' },
  casual_laughing:      { expressions: { '04-prefab_happy04': 1.0 }, eyesClosed: true, coarse: 'happy' },
  casual_relieved:      { expressions: { '01-prefab_happy01': 0.7 }, eyesClosed: false, coarse: 'soft' },
  casual_shy:           { expressions: { '15-prefab_awkward01': 0.8 }, eyesClosed: false, coarse: 'shy' },
  casual_embarrassed:   { expressions: { '16-prefab_awkward02': 1.0 }, eyesClosed: true, coarse: 'shy' },
  casual_mumbling:      { expressions: { '18-prefab_awkward04': 0.7 }, eyesClosed: false, coarse: 'doubtful' },
  casual_jealous:       { expressions: { '08-prefab_angry02': 0.6, '19-prefab_doubt': 0.4 }, eyesClosed: false, coarse: 'angry' },
  casual_caring:        { expressions: { '03-prefab_happy03': 0.8 }, eyesClosed: false, coarse: 'soft' },
  casual_surprise:      { expressions: { '21-prefab_emoji': 1.0 }, eyesClosed: false, coarse: 'surprised' },
  casual_angry:         { expressions: { '08-prefab_angry02': 0.9 }, eyesClosed: false, coarse: 'angry' },
  casual_frustrated:    { expressions: { '07-prefab_angry01': 0.8 }, eyesClosed: false, coarse: 'angry' },
  casual_sad:           { expressions: { '12-prefab_sad01': 0.9 }, eyesClosed: false, coarse: 'sad' },
  casual_tired:         { expressions: { '14-prefab_sad03': 0.7 }, eyesClosed: false, coarse: 'sad' },
  casual_fear:          { expressions: { '20-prefab_startled': 0.9 }, eyesClosed: false, coarse: 'surprised' },
  casual_worried:       { expressions: { '17-prefab_awkward03': 0.8 }, eyesClosed: false, coarse: 'doubtful' },

  // ─── 3. SERIOUS ───
  serious_neutral:      { expressions: { '11-prefab_angry05': 0.3 }, eyesClosed: false, coarse: 'neutral' },
  serious_cold:         { expressions: { '11-prefab_angry05': 0.8 }, eyesClosed: false, coarse: 'angry' },
  serious_disappointed: { expressions: { '14-prefab_sad03': 0.8, '11-prefab_angry05': 0.4 }, eyesClosed: false, coarse: 'sad' },
  serious_surprise:     { expressions: { '21-prefab_emoji': 0.8, '19-prefab_doubt': 0.4 }, eyesClosed: false, coarse: 'surprised' },
  serious_angry:        { expressions: { '09-prefab_angry03': 0.9 }, eyesClosed: false, coarse: 'angry' },
  serious_very_angry:   { expressions: { '10-prefab_angry04': 1.0 }, eyesClosed: true, coarse: 'angry' },
  serious_protective:   { expressions: { '11-prefab_angry05': 0.5, '01-prefab_happy01': 0.4 }, eyesClosed: false, coarse: 'soft' },
  serious_worried:      { expressions: { '19-prefab_doubt': 0.8, '12-prefab_sad01': 0.5 }, eyesClosed: false, coarse: 'doubtful' },
  serious_anxious:      { expressions: { '17-prefab_awkward03': 0.9 }, eyesClosed: false, coarse: 'doubtful' },
  serious_sad:          { expressions: { '14-prefab_sad03': 0.9 }, eyesClosed: false, coarse: 'sad' },
  serious_fear:         { expressions: { '20-prefab_startled': 1.0 }, eyesClosed: false, coarse: 'surprised' },

  // ─── 4. INTIMATE ───
  intimate_neutral:     { expressions: { '01-prefab_happy01': 0.4 }, eyesClosed: false, coarse: 'neutral' },
  intimate_happy:       { expressions: { '03-prefab_happy03': 0.9 }, eyesClosed: false, coarse: 'happy' },
  intimate_very_happy:  { expressions: { '05-prefab_happy05': 0.9, '03-prefab_happy03': 0.5 }, eyesClosed: false, coarse: 'happy' },
  intimate_smile:       { expressions: { '01-prefab_happy01': 0.7 }, eyesClosed: false, coarse: 'happy' },
  intimate_playful:     { expressions: { '06-prefab_happy06': 0.8 }, eyesClosed: false, coarse: 'happy' },
  intimate_shy:         { expressions: { '15-prefab_awkward01': 0.9 }, eyesClosed: false, coarse: 'shy' },
  intimate_very_shy:    { expressions: { '16-prefab_awkward02': 1.0 }, eyesClosed: true, coarse: 'shy' },
  intimate_caring:      { expressions: { '03-prefab_happy03': 1.0 }, eyesClosed: false, coarse: 'soft' },
  intimate_very_caring: { expressions: { '03-prefab_happy03': 1.0, '01-prefab_happy01': 0.5 }, eyesClosed: false, coarse: 'soft' },
  intimate_jealous:     { expressions: { '07-prefab_angry01': 0.7, '16-prefab_awkward02': 0.5 }, eyesClosed: false, coarse: 'angry' },
  intimate_mumbling:    { expressions: { '18-prefab_awkward04': 0.8 }, eyesClosed: false, coarse: 'doubtful' },
  intimate_relieved:    { expressions: { '04-prefab_happy04': 0.7 }, eyesClosed: true, coarse: 'soft' },
  intimate_tearful:     { expressions: { '13-prefab_sad02': 0.9 }, eyesClosed: false, coarse: 'sad' },
  intimate_sad:         { expressions: { '12-prefab_sad01': 0.8 }, eyesClosed: false, coarse: 'sad' },
  intimate_very_sad:    { expressions: { '13-prefab_sad02': 1.0 }, eyesClosed: false, coarse: 'sad' },
  intimate_sleepy:      { expressions: { '14-prefab_sad03': 0.6 }, eyesClosed: false, coarse: 'soft' },
  intimate_tired:       { expressions: { '14-prefab_sad03': 0.8 }, eyesClosed: false, coarse: 'sad' },
  intimate_worried:     { expressions: { '17-prefab_awkward03': 0.7 }, eyesClosed: false, coarse: 'doubtful' },

  // ─── 5. WHISPER ───
  whisper_neutral:      { expressions: {}, eyesClosed: false, coarse: 'neutral' },
  whisper_happy:        { expressions: { '01-prefab_happy01': 0.6 }, eyesClosed: false, coarse: 'happy' },
  whisper_smile:        { expressions: { '01-prefab_happy01': 0.5 }, eyesClosed: false, coarse: 'happy' },
  whisper_caring:       { expressions: { '03-prefab_happy03': 0.7 }, eyesClosed: false, coarse: 'soft' },
  whisper_relieved:     { expressions: { '04-prefab_happy04': 0.6 }, eyesClosed: true, coarse: 'soft' },
  whisper_shy:          { expressions: { '15-prefab_awkward01': 0.8 }, eyesClosed: false, coarse: 'shy' },
  whisper_sad:          { expressions: { '12-prefab_sad01': 0.7 }, eyesClosed: false, coarse: 'sad' },
  whisper_worried:      { expressions: { '17-prefab_awkward03': 0.6 }, eyesClosed: false, coarse: 'doubtful' },
  whisper_tearful:      { expressions: { '13-prefab_sad02': 0.7 }, eyesClosed: false, coarse: 'sad' },
  whisper_sleepy:       { expressions: { '04-prefab_happy04': 0.5 }, eyesClosed: true, coarse: 'soft' },
});

/**
 * Retorna as definições de VRM para a emoção solicitada.
 */
export function getVrmEmotionConfig(rawTag) {
  const canonical = resolveEmotion(rawTag, DEFAULT_EMOTION);
  const config = VRM_EMOTIONS[canonical] || VRM_EMOTIONS[DEFAULT_EMOTION];
  return {
    emotionKey: canonical,
    expressions: config.expressions,
    eyesClosed: config.eyesClosed,
    coarse: config.coarse,
  };
}

/**
 * Aplica uma emoção atômica no ExpressionDriver do avatar VRM.
 * Decai suavemente as expressões vigentes e sobe as novas.
 */
export function applyVrmEmotion(rawTag, expressionDriver, { ttlMs = 4500 } = {}) {
  const config = getVrmEmotionConfig(rawTag);
  if (!expressionDriver || typeof expressionDriver.set !== 'function') {
    return { applied: false, ...config };
  }

  // Decai as expressões ativas que não fazem parte da nova emoção
  if (typeof expressionDriver.releaseAll === 'function') {
    expressionDriver.releaseAll();
  }

  for (const [morphName, weight] of Object.entries(config.expressions)) {
    expressionDriver.set(morphName, weight, {
      ttlMs,
    });
  }

  return { applied: true, ...config };
}
