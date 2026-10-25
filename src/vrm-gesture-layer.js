// Etapa 4: gestos procedurais no rig humanoid do VRM + camada de "body language"
// por emoção. Regra de ouro da composição: esta camada escreve APENAS nos nós
// normalizados rightUpperArm/rightLowerArm/rightHand e head — nenhum nó
// compartilhado com o sway (spine/chest/neck), o driver de expressões (rosto)
// ou o blink, então as camadas compõem naturalmente.
// Toda escrita é `base + offset` (base capturada na construção), nunca rotação
// absoluta pura; em repouso os offsets são zero e a escrita é idempotente.
//
// A biblioteca de gestos (etapa 5) assume os braços, ombros, quadril e os eixos
// x de spine/neck; aqui ficam o aceno legado de um braço, o tilt e a pose
// emocional da cabeça. Os offsets de head pedidos por um gesto são somados aos
// da pose, e a biblioteca roda depois do sway, escrevendo só nos eixos que o
// sway não usa — assim as camadas compõem em vez de se sobrescreverem.

import { createGestureLibrary } from './vrm-gesture-library.js';

// amplitudes preliminares, ajustar visualmente
export const EMOTION_POSES = {
  neutral:   { x: 0,     z: 0 },
  happy:     { x: -0.04, z: 0.05 },
  shy:       { x: 0.10,  z: 0.12 },
  sad:       { x: 0.16,  z: 0 },
  soft:      { x: 0.07,  z: 0.03 },
  angry:     { x: -0.06, z: 0 },
  surprised: { x: -0.12, z: 0 },
  doubtful:  { x: 0,     z: -0.10 },
};

const ARM_BONES = ['rightUpperArm', 'rightLowerArm', 'rightHand'];
const LAYER_BONES = [...ARM_BONES, 'head'];

const WAVE = { durationMs: 3000, attackMs: 600, releaseMs: 600, upperArmZ: 1.25, lowerArmZ: 0.35, handSpeed: 7, handAmp: 0.25 };
const TILT = { durationMs: 1200, attackMs: 300, releaseMs: 400, amp: 0.14 };
const POSE = { attackTauMs: 150, releaseTauMs: 250, snap: 1e-4, defaultDurationMs: 4500 };

const clamp01 = value => (value < 0 ? 0 : value > 1 ? 1 : value);

const cloneRotation = rotation => {
  if (rotation && typeof rotation.clone === 'function') return rotation.clone();
  return { x: rotation?.x ?? 0, y: rotation?.y ?? 0, z: rotation?.z ?? 0 };
};

// Envelope trapezoidal (espírito do custom-motion): ataque linear, platô, release linear.
const trapezoid = (elapsedMs, attackMs, releaseMs, durationMs) => {
  if (elapsedMs <= 0 || elapsedMs >= durationMs) return 0;
  if (elapsedMs < attackMs) return elapsedMs / attackMs;
  const releaseStart = durationMs - releaseMs;
  if (elapsedMs > releaseStart) return (durationMs - elapsedMs) / releaseMs;
  return 1;
};

