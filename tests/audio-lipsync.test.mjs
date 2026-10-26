import test from 'node:test';
import assert from 'node:assert/strict';
import { createAudioLipSync, ATTACK_TAU_MS, RELEASE_TAU_MS } from '../src/audio-lipsync.js';

// Harness no idioma dos testes locais: Web Audio falso injetável + relógio fake.
const VISEME_NAMES = ['a', 'I', 'u', 'e', 'o'];

function makeMorphTargets(extra = []) {
  return [...VISEME_NAMES, ...extra].map(name => ({ name, object: { morphTargetInfluences: [0, 0] }, index: 1 }));
}

const valuesOf = targets => targets.map(m => m.object.morphTargetInfluences[m.index]);

function makeAudioElement({ readyState = 2, paused = false, src = 'blob:usami-tts' } = {}) {
  const element = {
    src,
    readyState,
    paused,
    ended: false,
    plays: 0,
    play() { element.plays += 1; element.paused = false; return Promise.resolve(); },
  };
  return element;
}

function makeWebAudio({ data = new Uint8Array(128), sourceThrows = false, withAnalyserConnect = true, state = 'running' } = {}) {
  const calls = { sources: 0, analysers: 0, closes: 0, sourceDisconnects: 0, resumes: 0 };
  const analyser = {
    fftSize: 0,
    smoothingTimeConstant: 0,
    frequencyBinCount: 128,
    connect() {},
    disconnect() {},
    getByteFrequencyData(arr) { arr.set(data); },
  };
  if (!withAnalyserConnect) delete analyser.connect;
  const ctx = {
    destination: {},
    state,
    createMediaElementSource() {
      calls.sources += 1;
      if (sourceThrows) throw new Error('media element indisponível');
      return { connect() {}, disconnect() { calls.sourceDisconnects += 1; } };
    },
    createAnalyser() { calls.analysers += 1; return analyser; },
    close() { calls.closes += 1; },
    resume() {
      calls.resumes += 1;
      if (resumeThrows) throw new Error('resume indisponível');
      ctx.state = 'running';
    },
  };
  // `new Ctor()` precisa de função construtora — arrow não é constructível.
  const Ctor = function () { return ctx; };
  return { ctx, analyser, calls, data, Ctor };
}

function makeClock(start = 0) {
  let t = start;
  return { now: () => t, advance: ms => { t += ms; } };
}

function makeSpeakingLayer({ data = new Uint8Array(128).fill(255), targets = makeMorphTargets(), withAnalyserConnect = true } = {}) {
  const web = makeWebAudio({ data, withAnalyserConnect });
  const clock = makeClock();
  const element = makeAudioElement();
  const layer = createAudioLipSync({ audioElement: element, morphTargets: targets, now: clock.now, AudioContextCtor: web.Ctor });
  return { web, clock, element, layer, targets, data };
}

const setGlobal = (name, value) => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, name);
  if (value === undefined) delete globalThis[name];
  else globalThis[name] = value;
  return () => {
    if (saved === undefined) delete globalThis[name];
    else Object.defineProperty(globalThis, name, saved);
  };
};

test('constantes exportadas (rampa 30/80 ms)', () => {
  assert.equal(ATTACK_TAU_MS, 30);
  assert.equal(RELEASE_TAU_MS, 80);
});

test('sem audioElement ou com readyState < 2 não quebra, não cria contexto e a boca fica fechada', () => {
  const targets = makeMorphTargets();
  const web = makeWebAudio();
  const empty = createAudioLipSync({ morphTargets: targets, AudioContextCtor: web.Ctor });
  empty.update();
  assert.deepEqual(valuesOf(targets), [0, 0, 0, 0, 0]);

  const element = makeAudioElement({ readyState: 0 });
  const waiting = createAudioLipSync({
    audioElement: element,
    morphTargets: targets,
    AudioContextCtor: function () { throw new Error('não deve criar contexto antes do áudio estar pronto'); },
  });
  waiting.update();
  assert.deepEqual(valuesOf(targets), [0, 0, 0, 0, 0]);
  assert.equal(web.calls.sources, 0, 'nenhum MediaElementSource antes do readyState >= 2');
  assert.equal(waiting.enabled, true, 'capaz — apenas aguardando o áudio');
});

