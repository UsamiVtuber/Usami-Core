// Etapa 5: biblioteca de gestos procedurais sobre o rig humanoid normalizado do VRM.
//
// Cada gesto é dado puro: amplitudes por osso/eixo + envelope temporal, no mesmo
// espírito da camada de gestos (toda escrita é `base + offset`, nunca rotação
// absoluta). Por isso o repouso é idempotente e as camadas (sway, expressões,
// blink) compõem sem se pisarem.
//
// Convenção de eixos (braços em T-pose, óssea local +X ao longo do osso):
//   upperArm.z negativo = braço sobe | upperArm.x negativo = braço vai à frente
//   lowerArm.z negativo = dobra o cotovelo | shoulder.z negativo = ombro sobe
// Os valores são calibrados visualmente no painel de rig; ossos ausentes no
// modelo são ignorados, então o gesto degrada em vez de quebrar.

const ARM_BONES = [
  'leftUpperArm', 'leftLowerArm', 'leftHand', 'leftShoulder',
  'rightUpperArm', 'rightLowerArm', 'rightHand', 'rightShoulder',
];
// head é da camada de gestos (pose + tilt) e chest é do sway (respiração): ambos
// ficam fora. O que esta biblioteca escreve é só `spine.x`/`neck.x`, eixos que
// nenhum outro driver toca — por isso as camadas compõem em vez de se anularem.
const TRUNK_BONES = ['spine', 'neck'];
const GESTURE_BONES = [...ARM_BONES, 'head', 'hips', ...TRUNK_BONES];

// `hold: true` mantém a pose até stop()/novo gesto; sem hold o gesto é one-shot.
export const GESTURE_DEFS = {
  clap: {
    durationMs: 2400, attackMs: 260, releaseMs: 420,
    bones: {
      leftUpperArm: { x: -0.30, z: -0.18 }, rightUpperArm: { x: -0.30, z: -0.18 },
      leftLowerArm: { x: -0.75, z: -0.55 }, rightLowerArm: { x: -0.75, z: 0.55 },
      leftHand: { x: -0.20 }, rightHand: { x: -0.20 },
    },
    // Palmas: as duas mãos alternam no eixo que as aproxima no plano sagital.
    osc: [{ bone: 'leftHand', axis: 'z', amplitude: 0.26, hz: 3.4, phase: 0 },
      { bone: 'rightHand', axis: 'z', amplitude: 0.26, hz: 3.4, phase: Math.PI }],
  },
  'hand-on-hip': {
    durationMs: 3200, attackMs: 320, releaseMs: 520, hold: true,
    bones: {
      rightUpperArm: { x: -0.10, z: -0.32 }, rightLowerArm: { x: -0.15, z: -1.20 },
      rightHand: { x: -0.20 }, hips: { y: -0.05 }, head: { z: 0.05 },
    },
  },
  // Aceno com as duas mãos — o `wave` legado de um braço fica na camada de gestos.
  wave2: {
    durationMs: 3400, attackMs: 480, releaseMs: 620,
    bones: {
      leftUpperArm: { z: -1.15 }, rightUpperArm: { z: -1.15 },
      leftLowerArm: { z: -0.30 }, rightLowerArm: { z: -0.30 },
    },
    osc: [{ bone: 'leftHand', axis: 'z', amplitude: 0.26, hz: 2.2, phase: 0 },
      { bone: 'rightHand', axis: 'z', amplitude: 0.26, hz: 2.2, phase: 0.4 }],
  },
  point: {
    durationMs: 2600, attackMs: 300, releaseMs: 480,
    bones: { rightUpperArm: { x: -0.45, z: -0.55 }, rightHand: { x: -0.15 }, head: { y: -0.08 } },
  },
  shrug: {
    durationMs: 2000, attackMs: 220, releaseMs: 380,
    bones: {
      leftShoulder: { z: -0.18 }, rightShoulder: { z: -0.18 },
      leftUpperArm: { z: -0.22 }, rightUpperArm: { z: -0.22 },
      neck: { x: -0.08 }, head: { x: -0.06 },
    },
  },
  'head-scratch': {
    durationMs: 2600, attackMs: 300, releaseMs: 460,
    bones: {
      rightUpperArm: { x: -0.25, z: -1.05 }, rightLowerArm: { x: -0.20, z: -1.45 },
      rightHand: { x: -0.30 }, head: { x: 0.08, z: 0.07 },
    },
    osc: [{ bone: 'rightHand', axis: 'x', amplitude: 0.10, hz: 2.6, phase: 0 }],
  },
  'arms-crossed': {
    durationMs: 2400, attackMs: 340, releaseMs: 520, hold: true,
    bones: {
      leftUpperArm: { x: -0.35, z: -0.45 }, rightUpperArm: { x: -0.35, z: -0.45 },
      leftLowerArm: { x: -1.10, z: -0.55 }, rightLowerArm: { x: -1.10, z: 0.55 },
      head: { x: 0.06 },
    },
  },
  facepalm: {
    durationMs: 2800, attackMs: 260, releaseMs: 520,
    bones: {
      rightUpperArm: { x: -0.55, z: -0.85 }, rightLowerArm: { x: -0.30, z: -1.70 },
      rightHand: { x: -0.35 }, head: { x: 0.12 }, neck: { x: 0.06 },
    },
  },
  cheer: {
    durationMs: 2600, attackMs: 280, releaseMs: 520,
    bones: { leftUpperArm: { z: -2.00 }, rightUpperArm: { z: -2.00 }, head: { x: -0.10 } },
    osc: [{ bone: 'leftUpperArm', axis: 'z', amplitude: 0.12, hz: 1.8, phase: 0 },
      { bone: 'rightUpperArm', axis: 'z', amplitude: 0.12, hz: 1.8, phase: Math.PI }],
  },
  'blow-kiss': {
    durationMs: 3000, attackMs: 320, releaseMs: 560,
    bones: { rightUpperArm: { x: -0.60, z: -1.15 }, rightLowerArm: { x: -0.40, z: -1.55 }, rightHand: { x: -0.25 }, head: { x: -0.05 } },
    // A mão sai do rosto e vai para fora no fim do gesto.
    sweep: [{ bone: 'rightUpperArm', axis: 'x', from: -0.60, to: -1.10, start: 0.55, end: 0.9 }],
  },
  'hands-on-cheeks': {
    durationMs: 2600, attackMs: 260, releaseMs: 460, hold: true,
    bones: {
      leftUpperArm: { x: -0.55, z: -0.95 }, rightUpperArm: { x: -0.55, z: -0.95 },
      leftLowerArm: { x: -0.35, z: -1.60 }, rightLowerArm: { x: -0.35, z: -1.60 },
      head: { x: -0.05 },
    },
  },
  bow: {
    durationMs: 2200, attackMs: 420, releaseMs: 620,
    bones: { spine: { x: 0.45 }, neck: { x: 0.16 }, head: { x: 0.16 } },
  },
};

