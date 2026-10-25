import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateSequence,
  sampleSequence,
  findConflicts,
  scoreEvaluation,
  describeEvaluation,
  EVALUATION_THRESHOLDS,
  CONTINUOUS_DRIVERS,
} from '../src/motion-evaluation.js';

const seq = (tracks, durationMs = 2000, name = 'teste') => ({ name, durationMs, tracks });
const arm = (keys, bone = 'rightUpperArm') => ({ bone, keys });

const findCode = (evaluation, code) => evaluation.findings.find(item => item.code === code);

// --- contrato: validade primeiro, métrica depois ----------------------------

test('sequência fora do contrato é fail e não gera métrica', () => {
  const evaluation = evaluateSequence(seq([arm([{ t: 0, axis: 'z', value: 0 }, { t: 100, axis: 'z', value: 2.5 }])], 100));
  assert.equal(evaluation.verdict, 'fail');
  assert.equal(evaluation.ok, false);
  assert.equal(evaluation.metrics, null);
  assert.equal(evaluation.score, 0);
  assert.ok(evaluation.errors.length > 0);
  assert.equal(findCode(evaluation, 'contract-invalid').severity, 'error');
});

test('avaliação é determinística: mesma entrada, mesmos números', () => {
  const input = seq([arm([{ t: 0, axis: 'z', value: 0 }, { t: 1000, axis: 'z', value: 0.4 }, { t: 2000, axis: 'z', value: 0 }])]);
  assert.deepEqual(evaluateSequence(input), evaluateSequence(input));
});

// --- continuidade: repouso nas duas pontas ----------------------------------

test('começa e termina em repouso não gera achado e vale nota cheia', () => {
  const evaluation = evaluateSequence(seq([arm([{ t: 0, axis: 'z', value: 0 }, { t: 1000, axis: 'z', value: 0.4 }, { t: 2000, axis: 'z', value: 0 }])]));
  assert.equal(evaluation.metrics.restDeltaStartRad, 0);
  assert.equal(evaluation.metrics.restDeltaEndRad, 0);
  assert.equal(evaluation.verdict, 'pass');
  assert.equal(evaluation.score, 100);
});

test('terminar fora do repouso é alertado (a pose ficaria presa)', () => {
  const evaluation = evaluateSequence(seq([arm([{ t: 0, axis: 'z', value: 0 }, { t: 1000, axis: 'z', value: 0.4 }, { t: 2000, axis: 'z', value: 0.3 }])]));
  assert.equal(evaluation.metrics.restDeltaEndRad, 0.3);
  assert.ok(findCode(evaluation, 'not-at-rest-end'));
  assert.equal(evaluation.verdict, 'warn');
  assert.ok(evaluation.score < 100);
});

test('começar fora do repouso é alertado', () => {
  const evaluation = evaluateSequence(seq([arm([{ t: 0, axis: 'z', value: 0.2 }, { t: 1000, axis: 'z', value: 0.4 }, { t: 2000, axis: 'z', value: 0 }])]));
  assert.ok(findCode(evaluation, 'not-at-rest-start'));
  assert.ok(evaluation.score < 100);
});

// --- suavidade e limites ----------------------------------------------------

test('a mesma amplitude em menos tempo produz mais velocidade, jerk e menos nota', () => {
  const keys = (durationMs) => arm([{ t: 0, axis: 'z', value: 0 }, { t: durationMs / 2, axis: 'z', value: 0.6 }, { t: durationMs, axis: 'z', value: 0 }]);
  const devagar = evaluateSequence(seq([keys(2000)], 2000));
  const rapido = evaluateSequence(seq([keys(200)], 200));
  assert.ok(rapido.metrics.peakVelocityRadS > devagar.metrics.peakVelocityRadS * 3);
  assert.ok(rapido.metrics.peakJerkRadS3 > devagar.metrics.peakJerkRadS3);
  assert.ok(rapido.score < devagar.score);
  assert.ok(findCode(rapido, 'velocity-over-limit'));
  assert.ok(findCode(rapido, 'jerk-over-limit'));
  assert.equal(devagar.verdict, 'pass');
});

test('limiar customizado governa o veredito (sem número mágico escondido)', () => {
  const input = seq([arm([{ t: 0, axis: 'z', value: 0 }, { t: 1000, axis: 'z', value: 0.4 }, { t: 2000, axis: 'z', value: 0 }])]);
  const folgada = evaluateSequence(input, { thresholds: { ...EVALUATION_THRESHOLDS, maxVelocityRadS: 100 } });
  const apertada = evaluateSequence(input, { thresholds: { ...EVALUATION_THRESHOLDS, maxVelocityRadS: 0.1 } });
  assert.equal(folgada.verdict, 'pass');
  assert.ok(findCode(apertada, 'velocity-over-limit'));
  assert.equal(apertada.verdict, 'warn');
});

