// Driver de canais de rosto FACS para o avatar VRM.
//
// Gerencia pesos por canal com rampa suave (ataque/release) e TTL,
// escrevendo via `setRaw(channel, weight)` injetado. No cliente do Shiro,
// `setRaw` escreve no `vrm.expressionManager.setValue(nome, peso)` para as
// expressões nomeadas mapeadas pelo `facs-map.js`.
//
// Canais:
//   sobrancelha: browInner (AU1/AU4), browOuter (AU2), browLower (AU4)
//   olhos: eyeOpen (AU5), eyeClosed (AU43), blink (AU45)
//   boca: mouthSmile (AU12), mouthFrown (AU15), mouthStretch (AU20),
//         mouthOpen (AU25), jawOpen (AU26), lipPress (AU24)
//   bochecha: cheekRaiser (AU6)
//   nariz: noseWrinkle (AU9)
//   queixo: chinRaiser (AU17)

export const FACS_CHANNELS = [
  'browInnerL', 'browInnerR', 'browOuterL', 'browOuterR', 'browLowerL', 'browLowerR',
  'eyeL', 'eyeR', 'blinkL', 'blinkR',
  'cheekL', 'cheekR',
  'mouthSmile', 'mouthFrown', 'mouthStretch', 'mouthOpen', 'jawOpen',
  'lipPress', 'noseWrinkle', 'chinRaiser',
];

const ATTACK_TAU_MS = 60;
const RELEASE_TAU_MS = 160;
const DEFAULT_TTL_MS = 4000;
const EPSILON = 0.01;

const clamp01 = value => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);

export function createFacsChannels({ setRaw, now = () => performance.now() } = {}) {
  if (typeof now !== 'function') now = () => performance.now();

  // channel -> { target, current, expiresAt }
  const entries = new Map();
  let lastUpdateMs = null;

  function set(channel, weight = 1, { ttlMs = DEFAULT_TTL_MS } = {}) {
    if (!setRaw) return false;
    if (!FACS_CHANNELS.includes(channel)) return false;
    const target = clamp01(weight);
    const previous = entries.get(channel);
    if (target <= 0) {
      if (previous) previous.target = 0;
      return true;
    }
    const currentMs = now();
    entries.set(channel, { target, current: previous ? previous.current : 0, expiresAt: currentMs + ttlMs });
    if (lastUpdateMs === null) lastUpdateMs = currentMs;
    return true;
  }

  function update() {
    const currentMs = now();
    const dt = lastUpdateMs === null ? 0 : Math.max(0, currentMs - lastUpdateMs);
    lastUpdateMs = currentMs;
    for (const [channel, entry] of entries) {
      if (currentMs > entry.expiresAt) entry.target = 0;
      if (dt <= 0) {
        setRaw(channel, entry.current);
        continue;
      }
      const tau = entry.target > entry.current ? ATTACK_TAU_MS : RELEASE_TAU_MS;
      entry.current += (entry.target - entry.current) * (1 - Math.exp(-dt / tau));
      if (entry.target === 0 && entry.current < EPSILON) {
        setRaw(channel, 0);
        entries.delete(channel);
      } else {
        setRaw(channel, entry.current);
      }
    }
  }

  function releaseAll() {
    for (const entry of entries.values()) entry.target = 0;
  }

  function clear() {
    for (const channel of entries.keys()) setRaw(channel, 0);
    entries.clear();
  }

  function getWeight(channel) {
    const entry = entries.get(channel);
    return entry ? entry.current : 0;
  }

  return { set, update, releaseAll, clear, getWeight };
}
