// Fase 2: avaliação objetiva de sequências de movimento.
//
// Métrica ≠ opinião. Aqui só existe conta determinística sobre a mesma curva que
// o runtime vai amostrar (sampleTrack), sem three.js, sem avatar, sem rede: a
// mesma sequência produz sempre os mesmos números, então o motor de experimentação
// pode comparar tentativas e o planner pode ranquear. O julgamento visual humano
// é um campo separado no registro (record.visual) e nunca entra no score.
//
// As quatro perguntas que estas métricas respondem:
//   validade    — a sequência passa no contrato? (validateSequence)
//   limites     — respeita amplitude/velocidade/aceleração dentro do saudável?
//   continuidade — começa e termina em repouso (base + offset volta a zero)?
//   suavidade   — quão brusca é (picos de velocidade, aceleração e jerk)?
// "conflitos" é sobre posse: quais canais outros drivers escrevem todo frame e
// vão brigar com a sequência.

import { SEQUENCE_LIMITS, validateSequence, sampleTrack } from './motion-sequence.js';

// Amostra em 125 Hz (8 ms) — resolução bem acima da taxa de quadro, com teto de
// passos para o custo ficar previsível em buscas do motor de experimentação.
export const EVALUATION_THRESHOLDS = {
  sampleMs: 8,
  maxSamples: 1250,
  restEpsilonRad: 1e-3,
  minPathLengthRad: 0.05,
  // Calibrados sobre a grade de shapes (scripts/run-motion-experiments.mjs):
  // movimento natural fica abaixo; transições bruscas de keyframe estouram.
  maxVelocityRadS: 6,
  maxAccelerationRadS2: 120,
  maxJerkRadS3: 6000,
  amplitudeWarnRatio: 0.9,
};

// Canais que um driver contínuo do rAF também escreve. sway/gestureLayer são
// bloqueados pelo próprio contrato (SEQUENCE_BONE_AXES); o lookAt/gaze não é —
// osso de olho é controlável, mas a cada frame o cursor reescreve a rotação.
export const CONTINUOUS_DRIVERS = Object.freeze({
  sway: Object.freeze(['chest.x', 'spine.z', 'neck.z']),
  gestureLayer: Object.freeze(['head.x', 'head.y', 'head.z', 'rightUpperArm.z', 'rightLowerArm.z', 'rightHand.z']),
  lookAt: Object.freeze(['leftEye.x', 'leftEye.y', 'leftEye.z', 'rightEye.x', 'rightEye.y', 'rightEye.z']),
});

const CONFLICT_SEVERITY = Object.freeze({ sway: 'error', gestureLayer: 'info', lookAt: 'warn' });

const derivative = (values, dtSec) => {
  const out = [];
  for (let i = 1; i < values.length; i += 1) out.push((values[i] - values[i - 1]) / dtSec);
  return out;
};

const peakAbs = values => (values.length ? values.reduce((max, v) => Math.max(max, Math.abs(v)), 0) : 0);

const round = (value, digits = 4) => Number(value.toFixed(digits));

// Canais (bone.axis) de uma sequência e a série amostrada de cada um. keys já
// vêm ordenados por t (garantia do contrato).
export function sampleSequence(sequence, { sampleMs = EVALUATION_THRESHOLDS.sampleMs, maxSamples = EVALUATION_THRESHOLDS.maxSamples } = {}) {
  const channels = [];
  for (const track of sequence.tracks) {
    const byAxis = new Map();
    for (const key of track.keys) {
      if (!byAxis.has(key.axis)) byAxis.set(key.axis, []);
      byAxis.get(key.axis).push(key);
    }
    for (const [axis, keys] of byAxis) channels.push({ id: `${track.bone}.${axis}`, bone: track.bone, axis, keys });
  }
  const steps = Math.min(maxSamples, Math.max(2, Math.ceil(sequence.durationMs / sampleMs)));
  const dtMs = sequence.durationMs / steps;
  const times = Array.from({ length: steps + 1 }, (_, index) => (index === steps ? sequence.durationMs : index * dtMs));
  const series = channels.map(channel => times.map(time => sampleTrack(channel.keys, time)));
  return { channels: channels.map(({ id, bone, axis }) => ({ id, bone, axis })), dtMs, times, series };
}

