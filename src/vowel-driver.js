// Port adaptado de airi/packages/model-driver-lipsync/src/shared/wlipsync/vowel-driver.ts
// Deriva vogais do espectro do AnalyserNode (sem dependência wlipsync/MFCC).
export const VOWELS = ['A', 'E', 'I', 'O', 'U'];
export const RAW_VISEMES = ['A', 'E', 'I', 'O', 'U', 'S'];
const RAW_TO_VOWEL = { A: 'A', E: 'E', I: 'I', O: 'O', S: 'I', U: 'U' };

export const AMPLITUDE_FLOOR = 0.04;
export const WEIGHT_FLOOR = 0.05;
export const SILENCE_MS = 160;
export const ATTACK_RATE = 50;
export const RELEASE_RATE = 30;
export const WINNER_CAP = 0.7;
export const RUNNER_CAP = 0.35;
export const OUTPUT_SCALE = 0.7;
export const EPSILON = 0.01;

export function createVowelDriver(now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now())) {
  const smooth = { A: 0, E: 0, I: 0, O: 0, U: 0 };
  let lastActiveAt = 0;

  function reset() {
    for (const v of VOWELS) smooth[v] = 0;
    lastActiveAt = 0;
  }

  function update(frame, deltaSeconds = 0.016) {
    const amplitude = Math.min((frame?.volume ?? 0) * 0.9, 1) ** 0.7;
    const projected = { A: 0, E: 0, I: 0, O: 0, U: 0 };
    for (const raw of RAW_VISEMES) {
      const vowel = RAW_TO_VOWEL[raw];
      const w = frame?.weights?.[raw] ?? 0;
      projected[vowel] = Math.max(projected[vowel], w * amplitude);
    }
    let winner = 'I', runner = 'E', winnerWeight = -Infinity, runnerWeight = -Infinity;
    for (const v of VOWELS) {
      const w = projected[v];
      if (w > winnerWeight) { runnerWeight = winnerWeight; runner = winner; winnerWeight = w; winner = v; }
      else if (w > runnerWeight) { runnerWeight = w; runner = v; }
    }
    const t = now();
    let silent = amplitude < AMPLITUDE_FLOOR || winnerWeight < WEIGHT_FLOOR;
    if (!silent) lastActiveAt = t;
    if (t - lastActiveAt > SILENCE_MS) silent = true;
    const target = { A: 0, E: 0, I: 0, O: 0, U: 0 };
    if (!silent) {
      target[winner] = Math.min(WINNER_CAP, winnerWeight);
      target[runner] = Math.min(RUNNER_CAP, runnerWeight * 0.6);
    }
    const out = { A: 0, E: 0, I: 0, O: 0, U: 0 };
    for (const v of VOWELS) {
      const from = smooth[v], to = target[v];
      const rate = 1 - Math.exp(-(to > from ? ATTACK_RATE : RELEASE_RATE) * deltaSeconds);
      smooth[v] = from + (to - from) * rate;
      out[v] = (smooth[v] <= EPSILON ? 0 : smooth[v]) * OUTPUT_SCALE;
    }
    return out;
  }
  return { reset, update };
}

// Formantes médios pt-BR (Hz): [F1_low, F1_high], [F2_low, F2_high]
export const VOWEL_FORMANTS = {
  A: [[650, 1050], [1000, 1550]],
  E: [[300, 600], [1700, 2500]],
  I: [[200, 420], [2000, 3000]],
  O: [[300, 600], [700, 1050]],
  U: [[220, 480], [500, 800]],
};

export function spectrumToVowelFrame(data, { sampleRate = 24000, fftSize = null } = {}) {
  const bins = data?.length || 0;
  // Se fftSize não foi passado, assume que bins = fftSize/2 (padrão AnalyserNode)
  const size = fftSize || (bins > 0 ? bins * 2 : 256);
  const binWidth = sampleRate / size;
  const bandMean = (lo, hi) => {
    if (!bins) return 0;
    const start = Math.max(0, Math.floor(lo / binWidth));
    const end = Math.min(bins - 1, Math.ceil(hi / binWidth));
    if (end < start) return 0;
    let sum = 0, count = 0;
    for (let i = start; i <= end; i += 1) { sum += data[i]; count += 1; }
    return count ? sum / count : 0;
  };
  let energy = 0;
  for (let i = 0; i < bins; i += 1) { const v = data[i] / 255; energy += v * v; }
  const volume = bins ? Math.min(1, Math.sqrt(energy / bins)) : 0;
  const scores = {}; let maxScore = 0;
  for (const vowel of VOWELS) {
    const [f1, f2] = VOWEL_FORMANTS[vowel];
    const score = (bandMean(f1[0], f1[1]) + bandMean(f2[0], f2[1])) / (2 * 255);
    scores[vowel] = score;
    if (score > maxScore) maxScore = score;
  }
  const weights = {};
  for (const vowel of VOWELS) weights[vowel] = maxScore > 0 ? Math.min(1, scores[vowel] / maxScore) : 0;
  return { volume, weights };
}