import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveReplyEmotion } from '../src/reply-emotion.js';

const HAPPY_REPLY = 'Haha, que bom te ver! 😊'; // confidence 0.85
const CAP_REPLY = 'Que bom! haha 😊 🎉 😄';      // confidence 0.95 (teto)
const PLAIN_REPLY = 'ok, então combinamos assim'; // confidence 0

const makeEngine = () => {
  const calls = [];
  return { calls, engine: { apply: payload => calls.push(payload) } };
};

test('confiança alta aplica o engine e remove set_expression das actions', () => {
  const { calls, engine } = makeEngine();
  const actions = [{ type: 'set_expression', name: '01-prefab_happy04', weight: 1 }, { type: 'gesture', name: 'wave' }];
  const result = resolveReplyEmotion({ reply: HAPPY_REPLY, actions, engine });
  assert.equal(result.applied, true);
  assert.equal(result.emotion.label, 'happy');
  assert.deepEqual(result.actions, [{ type: 'gesture', name: 'wave' }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].label, 'happy');
  assert.equal(calls[0].intensity, result.emotion.intensity);
  assert.equal(calls[0].durationMs, 4500);
});

test('confiança baixa mantém as actions intactas e não toca no engine', () => {
  const { calls, engine } = makeEngine();
  const actions = [{ type: 'set_expression', name: '19-prefab_doubt' }, { type: 'play_clip', name: 'Dance_Asset' }];
  const result = resolveReplyEmotion({ reply: PLAIN_REPLY, actions, engine });
  assert.equal(result.applied, false);
  assert.equal(result.actions, actions);
  assert.equal(calls.length, 0);
});

test('engine ausente não causa crash e preserva as actions', () => {
  const actions = [{ type: 'set_expression', name: 'blink' }];
  const nulled = resolveReplyEmotion({ reply: HAPPY_REPLY, actions, engine: null });
  assert.equal(nulled.applied, false);
  assert.equal(nulled.actions, actions);
  const omitted = resolveReplyEmotion({ reply: HAPPY_REPLY, actions });
  assert.equal(omitted.applied, false);
  assert.equal(omitted.actions, actions);
});

test('sem set_expression nas actions nada é removido, mas a emoção é aplicada', () => {
  const { calls, engine } = makeEngine();
  const actions = [{ type: 'gesture', name: 'wave' }];
  const result = resolveReplyEmotion({ reply: HAPPY_REPLY, actions, engine });
  assert.equal(result.applied, true);
  assert.equal(result.actions, actions);
  assert.equal(calls.length, 1);
});

test('threshold custom 0.95 exige confiança no teto', () => {
  const { calls, engine } = makeEngine();
  const below = resolveReplyEmotion({ reply: HAPPY_REPLY, actions: [], engine, threshold: 0.95 });
  assert.equal(below.applied, false); // 0.85 < 0.95
  assert.equal(calls.length, 0);
  const ceiling = resolveReplyEmotion({ reply: CAP_REPLY, actions: [], engine, threshold: 0.95 });
  assert.equal(ceiling.applied, true); // 0.95 >= 0.95
  assert.equal(calls.length, 1);
});