export function createVrmGestureLayer({ humanoid, now = () => performance.now() }) {
  const readNode = name => {
    if (!humanoid || typeof humanoid.getNormalizedBoneNode !== 'function') return null;
    try {
      return humanoid.getNormalizedBoneNode(name) ?? null;
    } catch {
      return null;
    }
  };

  // Base capturada na construção: todo offset é aplicado sobre ela.
  const nodes = {};
  const base = {};
  for (const name of LAYER_BONES) {
    const node = readNode(name);
    if (node?.rotation) {
      nodes[name] = node;
      base[name] = cloneRotation(node.rotation);
    }
  }

  // Capacidades congeladas: o rig não muda depois do load.
  const library = createGestureLibrary({ humanoid, now });
  const available = Object.freeze({
    wave: ARM_BONES.every(name => nodes[name]),
    tilt: Boolean(nodes.head),
    idle: Boolean(humanoid),
    emotions: Boolean(nodes.head),
    ...Object.fromEntries(Object.entries(library.available).map(([name, ok]) => [name, ok && Boolean(humanoid)])),
  });

  // dt do update: diferença entre chamadas; o primeiro update após um set conta
  // desde o momento do set (mesma correção aplicada ao expression-driver).
  let lastUpdateMs = null;
  const waveState = { playing: false, startedAt: 0 };
  const tiltState = { playing: false, startedAt: 0 };
  const poseState = { label: 'neutral', intensity: 0, current: { x: 0, z: 0 }, target: { x: 0, z: 0 }, expiresAt: Number.POSITIVE_INFINITY };

  const markClock = () => {
    if (lastUpdateMs === null) lastUpdateMs = now();
  };

  function wave() {
    if (!available.wave || waveState.playing || library.active().name) return false;
    waveState.playing = true;
    waveState.startedAt = now();
    markClock();
    return true;
  }

  function tilt() {
    if (!available.tilt || tiltState.playing) return false;
    tiltState.playing = true;
    tiltState.startedAt = now();
    markClock();
    return true;
  }

  // Dispatcher usado pelo controller.gesture(): 'idle' é no-op de propósito —
  // o sway já dá vida contínua ao avatar. Os demais nomes vão para a biblioteca.
  function gesture(name) {
    if (name === 'wave') return wave();
    if (name === 'tilt') return tilt();
    if (name === 'idle') return available.idle;
    if (library.play(name)) {
      // Um gesto de braço novo encerra o aceno legado: os dois escrevem nos
      // mesmos ossos e não há blend entre as camadas.
      waveState.playing = false;
      waveState.startedAt = 0;
      return true;
    }
    return false;
  }

  // Encerra o gesto em curso (inclusive os de pose mantida) sem tocar na pose
  // emocional nem no tilt.
  function stopGesture() {
    waveState.playing = false;
    waveState.startedAt = 0;
    return library.stop();
  }

  function setEmotion(label, intensity = 1, durationMs = POSE.defaultDurationMs) {
    if (!available.emotions) return false;
    const known = Object.prototype.hasOwnProperty.call(EMOTION_POSES, label);
    const pose = EMOTION_POSES[known ? label : 'neutral'];
    const weight = clamp01(intensity);
    // Re-set: alvo novo + TTL estendido; o current é preservado (a rampa parte dele).
    poseState.label = known ? label : 'neutral';
    poseState.intensity = weight;
    poseState.target = { x: pose.x * weight, z: pose.z * weight };
    poseState.expiresAt = now() + durationMs;
    markClock();
    return true;
  }

  function update() {
    const t = now();
    let dt = 0;
    if (lastUpdateMs === null) lastUpdateMs = t;
    else {
      dt = Math.max(0, t - lastUpdateMs);
      lastUpdateMs = t;
    }

    // — pose emocional (head.x/z): TTL + rampa exponencial independente de frame-rate —
    if (poseState.expiresAt !== Number.POSITIVE_INFINITY && t >= poseState.expiresAt) {
      poseState.label = 'neutral';
      poseState.intensity = 0;
      poseState.target = { x: 0, z: 0 };
      poseState.expiresAt = Number.POSITIVE_INFINITY;
    }
    const relaxing = poseState.target.x === 0 && poseState.target.z === 0;
    const tau = relaxing ? POSE.releaseTauMs : POSE.attackTauMs;
    const blend = dt > 0 ? 1 - Math.exp(-dt / tau) : 0;
    poseState.current.x += (poseState.target.x - poseState.current.x) * blend;
    poseState.current.z += (poseState.target.z - poseState.current.z) * blend;
    if (Math.abs(poseState.current.x) < POSE.snap) poseState.current.x = 0;
    if (Math.abs(poseState.current.z) < POSE.snap) poseState.current.z = 0;

    // — gestos one-shot: envelopes trapezoidais no tempo absoluto desde o início —
    let waveEnv = 0;
    let waveElapsedMs = 0;
    if (waveState.playing) {
      waveElapsedMs = t - waveState.startedAt;
      if (waveElapsedMs >= WAVE.durationMs) {
        waveState.playing = false;
        waveState.startedAt = 0;
      } else {
        waveEnv = trapezoid(waveElapsedMs, WAVE.attackMs, WAVE.releaseMs, WAVE.durationMs);
      }
    }
    let tiltEnv = 0;
    if (tiltState.playing) {
      const elapsedMs = t - tiltState.startedAt;
      if (elapsedMs >= TILT.durationMs) {
        tiltState.playing = false;
        tiltState.startedAt = 0;
      } else {
        tiltEnv = trapezoid(elapsedMs, TILT.attackMs, TILT.releaseMs, TILT.durationMs);
      }
    }

    // — biblioteca: escreve braços/ombros/quadril/espinha antes da cabeça —
    library.update();
    const gestureHead = library.headOffsets();
    const legacyArm = !library.active().name;

    // — escrita: TODOS os nós que possui, sempre base + offset (idempotente) —
    if (legacyArm) {
      if (nodes.rightUpperArm) nodes.rightUpperArm.rotation.z = base.rightUpperArm.z - WAVE.upperArmZ * waveEnv;
      if (nodes.rightLowerArm) nodes.rightLowerArm.rotation.z = base.rightLowerArm.z - WAVE.lowerArmZ * waveEnv;
      if (nodes.rightHand) nodes.rightHand.rotation.z = base.rightHand.z + Math.sin((waveElapsedMs / 1000) * WAVE.handSpeed) * WAVE.handAmp * waveEnv;
    }
    if (nodes.head) {
      // head.x é só da pose + gesto; head.z soma pose + tilt + gesto.
      nodes.head.rotation.x = base.head.x + poseState.current.x + gestureHead.x;
      nodes.head.rotation.z = base.head.z + poseState.current.z + TILT.amp * tiltEnv + gestureHead.z;
      nodes.head.rotation.y = base.head.y + gestureHead.y;
    }
  }

  function clear() {
    library.clear();
    for (const name of LAYER_BONES) {
      if (!nodes[name]) continue;
      nodes[name].rotation.x = base[name].x;
      nodes[name].rotation.y = base[name].y;
      nodes[name].rotation.z = base[name].z;
    }
    waveState.playing = false;
    waveState.startedAt = 0;
    tiltState.playing = false;
    tiltState.startedAt = 0;
    poseState.label = 'neutral';
    poseState.intensity = 0;
    poseState.current = { x: 0, z: 0 };
    poseState.target = { x: 0, z: 0 };
    poseState.expiresAt = Number.POSITIVE_INFINITY;
    lastUpdateMs = null;
  }

  // Descrição do estado para testes (snapshot congelado).
  function active() {
    return Object.freeze({
      wave: waveState.playing,
      tilt: tiltState.playing,
      gesture: library.active().name,
      emotion: Object.freeze({
        label: poseState.label,
        intensity: poseState.intensity,
        current: Object.freeze({ ...poseState.current }),
        target: Object.freeze({ ...poseState.target }),
        expiresAt: poseState.expiresAt,
      }),
    });
  }

  return { available, gestureNames: library.names, wave, tilt, gesture, stopGesture, setEmotion, update, clear, active };
}
