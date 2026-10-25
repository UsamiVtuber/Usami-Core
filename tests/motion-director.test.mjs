import test from 'node:test';
import assert from 'node:assert/strict';
import { createMotionDirector } from '../src/motion-director.js';

const capabilities = {
  clips: [
    { name: 'Dance_Asset', boneTracks: 10, excludedTracks: 0 },
    { name: 'MainAction', boneTracks: 0, excludedTracks: 0 },
    { name: 'DEF-MainAction', boneTracks: 5, excludedTracks: 3 },
  ],
  morphs: ['smile', 'blink'],
  expressions: ['happy', 'sad'],
  meshes: [
    { name: 'Body', skinned: true },
    { name: 'Hat', skinned: false },
  ],
  customIdle: true,
  customWave: false,
};

function makeController({ failGesture = false } = {}) {
  const calls = [];
  let shown = {};
  return {
    calls,
    playClip: name => calls.push(['playClip', name]),
    gesture: () => (!failGesture && (calls.push(['gesture']), true)),
    idle: () => (!failGesture && (calls.push(['idle']), true)),
    wave: () => (!failGesture && (calls.push(['wave']), true)),
    setMorph: (name, value) => { shown[name] = value; calls.push(['setMorph', name, value]); },
    setExpression: (name, weight) => { calls.push(['setExpression', name, weight]); return true; },
    setMeshVisible: (name, visible) => { shown[name] = visible; calls.push(['setMeshVisible', name, visible]); },
    shown,
  };
}

const now = () => 1000;

function makeDirector(extra = {}) {
  return createMotionDirector({ controller: null, capabilities: {}, ...extra });
}

test('coleção de ações válidas passa e inválidas são rejeitadas', () => {
  const controller = makeController();
  let clock = 1000;
  const director = createMotionDirector({ controller, capabilities, now: () => clock });
  const first = director.execute([
    { type: 'play_clip', name: 'Dance_Asset' },
    { type: 'set_morph', name: 'smile', value: 0.5 },
    { type: 'set_morph', name: 'desconhecido', value: 0.5 },
    { type: 'set_morph', name: 'smile', value: 7 },
    { type: 'play_clip', name: 'MainAction' },
    { type: 'play_clip', name: 'DEF-MainAction' },
    { type: 'atalho' },
  ]);
  assert.deepEqual(controller.calls, [['playClip', 'Dance_Asset'], ['setMorph', 'smile', 0.5], ['setMorph', 'smile', 1]]);
  assert.ok(first.results.every(result => result.reason !== 'clip not playable (tracks)'));
  clock += 10000;
  assert.equal(director.execute([{ type: 'play_clip', name: 'MainAction' }]).results[0].reason, 'clip not playable (tracks)');
  clock += 10000;
  assert.equal(director.execute([{ type: 'play_clip', name: 'DEF-MainAction' }]).results[0].reason, 'clip not playable (tracks)');
  clock += 10000;
  assert.equal(director.execute([{ type: 'play_clip', name: 'Inexistente' }]).results[0].reason, 'not in catalog');
  assert.ok(director.execute([{ type: 'atalho' }]).results.some(result => result.reason === 'not in catalog' && result.type === 'atalho'));
});

test('cooldowns e limites por escalada', () => {
  const controller = makeController();
  let clock = 1000;
  const director = createMotionDirector({ controller, capabilities, now: () => clock, cooldowns: { play_clip: 100, gesture: 200, set_mesh_visible: 50 } });
  director.execute([{ type: 'play_clip', name: 'Dance_Asset' }]);
  clock = 1050;
  const second = director.execute([{ type: 'play_clip', name: 'Dance_Asset' }]);
  assert.equal(second.results[0].applied, false);
  assert.equal(second.results[0].reason, 'cooldown');
  clock = 1200;
  const third = director.execute([{ type: 'play_clip', name: 'Dance_Asset' }]);
  assert.equal(third.results[0].applied, true);
});

test('gestos dependem do catálogo e da disponibilidade do modelo', () => {
  const controller = makeController();
  let clock = 1000;
  const director = createMotionDirector({ controller, capabilities, now: () => clock });
  const first = director.execute([{ type: 'gesture', name: 'idle' }, { type: 'gesture', name: 'wave' }]);
  assert.deepEqual(controller.calls, [['idle']]);
  assert.equal(first.results[0].applied, true);
  assert.equal(first.results[1].reason, 'cooldown');
  clock += 10000;
  const second = director.execute([{ type: 'gesture', name: 'wave' }]);
  assert.deepEqual(controller.calls, [['idle']]);
  assert.equal(second.results[0].reason, 'gesture unavailable on this model');
  clock += 10000;
  const third = director.execute([{ type: 'gesture', name: 'desconhecido' }]);
  assert.equal(third.results[0].reason, 'gesture unavailable on this model');
});

