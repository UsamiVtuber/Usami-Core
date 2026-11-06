import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  VRM_EMOTIONS,
  getVrmEmotionConfig,
  applyVrmEmotion,
} from '../src/vrm-emotion-map.js';
import { VALID_EMOTIONS } from '../src/emotion-resolver.js';

test('vrm-emotion-map: todas as 69 emoções válidas têm entrada no mapa', () => {
  for (const emotionKey of VALID_EMOTIONS) {
    const entry = VRM_EMOTIONS[emotionKey];
    assert.ok(entry, `Falta mapeamento VRM para a chave: ${emotionKey}`);
    assert.ok(typeof entry.eyesClosed === 'boolean');
    assert.ok(typeof entry.expressions === 'object');
    assert.ok(typeof entry.coarse === 'string');
  }
});

test('vrm-emotion-map: getVrmEmotionConfig resolve tags variadas', () => {
  const happyConfig = getVrmEmotionConfig('casual_happy');
  assert.equal(happyConfig.emotionKey, 'casual_happy');
  assert.equal(happyConfig.coarse, 'happy');
  assert.equal(happyConfig.expressions['02-prefab_happy02'], 1.0);
  assert.equal(happyConfig.eyesClosed, false);

  const laughingConfig = getVrmEmotionConfig('casual_laughing');
  assert.equal(laughingConfig.eyesClosed, true); // olhos fechados rindo

  const unknownConfig = getVrmEmotionConfig('chave_inexistente');
  assert.equal(unknownConfig.emotionKey, 'casual_neutral');
});

test('vrm-emotion-map: applyVrmEmotion interage corretamente com o expressionDriver', () => {
  const applied = [];
  let released = false;

  const fakeDriver = {
    releaseAll() {
      released = true;
    },
    set(name, weight, options) {
      applied.push({ name, weight, options });
      return true;
    },
  };

  const result = applyVrmEmotion('casual_happy', fakeDriver);
  assert.ok(result.applied);
  assert.ok(released, 'releaseAll deveria ter sido chamado para decair expressões antigas');
  assert.equal(applied.length, 1);
  assert.equal(applied[0].name, '02-prefab_happy02');
  assert.equal(applied[0].weight, 1.0);
});

test('vrm-emotion-map: applyVrmEmotion sem driver não lança erro', () => {
  const result = applyVrmEmotion('casual_happy', null);
  assert.equal(result.applied, false);
  assert.equal(result.emotionKey, 'casual_happy');
});
