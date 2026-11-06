import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REGISTERS,
  EMOTION_SETS,
  VALID_EMOTIONS,
  DEFAULT_EMOTION,
  resolveEmotion,
  normalizeEmotionTag,
} from '../src/emotion-resolver.js';

test('emotion-resolver: estrutura básica de registros e emoções', () => {
  assert.equal(REGISTERS.length, 5);
  assert.ok(REGISTERS.includes('polite'));
  assert.ok(REGISTERS.includes('casual'));
  assert.ok(REGISTERS.includes('serious'));
  assert.ok(REGISTERS.includes('intimate'));
  assert.ok(REGISTERS.includes('whisper'));

  assert.equal(VALID_EMOTIONS.size, 69);
  assert.ok(VALID_EMOTIONS.has('casual_neutral'));
  assert.ok(VALID_EMOTIONS.has('casual_happy'));
  assert.ok(VALID_EMOTIONS.has('intimate_shy'));
  assert.ok(VALID_EMOTIONS.has('whisper_caring'));
  assert.ok(VALID_EMOTIONS.has('serious_cold'));
});

test('emotion-resolver: normalizeEmotionTag lida com formatações livres', () => {
  assert.equal(normalizeEmotionTag('[casual_happy]'), 'casual_happy');
  assert.equal(normalizeEmotionTag('【casual-happy】'), 'casual_happy');
  assert.equal(normalizeEmotionTag('Casual Happy'), 'casual_happy');
  assert.equal(normalizeEmotionTag('casual_shy 0.4'), 'casual_shy');
  assert.equal(normalizeEmotionTag('intimate/caring'), 'intimate_caring');
  assert.equal(normalizeEmotionTag(''), '');
  assert.equal(normalizeEmotionTag(null), '');
});

test('emotion-resolver: resolveEmotion acerta tags canônicas', () => {
  assert.equal(resolveEmotion('casual_happy'), 'casual_happy');
  assert.equal(resolveEmotion('intimate_shy'), 'intimate_shy');
  assert.equal(resolveEmotion('polite_smile'), 'polite_smile');
  assert.equal(resolveEmotion('serious_cold'), 'serious_cold');
  assert.equal(resolveEmotion('whisper_caring'), 'whisper_caring');
});

test('emotion-resolver: resolveEmotion sem registro infere casual', () => {
  assert.equal(resolveEmotion('happy'), 'casual_happy');
  assert.equal(resolveEmotion('smile'), 'casual_smile');
  assert.equal(resolveEmotion('shy'), 'casual_shy');
  assert.equal(resolveEmotion('angry'), 'casual_angry');
});

test('emotion-resolver: resolveEmotion traduz aliases e sinônimos comuns', () => {
  assert.equal(resolveEmotion('curious'), 'casual_smile');
  assert.equal(resolveEmotion('polite_curious'), 'polite_smile');
  assert.equal(resolveEmotion('casual_excited'), 'casual_very_happy');
  assert.equal(resolveEmotion('pout'), 'casual_frustrated');
  assert.equal(resolveEmotion('giggle'), 'casual_laughing');
  assert.equal(resolveEmotion('formal_happy'), 'polite_happy');
  assert.equal(resolveEmotion('quiet_caring'), 'whisper_caring');
});

test('emotion-resolver: resolveEmotion preserva o registro com fallback intra-registro', () => {
  // polite não tem very_happy nem laughing -> cai em happy
  assert.equal(resolveEmotion('polite_laughing'), 'polite_happy');
  assert.equal(resolveEmotion('polite_very_happy'), 'polite_happy');
  // casual não tem cold -> cai em frustrated
  assert.equal(resolveEmotion('casual_cold'), 'casual_frustrated');
  // whisper não tem angry -> cai em worried
  assert.equal(resolveEmotion('whisper_angry'), 'whisper_worried');
  // Se for algo totalmente desconhecido, decai para o neutral do mesmo registro
  assert.equal(resolveEmotion('intimate_totalmente_inventado'), 'intimate_neutral');
  assert.equal(resolveEmotion('polite_abobrinha'), 'polite_neutral');
});

test('emotion-resolver: entradas vazias caem no DEFAULT_EMOTION', () => {
  assert.equal(resolveEmotion(''), DEFAULT_EMOTION);
  assert.equal(resolveEmotion(null), DEFAULT_EMOTION);
  assert.equal(resolveEmotion(undefined), DEFAULT_EMOTION);
  assert.equal(resolveEmotion('   '), DEFAULT_EMOTION);
});
