import test from 'node:test';
import assert from 'node:assert/strict';
import { createSpeechPace, SEED_MS_PER_CHAR, SPEECH_TAIL_MS, MIN_HOLD_MS, MAX_HOLD_MS, MIN_MS_PER_CHAR, MAX_MS_PER_CHAR } from '../src/speech-pace.js';

test('constantes exportadas', () => {
  assert.equal(SEED_MS_PER_CHAR, 127);
  assert.equal(SPEECH_TAIL_MS, 900);
  assert.equal(MIN_HOLD_MS, 4000);
  assert.equal(MAX_HOLD_MS, 20000);
});

test('balão curto fica no piso e balão comprido no teto; no meio cresce com o texto', () => {
  const pace = createSpeechPace();
  assert.equal(pace.holdMs(5), MIN_HOLD_MS);
  assert.equal(pace.holdMs(400), MAX_HOLD_MS);
  const mid = pace.holdMs(60);
  assert.ok(mid > MIN_HOLD_MS && mid < MAX_HOLD_MS);
  assert.ok(mid > pace.holdMs(40) && mid < pace.holdMs(80), 'monótono no tamanho');
  assert.ok(Math.abs(pace.holdMs(60) - (60 * SEED_MS_PER_CHAR + SPEECH_TAIL_MS)) < 1e-9);
});

test('texto vazio ou inválido devolve o piso, sem NaN', () => {
  const pace = createSpeechPace();
  for (const value of [0, -10, null, undefined, Number.NaN, 'x']) assert.equal(pace.holdMs(value), MIN_HOLD_MS);
});

test('observe aprende com a duração real e o próximo balão usa o ritmo novo', () => {
  const pace = createSpeechPace();
  const before = pace.holdMs(50);
  pace.observe(50, 50 * 40); // áudio rápido: 40 ms/char
  assert.ok(pace.holdMs(50) < before, 'aprendeu a fala mais rápida');
  pace.observe(50, 50 * 260); // e depois lenta demais
  assert.ok(pace.msPerChar <= MAX_MS_PER_CHAR, 'o teto de ritmo segura o outlier');
  assert.equal(pace.holdMs(50), Math.min(MAX_HOLD_MS, Math.max(MIN_HOLD_MS, 50 * pace.msPerChar + SPEECH_TAIL_MS)));
});

test('observe ignora medição sem sentido e não corrói o ritmo', () => {
  const pace = createSpeechPace();
  const rate = pace.msPerChar;
  for (const [chars, ms] of [[0, 1000], [-5, 1000], [null, 1000], [10, 0], [10, -3], [10, Number.NaN]]) pace.observe(chars, ms);
  assert.equal(pace.msPerChar, rate);
});

test('seed inválido cai no seed medido e a suavização é respeitada', () => {
  assert.equal(createSpeechPace({ msPerChar: 'abc' }).msPerChar, SEED_MS_PER_CHAR);
  assert.equal(createSpeechPace({ msPerChar: 1_000_000 }).msPerChar, MAX_MS_PER_CHAR);
  assert.equal(createSpeechPace({ msPerChar: 1 }).msPerChar, MIN_MS_PER_CHAR);
  const pace = createSpeechPace({ smoothing: 1 });
  pace.observe(10, 10 * 100);
  assert.equal(pace.msPerChar, 100, 'smoothing 1 adota a medição inteira');
});