test('silêncio total mantém os visemas em 0 e o grafo nasce uma única vez', () => {
  const targets = makeMorphTargets();
  const web = makeWebAudio();
  const clock = makeClock();
  const layer = createAudioLipSync({ audioElement: makeAudioElement(), morphTargets: targets, now: clock.now, AudioContextCtor: web.Ctor });
  layer.update();
  for (let step = 0; step < 5; step++) { clock.advance(30); layer.update(); }
  assert.deepEqual(valuesOf(targets), [0, 0, 0, 0, 0]);
  assert.equal(web.calls.sources, 1, 'createMediaElementSource chamado uma única vez');
  assert.equal(web.calls.analysers, 1);
  assert.equal(web.analyser.fftSize, 256);
  assert.equal(web.analyser.smoothingTimeConstant, 0.3);
});

test('contexto suspenso é retomado (sem isso o elemento roteado fica mudo)', () => {
  const targets = makeMorphTargets();
  const web = makeWebAudio({ state: 'suspended', data: new Uint8Array(128).fill(255) });
  const clock = makeClock();
  const layer = createAudioLipSync({ audioElement: makeAudioElement(), morphTargets: targets, now: clock.now, AudioContextCtor: web.Ctor });
  layer.update();
  assert.equal(web.calls.resumes, 1, 'resume chamado a cada frame enquanto suspenso');
  clock.advance(ATTACK_TAU_MS);
  layer.update();
  assert.ok(Math.max(...valuesOf(targets)) > 0, 'a boca continua sendo dirigida');

  // 'running' de fábrica não gasta resume algum.
  const idle = makeWebAudio();
  const live = createAudioLipSync({ audioElement: makeAudioElement(), morphTargets: makeMorphTargets(), now: makeClock().now, AudioContextCtor: idle.Ctor });
  live.update();
  assert.equal(idle.calls.resumes, 0);
});

test('voz cheia (bins 255) abre a boca: ≈0.95 após ~3×tau de ataque (90 ms)', () => {
  const h = makeSpeakingLayer();
  h.layer.update(); // dt = 0 — cria o grafo e ancora o relógio
  for (let step = 0; step < 3; step++) { h.clock.advance(ATTACK_TAU_MS); h.layer.update(); }
  for (const value of valuesOf(h.targets)) assert.ok(Math.abs(value - 0.95) < 0.01, `visema ≈ 0.95 após 90 ms (veio ${value})`);
});

test('silêncio súbito decai com o tau de release (80 ms): ≈0 após ~3×tau (240 ms)', () => {
  const h = makeSpeakingLayer();
  h.layer.update();
  for (let step = 0; step < 3; step++) { h.clock.advance(ATTACK_TAU_MS); h.layer.update(); }
  h.data.fill(0);
  for (let step = 0; step < 3; step++) { h.clock.advance(RELEASE_TAU_MS); h.layer.update(); }
  for (const value of valuesOf(h.targets)) {
    assert.ok(value < 0.06, `boca quase fechada após 240 ms (veio ${value})`);
    assert.ok(value > 0.02, `decai com o tau de release, não com o de ataque (veio ${value})`);
  }
});

test('elemento pausado ou terminado zera os visemas e limpa o estado', () => {
  const h = makeSpeakingLayer();
  h.layer.update();
  for (let step = 0; step < 3; step++) { h.clock.advance(ATTACK_TAU_MS); h.layer.update(); }
  assert.ok(valuesOf(h.targets).every(value => value > 0.9), 'boca aberta antes da pausa');
  h.element.paused = true;
  h.layer.update();
  assert.deepEqual(valuesOf(h.targets), [0, 0, 0, 0, 0]);
  h.element.paused = false;
  h.element.ended = true;
  h.layer.update();
  assert.deepEqual(valuesOf(h.targets), [0, 0, 0, 0, 0]);
});

test('reset zera os visemas, fecha o contexto e desconecta o source', () => {
  const h = makeSpeakingLayer();
  h.layer.update();
  for (let step = 0; step < 3; step++) { h.clock.advance(ATTACK_TAU_MS); h.layer.update(); }
  h.layer.reset();
  assert.deepEqual(valuesOf(h.targets), [0, 0, 0, 0, 0]);
  assert.equal(h.web.calls.closes, 1, 'AudioContext.close chamado');
  assert.equal(h.web.calls.sourceDisconnects, 1, 'source desconectado');
  h.layer.update(); // rearmável: sem crash, pronto para um novo elemento
  assert.equal(h.layer.enabled, true);
  assert.equal(h.web.calls.closes, 1, 'o contexto não é fechado de novo');
});