// Quais canais da sequência pertencem a um driver contínuo do rAF.
export function findConflicts(sequence, drivers = CONTINUOUS_DRIVERS) {
  const conflicts = [];
  for (const track of sequence.tracks) {
    for (const axis of new Set(track.keys.map(key => key.axis))) {
      const id = `${track.bone}.${axis}`;
      for (const [driver, owned] of Object.entries(drivers)) {
        if (owned.includes(id)) conflicts.push({ channel: id, driver, severity: CONFLICT_SEVERITY[driver] ?? 'warn' });
      }
    }
  }
  return conflicts;
}

function channelMetrics(channel, series, dtSec) {
  const velocity = derivative(series, dtSec);
  const acceleration = derivative(velocity, dtSec);
  const jerk = derivative(acceleration, dtSec);
  const path = velocity.reduce((sum, v) => sum + Math.abs(v) * dtSec, 0);
  return {
    channel: channel.id,
    peakOffsetRad: round(peakAbs(series), 4),
    peakVelocityRadS: round(peakAbs(velocity), 2),
    peakAccelerationRadS2: round(peakAbs(acceleration), 1),
    peakJerkRadS3: round(peakAbs(jerk), 1),
    pathLengthRad: round(path, 4),
    startOffsetRad: round(series[0], 4),
    endOffsetRad: round(series[series.length - 1], 4),
  };
}

// Score 0..100 puramente numérico: parte de 100 e desconta conforme as métricas.
// Nada aqui lê opinião humana; é a nota objetiva que permite ranquear tentativas.
export function scoreEvaluation(metrics, thresholds = EVALUATION_THRESHOLDS) {
  let score = 100;
  if (metrics.restDeltaStartRad > thresholds.restEpsilonRad) score -= 15;
  if (metrics.restDeltaEndRad > thresholds.restEpsilonRad) score -= 15;
  if (metrics.peakVelocityRadS > thresholds.maxVelocityRadS) {
    score -= Math.min(30, 10 * (metrics.peakVelocityRadS / thresholds.maxVelocityRadS - 1) + 10);
  }
  if (metrics.peakJerkRadS3 > thresholds.maxJerkRadS3) {
    score -= Math.min(25, 8 * (metrics.peakJerkRadS3 / thresholds.maxJerkRadS3 - 1) + 8);
  }
  if (metrics.amplitudeUsage > thresholds.amplitudeWarnRatio) score -= 10;
  if (metrics.pathLengthRad < thresholds.minPathLengthRad) score -= 20;
  for (const conflict of metrics.conflicts) score -= conflict.severity === 'error' ? 25 : conflict.severity === 'warn' ? 10 : 0;
  return round(Math.max(0, Math.min(100, score)), 1);
}