// Leitura segura: o VRM real lança para nomes de osso 1.0 que o modelo não tem
// (e para um humanoid ainda não inicializado), então capacidade e lookup usam
// exatamente o mesmo acesso.
function readBoneNode(humanoid, name) {
  if (!humanoid || typeof humanoid.getNormalizedBoneNode !== 'function') return null;
  try {
    return humanoid.getNormalizedBoneNode(name) ?? null;
  } catch {
    return null;
  }
}

// Os gestos só rodam nos ossos que o modelo tem; esta é a checagem de capacidade.
export function gestureAvailability(humanoid) {
  const has = name => Boolean(readBoneNode(humanoid, name));
  return Object.freeze(Object.fromEntries(Object.entries(GESTURE_DEFS).map(([name, def]) => {
    const used = Object.keys(def.bones).filter(bone => GESTURE_BONES.includes(bone));
    // Precisa de pelo menos um osso de braço (ou da espinha, para o bow) presente.
    const core = used.filter(bone => ARM_BONES.includes(bone));
    const trunk = used.filter(bone => TRUNK_BONES.includes(bone));
    return [name, core.length ? core.some(has) : trunk.length ? trunk.some(has) : used.some(has)];
  })));
}

const clamp01 = value => (value < 0 ? 0 : value > 1 ? 1 : value);

const cloneRotation = rotation => {
  if (rotation && typeof rotation.clone === 'function') return rotation.clone();
  return { x: rotation?.x ?? 0, y: rotation?.y ?? 0, z: rotation?.z ?? 0 };
};

// Envelope trapezoidal: ataque linear, platô, release linear.
const trapezoid = (elapsedMs, attackMs, releaseMs, durationMs) => {
  if (elapsedMs <= 0 || elapsedMs >= durationMs) return 0;
  if (elapsedMs < attackMs) return elapsedMs / attackMs;
  const releaseStart = durationMs - releaseMs;
  if (elapsedMs > releaseStart) return (durationMs - elapsedMs) / releaseMs;
  return 1;
};

// Curva suave 0..1 entre duas frações do tempo do gesto (para o sweep do beijo).
const ramp = (progress, start, end) => {
  if (progress <= start) return 0;
  if (progress >= end) return 1;
  const t = (progress - start) / (end - start);
  return t * t * (3 - 2 * t);
};

// Eixos que um gesto realmente mexe num osso. Escrever só neles é o que permite
// compor com o sway: spine.z e neck.z são da respiração, e um gesto que os
// resetasse à base congelaria o avatar enquanto durasse.
function touchedAxes(def, bone) {
  const axes = new Set(Object.keys(def.bones[bone] ?? {}));
  for (const s of def.sweep ?? []) if (s.bone === bone) axes.add(s.axis);
  for (const o of def.osc ?? []) if (o.bone === bone) axes.add(o.axis);
  return new Set([...axes].filter(axis => ['x', 'y', 'z'].includes(axis)));
}

