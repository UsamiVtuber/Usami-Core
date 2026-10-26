import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSequence, sampleTrack, createSequenceRunner, SEQUENCE_BONE_AXES, SEQUENCE_LIMITS } from '../src/motion-sequence.js';

const makeRotation = (x = 0, y = 0, z = 0) => ({
  x, y, z,
  clone() { return Object.assign(makeRotation(), { x: this.x, y: this.y, z: this.z }); },
});
const makeNode = (x = 0, y = 0, z = 0) => ({ rotation: makeRotation(x, y, z) });

function makeClock(start = 0) {
  let t = start;
  return { now: () => t, advance: ms => { t += ms; return t; } };
}

const seq = (overrides = {}) => ({
  name: 'teste',
  durationMs: 2000,
  tracks: [
    { bone: 'rightUpperArm', keys: [{ t: 0, axis: 'z', value: 0 }, { t: 1000, axis: 'z', value: 0.4 }, { t: 2000, axis: 'z', value: 0 }] },
  ],
  ...overrides,
});

// --- validateSequence ------------------------------------------------------

test('sequência válida passa e é normalizada', () => {
  const result = validateSequence(seq());
  assert.equal(result.ok, true);
  assert.equal(result.sequence.name, 'teste');
  assert.equal(result.sequence.tracks[0].bone, 'rightUpperArm');
  assert.equal(result.sequence.tracks[0].keys.length, 3);
});

test('rejeita osso fora da allowlist (head é da camada de gestos)', () => {
  const bad = seq({ tracks: [{ bone: 'head', keys: [{ t: 0, axis: 'x', value: 0.1 }, { t: 2000, axis: 'x', value: 0 }] }] });
  const result = validateSequence(bad);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.includes('head')));
});

test('rejeita eixo não permitido: spine só aceita x', () => {
  const bad = seq({ tracks: [{ bone: 'spine', keys: [{ t: 0, axis: 'z', value: 0 }, { t: 2000, axis: 'z', value: 0.2 }] }] });
  const result = validateSequence(bad);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.includes('eixo')));
  assert.ok('spine' in SEQUENCE_BONE_AXES);
});

test('rejeita amplitude acima do limite e valor não numérico', () => {
  const bad = seq({ tracks: [{ bone: 'rightHand', keys: [{ t: 0, axis: 'x', value: 0 }, { t: 2000, axis: 'x', value: SEQUENCE_LIMITS.maxOffsetRad + 0.1 }] }] });
  assert.equal(validateSequence(bad).ok, false);
  const nan = seq({ tracks: [{ bone: 'rightHand', keys: [{ t: 0, axis: 'x', value: 0 }, { t: 2000, axis: 'x', value: 'muito' }] }] });
  assert.equal(validateSequence(nan).ok, false);
});

test('rejeita t fora de ordem, gap mínimo e fim descasado com durationMs', () => {
  const ordem = seq({ tracks: [{ bone: 'rightHand', keys: [{ t: 1000, axis: 'x', value: 0 }, { t: 500, axis: 'x', value: 0.1 }, { t: 2000, axis: 'x', value: 0 }] }] });
  assert.equal(validateSequence(ordem).ok, false);
  const gap = seq({ tracks: [{ bone: 'rightHand', keys: [{ t: 0, axis: 'x', value: 0 }, { t: 10, axis: 'x', value: 0.1 }, { t: 2000, axis: 'x', value: 0 }] }] });
  assert.equal(validateSequence(gap).ok, false);
  const fim = seq({ tracks: [{ bone: 'rightHand', keys: [{ t: 0, axis: 'x', value: 0 }, { t: 1500, axis: 'x', value: 0.1 }] }] });
  assert.equal(validateSequence(fim).ok, false);
});

test('rejeita duração fora dos limites, ossos duplicados e tracks vazio', () => {
  assert.equal(validateSequence(seq({ durationMs: 50 })).ok, false);
  assert.equal(validateSequence(seq({ durationMs: 60000 })).ok, false);
  assert.equal(validateSequence(seq({ tracks: [seq().tracks[0], seq().tracks[0]] })).ok, false);
  assert.equal(validateSequence(seq({ tracks: [] })).ok, false);
  assert.equal(validateSequence(null).ok, false);
  assert.equal(validateSequence('x').ok, false);
});

// --- sampleTrack ------------------------------------------------------------

test('sampleTrack interpola com easing e segura as bordas', () => {
  const keys = [{ t: 0, axis: 'x', value: 0 }, { t: 1000, axis: 'x', value: 1 }];
  assert.equal(sampleTrack(keys, -50), 0);
  assert.equal(keys.length, 2);
  const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
  near(sampleTrack(keys, 0), 0);
  near(sampleTrack(keys, 1000), 1);
  near(sampleTrack(keys, 1500), 1); // borda superior segura
  near(sampleTrack(keys, 500), 0.5); // meio do ciclo: cos(π/2) = 0
  // easing de cosseno: antes da metade, abaixo da rampa linear
  assert.ok(sampleTrack(keys, 250) < 0.25);
  // três keys: interpolado exatamente sobre uma key devolve seu valor
  const tres = [{ t: 0, axis: 'x', value: 0 }, { t: 500, axis: 'x', value: 0.3 }, { t: 1000, axis: 'x', value: 0 }];
  near(sampleTrack(tres, 500), 0.3);
  near(sampleTrack(tres, 250), 0.15);
  near(sampleTrack(tres, 750), 0.15);
});

