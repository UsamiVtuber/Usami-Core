// Aplica Action Units FACS detectadas na frase do usuário ao
// expression-driver do Shiro, traduzindo cada AU na expressão nomeada
// correspondente (veja facs-map.js). Puro: não depende de DOM nem do VRM.
//
// Retorna { applied, weights } com o número de expressões aplicadas e os
// pesos finais por nome de expressão.

import { FACS_TO_SHIRO } from './facs-map.js';

const clamp01 = value => Math.min(1, Math.max(0, value));

export function applyFacsToDriver(aus, intensity, expressionDriver, { ttlMs = 4000 } = {}) {
  if (!expressionDriver || typeof expressionDriver.set !== 'function' || !aus?.length) {
    return { applied: 0, weights: {} };
  }

  const weights = {};
  for (const { au, intensity: auIntensity } of aus) {
    const mappings = FACS_TO_SHIRO[au] || [];
    for (const { name, weight } of mappings) {
      const finalWeight = clamp01(weight * auIntensity * intensity);
      weights[name] = Math.max(weights[name] || 0, finalWeight);
    }
  }

  let applied = 0;
  for (const [name, weight] of Object.entries(weights)) {
    expressionDriver.set(name, weight, { ttlMs });
    applied += 1;
  }
  return { applied, weights };
}
