import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveVoicePhase, levelFromSpectrum, smoothLevel } from '../src/voice-phase.js';

test('fora de chamada a fase é idle, mesmo com flags acesas', () => {
  assert.equal(deriveVoicePhase({ call: false, listening: true, speaking: true }).id, 'idle');
});

test('prioridade: erro > falando > pensando > ouvindo alguém > mic aberto', () => {
  const base = { call: true, listening: true };
  assert.equal(deriveVoicePhase(base).id, 'listening');
  assert.equal(deriveVoicePhase({ ...base, hearing: true }).id, 'hearing');
  assert.equal(deriveVoicePhase({ ...base, hearing: true, busy: true }).id, 'thinking');
  assert.equal(deriveVoicePhase({ ...base, hearing: true, busy: true, speaking: true }).id, 'speaking');
  assert.equal(deriveVoicePhase({ ...base, speaking: true, micError: true }).id, 'error');
});

test('chamada sem reconhecimento ativo fica idle', () => {
  assert.equal(deriveVoicePhase({ call: true }).id, 'idle');
});

test('levelFromSpectrum: silêncio 0, saturado 1, vazio 0', () => {
  assert.equal(levelFromSpectrum(new Uint8Array(8)), 0);
  assert.equal(levelFromSpectrum(new Uint8Array(8).fill(255)), 1);
  assert.equal(levelFromSpectrum(new Uint8Array(0)), 0);
  assert.equal(levelFromSpectrum(null), 0);
});

test('smoothLevel sobe mais rápido do que desce e respeita 0..1', () => {
  const up = smoothLevel(0, 1, 0.05);
  const down = 1 - smoothLevel(1, 0, 0.05);
  assert.ok(up > down);
  assert.ok(smoothLevel(0.5, 5, 1) <= 1);
  assert.ok(smoothLevel(0.5, -5, 1) >= 0);
  assert.equal(smoothLevel(0.4, 0.4, 0.1), 0.4);
  assert.equal(smoothLevel(NaN, NaN, NaN), 0);
});
