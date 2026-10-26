// Etapa 5: biblioteca de gestos procedurais sobre o rig humanoid normalizado do VRM.
//
// Cada gesto é dado puro: amplitudes por osso/eixo + envelope temporal, no mesmo
// espírito da camada de gestos (toda escrita é `base + offset`, nunca rotação
// absoluta). Por isso o repouso é idempotente e as camadas (sway, expressões,
// blink) compõem sem se pisarem.
//
// EIXOS SEMÂNTICOS (A opção): os braços não são descritos em Euler local — que
// muda de sentido conforme o roll da armature de cada modelo (e espelha entre L
// e R no shiro.vrm) — e sim pela intenção do movimento:
//   raise = marcador sobe | fwd = marcador vai à frente do personagem
//   flex = cotovelo dobra (mão encurta a distância ao ombro)
//   fold = palma dobra para frente | flick = mão varre para o lado
// A tabela {osso → (eixo local, sinal)} vem de vrm-bone-calibration.js: calibrada
// no load contra o modelo real, ou a convenção legada como fallback. Valores
// semânticos são positivos na direção nomeada; o sinal local é responsabilidade
// da tabela, não da definição.
//
// ossos de tronco (head/hips/spine/neck) não espelham entre L/R: ficam em Euler
// cru. head é lido pela camada de gestos (pose + tilt) e chest é do sway
// (respiração): nenhum dos dois é escrito aqui. Os gestos só mexem
// `spine.x`/`neck.x`, eixos que nenhum outro driver toca — por isso as camadas
// compõem em vez de se anularem.
// Os valores são calibrados visualmente no painel de rig; ossos ausentes no
// modelo são ignorados, então o gesto degrada em vez de quebrar.

import { legacyAxisTable, resolveAxis } from './vrm-bone-calibration.js';

const ARM_BONES = [
  'leftUpperArm', 'leftLowerArm', 'leftHand', 'leftShoulder',
  'rightUpperArm', 'rightLowerArm', 'rightHand', 'rightShoulder',
];
const TRUNK_BONES = ['spine', 'neck'];
const GESTURE_BONES = [...ARM_BONES, 'head', 'hips', ...TRUNK_BONES];