test('amplitude perto do teto do contrato é alertada', () => {
  const evaluation = evaluateSequence(seq([arm([{ t: 0, axis: 'z', value: 0 }, { t: 1000, axis: 'z', value: 0.98 }, { t: 2000, axis: 'z', value: 0 }])]));
  assert.ok(evaluation.metrics.amplitudeUsage > 0.9);
  assert.ok(findCode(evaluation, 'amplitude-near-limit'));
});

test('sequência que não move nada é marcada como invisível', () => {
  const evaluation = evaluateSequence(seq([arm([{ t: 0, axis: 'z', value: 0 }, { t: 1000, axis: 'z', value: 0 }, { t: 2000, axis: 'z', value: 0 }])]));
  assert.equal(evaluation.metrics.pathLengthRad, 0);
  assert.ok(findCode(evaluation, 'motion-too-small'));
  assert.ok(evaluation.score <= 80);
});

// --- conflitos de posse -----------------------------------------------------

test('canal escrito pelo look-at vira conflito (alerta, não bloqueio)', () => {
  const evaluation = evaluateSequence(seq([arm([{ t: 0, axis: 'x', value: 0 }, { t: 1000, axis: 'x', value: 0.05 }, { t: 2000, axis: 'x', value: 0 }], 'leftEye')]));
  const conflict = evaluation.metrics.conflicts.find(item => item.channel === 'leftEye.x');
  assert.equal(conflict.driver, 'lookAt');
  assert.equal(conflict.severity, 'warn');
  assert.ok(findCode(evaluation, 'conflict-lookAt'));
  assert.equal(evaluation.verdict, 'warn');
});

test('a severidade do conflito vem do driver dono do canal', () => {
  const drivers = { ...CONTINUOUS_DRIVERS, sway: ['chest.x', 'spine.z', 'neck.z', 'rightUpperArm.z'] };
  const conflicts = findConflicts({ tracks: [arm([{ t: 0, axis: 'z', value: 0 }, { t: 2000, axis: 'z', value: 0 }])] }, drivers);
  // o mesmo canal pode pertencer a dois drivers (aqui: sway e gestureLayer)
  assert.deepEqual(conflicts.map(item => `${item.driver}:${item.severity}`).sort(), ['gestureLayer:info', 'sway:error']);
  assert.ok(conflicts.some(item => item.channel === 'rightUpperArm.z' && item.severity === 'error'));
});

test('eixo proibido pelo contrato nunca chega a virar métrica', () => {
  // spine.z é do sway: o contrato recusa, então a avaliação nem tenta medir.
  const evaluation = evaluateSequence(seq([{ bone: 'spine', keys: [{ t: 0, axis: 'z', value: 0 }, { t: 2000, axis: 'z', value: 0.1 }] }]));
  assert.equal(evaluation.verdict, 'fail');
  assert.match(evaluation.errors.join(' '), /eixo .* não permitido/);
});

// --- custo e formato --------------------------------------------------------

test('amostragem tem teto mesmo em sequência de 10 s', () => {
  const evaluation = evaluateSequence(seq([arm([{ t: 0, axis: 'z', value: 0 }, { t: 5000, axis: 'z', value: 0.2 }, { t: 10000, axis: 'z', value: 0 }])], 10000));
  assert.ok(evaluation.metrics.samples <= EVALUATION_THRESHOLDS.maxSamples + 1);
  assert.ok(evaluation.metrics.sampleMs >= 8);
});

test('sampleSequence separa um canal por eixo e cobre o tempo todo', () => {
  const input = seq([arm([{ t: 0, axis: 'z', value: 0 }, { t: 1000, axis: 'z', value: 0.4 }, { t: 2000, axis: 'z', value: 0 }, { t: 0, axis: 'x', value: 0 }, { t: 2000, axis: 'x', value: 0.1 }])]);
  const sampled = sampleSequence(input, { sampleMs: 500 });
  assert.deepEqual(sampled.channels.map(channel => channel.id).sort(), ['rightUpperArm.x', 'rightUpperArm.z']);
  assert.equal(sampled.series.length, 2);
  assert.deepEqual(sampled.times, [0, 500, 1000, 1500, 2000]);
  const z = sampled.series[sampled.channels.findIndex(channel => channel.id === 'rightUpperArm.z')];
  assert.equal(z[0], 0);
  assert.equal(z[2], 0.4);
  assert.equal(z.at(-1), 0);
});

test('describeEvaluation e scoreEvaluation são funções puras de texto/nota', () => {
  const evaluation = evaluateSequence(seq([arm([{ t: 0, axis: 'z', value: 0 }, { t: 1000, axis: 'z', value: 0.4 }, { t: 2000, axis: 'z', value: 0 }])]));
  assert.match(describeEvaluation(evaluation), /score 100/);
  assert.equal(describeEvaluation({ metrics: null, errors: ['x'] }), 'fail contrato: x');
  assert.equal(scoreEvaluation(evaluation.metrics), 100);
});