// Avalia UMA sequência (dado puro, já expandido). Sequência inválida não gera
// métrica: é 'fail' de contrato, e o motor registra o motivo sem tentar salvar.
export function evaluateSequence(input, { limits = SEQUENCE_LIMITS, thresholds = EVALUATION_THRESHOLDS } = {}) {
  const validation = validateSequence(input, limits);
  if (!validation.ok) {
    return {
      ok: false,
      verdict: 'fail',
      errors: validation.errors,
      findings: [{ code: 'contract-invalid', severity: 'error', message: validation.errors.join('; ') }],
      metrics: null,
      score: 0,
    };
  }
  const sequence = validation.sequence;
  const { channels, dtMs, series } = sampleSequence(sequence, thresholds);
  const dtSec = dtMs / 1000;
  const perChannel = channels.map((channel, index) => channelMetrics(channel, series[index], dtSec));
  const conflicts = findConflicts(sequence);

  const metrics = {
    durationMs: sequence.durationMs,
    channels: channels.length,
    samples: series[0]?.length ?? 0,
    sampleMs: round(dtMs, 3),
    peakOffsetRad: round(Math.max(...perChannel.map(item => item.peakOffsetRad)), 4),
    peakVelocityRadS: round(Math.max(...perChannel.map(item => item.peakVelocityRadS)), 2),
    peakAccelerationRadS2: round(Math.max(...perChannel.map(item => item.peakAccelerationRadS2)), 1),
    peakJerkRadS3: round(Math.max(...perChannel.map(item => item.peakJerkRadS3)), 1),
    pathLengthRad: round(perChannel.reduce((sum, item) => sum + item.pathLengthRad, 0), 4),
    restDeltaStartRad: round(Math.max(...perChannel.map(item => Math.abs(item.startOffsetRad))), 4),
    restDeltaEndRad: round(Math.max(...perChannel.map(item => Math.abs(item.endOffsetRad))), 4),
    amplitudeUsage: round(Math.max(...perChannel.map(item => item.peakOffsetRad)) / limits.maxOffsetRad, 3),
    conflicts,
    byChannel: perChannel,
  };

  const findings = [];
  if (metrics.restDeltaStartRad > thresholds.restEpsilonRad) {
    findings.push({ code: 'not-at-rest-start', severity: 'warn', weight: 15, message: `começa a ${metrics.restDeltaStartRad} rad da base` });
  }
  if (metrics.restDeltaEndRad > thresholds.restEpsilonRad) {
    findings.push({ code: 'not-at-rest-end', severity: 'warn', weight: 15, message: `termina a ${metrics.restDeltaEndRad} rad da base (pose ficaria presa)` });
  }
  if (metrics.peakVelocityRadS > thresholds.maxVelocityRadS) {
    findings.push({ code: 'velocity-over-limit', severity: 'warn', message: `pico de ${metrics.peakVelocityRadS} rad/s > ${thresholds.maxVelocityRadS}` });
  }
  if (metrics.peakAccelerationRadS2 > thresholds.maxAccelerationRadS2) {
    findings.push({ code: 'acceleration-over-limit', severity: 'info', message: `pico de ${metrics.peakAccelerationRadS2} rad/s² > ${thresholds.maxAccelerationRadS2}` });
  }
  if (metrics.peakJerkRadS3 > thresholds.maxJerkRadS3) {
    findings.push({ code: 'jerk-over-limit', severity: 'warn', message: `pico de jerk ${metrics.peakJerkRadS3} rad/s³ > ${thresholds.maxJerkRadS3}` });
  }
  if (metrics.amplitudeUsage > thresholds.amplitudeWarnRatio) {
    findings.push({ code: 'amplitude-near-limit', severity: 'warn', message: `usa ${(metrics.amplitudeUsage * 100).toFixed(0)}% da amplitude máxima` });
  }
  if (metrics.pathLengthRad < thresholds.minPathLengthRad) {
    findings.push({ code: 'motion-too-small', severity: 'warn', weight: 20, message: `percurso total ${metrics.pathLengthRad} rad — invisível no avatar` });
  }
  for (const conflict of conflicts) {
    findings.push({
      code: `conflict-${conflict.driver}`,
      severity: conflict.severity,
      message: `${conflict.channel} é escrito pelo ${conflict.driver} a cada frame`,
    });
  }

  const hasError = findings.some(item => item.severity === 'error');
  const verdict = hasError ? 'fail' : findings.some(item => item.severity === 'warn') ? 'warn' : 'pass';
  return { ok: !hasError, verdict, errors: [], findings, metrics, score: scoreEvaluation(metrics, thresholds), sequence };
}

// Uma linha por avaliação — para tabela de relatório sem reimprimir JSON.
export function describeEvaluation(evaluation) {
  if (!evaluation.metrics) return `fail contrato: ${(evaluation.errors ?? []).slice(0, 2).join(', ')}`;
  const m = evaluation.metrics;
  return `score ${evaluation.score} | ${m.durationMs}ms | pico ${m.peakOffsetRad} rad | ${m.peakVelocityRadS} rad/s | jerk ${m.peakJerkRadS3} | repouso ${m.restDeltaStartRad}/${m.restDeltaEndRad}`;
}
