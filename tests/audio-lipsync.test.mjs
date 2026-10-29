import test from 'node:test';
import assert from 'node:assert/strict';
import { createAudioLipSync } from '../src/audio-lipsync.js';
import { VOWELS } from '../src/vowel-driver.js';

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

function makeWebAudio({ data = new Uint8Array(512), sourceThrows = false, resumeThrows = false, withAnalyserConnect = true, state = 'running' } = {}) {
  const calls = { sources: 0, analysers: 0, closes: 0, sourceDisconnects: 0, resumes: 0 };
  const analyser = {
    fftSize: 0,
    smoothingTimeConstant: 0,
    frequencyBinCount: 512,
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
  const Ctor = function () { return ctx; };
  return { ctx, analyser, calls, data, Ctor };
}

function makeClock(start = 0) {
  let t = start;
  return { now: () => t, advance: ms => { t += ms; } };
}

// Cria espectro com energia nas bandas de uma vogal específica (para 48 kHz, fftSize 1024).
function makeVowelSpectrum(vowel) {
  const data = new Uint8Array(512).fill(0);
  // binWidth = 48000 / 1024 ≈ 46.875 Hz
  const bands = {
    A: { f1: [14, 22], f2: [21, 33] },      // 650-1050, 1000-1550
    E: { f1: [6, 13], f2: [36, 53] },        // 300-600, 1700-2500
    I: { f1: [4, 9], f2: [43, 64] },         // 200-420, 2000-3000
    O: { f1: [6, 13], f2: [15, 22] },        // 300-600, 700-1050
    U: { f1: [5, 10], f2: [11, 17] },        // 220-480, 500-800
  };
  const b = bands[vowel];
  if (!b) return data;
  for (let i = b.f1[0]; i <= b.f1[1]; i += 1) data[i] = 255;
  for (let i = b.f2[0]; i <= b.f2[1]; i += 1) data[i] = 255;
  return data;
}

function makeSpeakingLayer({ data = makeVowelSpectrum('A'), targets = makeMorphTargets(), withAnalyserConnect = true } = {}) {
  const web = makeWebAudio({ data, withAnalyserConnect });
  const clock = makeClock();
  const element = makeAudioElement();
  const layer = createAudioLipSync({ audioElement: element, morphTargets: targets, now: clock.now, AudioContextCtor: web.Ctor });
  return { web, clock, element, layer, targets, data };
}

function makeChannelLayer({ data = makeVowelSpectrum('A'), morphTargets = makeMorphTargets() } = {}) {
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

function makeTapLayer({ data = makeVowelSpectrum('A'), audioElement = null } = {}) {
  const web = makeWebAudio({ data });
  const clock = makeClock();
  const targets = makeMorphTargets();
  const layer = createAudioLipSync({
    audioElement,
    morphTargets: targets,
    now: clock.now,
    AudioContextCtor: web.Ctor,
  });
  return { web, clock, targets, layer, data };
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
  const web = makeWebAudio({ data: new Uint8Array(512).fill(0) });
  const clock = makeClock();
  const layer = createAudioLipSync({ audioElement: makeAudioElement(), morphTargets: targets, now: clock.now, AudioContextCtor: web.Ctor });
  layer.update();
  for (let step = 0; step < 5; step++) { clock.advance(30); layer.update(); }
  assert.deepEqual(valuesOf(targets), [0, 0, 0, 0, 0]);
  assert.equal(web.calls.sources, 1, 'createMediaElementSource chamado uma única vez');
  assert.equal(web.calls.analysers, 1);
  assert.equal(web.analyser.fftSize, 1024);
  assert.equal(web.analyser.smoothingTimeConstant, 0.3);
});

test('contexto suspenso é retomado (sem isso o elemento roteado fica mudo)', () => {
  const targets = makeMorphTargets();
  const web = makeWebAudio({ state: 'suspended', data: makeVowelSpectrum('A') });
  const clock = makeClock();
  const layer = createAudioLipSync({ audioElement: makeAudioElement(), morphTargets: targets, now: clock.now, AudioContextCtor: web.Ctor });
  clock.advance(20); // avança ANTES do primeiro update para dt > 0
  layer.update();
  assert.equal(web.calls.resumes, 1, 'resume chamado a cada frame enquanto suspenso');
  clock.advance(20);
  layer.update();
  assert.ok(Math.max(...valuesOf(targets)) > 0.05, 'a boca continua sendo dirigida');

  const idle = makeWebAudio();
  const live = createAudioLipSync({ audioElement: makeAudioElement(), morphTargets: makeMorphTargets(), now: makeClock().now, AudioContextCtor: idle.Ctor });
  live.update();
  assert.equal(idle.calls.resumes, 0);
});

test('voz com espectro de "A" abre o visema A e os outros ficam ~0', () => {
  const h = makeSpeakingLayer({ data: makeVowelSpectrum('A') });
  h.layer.update(); // dt = 0 — cria o grafo
  for (let step = 0; step < 10; step++) { h.clock.advance(20); h.layer.update(); }
  const vals = valuesOf(h.targets);
  // Ordem dos visemas em makeMorphTargets: ['a', 'I', 'u', 'e', 'o']
  // Vogal A → visema 'a' (índice 0)
  assert.ok(vals[0] > 0.2, `visema 'a' abre (veio ${vals[0]})`);
  for (let i = 1; i < 5; i += 1) {
    assert.ok(vals[i] < 0.1, `visema ${i} ≈ 0 (veio ${vals[i]})`);
  }
});

test('voz com espectro de "U" abre o visema U e os outros ficam ~0 (motivação do port)', () => {
  const h = makeSpeakingLayer({ data: makeVowelSpectrum('U') });
  h.layer.update();
  for (let step = 0; step < 10; step++) { h.clock.advance(20); h.layer.update(); }
  const vals = valuesOf(h.targets);
  // Vogal U → visema 'u' (índice 2)
  // U tem menos bins de formante → amplitude menor (~0.18), threshold ajustado
  assert.ok(vals[2] > 0.15, `visema 'u' abre (veio ${vals[2]})`);
  for (let i = 0; i < 5; i += 1) {
    if (i === 2) continue;
    assert.ok(vals[i] < 0.1, `visema ${i} ≈ 0 (veio ${vals[i]})`);
  }
  // Antes do port, A e U produziriam o mesmo RMS → todos 5 iguais.
});

test('silêncio súbito decai e fecha a boca (piso 160 ms)', () => {
  const h = makeSpeakingLayer({ data: makeVowelSpectrum('A') });
  h.layer.update();
  for (let step = 0; step < 10; step++) { h.clock.advance(20); h.layer.update(); }
  assert.ok(Math.max(...valuesOf(h.targets)) > 0.2, 'boca aberta antes do silêncio');
  h.data.fill(0);
  // Avança > 160 ms (piso de silêncio do driver)
  for (let step = 0; step < 10; step++) { h.clock.advance(20); h.layer.update(); }
  for (const value of valuesOf(h.targets)) {
    assert.ok(value < 0.05, `boca quase fechada após silêncio (veio ${value})`);
  }
});

test('elemento pausado ou terminado zera os visemas e limpa o estado', () => {
  const h = makeSpeakingLayer({ data: makeVowelSpectrum('A') });
  h.layer.update();
  for (let step = 0; step < 10; step++) { h.clock.advance(20); h.layer.update(); }
  assert.ok(Math.max(...valuesOf(h.targets)) > 0.2, 'boca aberta antes da pausa');
  h.element.paused = true;
  h.layer.update();
  assert.deepEqual(valuesOf(h.targets), [0, 0, 0, 0, 0]);
  h.element.paused = false;
  h.element.ended = true;
  h.layer.update();
  assert.deepEqual(valuesOf(h.targets), [0, 0, 0, 0, 0]);
});

test('reset zera os visemas, fecha o contexto e desconecta o source', () => {
  const h = makeSpeakingLayer({ data: makeVowelSpectrum('A') });
  h.layer.update();
  for (let step = 0; step < 10; step++) { h.clock.advance(20); h.layer.update(); }
  h.layer.reset();
  assert.deepEqual(valuesOf(h.targets), [0, 0, 0, 0, 0]);
  assert.equal(h.web.calls.closes, 1, 'AudioContext.close chamado');
  assert.equal(h.web.calls.sourceDisconnects, 1, 'source desconectado');
  h.layer.update(); // rearmável
  assert.equal(h.layer.enabled, true);
  assert.equal(h.web.calls.closes, 1, 'o contexto não é fechado de novo');
});

test('attach troca o elemento sem fechar o contexto e recria apenas o source', () => {
  const h = makeSpeakingLayer({ data: makeVowelSpectrum('A') });
  h.layer.update();
  const second = makeAudioElement();
  h.layer.attach(second);
  h.clock.advance(20);
  h.layer.update();
  assert.equal(h.web.calls.closes, 0, 'o contexto sobrevive à troca de elemento');
  assert.equal(h.web.calls.sources, 2, 'um MediaElementSource por elemento');
  assert.equal(h.web.calls.analysers, 1, 'AnalyserNode reaproveitado');
  h.layer.attach(second);
  h.clock.advance(20);
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
    layer.update();
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
  layer.update();
  assert.deepEqual(valuesOf(targets), [0, 0, 0, 0, 0]);
});

test('stub de AnalyserNode sem connect não derruba a inicialização', () => {
  const h = makeSpeakingLayer({ withAnalyserConnect: false });
  h.layer.update();
  assert.equal(h.layer.enabled, true);
  for (let step = 0; step < 10; step++) { h.clock.advance(20); h.layer.update(); }
  assert.ok(Math.max(...valuesOf(h.targets)) > 0.2);
});

test('morph fora dos visemas nunca é escrito; modelo sem visemas fica inativo', () => {
  const targets = makeMorphTargets(['blink']);
  const h = makeSpeakingLayer({ data: makeVowelSpectrum('A'), targets });
  h.layer.update();
  for (let step = 0; step < 10; step++) { h.clock.advance(20); h.layer.update(); }
  const blink = targets[targets.length - 1];
  assert.equal(blink.object.morphTargetInfluences[blink.index], 0, 'blink intocado');
  assert.ok(Math.max(...valuesOf(targets.slice(0, 5))) > 0.2, 'os 5 visemas sobem');
  const bare = createAudioLipSync({ audioElement: makeAudioElement(), morphTargets: [] });
  assert.equal(bare.enabled, false);
  bare.update();
  bare.reset();
});

test('canal setWeight: boca vai ao expressionManager e os morphs ficam intactos', () => {
  const h = makeChannelLayer({ data: makeVowelSpectrum('A') });
  h.layer.update();
  for (let step = 0; step < 10; step++) { h.clock.advance(20); h.layer.update(); }
  assert.ok(h.written.length >= 5, 'cada frame escreve os 5 visemas do canal');
  const names = [...new Set(h.written.map(([name]) => name))].sort();
  assert.deepEqual(names, ['aa', 'ee', 'ih', 'oh', 'ou']);
  // A vencedora (A→aa) abre; achar a entrada para 'aa' no último frame
  const lastFrame = h.written.slice(-5);
  const aaEntry = lastFrame.find(([name]) => name === 'aa');
  assert.ok(aaEntry, 'aa escrito no último frame');
  assert.ok(aaEntry[1] > 0.1, `visema vencedor 'aa' abre (veio ${aaEntry[1]})`);
  assert.deepEqual(valuesOf(h.morphTargets), [0, 0, 0, 0, 0], 'fallback morph não é escrito com o canal ativo');
  assert.equal(h.layer.enabled, true);
});

test('canal setWeight: clear e elemento pausado zeram pelo mesmo canal', () => {
  const h = makeChannelLayer({ data: makeVowelSpectrum('A') });
  h.layer.update();
  for (let step = 0; step < 10; step++) { h.clock.advance(20); h.layer.update(); }
  h.layer.clear();
  // clear escreve 0 em todos os 5 slots
  const last5 = h.written.slice(-5);
  for (const [name, value] of last5) assert.equal(value, 0, `clear escreveu 0 em ${name}`);
  h.written.length = 0;
  h.layer.update(); // reabre com o mesmo elemento
  for (let step = 0; step < 10; step++) { h.clock.advance(20); h.layer.update(); }
  // Verificar que 'aa' (vencedora A) abre novamente
  const lastFrame = h.written.slice(-5);
  const aaEntry = lastFrame.find(([name]) => name === 'aa');
  assert.ok(aaEntry, 'aa escrito após reabrir');
  assert.ok(aaEntry[1] > 0.1, `aa abre após reabrir (veio ${aaEntry[1]})`);
  h.written.length = 0;
  h.element.paused = true;
  h.clock.advance(20);
  h.layer.update();
  assert.ok(h.written.some(([, value]) => value === 0), 'pausado escreve 0 pelo canal');
});

test('setWeight sem visemeNames (ou vazio) cai no fallback de morph', () => {
  const targets = makeMorphTargets();
  const web = makeWebAudio({ data: makeVowelSpectrum('A') });
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
  for (let step = 0; step < 10; step++) { clock.advance(20); layer.update(); }
  assert.ok(Math.max(...valuesOf(targets)) > 0.2, 'escreve os morphs como antes');
});

test('canal setWeight sem morphTargets (modelo via expressões) continua ativo', () => {
  const written = [];
  const web = makeWebAudio({ data: makeVowelSpectrum('A') });
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
  clock.advance(20); // avança antes do primeiro update para dt > 0
  layer.update();
  for (let step = 0; step < 10; step++) { clock.advance(20); layer.update(); }
  // Com apenas 'aa' no visemeNames, apenas A (→aa) será escrito
  // Pegar a última entrada para 'aa' (a que tem o peso final)
  const aaEntries = written.filter(([name]) => name === 'aa');
  assert.ok(aaEntries.length > 0, 'aa foi escrito');
  const lastAa = aaEntries[aaEntries.length - 1];
  assert.ok(lastAa[1] > 0.05, `aa tem peso > 0 (veio ${lastAa[1]})`);
  layer.reset();
  const lastAfterReset = written[written.length - 1];
  assert.equal(lastAfterReset[1], 0, 'reset zera pelo canal');
});

test('getTap cria contexto e analyser sem tocar em createMediaElementSource', () => {
  const h = makeTapLayer();
  const tap = h.layer.getTap();
  assert.ok(tap, 'o grafo é entregue ao player de PCM');
  assert.equal(tap.context, h.web.ctx);
  assert.equal(tap.input, h.web.analyser, 'input é o próprio AnalyserNode da boca');
  assert.equal(h.web.calls.sources, 0, 'sem elemento, sem MediaElementSource');
  assert.equal(h.web.calls.analysers, 1);
  assert.equal(h.web.analyser.fftSize, 1024);
  assert.equal(h.web.analyser.smoothingTimeConstant, 0.3);
  const again = h.layer.getTap();
  assert.equal(again.input, tap.input, 'tap idempotente');
  assert.equal(h.web.calls.analysers, 1, 'o segundo getTap não recria o grafo');
});

test('getTap reaproveita o grafo já criado pelo caminho do elemento', () => {
  const h = makeTapLayer({ audioElement: makeAudioElement() });
  h.layer.update();
  const tap = h.layer.getTap();
  assert.equal(h.web.calls.analysers, 1, 'analyser compartilhado');
  assert.equal(h.web.calls.sources, 1);
  assert.equal(tap.input, h.web.analyser);
});

test('getTap sem AudioContext (SSR) ou sem visemas devolve null sem crash', () => {
  const restore = setGlobal('AudioContext', undefined);
  const restoreWebkit = setGlobal('webkitAudioContext', undefined);
  try {
    const targets = makeMorphTargets();
    const layer = createAudioLipSync({ morphTargets: targets });
    assert.equal(layer.getTap(), null);
    assert.equal(layer.enabled, false, 'fallback silencioso, sem exceção');
    layer.update();
  } finally {
    restore();
    restoreWebkit();
  }
  const bare = createAudioLipSync({ morphTargets: [] });
  assert.equal(bare.getTap(), null, 'modelo sem boca não expõe grafo algum');
});

test('modo externo: update dirige a boca pelo analyser mesmo sem elemento', () => {
  const h = makeTapLayer();
  h.layer.update();
  assert.deepEqual(valuesOf(h.targets), [0, 0, 0, 0, 0], 'sem elemento a boca segue fechada');
  assert.equal(h.web.calls.analysers, 0, 'e o grafo nem nasce');
  assert.equal(h.layer.beginExternal(), true);
  h.clock.advance(20); // avança ANTES do primeiro update para dt > 0
  h.layer.update(); // cria o contexto do tap
  for (let step = 0; step < 10; step++) { h.clock.advance(20); h.layer.update(); }
  // Apenas o visema da vogal ativa (A→'a', índice 0) deve abrir
  const vals = valuesOf(h.targets);
  assert.ok(vals[0] > 0.05, `visema 'a' abre (veio ${vals[0]})`);
  for (let i = 1; i < 5; i += 1) {
    assert.ok(vals[i] < 0.1, `visema ${i} ≈ 0 (veio ${vals[i]})`);
  }
  assert.equal(h.web.calls.sources, 0, 'o caminho do elemento não é invocado');
  h.layer.endExternal();
  h.layer.update();
  assert.deepEqual(valuesOf(h.targets), [0, 0, 0, 0, 0], 'comportamento antigo restaurado');
});

test('modo externo: elemento pausado ou sem src não zera a boca no meio da fala', () => {
  const element = makeAudioElement({ paused: true, src: '' });
  const h = makeTapLayer({ audioElement: element });
  h.layer.beginExternal();
  h.layer.update();
  for (let step = 0; step < 10; step++) { h.clock.advance(20); h.layer.update(); }
  assert.ok(Math.max(...valuesOf(h.targets)) > 0.1, 'a fala em streaming segue dirigida');
  h.data.fill(0);
  for (let step = 0; step < 10; step++) { h.clock.advance(20); h.layer.update(); }
  assert.ok(Math.max(...valuesOf(h.targets)) < 0.05, 'silêncio do fim do stream fecha a boca');
});

test('modo externo: contexto suspenso do tap é retomado a cada frame', () => {
  const web = makeWebAudio({ state: 'suspended', data: makeVowelSpectrum('A') });
  const clock = makeClock();
  const targets = makeMorphTargets();
  const layer = createAudioLipSync({ morphTargets: targets, now: clock.now, AudioContextCtor: web.Ctor });
  assert.ok(layer.getTap(), 'contexto nasce suspenso (política de autoplay)');
  layer.beginExternal();
  clock.advance(20); // avança ANTES do primeiro update
  layer.update();
  assert.equal(web.calls.resumes, 1, 'resume também se aplica ao contexto do tap');
  clock.advance(20);
  layer.update();
  assert.ok(Math.max(...valuesOf(targets)) > 0.05, 'a boca continua sendo dirigida');
});

test('modo externo: clear e reset continuam seguros, reset derruba o modo', () => {
  const h = makeTapLayer();
  h.layer.beginExternal();
  h.layer.update();
  for (let step = 0; step < 10; step++) { h.clock.advance(20); h.layer.update(); }
  h.layer.clear();
  assert.deepEqual(valuesOf(h.targets), [0, 0, 0, 0, 0], 'clear fecha a boca na hora');
  for (let step = 0; step < 10; step++) { h.clock.advance(20); h.layer.update(); }
  assert.ok(Math.max(...valuesOf(h.targets)) > 0.1, 'e o modo externo segue vivo depois do clear');
  h.layer.reset();
  assert.deepEqual(valuesOf(h.targets), [0, 0, 0, 0, 0]);
  assert.equal(h.web.calls.closes, 1, 'contexto fechado no teardown');
  h.layer.update();
  assert.deepEqual(valuesOf(h.targets), [0, 0, 0, 0, 0], 'sem modo externo pendurado após o reset');
  assert.equal(h.layer.beginExternal(), true, 'rearmável para a próxima fala');
  assert.ok(h.layer.getTap(), 'o tap volta a existir depois do reset');
  assert.equal(h.web.calls.analysers, 2, 'novo grafo, não o nó fechado');
});

test('tap depois de uma falha do Web Audio devolve null e o modo externo desiste', () => {
  const web = makeWebAudio({ sourceThrows: true });
  const clock = makeClock();
  const targets = makeMorphTargets();
  const element = makeAudioElement();
  const layer = createAudioLipSync({ audioElement: element, morphTargets: targets, now: clock.now, AudioContextCtor: web.Ctor });
  layer.update();
  assert.equal(layer.enabled, false, 'createMediaElementSource quebrou o caminho');
  assert.equal(layer.getTap(), null, 'nada a conectar em um grafo morto');
  assert.equal(layer.beginExternal(), false, 'player de PCM descobre que não há boca dirigida');
  layer.update();
  assert.deepEqual(valuesOf(targets), [0, 0, 0, 0, 0]);
});