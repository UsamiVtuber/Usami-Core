// Fase 1: contrato tipado de sequências de keyframes (motion sequences).
//
// Uma sequência é dado puro — a IA produz, o motor de experimentação avalia e o
// runner executa; nenhum dos três depende de three.js. A escrita é sempre
// `base + offset` sobre os nós normalizados do VRM, no mesmo espírito da
// biblioteca de gestos, então repouso é idempotente e as camadas compõem.
//
// Convenção de ossos (mesma da biblioteca, vrm-gesture-library.js):
//   - head é EXCLUÍDO: cabeça é da camada de gestos (pose emocional + tilt).
//   - spine/neck: só eixo x — z é do sway (respiração/balanço), e escrever nele
//     brigaria com o rAF.
//   - chest: excluído, mesmo motivo do spine.z.
//   - braço/ombro/quadril: x, y, z liberados (nenhuma outra camada os usa).
// As amplitudes são offsets em radianos a partir da pose capturada no load;
// os limites abaixo são a trava de segurança do runtime determinístico.

export const SEQUENCE_LIMITS = {
  maxDurationMs: 10000,
  minDurationMs: 200,
  maxTracks: 8,
  minKeys: 2,
  maxKeys: 12,
  maxOffsetRad: 1.0,
  // gap mínimo entre keys: evita keyframes absurdamente próximos (impossíveis
  // de render e sintoma de alucinação do LLM)
  minKeyGapMs: 40,
  maxKeyTimeMs: 10000,
};

const ARM_AXES = ['x', 'y', 'z'];

export const SEQUENCE_BONE_AXES = Object.freeze({
  hips: ARM_AXES,
  leftShoulder: ARM_AXES,
  rightShoulder: ARM_AXES,
  leftUpperArm: ARM_AXES,
  leftLowerArm: ARM_AXES,
  leftHand: ARM_AXES,
  rightUpperArm: ARM_AXES,
  rightLowerArm: ARM_AXES,
  rightHand: ARM_AXES,
  leftEye: ARM_AXES,
  rightEye: ARM_AXES,
  spine: ['x'],
  neck: ['x'],
});

const BONE_SET = new Set(Object.keys(SEQUENCE_BONE_AXES));

// Validação estrita: devolve a sequência normalizada ou as razões de rejeição.
// Nunca lança — o chamador (director, motor de experimentação) decide o que fazer.
export function validateSequence(seq, limits = SEQUENCE_LIMITS) {
  const errors = [];
  if (!seq || typeof seq !== 'object' || Array.isArray(seq)) return { ok: false, errors: ['sequência deve ser um objeto'] };

  const name = typeof seq.name === 'string' && seq.name.trim() ? seq.name.trim().slice(0, 60) : '';
  const durationMs = Number(seq.durationMs);
  if (!Number.isFinite(durationMs) || durationMs < limits.minDurationMs || durationMs > limits.maxDurationMs) {
    errors.push(`durationMs fora de ${limits.minDurationMs}..${limits.maxDurationMs}`);
  }

  const tracks = Array.isArray(seq.tracks) ? seq.tracks : null;
  if (!tracks) errors.push('tracks ausente ou não é lista');
  else if (tracks.length === 0 || tracks.length > limits.maxTracks) errors.push(`tracks deve ter 1..${limits.maxTracks} faixas`);

  if (tracks) {
    const seenBones = new Set();
    for (const track of tracks) {
      const bone = track?.bone;
      if (!BONE_SET.has(bone)) { errors.push(`osso não controlável: ${JSON.stringify(bone)}`); continue; }
      if (seenBones.has(bone)) { errors.push(`osso duplicado em duas faixas: ${bone}`); continue; }
      seenBones.add(bone);
      const axes = SEQUENCE_BONE_AXES[bone];
      const keys = Array.isArray(track?.keys) ? track.keys : null;
      if (!keys || keys.length < limits.minKeys || keys.length > limits.maxKeys) {
        errors.push(`${bone}: keys deve ter ${limits.minKeys}..${limits.maxKeys} keyframes`);
        continue;
      }
      let previousTime = -Infinity;
      keys.forEach((key, index) => {
        const t = Number(key?.t);
        const axis = key?.axis;
        const value = Number(key?.value);
        if (!axes.includes(axis)) errors.push(`${bone}[${index}]: eixo ${JSON.stringify(axis)} não permitido para este osso`);
        if (!Number.isFinite(t) || t < 0 || t > limits.maxKeyTimeMs) errors.push(`${bone}[${index}]: t inválido`);
        else if (previousTime > -Infinity && t - previousTime < limits.minKeyGapMs) errors.push(`${bone}[${index}]: t deve crescer pelo menos ${limits.minKeyGapMs} ms`);
        if (Number.isFinite(t)) previousTime = t;
        if (!Number.isFinite(value) || Math.abs(value) > limits.maxOffsetRad) errors.push(`${bone}[${index}]: |value| deve estar em 0..${limits.maxOffsetRad} rad`);
      });
      if (Number.isFinite(previousTime) && Math.abs(previousTime - durationMs) > 1) {
        errors.push(`${bone}: último keyframe (t=${previousTime}) deve coincidir com durationMs=${durationMs}`);
      }
    }
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    sequence: {
      name,
      durationMs,
      tracks: tracks.map(track => ({
        bone: track.bone,
        keys: track.keys.map(key => ({ t: Number(key.t), axis: key.axis, value: Number(key.value) })),
      })),
    },
  };
}

