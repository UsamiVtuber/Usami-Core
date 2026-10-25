import test from 'node:test';
import assert from 'node:assert/strict';
import { createVrmGestureLayer } from '../src/vrm-gesture-layer.js';

// Mesmo fake do harness da camada: rotação plana com clone e relógio injetável.
const makeRotation = (x = 0, y = 0, z = 0) => ({
  x, y, z,
  clone() { return Object.assign(makeRotation(), { x: this.x, y: this.y, z: this.z }); },
});
const makeNode = (x = 0, y = 0, z = 0) => ({ rotation: makeRotation(x, y, z) });

function makeHumanoid() {
  const nodes = {
    rightUpperArm: makeNode(.05, 0, -.1),
    rightLowerArm: makeNode(0, .05, -.2),
    rightHand: makeNode(.01, 0, .02),
    head: makeNode(.03, 0, .01),
  };
  return { nodes, getNormalizedBoneNode: name => nodes[name] ?? null };
}

function makeClock(start = 0) {
  let t = start;
  return { now: () => t, advance: ms => { t += ms; return t; } };
}

const settle = (layer, clock, steps, stepMs) => { for (let i = 0; i < steps; i++) { clock.advance(stepMs); layer.update(); } };

test('available.sequences reflete o humanoid; sem rig, playSequence recusa', () => {
  const semRig = createVrmGestureLayer({ humanoid: null, now: makeClock().now });
  assert.equal(semRig.available.sequences, false);
  assert.equal(semRig.playSequence({ shape: 'nod' }), false);
  semRig.update();
  semRig.stopSequence();

  const layer = createVrmGestureLayer({ humanoid: makeHumanoid(), now: makeClock().now });
  assert.equal(layer.available.sequences, true);
});

test('playSequence expande shape, move o osso e volta EXATA à base no fim', () => {
  const humanoid = makeHumanoid();
  const clock = makeClock();
  const layer = createVrmGestureLayer({ humanoid, now: clock.now });
  const baseZ = humanoid.nodes.rightUpperArm.rotation.z;
  assert.equal(layer.playSequence({ shape: 'wave-arm', durationMs: 2000 }), true);
  assert.equal(layer.active().sequence, 'wave-arm');
  settle(layer, clock, 10, 100);
  assert.notEqual(humanoid.nodes.rightUpperArm.rotation.z, baseZ);
  settle(layer, clock, 25, 100); // ultrapassa a duração
  assert.equal(layer.active().sequence, null);
  assert.equal(humanoid.nodes.rightUpperArm.rotation.z, baseZ);
  assert.equal(humanoid.nodes.rightHand.rotation.z, .02);
});

test('gesto novo encerra a sequência (quem chega depois vence), sem resíduo', () => {
  const humanoid = makeHumanoid();
  const clock = makeClock();
  const layer = createVrmGestureLayer({ humanoid, now: clock.now });
  assert.equal(layer.playSequence({ shape: 'wave-arm', durationMs: 4000 }), true);
  clock.advance(500);
  layer.update();
  assert.equal(layer.active().sequence, 'wave-arm');
  // direção de override: sequência > biblioteca > legado — e um gesto novo
  // substitui a sequência de forma previsível, restaurando a base antes.
  assert.equal(layer.gesture('point'), true);
  assert.equal(layer.active().sequence, null);
  assert.equal(layer.active().gesture, 'point');
  // rightUpperArm.z: a sequência escreveu, o gesto não usa z → de volta à base
  assert.ok(Math.abs(humanoid.nodes.rightUpperArm.rotation.z - (-0.1)) < 1e-9);
});

test('sequência em curso substitui gesto da biblioteca ao começar', () => {
  const humanoid = makeHumanoid();
  const clock = makeClock();
  const layer = createVrmGestureLayer({ humanoid, now: clock.now });
  assert.equal(layer.gesture('hand-on-hip'), true); // hold: fica até parar
  assert.equal(layer.active().gesture, 'hand-on-hip');
  assert.equal(layer.playSequence({ shape: 'wave-arm', durationMs: 2000 }), true);
  assert.equal(layer.active().gesture, null);
  assert.equal(layer.active().sequence, 'wave-arm');
  clock.advance(2200);
  layer.update();
  assert.equal(layer.active().sequence, null);
  assert.ok(Math.abs(humanoid.nodes.rightUpperArm.rotation.z - (-0.1)) < 1e-9);
});

test('stopGesture e clear liberam a sequência', () => {
  const humanoid = makeHumanoid();
  const clock = makeClock();
  const layer = createVrmGestureLayer({ humanoid, now: clock.now });
  layer.playSequence({ shape: 'sway-arms', durationMs: 3000 });
  clock.advance(300);
  layer.update();
  layer.stopGesture();
  assert.equal(layer.active().sequence, null);
  assert.equal(humanoid.nodes.rightUpperArm.rotation.z, -.1);

  layer.playSequence({ shape: 'wave-arm', durationMs: 3000 });
  clock.advance(300);
  layer.update();
  layer.clear();
  assert.equal(layer.active().sequence, null);
  assert.equal(humanoid.nodes.rightUpperArm.rotation.z, -.1);
  assert.equal(humanoid.nodes.rightHand.rotation.z, .02);
});

test('request inválido (shape inexistente) não altera estado nem lança', () => {
  const humanoid = makeHumanoid();
  const clock = makeClock();
  const layer = createVrmGestureLayer({ humanoid, now: clock.now });
  assert.equal(layer.playSequence({ shape: 'lua' }), false);
  assert.equal(layer.active().sequence, null);
  layer.update();
  assert.equal(humanoid.nodes.rightUpperArm.rotation.z, -.1);
});

test('sequência completa (tracks) também é aceita, e keys inválidas são recusadas', () => {
  const humanoid = makeHumanoid();
  const clock = makeClock();
  const layer = createVrmGestureLayer({ humanoid, now: clock.now });
  const full = {
    name: 'custom',
    durationMs: 1000,
    tracks: [{ bone: 'rightHand', keys: [{ t: 0, axis: 'x', value: 0 }, { t: 500, axis: 'x', value: 0.2 }, { t: 1000, axis: 'x', value: 0 }] }],
  };
  assert.equal(layer.playSequence(full), true);
  clock.advance(500);
  layer.update();
  assert.ok(humanoid.nodes.rightHand.rotation.x > .01 + .1);
  assert.equal(layer.playSequence({ name: 'ruim', durationMs: 1000, tracks: [{ bone: 'head', keys: full.tracks[0].keys }] }), false);
});
