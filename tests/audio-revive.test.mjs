import test from 'node:test';
import assert from 'node:assert/strict';
import { createAudioRevive, REVIVE_EVENTS } from '../src/audio-revive.js';

function makeTarget() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener(name, fn) { listeners.set(name, [...(listeners.get(name) ?? []), fn]); },
    removeEventListener(name, fn) { listeners.set(name, (listeners.get(name) ?? []).filter(item => item !== fn)); },
    emit(name) { for (const fn of listeners.get(name) ?? []) fn(); },
    count(name) { return (listeners.get(name) ?? []).length; },
  };
}

function makeContext(state = 'suspended') {
  const events = makeTarget();
  const ctx = {
    state,
    resumeCalls: 0,
    addEventListener: events.addEventListener,
    removeEventListener: events.removeEventListener,
    fireState(next) { ctx.state = next; events.emit('statechange'); },
    resume() { ctx.resumeCalls += 1; ctx.state = 'running'; return Promise.resolve(); },
  };
  ctx.addEventListener = events.addEventListener.bind(events);
  ctx.removeEventListener = events.removeEventListener.bind(events);
  return ctx;
}

test('gesto cria o contexto (prime) e o retoma quando suspenso', () => {
  const target = makeTarget();
  const doc = makeTarget();
  let ctx = null;
  const revive = createAudioRevive({ target, doc, getContext: () => ctx, prime: () => { ctx = makeContext('suspended'); } });
  revive.attach();
  target.emit('pointerdown');
  assert.equal(ctx.resumeCalls, 1);
  assert.equal(revive.resumes, 1);
});

test('sem contexto o estado é none e nada lança', () => {
  const target = makeTarget();
  const revive = createAudioRevive({ target, doc: makeTarget(), getContext: () => null });
  revive.attach();
  assert.doesNotThrow(() => target.emit('keydown'));
  assert.equal(revive.state, 'none');
});

test('contexto já running não recebe resume', () => {
  const target = makeTarget();
  const ctx = makeContext('running');
  const revive = createAudioRevive({ target, doc: makeTarget(), getContext: () => ctx });
  revive.attach();
  target.emit('touchstart');
  assert.equal(ctx.resumeCalls, 0);
  assert.equal(revive.state, 'running');
});

test('statechange para suspended/interrupted retoma sem novo gesto', () => {
  const target = makeTarget();
  const ctx = makeContext('running');
  const seen = [];
  const revive = createAudioRevive({ target, doc: makeTarget(), getContext: () => ctx, onState: state => seen.push(state) });
  revive.attach();
  revive.revive();
  ctx.fireState('interrupted');
  assert.equal(ctx.resumeCalls, 1);
  assert.ok(seen.includes('interrupted'));
});

test('voltar à aba revive; aba oculta não', () => {
  const target = makeTarget();
  const doc = Object.assign(makeTarget(), { visibilityState: 'hidden' });
  const ctx = makeContext('suspended');
  const revive = createAudioRevive({ target, doc, getContext: () => ctx });
  revive.attach();
  doc.emit('visibilitychange');
  assert.equal(ctx.resumeCalls, 0);
  doc.visibilityState = 'visible';
  doc.emit('visibilitychange');
  assert.equal(ctx.resumeCalls, 1);
});

test('resume que rejeita ou lança não propaga', async () => {
  const target = makeTarget();
  const ctx = makeContext('suspended');
  ctx.resume = () => Promise.reject(new Error('recusado'));
  const revive = createAudioRevive({ target, doc: makeTarget(), getContext: () => ctx });
  revive.attach();
  assert.doesNotThrow(() => target.emit('pointerdown'));
  ctx.resume = () => { throw new Error('boom'); };
  assert.doesNotThrow(() => target.emit('pointerdown'));
  await new Promise(resolve => setImmediate(resolve));
});

test('detach remove todos os listeners e attach é idempotente', () => {
  const target = makeTarget();
  const doc = makeTarget();
  const ctx = makeContext('running');
  const revive = createAudioRevive({ target, doc, getContext: () => ctx });
  revive.attach();
  revive.attach();
  for (const name of REVIVE_EVENTS) assert.equal(target.count(name), 1);
  revive.revive();
  revive.detach();
  for (const name of REVIVE_EVENTS) assert.equal(target.count(name), 0);
  assert.equal(target.count('focus'), 0);
  assert.equal(doc.count('visibilitychange'), 0);
});
