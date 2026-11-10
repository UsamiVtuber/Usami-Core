// Fase da voz na chamada: uma única verdade para o mic badge, o beacon e o
// texto do status. Pura — a UI só lê `deriveVoicePhase` e `VOICE_PHASES`.
//
// Prioridade (do mais forte ao mais fraco): falando > pensando > ouvindo
// alguém > microfone aberto > parado. Falando vence porque o reconhecimento é
// ignorado enquanto a Usami fala (`speakingRef`), então o mic nesse momento
// não está de fato escutando.

export const VOICE_PHASES = {
  idle: { id: 'idle', label: 'microfone desligado', hue: 'neutral' },
  listening: { id: 'listening', label: 'ouvindo', hue: 'listen' },
  hearing: { id: 'hearing', label: 'te ouvindo', hue: 'listen' },
  thinking: { id: 'thinking', label: 'pensando', hue: 'think' },
  speaking: { id: 'speaking', label: 'falando', hue: 'speak' },
  error: { id: 'error', label: 'sem microfone', hue: 'error' },
};

export function deriveVoicePhase({ call = false, micError = false, listening = false, hearing = false, busy = false, speaking = false } = {}) {
  if (!call) return VOICE_PHASES.idle;
  if (micError) return VOICE_PHASES.error;
  if (speaking) return VOICE_PHASES.speaking;
  if (busy) return VOICE_PHASES.thinking;
  if (hearing) return VOICE_PHASES.hearing;
  if (listening) return VOICE_PHASES.listening;
  return VOICE_PHASES.idle;
}

// Nível 0..1 do espectro em bytes (0..255) do AnalyserNode: RMS normalizado.
export function levelFromSpectrum(bytes) {
  if (!bytes || !bytes.length) return 0;
  let energy = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    const value = bytes[index] / 255;
    energy += value * value;
  }
  return Math.min(1, Math.sqrt(energy / bytes.length));
}

// Suavização ataque/release para o beacon não tremer: sobe rápido, desce devagar.
export function smoothLevel(previous, target, deltaSeconds, { attack = 18, release = 5 } = {}) {
  const from = Number.isFinite(previous) ? previous : 0;
  const to = Math.min(1, Math.max(0, Number.isFinite(target) ? target : 0));
  const dt = Math.min(0.25, Math.max(0, Number.isFinite(deltaSeconds) ? deltaSeconds : 0));
  const rate = to > from ? attack : release;
  const step = Math.min(1, rate * dt);
  return from + (to - from) * step;
}

export const DUPLICATE_COMMIT_WINDOW_MS = 5000;

// Normaliza uma fala transcrita (minúsculas, sem pontuação nem espaços) para
// comparar commits duplicados do VAD / Web Speech API (OpenAmika commit-once).
export function normalizeUtteranceKey(text) {
  return String(text ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, '');
}

// Filtra commits de voz idênticos dentro da janela (padrão 5 s), evitando que
// um stop/release logo após o commit automático envie a mesma fala duas vezes.
export function createUtteranceDeduper({
  windowMs = DUPLICATE_COMMIT_WINDOW_MS,
  now = () => Date.now(),
} = {}) {
  let lastKey = '';
  let lastAt = -Infinity;

  return {
    shouldCommit(text) {
      const key = normalizeUtteranceKey(text);
      if (!key) return false;
      const currentNow = Number(now());
      if (key === lastKey && currentNow - lastAt < windowMs) {
        return false;
      }
      lastKey = key;
      lastAt = currentNow;
      return true;
    },
    reset() {
      lastKey = '';
      lastAt = -Infinity;
    },
  };
}