test('gesto indisponível no modelo sem idle', () => {
  const controller = makeController();
  const director = createMotionDirector({ controller, capabilities: { ...capabilities, customIdle: false }, now, cooldowns: { play_clip: 0, gesture: 0, set_mesh_visible: 0 } });
  const result = director.execute([{ type: 'gesture', name: 'idle' }]).results[0];
  assert.deepEqual(controller.calls, []);
  assert.equal(result.applied, false);
  assert.equal(result.reason, 'gesture unavailable on this model');
});

test('tilt indisponível quando customTilt é false', () => {
  const controller = makeController();
  const director = createMotionDirector({ controller, capabilities: { ...capabilities, customTilt: false }, cooldowns: { play_clip: 0, gesture: 0, set_mesh_visible: 0, set_expression: 0 } });
  const result = director.execute([{ type: 'gesture', name: 'tilt' }]).results[0];
  assert.deepEqual(controller.calls, []);
  assert.equal(result.applied, false);
  assert.equal(result.reason, 'gesture unavailable on this model');
});

test('gestos da biblioteca: só passam os que o manifesto lista', () => {
  const controller = makeController();
  const director = createMotionDirector({ controller, capabilities: { ...capabilities, gestures: ['clap', 'bow'] }, now, cooldowns: { gesture: 0 } });
  const applied = director.execute([{ type: 'gesture', name: 'clap' }]).results[0];
  assert.deepEqual(controller.calls, [['gesture']], 'a biblioteca é chamada pelo dispatcher');
  assert.equal(applied.applied, true);
  assert.equal(director.execute([{ type: 'gesture', name: 'facepalm' }]).results[0].reason, 'gesture unavailable on this model', 'fora da lista do modelo');
  assert.equal(director.execute([{ type: 'gesture', name: 'dancinha' }]).results[0].reason, 'gesture unavailable on this model', 'nem é gesto conhecido');
  assert.deepEqual(controller.calls, [['gesture']], 'recusas não chegam ao controller');
});

test('meshes só acessório e com cooldown próprio', () => {
  const controller = makeController();
  let clock = 1000;
  const director = createMotionDirector({ controller, capabilities, now: () => clock });
  const first = director.execute([{ type: 'set_mesh_visible', name: 'Hat', visible: false }, { type: 'set_mesh_visible', name: 'Body', visible: false }]);
  assert.deepEqual(controller.calls, [['setMeshVisible', 'Hat', false]]);
  assert.equal(first.results[1].applied, false);
  clock = 6000;
  controller.calls.length = 0;
  director.execute([{ type: 'set_mesh_visible', name: 'Hat' }]);
  assert.deepEqual(controller.calls, [['setMeshVisible', 'Hat', true]]);
});

test('limite de ações por turno e chamadas brutas aceitas', () => {
  const controller = makeController();
  const director = createMotionDirector({ controller, capabilities, now, maxActions: 2 });
  const payload = { actions: [{ type: 'set_morph', name: 'smile', value: 1 }, { type: 'set_morph', name: 'blink', value: 1 }, { type: 'set_morph', name: 'smile', value: 0 }] };
  const { results, overflow } = director.execute(payload);
  assert.deepEqual(controller.calls.slice(0, 2), [['setMorph', 'smile', 1], ['setMorph', 'blink', 1]]);
  assert.equal(overflow, 1);
  assert.equal(results.length, 2);
});

test('set_expression applies catalog expressions with clamped weight', () => {
  const controller = makeController();
  let clock = 1000;
  const director = createMotionDirector({ controller, capabilities, now: () => clock });
  const first = director.execute([{ type: 'set_expression', name: 'happy' }]);
  assert.deepEqual(controller.calls, [['setExpression', 'happy', 1]]);
  assert.equal(first.results[0].applied, true);
  clock += 4000;
  const second = director.execute([{ type: 'set_expression', name: 'happy', weight: 2 }]);
  assert.deepEqual(controller.calls[1], ['setExpression', 'happy', 1]);
  assert.equal(second.results[0].applied, true);
  clock += 4000;
  const third = director.execute([{ type: 'set_expression', name: 'sad', weight: 'abc' }]);
  assert.equal(third.results[0].applied, false);
  assert.equal(third.results[0].reason, 'bad value');
  clock += 4000;
  const fourth = director.execute([{ type: 'set_expression', name: 'angry' }]);
  assert.equal(fourth.results[0].applied, false);
  assert.equal(fourth.results[0].reason, 'not in catalog');
});

test('set_expression is refused when the controller lacks setExpression', () => {
  const director = createMotionDirector({ controller: { gesture: () => true }, capabilities, now });
  const result = director.execute([{ type: 'set_expression', name: 'happy' }]).results[0];
  assert.equal(result.applied, false);
  assert.equal(result.reason, 'model refused');
});

test('set_expression honors the default cooldown', () => {
  const controller = makeController();
  let clock = 1000;
  const director = createMotionDirector({ controller, capabilities, now: () => clock });
  const first = director.execute([{ type: 'set_expression', name: 'happy' }]);
  assert.equal(first.results[0].applied, true);
  clock = 1500;
  const second = director.execute([{ type: 'set_expression', name: 'sad' }]);
  assert.equal(second.results[0].applied, false);
  assert.equal(second.results[0].reason, 'cooldown');
});