test('attach troca o elemento sem fechar o contexto e recria apenas o source', () => {
  const h = makeSpeakingLayer();
  h.layer.update();
  const second = makeAudioElement();
  h.layer.attach(second);
  h.clock.advance(ATTACK_TAU_MS);
  h.layer.update();
  assert.equal(h.web.calls.closes, 0, 'o contexto sobrevive à troca de elemento');
  assert.equal(h.web.calls.sources, 2, 'um MediaElementSource por elemento');
  assert.equal(h.web.calls.analysers, 1, 'AnalyserNode reaproveitado');
  h.layer.attach(second); // idempotente
  h.clock.advance(ATTACK_TAU_MS);
  h.layer.update();
  assert.equal(h.web.calls.sources, 2);
});

test('sem AudioContext no ambiente (SSR) o layer se desativa sem crash', () => {
  const restore = setGlobal('AudioContext', undefined);
  const restoreWebkit = setGlobal('webkitAudioContext', undefined);
  try {
    const targets = makeMorphTargets();
    const clock = makeClock();
    const layer = createAudioLipSync({ audioElement: makeAudioElement(), morphTargets: targets, now: clock.now });
    layer.update();
    assert.equal(layer.enabled, false);
    assert.deepEqual(valuesOf(targets), [0, 0, 0, 0, 0]);
    layer.update(); // segue sem crash
  } finally {
    restore();
    restoreWebkit();
  }
});

test('AudioContext do globalThis (padrão do browser) é usado sem injeção explícita', () => {
  const web = makeWebAudio();
  const restore = setGlobal('AudioContext', web.Ctor);
  try {
    const targets = makeMorphTargets();
    const clock = makeClock();
    const layer = createAudioLipSync({ audioElement: makeAudioElement(), morphTargets: targets, now: clock.now });
    layer.update();
    assert.equal(web.calls.sources, 1);
    assert.equal(layer.enabled, true);
  } finally {
    restore();
  }
});

test('createMediaElementSource que lança desativa o layer; o elemento continua tocando', () => {
  const targets = makeMorphTargets();
  const web = makeWebAudio({ sourceThrows: true });
  const clock = makeClock();
  const element = makeAudioElement();
  const layer = createAudioLipSync({ audioElement: element, morphTargets: targets, now: clock.now, AudioContextCtor: web.Ctor });
  layer.update();
  assert.equal(layer.enabled, false, 'fallback silencioso ativado');
  element.play();
  assert.equal(element.plays, 1, 'elemento segue utilizável pelo player');
  layer.update(); // fallback: sem crash, boca fechada
  assert.deepEqual(valuesOf(targets), [0, 0, 0, 0, 0]);
});

test('stub de AnalyserNode sem connect não derruba a inicialização', () => {
  const h = makeSpeakingLayer({ withAnalyserConnect: false });
  h.layer.update();
  assert.equal(h.layer.enabled, true);
  for (let step = 0; step < 3; step++) { h.clock.advance(ATTACK_TAU_MS); h.layer.update(); }
  assert.ok(valuesOf(h.targets).every(value => value > 0.9));
});

test('morph fora dos visemas nunca é escrito; modelo sem visemas fica inativo', () => {
  const targets = makeMorphTargets(['blink']);
  const h = makeSpeakingLayer({ targets });
  h.layer.update();
  for (let step = 0; step < 3; step++) { h.clock.advance(ATTACK_TAU_MS); h.layer.update(); }
  const blink = targets[targets.length - 1];
  assert.equal(blink.object.morphTargetInfluences[blink.index], 0, 'blink intocado');
  assert.ok(valuesOf(targets.slice(0, 5)).every(value => value > 0.9), 'os 5 visemas sobem');
  const bare = createAudioLipSync({ audioElement: makeAudioElement(), morphTargets: [] });
  assert.equal(bare.enabled, false);
  bare.update();
  bare.reset();
});

