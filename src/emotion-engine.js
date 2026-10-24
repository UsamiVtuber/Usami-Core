// Camada semântica por cima do expression-driver: traduz rótulos de emoção
// (happy, shy, sad, soft, angry, surprised, doubtful, neutral) em pesos de
// expressão VRM usando o mapa de `emotion-map.js`.
//
// Nesta rodada o engine NÃO está conectado ao chat/server — apenas criado,
// testado e exportado. O wiring acontece depois da aprovação visual do mapa.

import { EMOTION_MAP } from './emotion-map.js';

const clamp01 = value => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);

export function createEmotionEngine({ driver, map = EMOTION_MAP } = {}) {
  if (!driver) throw new Error('createEmotionEngine exige um expression-driver');

  // Nomes de expressão que fecham os olhos (para suprimir o blink).
  const eyesClosedNames = [];
  for (const entry of Object.values(map)) {
    if (!entry?.eyesClosed) continue;
    for (const name of Object.keys(entry.expressions || {})) {
      if (!eyesClosedNames.includes(name)) eyesClosedNames.push(name);
    }
  }

  function apply({ label, intensity = 1, durationMs = 4500 } = {}) {
    const entry = map[label];
    if (!entry || label === 'neutral') {
      driver.releaseAll();
      return { applied: true, label: 'neutral' };
    }
    const weight = clamp01(intensity);
    const expressions = Object.entries(entry.expressions || {});
    if (!expressions.length) {
      driver.releaseAll();
      return { applied: true, label };
    }
    for (const [name, mappedWeight] of expressions) driver.set(name, mappedWeight * weight, { ttlMs: durationMs });
    return { applied: true, label };
  }

  function update() {
    driver.update();
  }

  // 1 enquanto nada suprime; ~0 quando uma expressão de olhos fechados pesa ~1.
  function blinkMultiplier() {
    let max = 0;
    for (const name of eyesClosedNames) {
      const weight = driver.getWeight(name);
      if (weight > max) max = weight;
    }
    return clamp01(1 - max);
  }

  function reset() {
    driver.clear();
  }

  return { apply, update, blinkMultiplier, reset };
}
