import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutoMotion } from '../src/auto-motion.js';

test('blink segue a rampa triangular de 120/60/140 ms de forma determinística', () => {
  let t = 1000;
  const motion = createAutoMotion({ now: () => t, rng: () => 0 });
  const first = motion.update(1000);
  assert.equal(first.blink, 0);
  assert.equal(first.idleActive, false);
  assert.equal(motion.update(3000).blink, 0);
  assert.equal(motion.update(3060).blink, 0.5);
  assert.equal(motion.update(3120).blink, 1);
  assert.equal(motion.update(3180).blink, 1);
  assert.equal(motion.update(3260).blink, 60 / 140);
  assert.equal(motion.update(3320).blink, 0);
  assert.notEqual(first, motion.update(3400));
});

test('o intervalo do próximo blink usa o rng injetado (rng 0.5 → start em t=4000)', () => {
  let t = 0;
  const motion = createAutoMotion({ now: () => t, rng: () => 0.5 });
  assert.equal(motion.update(3999).blink, 0);
  assert.equal(motion.update(4000).blink, 0);
  assert.equal(motion.update(4060).blink, 0.5);
  t = 8000;
  assert.equal(motion.update().blink, 0);
  assert.equal(motion.update(8060).blink, 0.5);
});

test('blink desabilitado devolve sempre 0 sem afetar o idle', () => {
  const events = [];
  let t = 1000;
  const motion = createAutoMotion({ blink: false, now: () => t, rng: () => 0, notify: event => events.push(event.kind) });
  assert.equal(motion.update(1000).blink, 0);
  assert.equal(motion.update(3000).blink, 0);
  assert.equal(motion.update(3120).blink, 0);
  assert.equal(events.includes('blink'), false);
  assert.equal(motion.update(31000).idleActive, true);
  assert.deepEqual(events, ['idleOn']);
});

test('idle liga após idleAfterMs, volta com notifyActivity e religa depois', () => {
  let t = 1000;
  const motion = createAutoMotion({ now: () => t, rng: () => 0 });
  assert.equal(motion.update(30999).idleActive, false);
  assert.equal(motion.update(31000).idleActive, true);
  t = 31010;
  motion.notifyActivity();
  assert.equal(motion.update(31100).idleActive, false);
  assert.equal(motion.update(61010).idleActive, true);
});

test('idle desabilitado nunca ativa sem afetar o blink', () => {
  const motion = createAutoMotion({ idle: false, now: () => 0, rng: () => 0 });
  assert.equal(motion.update(0).idleActive, false);
  assert.equal(motion.update(2000).blink, 0);
  assert.equal(motion.update(2060).blink, 0.5);
  assert.equal(motion.update(30000).idleActive, false);
  assert.equal(motion.update(100000).idleActive, false);
});

test('notify dispara em cada blink e nas transições de idle', () => {
  const events = [];
  let t = 0;
  const motion = createAutoMotion({
    now: () => t, rng: () => 0, blinkGapMinMs: 60000, blinkGapMaxMs: 60000,
    notify: event => events.push(event.kind),
  });
  motion.update(0);
  assert.deepEqual(events, []);
  motion.update(30000);
  assert.deepEqual(events, ['idleOn']);
  motion.update(60000);
  assert.deepEqual(events, ['idleOn', 'blink']);
  t = 61000;
  motion.notifyActivity();
  motion.update(61000);
  assert.deepEqual(events, ['idleOn', 'blink', 'idleOff']);
});
