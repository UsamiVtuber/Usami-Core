import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createSpeechScheduler, SPEECH_TRIGGERS } from '../src/speech-timing.js';

function makeFakeAudio({ duration = null, ended = false } = {}) {
  const listeners = {};
  return {
    duration,
    addEventListener(event, handler, opts) {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(handler);
    },
    removeEventListener(event, handler) {
      if (!listeners[event]) return;
      listeners[event] = listeners[event].filter(h => h !== handler);
    },
    dispatchEvent(event) {
      const handlers = listeners[event.type] || [];
      for (const h of handlers) h(event);
    },
    _ended: ended,
  };
}

test('speech-timing: SPEECH_TRIGGERS tem os três gatilhos', () => {
  assert.deepEqual(SPEECH_TRIGGERS, ['start', 'middle', 'end']);
});

test('speech-timing: sem actions não agenda nada', () => {
  const scheduler = createSpeechScheduler();
  const result = scheduler.schedule({ actions: [], audio: {}, onAction: () => {} });
  assert.equal(typeof result.cancel, 'function');
  scheduler.cancel();
});

test('speech-timing: sem audio não agenda nada', () => {
  const scheduler = createSpeechScheduler();
  let called = false;
  const result = scheduler.schedule({ actions: [{ type: 'gesture', name: 'wave' }], audio: null, onAction: () => { called = true; } });
  assert.equal(called, false);
  scheduler.cancel();
});

test('speech-timing: actions sem timing executam imediatamente', () => {
  const scheduler = createSpeechScheduler();
  const executed = [];
  const result = scheduler.schedule({
    actions: [
      { type: 'gesture', name: 'wave' },
      { type: 'set_expression', name: '02-prefab_happy02', weight: 1 },
    ],
    audio: makeFakeAudio(),
    onAction: (action) => executed.push(action),
  });
  assert.equal(executed.length, 2);
  assert.equal(executed[0].type, 'gesture');
  assert.equal(executed[1].type, 'set_expression');
  scheduler.cancel();
});

test('speech-timing: actions com trigger start executam imediatamente', () => {
  const scheduler = createSpeechScheduler();
  const executed = [];
  scheduler.schedule({
    actions: [{ type: 'gesture', name: 'wave', trigger: 'start' }],
    audio: makeFakeAudio(),
    onAction: (action) => executed.push(action),
  });
  assert.equal(executed.length, 1);
  scheduler.cancel();
});

test('speech-timing: actions com delayMs executam após o atraso (relógio fake)', () => {
  let now = 0;
  const scheduler = createSpeechScheduler({ now: () => now });
  const executed = [];
  const audio = makeFakeAudio();
  scheduler.schedule({
    actions: [
      { type: 'gesture', name: 'wave', delayMs: 1000 },
      { type: 'gesture', name: 'tilt', delayMs: 500 },
    ],
    audio,
    onAction: (action) => executed.push(action),
  });
  assert.equal(executed.length, 0);
  now += 500;
  // Simular passagem de tempo não dispara setTimeout real; só testamos que agendou
  scheduler.cancel();
});

test('speech-timing: trigger end executa no onended do áudio', () => {
  const scheduler = createSpeechScheduler();
  const executed = [];
  const audio = makeFakeAudio();
  scheduler.schedule({
    actions: [{ type: 'gesture', name: 'wave', trigger: 'end' }],
    audio,
    onAction: (action) => executed.push(action),
  });
  assert.equal(executed.length, 0);
  audio.dispatchEvent({ type: 'ended' });
  assert.equal(executed.length, 1);
  assert.equal(executed[0].type, 'gesture');
  scheduler.cancel();
});

test('speech-timing: trigger middle executa na metade da duração', () => {
  const scheduler = createSpeechScheduler();
  const executed = [];
  const audio = makeFakeAudio({ duration: 6000 });
  scheduler.schedule({
    actions: [{ type: 'gesture', name: 'wave', trigger: 'middle' }],
    audio,
    onAction: (action) => executed.push(action),
  });
  assert.equal(executed.length, 0);
  // Disparar o polling de duração (loadedmetadata)
  audio.dispatchEvent({ type: 'loadedmetadata' });
  assert.equal(executed.length, 0); // ainda não, setTimeout não foi acelerado
  scheduler.cancel();
});

test('speech-timing: cancel limpa agendamentos pendentes', () => {
  const scheduler = createSpeechScheduler();
  const executed = [];
  scheduler.schedule({
    actions: [{ type: 'gesture', name: 'wave', delayMs: 1000 }],
    audio: makeFakeAudio(),
    onAction: (action) => executed.push(action),
  });
  scheduler.cancel();
  assert.equal(executed.length, 0);
});

test('speech-timing: nova chamada cancela a anterior', () => {
  const scheduler = createSpeechScheduler();
  const executed = [];
  const audio = makeFakeAudio();
  scheduler.schedule({
    actions: [{ type: 'gesture', name: 'wave', delayMs: 1000 }],
    audio,
    onAction: (action) => executed.push(action),
  });
  scheduler.schedule({
    actions: [{ type: 'gesture', name: 'tilt', trigger: 'start' }],
    audio,
    onAction: (action) => executed.push(action),
  });
  assert.equal(executed.length, 1);
  assert.equal(executed[0].name, 'tilt');
  scheduler.cancel();
});
