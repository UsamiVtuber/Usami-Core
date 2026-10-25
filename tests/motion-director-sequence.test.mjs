import test from 'node:test';
import assert from 'node:assert/strict';
import { createMotionDirector, SHAPE_NAMES, DIRECTOR_VERBS } from '../src/motion-director.js';

const baseCapabilities = {
  clips: [], morphs: [], expressions: [], meshes: [],
  customIdle: true, customWave: true, customTilt: true, gestures: [],
};

function makeController({ refuse = false } = {}) {
  const calls = [];
  return {
    calls,
    playSequence: request => { calls.push(request); return !refuse; },
    gesture: () => true,
    playClip: () => true,
    setMorph: () => true,
    setExpression: () => true,
    setMeshVisible: () => true,
  };
};

const seqAction = (overrides = {}) => ({ type: 'play_sequence', shape: 'wave-arm', ...overrides });

test('play_sequence está no vocabulário do director', () => {
  assert.ok(DIRECTOR_VERBS.includes('play_sequence'));
  assert.ok(SHAPE_NAMES.length >= 6);
});

test('modelo com sequences:true roteia o pedido completo ao controller', () => {
  const controller = makeController();
  const director = createMotionDirector({ controller, capabilities: { ...baseCapabilities, sequences: true } });
  const result = director.execute([seqAction({ amplitude: 0.3, cycles: 3, side: 'left', name: 'aceno-x' })]);
  assert.equal(result.results[0].applied, true);
  assert.deepEqual(controller.calls[0], {
    name: 'aceno-x', shape: 'wave-arm', side: 'left', amplitude: 0.3, cycles: 3, durationMs: undefined,
  });
});

test('modelo sem sequences recusa antes de tocar no controller', () => {
  const controller = makeController();
  const director = createMotionDirector({ controller, capabilities: baseCapabilities });
  const result = director.execute([seqAction()]);
  assert.equal(result.results[0].applied, false);
  assert.equal(result.results[0].reason, 'sequences unavailable on this model');
  assert.equal(controller.calls.length, 0);
});

test('shape fora do vocabulário é rejeitada (não é sugestão)', () => {
  const controller = makeController();
  const director = createMotionDirector({ controller, capabilities: { ...baseCapabilities, sequences: true } });
  for (const shape of ['moonwalk', 'spin-360', '', null, 42]) {
    const result = director.execute([seqAction({ shape })]);
    assert.equal(result.results[0].applied, false, `shape ${JSON.stringify(shape)} deveria recusar`);
    assert.equal(result.results[0].reason, 'shape unknown');
  }
  assert.equal(controller.calls.length, 0);
});

test('controller que recusa devolve reason model refused', () => {
  const controller = makeController({ refuse: true });
  const director = createMotionDirector({ controller, capabilities: { ...baseCapabilities, sequences: true } });
  const result = director.execute([seqAction()]);
  assert.equal(result.results[0].applied, false);
  assert.equal(result.results[0].reason, 'model refused');
});

test('cooldown separa sequências de gestos: dois play_sequence seguidos no cooldown, o segundo não', () => {
  let clock = 0;
  const controller = makeController();
  const director = createMotionDirector({
    controller,
    capabilities: { ...baseCapabilities, sequences: true },
    cooldowns: { play_sequence: 4000 },
    now: () => clock,
  });
  assert.equal(director.execute([seqAction()]).results[0].applied, true);
  clock = 1000;
  const second = director.execute([seqAction({ shape: 'nod' })]);
  assert.equal(second.results[0].applied, false);
  assert.equal(second.results[0].reason, 'cooldown');
  clock = 4500;
  assert.equal(director.execute([seqAction({ shape: 'nod' })]).results[0].applied, true);
});

test('sequência não consome o cooldown dos gestos nem vice-versa', () => {
  let clock = 0;
  const controller = makeController();
  const director = createMotionDirector({
    controller,
    capabilities: { ...baseCapabilities, sequences: true, gestures: ['clap'] },
    cooldowns: { gesture: 2500, play_sequence: 4000 },
    now: () => clock,
  });
  assert.equal(director.execute([seqAction()]).results[0].applied, true);
  clock = 500;
  assert.equal(director.execute([{ type: 'gesture', name: 'clap' }]).results[0].applied, true);
});

test('limite de ações por turno também vale para sequências', () => {
  const controller = makeController();
  const director = createMotionDirector({
    controller,
    capabilities: { ...baseCapabilities, sequences: true },
    maxActions: 2,
    cooldowns: { play_sequence: 0 },
  });
  const result = director.execute([seqAction(), seqAction({ shape: 'nod' }), seqAction({ shape: 'reach' })]);
  assert.equal(result.results.length, 2);
  assert.equal(result.overflow, 1);
  assert.equal(controller.calls.length, 2);
});
