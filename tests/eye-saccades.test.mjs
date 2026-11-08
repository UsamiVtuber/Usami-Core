import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEyeSaccades } from '../src/eye-saccades.js';

test('createEyeSaccades inicializa com offsets zerados no centro', () => {
  let t = 1000;
  const saccades = createEyeSaccades({
    now: () => t,
    rng: () => 0.5,
  });

  const state = saccades.update(0.016);
  assert.equal(state.isThinkingGaze, false);
  // No início, lerp suave partindo de 0
  assert.ok(Math.abs(state.x) < 0.05);
  assert.ok(Math.abs(state.y) < 0.05);
});

test('saccades desviam o olhar após o intervalo de disparo', () => {
  let t = 1000;
  // minIntervalMs = 1500, com rng = 0 o primeiro disparo é em t = 2500
  const saccades = createEyeSaccades({
    now: () => t,
    rng: () => 0,
    minIntervalMs: 1500,
    maxIntervalMs: 3000,
  });

  // Antes do intervalo: próximo de zero
  saccades.update(0.016);
  t = 2400;
  const before = saccades.update(0.016);
  assert.ok(Math.abs(before.x) < 0.01);

  // Passou de 2500ms: sacada engatada
  t = 2600;
  for (let i = 0; i < 10; i++) {
    t += 16;
    saccades.update(0.016);
  }
  const during = saccades.update(0.016);
  // Deve ter se movido do centro
  assert.ok(Math.abs(during.x) > 0.01 || Math.abs(during.y) > 0.01);
});

test('isThinking direciona o olhar para cima e para o lado (olhar cognitivo)', () => {
  let t = 1000;
  const saccades = createEyeSaccades({
    now: () => t,
    rng: () => 0.8, // thinkSide = 1
  });

  // Simula frames enquanto pensa
  for (let i = 0; i < 20; i++) {
    t += 16;
    saccades.update(0.016, { isThinking: true });
  }

  const thinkingState = saccades.update(0.016, { isThinking: true });
  assert.equal(thinkingState.isThinkingGaze, true);
  // Olhar para cima (y positivo) e para o lado (x != 0)
  assert.ok(thinkingState.y > 0.05, `Esperado y > 0.05, recebido ${thinkingState.y}`);
  assert.ok(Math.abs(thinkingState.x) > 0.05, `Esperado |x| > 0.05, recebido ${thinkingState.x}`);

  // Quando para de pensar, deve relaxar de volta para o centro
  for (let i = 0; i < 40; i++) {
    t += 16;
    saccades.update(0.016, { isThinking: false });
  }
  const relaxedState = saccades.update(0.016, { isThinking: false });
  assert.equal(relaxedState.isThinkingGaze, false);
  assert.ok(Math.abs(relaxedState.x) < Math.abs(thinkingState.x));
});

test('isListening mantém o olhar firme no centro para o usuário', () => {
  let t = 1000;
  const saccades = createEyeSaccades({
    now: () => t,
    rng: () => 0.1,
  });

  const listeningState = saccades.update(0.016, { isListening: true });
  assert.equal(listeningState.isListeningGaze, true);
  assert.ok(Math.abs(listeningState.x) < 0.01);
  assert.ok(Math.abs(listeningState.y) < 0.01);
});

test('reset devolve os offsets para o centro', () => {
  let t = 1000;
  const saccades = createEyeSaccades({ now: () => t, rng: () => 0.5 });
  saccades.update(0.016, { isThinking: true });
  saccades.reset();
  const state = saccades.getState();
  assert.equal(state.currentX, 0);
  assert.equal(state.currentY, 0);
  assert.equal(state.targetX, 0);
  assert.equal(state.targetY, 0);
});
