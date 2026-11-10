import test from 'node:test';
import assert from 'node:assert/strict';
import { VALID_EMOTIONS } from '../src/emotion-resolver.js';
import {
  EMOTION_PROSODY,
  REGISTER_PROSODY,
  STYLE_INSTRUCTIONS,
  isKnownEmotionStyle,
  resolveGeminiStyleClause,
} from '../src/tts-prosody.js';
import {
  DEFAULT_PAUSE_MS,
  PAUSE_TABLE_MS,
  getEmotionPauseMs,
  pauseAfterSeconds,
} from '../src/tts-pause.js';
import { buildGeminiInstruction } from '../server.mjs';

test('tts-prosody: preserva 100% das chaves legadas V1', () => {
  const legacyKeys = [
    'happy', 'sad', 'angry', 'surprised', 'relaxed', 'whisper',
    'soft', 'shy', 'doubtful', 'clingy', 'pout', 'hype', 'tsundere',
  ];
  for (const key of legacyKeys) {
    const clause = resolveGeminiStyleClause(key);
    assert.ok(clause.length > 0, `chave legada ${key} deve ter cláusula`);
    assert.equal(clause, STYLE_INSTRUCTIONS[key]);
    assert.ok(!clause.includes('envergonhada'), `chave ${key} nunca pode conter "envergonhada"`);
  }
});

test('tts-prosody: neutral, casual_neutral e rótulos desconhecidos devolvem cláusula vazia', () => {
  assert.equal(resolveGeminiStyleClause(''), '');
  assert.equal(resolveGeminiStyleClause(null), '');
  assert.equal(resolveGeminiStyleClause('neutral'), '');
  assert.equal(resolveGeminiStyleClause('casual_neutral'), '');
  assert.equal(resolveGeminiStyleClause('estranho-x'), '');
  assert.equal(resolveGeminiStyleClause('modo-inexistente-99'), '');
  assert.equal(isKnownEmotionStyle('estranho-x'), false);
});

test('tts-prosody: cobre todas as 69 emoções canônicas V2 com nuance de registro + emoção', () => {
  assert.equal(VALID_EMOTIONS.size, 69);
  for (const key of VALID_EMOTIONS) {
    assert.equal(isKnownEmotionStyle(key), true, `${key} deve ser reconhecida`);
    const clause = resolveGeminiStyleClause(key);
    assert.ok(!clause.includes('envergonhada'), `${key} não pode usar a palavra "envergonhada"`);
    if (key === 'casual_neutral') {
      assert.equal(clause, '');
    } else {
      assert.ok(clause.length > 0, `${key} deveria produzir cláusula prosódica não-vazia`);
    }
  }

  // Registro íntimo + shy combina nuance de registro e emoção
  const intimateShy = resolveGeminiStyleClause('intimate_shy');
  assert.ok(intimateShy.includes(REGISTER_PROSODY.intimate));
  assert.ok(intimateShy.includes(EMOTION_PROSODY.shy));

  // Registro whisper + sleepy combina sussurro + sono
  const whisperSleepy = resolveGeminiStyleClause('whisper_sleepy');
  assert.ok(whisperSleepy.includes(REGISTER_PROSODY.whisper));
  assert.ok(whisperSleepy.includes(EMOTION_PROSODY.sleepy));

  // Registro polite + caring combina educação + acolhimento
  const politeCaring = resolveGeminiStyleClause('polite_caring');
  assert.ok(politeCaring.includes(REGISTER_PROSODY.polite));
  assert.ok(politeCaring.includes(EMOTION_PROSODY.caring));

  // buildGeminiInstruction integra registro + emoção dentro dos colchetes [...]
  const tag = buildGeminiInstruction('[em português do Brasil, voz aguda]', 'intimate_shy');
  assert.match(tag, /^\[em português do Brasil, voz aguda, .*com vergonha\] $/);
});

test('tts-pause: cobre todas as 69 emoções V2 e modula pausas por energia e modo quiet', () => {
  for (const key of VALID_EMOTIONS) {
    assert.ok(Object.hasOwn(PAUSE_TABLE_MS, key), `PAUSE_TABLE_MS precisa conter ${key}`);
    const ms = getEmotionPauseMs(key);
    assert.ok(ms >= 100 && ms <= 450, `${key} fora da faixa esperada: ${ms}ms`);
  }

  // Emoções rápidas/eufóricas têm pausa menor que neutra, e tristes/sussurradas têm pausa maior
  assert.ok(getEmotionPauseMs('casual_laughing') < getEmotionPauseMs('casual_neutral'));
  assert.ok(getEmotionPauseMs('casual_very_happy') < getEmotionPauseMs('casual_neutral'));
  assert.ok(getEmotionPauseMs('intimate_shy') > getEmotionPauseMs('casual_neutral'));
  assert.ok(getEmotionPauseMs('whisper_sleepy') > getEmotionPauseMs('intimate_shy'));

  // Modo quiet alonga a pausa em 25% (até teto de 600ms)
  assert.equal(getEmotionPauseMs('casual_neutral', { quiet: false }), 200);
  assert.equal(getEmotionPauseMs('casual_neutral', { quiet: true }), 250);
  assert.equal(pauseAfterSeconds('whisper_sleepy'), 0.45);

  // Fallback seguro para chave desconhecida
  assert.equal(getEmotionPauseMs('desconhecido_xyz'), DEFAULT_PAUSE_MS);
  assert.equal(getEmotionPauseMs(null), DEFAULT_PAUSE_MS);
});