// --- createSequenceRunner ----------------------------------------------------

function makeRunner(clock = makeClock()) {
  const nodes = {
    rightUpperArm: { node: makeNode(0, 0, -0.1), base: makeRotation(0, 0, -0.1) },
    rightHand: { node: makeNode(), base: makeRotation() },
  };
  return { nodes, clock, runner: createSequenceRunner({ nodes, now: clock.now }) };
}

test('runner reproduz sem sequência ativa e recusa entrada inválida', () => {
  const { runner, clock } = makeRunner();
  runner.update();
  assert.equal(runner.active(), null);
  const bad = runner.play({ durationMs: 10, tracks: [] });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.length > 0);
  assert.equal(runner.active(), null);
  clock.advance(100);
  runner.update();
  assert.equal(runner.active(), null);
});

test('runner aplica base+offset durante a sequência e restaura ao fim', () => {
  const { runner, nodes, clock } = makeRunner();
  const result = runner.play(seq());
  assert.equal(result.ok, true);
  assert.deepEqual(runner.active() && Object.keys(runner.active()), ['name', 'startedAt']);
  clock.advance(1000);
  runner.update();
  // pico: offset 0.4 sobre a base -0.1
  assert.equal(nodes.rightUpperArm.node.rotation.z, -0.1 + 0.4);
  clock.advance(1000); // chegou à duração
  runner.update();
  assert.equal(runner.active(), null);
  assert.equal(nodes.rightUpperArm.node.rotation.z, -0.1); // base restaurada
});

test('runner cancela com stop() devolvendo todos os eixos tocados à base', () => {
  const { runner, nodes, clock } = makeRunner();
  runner.play(seq());
  clock.advance(500);
  runner.update();
  assert.notEqual(nodes.rightUpperArm.node.rotation.z, -0.1);
  runner.stop();
  assert.equal(nodes.rightUpperArm.node.rotation.z, -0.1);
  assert.equal(runner.active(), null);
});

test('nova sequência substitui a anterior sem deixar resíduo na primeira', () => {
  const { runner, nodes, clock } = makeRunner();
  runner.play(seq());
  clock.advance(500);
  runner.update();
  const segunda = seq({ name: 'segunda', tracks: [{ bone: 'rightHand', keys: [{ t: 0, axis: 'x', value: 0 }, { t: 2000, axis: 'x', value: 0.2 }, { t: 4000, axis: 'x', value: 0 }] }], durationMs: 4000 });
  assert.equal(runner.play(segunda).ok, true);
  assert.equal(nodes.rightUpperArm.node.rotation.z, -0.1); // resíduo da primeira restaurado
  clock.advance(2000);
  runner.update();
  assert.equal(runner.active().name, 'segunda');
});

test('semântica: validação aceita nomes calibráveis e o runner resolve pela tabela', () => {
  const clock = makeClock();
  const nodes = { rightUpperArm: { node: makeNode(0, 0, -0.1), base: makeRotation(0, 0, -0.1) } };
  // como calibrateArmAxes pode mapear num rig espelhado: raise = z POSITIVO
  const axisTable = { rightUpperArm: { raise: { axis: 'z', sign: 1 }, fwd: { axis: 'x', sign: -1 } } };
  const runner = createSequenceRunner({ nodes, now: clock.now, axisTable });
  const s = seq({ tracks: [{ bone: 'rightUpperArm', keys: [{ t: 0, axis: 'raise', value: 0 }, { t: 1000, axis: 'raise', value: 0.4 }, { t: 2000, axis: 'raise', value: 0 }] }] });
  assert.equal(validateSequence(s).ok, true, 'nome semântico é eixo válido para braço');
  assert.equal(runner.play(s).ok, true);
  clock.advance(1000);
  runner.update();
  assert.equal(nodes.rightUpperArm.node.rotation.z, -0.1 + 0.4, 'sinal +1 da tabela aplicado sobre a base');
  clock.advance(1000);
  runner.update();
  assert.equal(nodes.rightUpperArm.node.rotation.z, -0.1, 'restauração usa o eixo resolvido');
});

test('validação rejeita semântica que o osso não controla', () => {
  const bad = seq({ tracks: [{ bone: 'rightUpperArm', keys: [{ t: 0, axis: 'flex', value: 0 }, { t: 2000, axis: 'flex', value: 0.2 }] }] });
  assert.equal(validateSequence(bad).ok, false);
  const trunk = seq({ tracks: [{ bone: 'spine', keys: [{ t: 0, axis: 'raise', value: 0 }, { t: 2000, axis: 'raise', value: 0.2 }] }] });
  assert.equal(validateSequence(trunk).ok, false, 'tronco continua só em Euler cru');
});

test('osso ausente no modelo degrada em vez de quebrar', () => {
  const clock = makeClock();
  const nodes = { rightHand: { node: makeNode(), base: makeRotation() } };
  const runner = createSequenceRunner({ nodes, now: clock.now });
  assert.equal(runner.play(seq()).ok, true); // faixa de rightUpperArm não tem nó
  clock.advance(1000);
  runner.update(); // não lança
  assert.equal(runner.active().name, 'teste');
});