export function createGestureLibrary({ humanoid, now = () => performance.now() }) {
  const readNode = name => readBoneNode(humanoid, name);

  const nodes = {};
  const base = {};
  for (const name of GESTURE_BONES) {
    const node = readNode(name);
    if (node?.rotation) {
      nodes[name] = node;
      base[name] = cloneRotation(node.rotation);
    }
  }

  const available = gestureAvailability(humanoid);
  const names = Object.freeze(Object.keys(GESTURE_DEFS).filter(name => available[name]));

  let current = null; // { name, def, startedAt }
  let lastUpdateMs = null;

  const markClock = () => {
    if (lastUpdateMs === null) lastUpdateMs = now();
  };

  // Devolve à base os eixos que o gesto anterior usava, exceto os que o novo
  // também usa (esses são reescritos pelo envelope na mesma moldura).
  const releaseBones = (def, nextDef) => {
    if (!def) return;
    for (const name of Object.keys(def.bones)) {
      if (name === 'head') continue;
      const node = nodes[name];
      if (!node || !base[name]) continue;
      const keep = nextDef ? touchedAxes(nextDef, name) : null;
      for (const axis of touchedAxes(def, name)) {
        if (keep?.has(axis)) continue;
        node.rotation[axis] = base[name][axis];
      }
    }
  };

  function play(name) {
    const def = GESTURE_DEFS[name];
    if (!def || !available[name]) return false;
    const previous = current?.def;
    releaseBones(previous, def);
    current = { name, def, startedAt: now() };
    markClock();
    return true;
  }

  // Para um gesto em curso (inclusive os hold) e devolve os ossos à base.
  function stop() {
    releaseBones(current?.def, null);
    current = null;
    lastUpdateMs = null;
    return true;
  }

  // Offsets de head pedidos por gestos, para a camada somar à pose emocional.
  function headOffsets() {
    const t = now();
    const gestureHead = headOffset(t);
    return { x: gestureHead.x, z: gestureHead.z, y: gestureHead.y };
  }

  function headOffset(t) {
    const out = { x: 0, y: 0, z: 0 };
    if (!current) return out;
    const { def, startedAt } = current;
    const target = def.bones.head;
    if (!target) return out;
    const env = envelopeFor(def, t - startedAt).env;
    for (const axis of ['x', 'y', 'z']) out[axis] = (target[axis] ?? 0) * env;
    return out;
  }

  function envelopeFor(def, elapsedMs) {
    const hold = Boolean(def.hold);
    if (hold) {
      // No hold, o platô é infinito: o release só vem de stop()/novo gesto.
      if (elapsedMs < def.attackMs) return { env: clamp01(elapsedMs / def.attackMs), progress: 0 };
      return { env: 1, progress: 1 };
    }
    if (elapsedMs >= def.durationMs) return { env: 0, progress: 1, finished: true };
    return { env: trapezoid(elapsedMs, def.attackMs, def.releaseMs, def.durationMs), progress: elapsedMs / def.durationMs };
  }

  function update() {
    const t = now();
    if (lastUpdateMs === null) lastUpdateMs = t;
    if (!current) return;

    const { def, startedAt } = current;
    const elapsedMs = t - startedAt;
    const { env, progress, finished } = envelopeFor(def, elapsedMs);

    if (finished) {
      releaseBones(def, null);
      current = null;
      return;
    }

    for (const [name, target] of Object.entries(def.bones)) {
      // head é da camada de gestos (pose emocional + tilt); ela soma os offsets
      // que este gesto pede, via headOffsets(). Escrever aqui brigaria com ela.
      if (name === 'head') continue;
      const node = nodes[name];
      const origin = base[name];
      if (!node || !origin) continue;
      for (const axis of touchedAxes(def, name)) {
        let offset = (target[axis] ?? 0) * env;
        for (const sweep of def.sweep ?? []) {
          if (sweep.bone === name && sweep.axis === axis) offset += (sweep.to - sweep.from) * ramp(progress, sweep.start, sweep.end) * env;
        }
        for (const osc of def.osc ?? []) {
          if (osc.bone === name && osc.axis === axis) offset += Math.sin((elapsedMs / 1000) * osc.hz * Math.PI * 2 + osc.phase) * osc.amplitude * env;
        }
        node.rotation[axis] = origin[axis] + offset;
      }
    }
  }

  function clear() {
    for (const name of Object.keys(nodes)) {
      nodes[name].rotation.x = base[name].x;
      nodes[name].rotation.y = base[name].y;
      nodes[name].rotation.z = base[name].z;
    }
    current = null;
    lastUpdateMs = null;
  }

  function active() {
    return Object.freeze({ name: current?.name ?? null, startedAt: current?.startedAt ?? 0 });
  }

  return { available, names, play, stop, update, clear, active, headOffsets };
}
