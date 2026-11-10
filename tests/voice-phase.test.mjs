import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createUtteranceDeduper,
  deriveVoicePhase,
  levelFromSpectrum,
  normalizeUtteranceKey,
  smoothLevel,
} from '../src/voice-phase.js';

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

test('createUtteranceDeduper descarta transcrição idêntica dentro de 5s e permite após a janela (OpenAmika commit-once)', () => {
  let clock = 1000;
  const deduper = createUtteranceDeduper({ windowMs: 5000, now: () => clock });

  assert.equal(normalizeUtteranceKey('Olá, tudo bem?!'), 'olátudobem');
  assert.equal(deduper.shouldCommit('Olá, tudo bem?!'), true);

  // 3s depois, mesma frase sem pontuação -> descartada
  clock += 3000;
  assert.equal(deduper.shouldCommit('olá tudo bem'), false);

  // Frase diferente -> permitida imediatamente
  assert.equal(deduper.shouldCommit('Sim, por favor.'), true);

  // 6s depois -> permitida novamente
  clock += 6000;
  assert.equal(deduper.shouldCommit('Sim, por favor.'), true);
});