// --- canal de expressão (vrm.expressionManager) ---
// A escrita bruta em morphTargetInfluences é zerada todo frame pelo
// clearAppliedWeight() do VRMExpressionManager dentro de vrm.update(delta);
// em VRM a boca precisa ir pelo setValue do manager.

function makeChannelLayer({ data = new Uint8Array(128).fill(255), morphTargets = makeMorphTargets() } = {}) {
  const web = makeWebAudio({ data });
  const clock = makeClock();
  const element = makeAudioElement();
  const written = [];
  const layer = createAudioLipSync({
    audioElement: element,
    morphTargets,
    setWeight: (name, value) => written.push([name, value]),
    visemeNames: ['aa', 'ih', 'ou', 'ee', 'oh'],
    now: clock.now,
    AudioContextCtor: web.Ctor,
  });
  return { web, clock, element, written, layer, morphTargets };
}

test('canal setWeight: boca vai ao expressionManager e os morphs ficam intactos', () => {
  const h = makeChannelLayer();
  h.layer.update();
  for (let step = 0; step < 3; step++) { h.clock.advance(ATTACK_TAU_MS); h.layer.update(); }
  assert.ok(h.written.length >= 5, 'cada frame escreve os 5 visemas do canal');
  assert.deepEqual([...new Set(h.written.map(([name]) => name))].sort(), ['aa', 'ee', 'ih', 'oh', 'ou']);
  const last = h.written[h.written.length - 1];
  assert.ok(last[1] > 0.9, `visema ≈ aberto após 3×tau de ataque (veio ${last[1]})`);
  assert.deepEqual(valuesOf(h.morphTargets), [0, 0, 0, 0, 0], 'fallback morph não é escrito com o canal ativo');
  assert.equal(h.layer.enabled, true);
});

test('canal setWeight: clear e elemento pausado zeram pelo mesmo canal', () => {
  const h = makeChannelLayer();
  h.layer.update();
  for (let step = 0; step < 3; step++) { h.clock.advance(ATTACK_TAU_MS); h.layer.update(); }
  h.layer.clear();
  for (const [name, value] of h.written.slice(-5)) assert.equal(value, 0, `clear escreveu 0 em ${name}`);
  h.written.length = 0;
  h.layer.update(); // reabre com o mesmo elemento
  for (let step = 0; step < 3; step++) { h.clock.advance(ATTACK_TAU_MS); h.layer.update(); }
  assert.ok(h.written[h.written.length - 1][1] > 0.9);
  h.written.length = 0;
  h.element.paused = true;
  h.clock.advance(ATTACK_TAU_MS);
  h.layer.update();
  assert.ok(h.written.some(([, value]) => value === 0), 'pausado escreve 0 pelo canal');
});

test('setWeight sem visemeNames (ou vazio) cai no fallback de morph', () => {
  const targets = makeMorphTargets();
  const web = makeWebAudio({ data: new Uint8Array(128).fill(255) });
  const clock = makeClock();
  const layer = createAudioLipSync({
    audioElement: makeAudioElement(),
    morphTargets: targets,
    setWeight: () => { throw new Error('não deveria usar o canal'); },
    visemeNames: [],
    now: clock.now,
    AudioContextCtor: web.Ctor,
  });
  layer.update();
  for (let step = 0; step < 3; step++) { clock.advance(ATTACK_TAU_MS); layer.update(); }
  assert.ok(valuesOf(targets).every(value => value > 0.9), 'escreve os morphs como antes');
});

test('canal setWeight sem morphTargets (modelo via expressões) continua ativo', () => {
  const written = [];
  const web = makeWebAudio({ data: new Uint8Array(128).fill(255) });
  const clock = makeClock();
  const layer = createAudioLipSync({
    audioElement: makeAudioElement(),
    morphTargets: [],
    setWeight: (name, value) => written.push([name, value]),
    visemeNames: ['aa'],
    now: clock.now,
    AudioContextCtor: web.Ctor,
  });
  assert.equal(layer.enabled, true, 'só o canal já habilita o lip-sync');
  layer.update();
  clock.advance(ATTACK_TAU_MS);
  layer.update();
  assert.ok(written[written.length - 1][1] > 0);
  layer.reset();
  assert.equal(written[written.length - 1][1], 0, 'reset zera pelo canal');
});
