// Ritmo da fala -> prazo das expressões faciais.
//
// A expressão do turno precisa durar enquanto a Usami fala. O áudio de cada
// balão só tem duração conhecida depois que toca (no streaming, nem durante),
// então aqui se estima pelo tamanho do texto e se corrige com a duração real
// de cada balão já tocado: o primeiro usa a mediana medida na cache de TTS
// (5847 ms de áudio para balões de ~46 caracteres, 2026-10-27) e os seguintes
// usam o ritmo aprendido nesta sessão — que já embute a velocidade real do
// provedor e o playbackRate do modo quieto.

export const SEED_MS_PER_CHAR = 127;
export const SPEECH_TAIL_MS = 900; // o rosto segura um pouco além da última sílaba
export const MIN_HOLD_MS = 4000;
export const MAX_HOLD_MS = 20000;
export const MIN_MS_PER_CHAR = 40;
export const MAX_MS_PER_CHAR = 260;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function createSpeechPace({ msPerChar = SEED_MS_PER_CHAR, smoothing = 0.5 } = {}) {
  let rate = clamp(Number(msPerChar) || SEED_MS_PER_CHAR, MIN_MS_PER_CHAR, MAX_MS_PER_CHAR);

  return {
    get msPerChar() { return rate; },
    // Quanto tempo de rosto um balão deste tamanho merece.
    holdMs(charCount) {
      const chars = Number(charCount);
      if (!Number.isFinite(chars) || chars <= 0) return MIN_HOLD_MS;
      return clamp(chars * rate + SPEECH_TAIL_MS, MIN_HOLD_MS, MAX_HOLD_MS);
    },
    // Duração real de um balão que acabou de tocar: recalibra o ritmo.
    observe(charCount, elapsedMs) {
      const chars = Number(charCount);
      const elapsed = Number(elapsedMs);
      if (!Number.isFinite(chars) || chars <= 0 || !Number.isFinite(elapsed) || elapsed <= 0) return;
      rate = clamp(rate * (1 - smoothing) + (elapsed / chars) * smoothing, MIN_MS_PER_CHAR, MAX_MS_PER_CHAR);
    },
  };
}
