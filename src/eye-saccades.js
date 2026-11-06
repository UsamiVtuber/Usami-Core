/**
 * Motor de micro-sacadas oculares e olhar autônomo (estilo Neuro-sama / VTubers).
 *
 * Em seres vivos e avatares expressivos, os olhos NUNCA ficam travados num ponto estático:
 * 1. Micro-sacadas involuntárias (desvios rápidos de 1° a 3° a cada 1.5 a 3.5s).
 * 2. Pausas breves de fixação (hold de 300ms a 1s) antes de retornar ao foco principal.
 * 3. Olhar de reflexão cognitiva (quando pensando/busy, desvia o olhar para cima e para o lado).
 * 4. Micro-olhar ocasional para o ambiente (~10s).
 *
 * Módulo puro, sem dependência do Three.js ou DOM, 100% testável com relógio e RNG injetáveis.
 */

export function createEyeSaccades({
  now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()),
  rng = Math.random,
  minIntervalMs = 1500,
  maxIntervalMs = 3500,
  saccadeSpeed = 16,
  maxOffset = 0.22,
} = {}) {
  let nextSaccadeAt = now() + minIntervalMs + rng() * (maxIntervalMs - minIntervalMs);
  let holdUntil = 0;

  // Offset atual e alvo em metros (no plano do target z = 2.5m)
  let currentX = 0;
  let currentY = 0;
  let targetX = 0;
  let targetY = 0;

  // Lado preferido para pensar (-1 = esquerda, 1 = direita)
  let thinkSide = rng() > 0.5 ? 1 : -1;
  let lastThinking = false;

  return {
    /**
     * Atualiza o offset do olhar para o frame atual.
     * @param {number} deltaSeconds tempo decorrido desde o último frame (em segundos)
     * @param {Object} [state]
     * @param {boolean} [state.isThinking] avatar está processando / pensando
     * @param {boolean} [state.hasPointer] usuário está ativamente movendo o ponteiro
     * @returns {{ x: number, y: number, isThinkingGaze: boolean }}
     */
    update(deltaSeconds = 0.016, { isThinking = false, hasPointer = false } = {}) {
      const t = now();
      const dt = Math.min(Math.max(deltaSeconds, 0.001), 0.1);

      // Transição de estado pensando
      if (isThinking) {
        if (!lastThinking) {
          // Começou a pensar: escolhe um lado para cima
          thinkSide = rng() > 0.5 ? 1 : -1;
          lastThinking = true;
        }
        targetX = thinkSide * (0.16 + rng() * 0.08);
        targetY = 0.14 + rng() * 0.06; // olhar para cima
      } else {
        if (lastThinking) {
          // Terminou de pensar: volta suavemente ao centro
          lastThinking = false;
          targetX = 0;
          targetY = 0;
          holdUntil = t + 600;
          nextSaccadeAt = t + minIntervalMs + rng() * (maxIntervalMs - minIntervalMs);
        }

        // Se está em hold, mantém a fixação
        if (t >= holdUntil) {
          if (t >= nextSaccadeAt) {
            // Dispara nova micro-sacada
            const isGlanceAway = rng() < 0.20; // 20% de chance de desviar um pouco mais
            const distanceScale = isGlanceAway ? 1.0 : 0.45;

            // Se o usuário está com o ponteiro ativo, as sacadas orbitam suavemente perto do ponteiro
            const maxRadius = maxOffset * distanceScale * (hasPointer ? 0.6 : 1.0);
            const angle = rng() * Math.PI * 2;
            const r = (0.2 + rng() * 0.8) * maxRadius;

            targetX = Math.cos(angle) * r;
            targetY = Math.sin(angle) * (r * 0.6); // elipse mais achatada verticalmente

            const holdDuration = 350 + rng() * 700;
            holdUntil = t + holdDuration;
            nextSaccadeAt = holdUntil + minIntervalMs + rng() * (maxIntervalMs - minIntervalMs);
          } else {
            // Fora de sacada: relaxa em direção ao centro / foco do usuário
            targetX = 0;
            targetY = 0;
          }
        }
      }

      // Interpolação exponencial suave independente de framerate
      const lerpFactor = 1 - Math.exp(-dt * saccadeSpeed);
      currentX += (targetX - currentX) * lerpFactor;
      currentY += (targetY - currentY) * lerpFactor;

      return {
        x: currentX,
        y: currentY,
        isThinkingGaze: isThinking,
      };
    },

    reset() {
      currentX = 0;
      currentY = 0;
      targetX = 0;
      targetY = 0;
      holdUntil = 0;
      nextSaccadeAt = now() + minIntervalMs;
    },

    getState() {
      return { currentX, currentY, targetX, targetY, lastThinking };
    },
  };
}