// `hold: true` mantém a pose até stop()/novo gesto; sem hold o gesto é one-shot.
export const GESTURE_DEFS = {
  clap: {
    durationMs: 2400, attackMs: 260, releaseMs: 420,
    bones: {
      leftUpperArm: { fwd: 0.95, raise: 0.40 }, rightUpperArm: { fwd: 0.95, raise: 0.40 },
      leftLowerArm: { fwd: 0.40, flex: 0.95 }, rightLowerArm: { fwd: 0.40, flex: 0.95 },
      leftHand: { fold: 0.40 }, rightHand: { fold: 0.40 },
    },
    // Palmas: as duas mãos alternam no eixo que as aproxima no plano sagital.
    osc: [{ bone: 'leftHand', axis: 'flick', amplitude: 0.26, hz: 3.4, phase: 0 },
      { bone: 'rightHand', axis: 'flick', amplitude: 0.26, hz: 3.4, phase: Math.PI }],
  },
  'hand-on-hip': {
    durationMs: 3200, attackMs: 320, releaseMs: 520, hold: true,
    bones: {
      rightUpperArm: { fwd: 0.10, raise: 0.32 }, rightLowerArm: { fwd: 0.15, flex: 1.20 },
      rightHand: { fold: 0.20 }, hips: { y: -0.05 }, head: { z: 0.05 },
    },
  },
  // Aceno com as duas mãos — o `wave` legado de um braço fica na camada de gestos.
  wave2: {
    durationMs: 3400, attackMs: 480, releaseMs: 620,
    bones: {
      leftUpperArm: { raise: 1.15 }, rightUpperArm: { raise: 1.15 },
      leftLowerArm: { flex: 0.30 }, rightLowerArm: { flex: 0.30 },
    },
    osc: [{ bone: 'leftHand', axis: 'flick', amplitude: 0.26, hz: 2.2, phase: 0 },
      { bone: 'rightHand', axis: 'flick', amplitude: 0.26, hz: 2.2, phase: 0.4 }],
  },
  point: {
    durationMs: 2600, attackMs: 300, releaseMs: 480,
    bones: { rightUpperArm: { fwd: 0.45, raise: 0.55 }, rightHand: { fold: 0.15 }, head: { y: -0.08 } },
  },
  shrug: {
    durationMs: 2000, attackMs: 220, releaseMs: 380,
    bones: {
      leftShoulder: { raise: 0.18 }, rightShoulder: { raise: 0.18 },
      leftUpperArm: { raise: 0.22 }, rightUpperArm: { raise: 0.22 },
      neck: { x: -0.08 }, head: { x: -0.06 },
    },
  },
  'head-scratch': {
    durationMs: 2600, attackMs: 300, releaseMs: 460,
    bones: {
      rightUpperArm: { fwd: 0.10, raise: 1.55 }, rightLowerArm: { fwd: 0.05, flex: 2.40 },
      rightHand: { fold: 0.70 }, head: { x: 0.08, z: 0.07 },
    },
    osc: [{ bone: 'rightHand', axis: 'fold', amplitude: 0.10, hz: 2.6, phase: 0 }],
  },
  'arms-crossed': {
    durationMs: 2400, attackMs: 340, releaseMs: 520, hold: true,
    bones: {
      leftUpperArm: { fwd: 0.35, raise: 0.45 }, rightUpperArm: { fwd: 0.35, raise: 0.45 },
      leftLowerArm: { fwd: 1.10, flex: 0.55 }, rightLowerArm: { fwd: 1.10, flex: 0.55 },
      head: { x: 0.06 },
    },
  },
  facepalm: {
    durationMs: 2800, attackMs: 260, releaseMs: 520,
    bones: {
      rightUpperArm: { fwd: 0.60, raise: 1.50 }, rightLowerArm: { fwd: 0.30, flex: 2.50 },
      rightHand: { fold: 0.90 }, head: { x: 0.12 }, neck: { x: 0.06 },
    },
  },
  cheer: {
    durationMs: 2600, attackMs: 280, releaseMs: 520,
    bones: { leftUpperArm: { raise: 2.00 }, rightUpperArm: { raise: 2.00 }, head: { x: -0.10 } },
    osc: [{ bone: 'leftUpperArm', axis: 'raise', amplitude: 0.12, hz: 1.8, phase: 0 },
      { bone: 'rightUpperArm', axis: 'raise', amplitude: 0.12, hz: 1.8, phase: Math.PI }],
  },
  'blow-kiss': {
    durationMs: 3000, attackMs: 320, releaseMs: 560,
    bones: { rightUpperArm: { fwd: 0.65, raise: 1.48 }, rightLowerArm: { fwd: 0.28, flex: 2.45 }, rightHand: { fold: 0.75 }, head: { x: -0.05 } },
    // A mão sai do rosto e vai para fora no fim do gesto.
    sweep: [{ bone: 'rightUpperArm', axis: 'fwd', from: 0.65, to: 1.10, start: 0.55, end: 0.9 }],
  },
  'hands-on-cheeks': {
    durationMs: 2600, attackMs: 260, releaseMs: 460, hold: true,
    bones: {
      leftUpperArm: { fwd: 0.75, raise: 1.55 }, rightUpperArm: { fwd: 0.75, raise: 1.55 },
      leftLowerArm: { fwd: 0.12, flex: 2.50 }, rightLowerArm: { fwd: 0.12, flex: 2.50 },
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

// Eixos EULER CRUS que um gesto realmente mexe num osso, depois de resolver a
// semântica pela tabela. Escrever só neles é o que permite compor com o sway:
// spine.z e neck.z são da respiração, e um gesto que os resetasse à base
// congelaria o avatar enquanto durasse.
function touchedAxes(def, bone, axisTable) {
  const axes = new Set();
  const add = axisName => {
    const resolved = resolveAxis(axisTable, bone, axisName);
    if (resolved) axes.add(resolved.axis);
  };
  for (const axisName of Object.keys(def.bones[bone] ?? {})) add(axisName);
  for (const s of def.sweep ?? []) if (s.bone === bone) add(s.axis);
  for (const o of def.osc ?? []) if (o.bone === bone) add(o.axis);
  return axes;
}

export function createGestureLibrary({ humanoid, now = () => performance.now(), axisTable = legacyAxisTable() }) {
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
      const keep = nextDef ? touchedAxes(nextDef, name, axisTable) : null;
      for (const axis of touchedAxes(def, name, axisTable)) {
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

  // Total por eixo Euler local do osso: cada nome da definição (semântico ou
  // cru) é resolvido pela tabela do modelo e acumula no eixo local resultante
  // (base da pose + sweep + osc). Semântica desconhecida para o osso é ignorada
  // em vez de chutar um eixo.
  const offsetMap = (def, name, { env, progress, elapsedMs }) => {
    const out = new Map();
    const apply = (axisName, value) => {
      const resolved = resolveAxis(axisTable, name, axisName);
      if (!resolved) return;
      out.set(resolved.axis, (out.get(resolved.axis) ?? 0) + resolved.sign * value);
    };
    for (const [axisName, target] of Object.entries(def.bones[name] ?? {})) apply(axisName, target * env);
    for (const sweep of def.sweep ?? []) {
      if (sweep.bone === name) apply(sweep.axis, (sweep.to - sweep.from) * ramp(progress, sweep.start, sweep.end) * env);
    }
    for (const osc of def.osc ?? []) {
      if (osc.bone === name) apply(osc.axis, Math.sin((elapsedMs / 1000) * osc.hz * Math.PI * 2 + osc.phase) * osc.amplitude * env);
    }
    return out;
  };

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

    for (const name of Object.keys(def.bones)) {
      // head é da camada de gestos (pose emocional + tilt); ela soma os offsets
      // que este gesto pede, via headOffsets(). Escrever aqui brigaria com ela.
      if (name === 'head') continue;
      const node = nodes[name];
      const origin = base[name];
      if (!node || !origin) continue;
      for (const [axis, offset] of offsetMap(def, name, { env, progress, elapsedMs })) {
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