// Amostra o offset de uma faixa em t (ms) com easing de cosseno entre keyframes
// (suave nos dois lados de cada key). Determinístico: função pura de (keys, t).
export function sampleTrack(keys, t) {
  const time = Math.max(0, t);
  if (time <= keys[0].t) return keys[0].value;
  const last = keys[keys.length - 1];
  if (time >= last.t) return last.value;
  let index = 0;
  while (index < keys.length - 1 && keys[index + 1].t < time) index += 1;
  const a = keys[index];
  const b = keys[index + 1];
  const raw = (time - a.t) / (b.t - a.t);
  const eased = (1 - Math.cos(Math.PI * raw)) / 2;
  return a.value + (b.value - a.value) * eased;
}

// Cria o runner de sequências sobre nós injetados ({ node, base }) — no runtime
// os nós vêm do humanoid normalizado; nos testes são objetos falsos. Não há
// escrita fora de base+offset nos eixos das keys.
export function createSequenceRunner({ nodes, now = () => performance.now(), limits = SEQUENCE_LIMITS }) {
  let current = null; // { name, sequence, startedAt }
  const touched = new Set(); // "bone.axis" da sequência em curso

  const restore = () => {
    for (const id of touched) {
      const [bone, axis] = id.split('.');
      const entry = nodes[bone];
      if (entry) entry.node.rotation[axis] = entry.base[axis];
    }
    touched.clear();
  };

  function play(sequence) {
    const result = validateSequence(sequence, limits);
    if (!result.ok) return { ok: false, errors: result.errors };
    // uma nova sequência substitui a anterior de forma previsível
    restore();
    current = { name: result.sequence.name || 'sequence', sequence: result.sequence, startedAt: now() };
    return { ok: true, sequence: result.sequence };
  }

  function stop() {
    restore();
    current = null;
    return true;
  }

  function update() {
    if (!current) return;
    const elapsed = now() - current.startedAt;
    if (elapsed >= current.sequence.durationMs) {
      restore();
      current = null;
      return;
    }
    for (const track of current.sequence.tracks) {
      const entry = nodes[track.bone];
      if (!entry) continue; // osso ausente no modelo: degrada em vez de quebrar
      // keys podem misturar eixos na mesma faixa; cada eixo tem sua própria
      // linha do tempo de keyframes
      const byAxis = new Map();
      for (const key of track.keys) {
        if (!byAxis.has(key.axis)) byAxis.set(key.axis, []);
        byAxis.get(key.axis).push(key);
      }
      for (const [axis, keys] of byAxis) {
        entry.node.rotation[axis] = entry.base[axis] + sampleTrack(keys, elapsed);
        touched.add(`${track.bone}.${axis}`);
      }
    }
  }

  function active() {
    return current ? { name: current.name, startedAt: current.startedAt } : null;
  }

  return { play, stop, update, active };
}
