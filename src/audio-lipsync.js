// Etapa 5 — lip-sync dirigido pelo áudio real (versão por vogal).
//
// A mímica textual de `visemes.js` era um plano cego: o `/api/tts` não traz
// duração, o `audio.duration` chega depois do início da fala e o timing
// derivava. A versão anterior reduzia o espectro a UM RMS e aplicava o mesmo
// valor aos 5 visemas (`a/I/u/e/o`), então "a" e "u" abriam a boca igual.
// Esta versão deriva pesos por vogal do espectro do AnalyserNode e passa por
// um driver winner+runner com piso de silêncio de 160 ms e suavização
// ataque/release — adaptação da AIRI
// (airi/packages/model-driver-lipsync/src/shared/wlipsync/vowel-driver.ts).
//
// Cadeia:
//   HTMLAudioElement → MediaElementSource → AnalyserNode (fftSize 1024, smoothing 0.3) → destination
//   AudioBufferSourceNode (PCM em streaming) ↗
//
// As duas entradas compartilham o mesmo AnalyserNode: `getTap()` entrega
// `{ context, input }` para o `playPcmStream` tocar o PCM do `/api/tts?stream`
// sem HTMLAudioElement, e `beginExternal()`/`endExternal()` dizem a `update()`
// que a fala do momento não passa pelo elemento (senão a boca fecharia porque
// o elemento está pausado/sem src).
//
// O espectro em bytes vira um frame { volume, weights[A/E/I/O/U] } via
// `spectrumToVowelFrame`; o driver `createVowelDriver` seleciona vencedor+runner,
// aplica piso de silêncio (160 ms) e suavização (ataque 50/s, release 30/s),
// e devolve pesos por vogal que são escritos nos visemas correspondentes.
//
// Canal de escrita: em VRMs a boca NÃO pode ser escrita direto em
// `morphTargetInfluences` — `VRMExpressionManager.update()` (dentro do
// `vrm.update(delta)`, que roda depois deste layer no loop) zera toda
// expressão via `clearAppliedWeight()` antes de reaplicar seus próprios
// pesos, apagando o visema todo frame. Por isso o layer aceita um canal
// injetável (`setWeight` + `visemeNames`, tipicamente
// `vrm.expressionManager.setValue` com `aa/ih/ou/ee/oh`); a escrita bruta em
// morphs continua como fallback para modelos sem expressionManager (GLB/FBX).
//
// Web Audio é opcional. Sem `AudioContext` no ambiente (SSR) ou se
// `createMediaElementSource` lançar, o layer se desativa em silêncio: o
// elemento continua tocando normalmente e a boca apenas fica fechada — o rAF
// nunca recebe exceção.

import { createVowelDriver, spectrumToVowelFrame, VOWELS } from './vowel-driver.js';

// Pausa longa entre frames (aba oculta) não pode virar salto brusco de valor.
const MAX_DT_MS = 250;

// Visemas do VRM (o modelo usa o "I" maiúsculo; a comparação é em minúsculas).
const VISEME_NAMES = ['a', 'i', 'u', 'e', 'o'];

// Mapeamento vogal→candidatos de nome de expressão/morph (case-insensitive).
const VOWEL_CANDIDATES = {
  A: ['aa', 'a'],
  E: ['ee', 'e'],
  I: ['ih', 'i'],
  O: ['oh', 'o'],
  U: ['ou', 'u'],
};

export function createAudioLipSync({
  audioElement = null,
  morphTargets = [],
  // Canal de expressão (VRM): quando fornecido, os pesos dos visemas vão por
  // `setWeight(name, value)` — ex.: vrm.expressionManager.setValue. Sem ele,
  // fallback de escrita bruta em morphTargetInfluences (GLB/FBX).
  setWeight = null,
  visemeNames = null,
  now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()),
  // Injetável para testes; o padrão resolve do globalThis (window no browser).
  AudioContextCtor = null,
  gain = 1,
} = {}) {
  const channel = typeof setWeight === 'function' && Array.isArray(visemeNames) && visemeNames.length > 0
    ? visemeNames.map(name => String(name)).filter(Boolean)
    : null;

  // Mapeia cada vogal ao seu slot de escrita (canal ou morph).
  const vowelSlots = [];
  if (channel) {
    // Canal: para cada vogal, ache o 1º nome em visemeNames que case (case-insensitive)
    // com um candidato da vogal.
    for (const vowel of VOWELS) {
      const candidates = VOWEL_CANDIDATES[vowel];
      const match = channel.find(name => candidates.includes(name.toLowerCase()));
      if (match) vowelSlots.push({ vowel, channelName: match });
    }
  } else {
    // Morph: itens já filtrados a visemas; mapeie nome (case-insensitive; trate i/I) para vogal.
    const targets = (Array.isArray(morphTargets) ? morphTargets : []).filter(
      m => m && m.object && Number.isInteger(m.index) && VISEME_NAMES.includes(String(m.name || '').toLowerCase()),
    );
    for (const t of targets) {
      const lname = String(t.name || '').toLowerCase();
      const vowel = VOWELS.find(v => VOWEL_CANDIDATES[v].includes(lname));
      if (vowel) vowelSlots.push({ vowel, morphItem: t });
    }
  }
  const hasTargets = vowelSlots.length > 0;

  let failed = false;
  let audioCtx = null;
  let analyser = null;
  let source = null;
  let dataArray = null;
  let boundElement = null; // elemento já roteado ao source atual
  let externalActive = false; // player de PCM usando o analyser diretamente
  let level = 0; // volume 0..1 do último frame de fala, lido pelo beacon

  const driver = createVowelDriver(now);

  const resolveContextCtor = () => {
    if (AudioContextCtor) return AudioContextCtor;
    const g = typeof globalThis !== 'undefined' ? globalThis : null;
    return g ? g.AudioContext || g.webkitAudioContext || null : null;
  };

  // Escrita da boca no canal dono do peso: expressão (VRM) quando injetada,
  // morphTargetInfluences (GLB/FBX) como fallback histórico.
  const writeMouth = weights => {
    for (const slot of vowelSlots) {
      const value = weights[slot.vowel] ?? 0;
      if (slot.channelName) {
        try { setWeight(slot.channelName, value); } catch {}
      } else if (slot.morphItem) {
        const influences = slot.morphItem.object ? slot.morphItem.object.morphTargetInfluences : null;
        if (influences) influences[slot.morphItem.index] = value;
      }
    }
  };

  // Zera a boca e limpa o estado do driver; escreve 0 em todos os slots.
  const stopMouth = () => {
    for (const v of VOWELS) {
      if (vowelSlots.some(s => s.vowel === v)) {
        // só escreve se o slot existe, mas driver.reset() já limpa tudo
      }
    }
    writeMouth({ A: 0, E: 0, I: 0, O: 0, U: 0 });
    driver.reset();
    level = 0;
  };

  // Desmonta o grafo Web Audio (teardown do Avatar). Depois disso o elemento
  // roteado não deve ser reaproveitado: um HTMLMediaElement só pode ser
  // consumido por createMediaElementSource uma vez na vida.
  const releaseGraph = () => {
    if (source && typeof source.disconnect === 'function') { try { source.disconnect(); } catch {} }
    if (analyser && typeof analyser.disconnect === 'function') { try { analyser.disconnect(); } catch {} }
    if (audioCtx && typeof audioCtx.close === 'function') { try { audioCtx.close(); } catch {} }
    source = null;
    analyser = null;
    dataArray = null;
    audioCtx = null;
    boundElement = null;
    externalActive = false;
  };

  // Contexto + analyser nascem uma única vez e NUNCA dependem do elemento: é o
  // ponto de entrada do áudio em streaming (src/stream-audio-player.js), que
  // conecta um AudioBufferSourceNode direto no analyser. Qualquer falha vira
  // fallback silencioso (failed).
  const ensureContext = () => {
    if (failed) return false;
    if (audioCtx && analyser) return true;
    const Ctor = resolveContextCtor();
    if (!Ctor) { failed = true; return false; }
    try {
      audioCtx = new Ctor();
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.3;
      // O analyser devolve o som ao destino, senão a fala sairia muda.
      if (typeof analyser.connect === 'function') analyser.connect(audioCtx.destination);
      dataArray = new Uint8Array(analyser.frequencyBinCount || 512);
    } catch {
      audioCtx = null;
      analyser = null;
      dataArray = null;
      failed = true;
      return false;
    }
    return true;
  };

  // Caminho histórico: além do grafo, roteia o HTMLAudioElement. Um source por
  // elemento (trocar de elemento recria só o source).
  const ensureGraph = el => {
    if (!ensureContext()) return false;
    if (boundElement !== el) {
      try {
        const nextSource = audioCtx.createMediaElementSource(el);
        nextSource.connect(analyser);
        if (source && typeof source.disconnect === 'function') { try { source.disconnect(); } catch {} }
        source = nextSource;
        boundElement = el;
      } catch {
        // Web Audio indisponível para este elemento — fallback silencioso: o
        // elemento segue tocando pelo caminho normal de saída.
        failed = true;
        return false;
      }
    }
    return true;
  };

  // Chamado 1×/frame pelo rAF do Avatar.
  const update = () => {
    if (!hasTargets || failed) { level = 0; stopMouth(); return; }
    const el = audioElement;
    if (externalActive) {
      // PCM em streaming: não existe elemento tocando — o analyser é alimentado
      // pelo AudioBufferSourceNode do player. Zerar a boca porque o elemento está
      // pausado/sem src seria calar o avatar no meio da fala.
      if (!ensureContext() || !dataArray) { stopMouth(); return; }
    } else {
      if (!el || !el.src || (el.readyState || 0) < 2) { stopMouth(); return; }
      if (!ensureGraph(el)) { stopMouth(); return; }
      if (el.paused || el.ended) { stopMouth(); return; }
    }
    // Política de autoplay: contexto suspenso é retomado a cada frame até ligar
    // — inclusive o criado sob demanda pelo tap do player de PCM.
    if (audioCtx.state === 'suspended' && typeof audioCtx.resume === 'function') { try { audioCtx.resume(); } catch {} }
    analyser.getByteFrequencyData(dataArray);

    // Deriva frame por vogal do espectro e passa pelo driver winner+runner.
    const frame = spectrumToVowelFrame(dataArray, { sampleRate: (audioCtx && audioCtx.sampleRate) || 48000 });
    const t = now();
    let dt = 0;
    if (!update.lastTime) update.lastTime = t;
    dt = t - update.lastTime;
    update.lastTime = t;
    if (dt > MAX_DT_MS) dt = MAX_DT_MS;
    const deltaSeconds = dt / 1000;

    level = frame.volume;
    const weights = driver.update(frame, deltaSeconds);
    writeMouth(weights);
  };

  // Liga o layer ao HTMLAudioElement real (speakReply). Trocar de elemento
  // reconstrói apenas o source — contexto e analyser são reaproveitados.
  const attach = element => {
    if (!element || element === audioElement) return;
    audioElement = element;
    if (source && typeof source.disconnect === 'function') { try { source.disconnect(); } catch {} }
    source = null;
    boundElement = null;
    // driver mantém estado de silêncio; não resetar aqui — o clear() faz isso quando preciso.
  };

  // Boca fechada sob demanda (fallback mudo do TTS, reset do avatar) sem
  // desmontar o grafo — o caminho de áudio continua vivo p/ a próxima fala.
  const clear = () => {
    writeMouth({ A: 0, E: 0, I: 0, O: 0, U: 0 });
    driver.reset();
    level = 0;
  };

  // Saída do grafo para um player de PCM: `{ context, input }` é exatamente o
  // par que `playPcmStream` precisa — o AudioBufferSourceNode conecta em
  // `input` (o AnalyserNode) e é medido pela mesma boca do caminho histórico.
  // Não chama createMediaElementSource: não há elemento, só amostras.
  const getTap = () => {
    if (!hasTargets || !ensureContext()) return null;
    return { context: audioCtx, input: analyser };
  };

  // Contexto atual (ou null): o audio-revive observa `statechange` nele.
  const getContext = () => audioCtx;

  // Cria o contexto dentro de um gesto do usuário, antes da primeira fala; o
  // contexto nascido fora de gesto começa suspenso e o PCM tocaria mudo.
  const prime = () => (hasTargets ? ensureContext() : false);

  // Volume 0..1 do último frame; 0 quando não há fala medida.
  const getLevel = () => level;

  // Enquanto o PCM toca, `update()` lê o analyser em vez de checar o elemento.
  const beginExternal = () => {
    if (!hasTargets || failed) return false;
    externalActive = true;
    update.lastTime = now();
    return true;
  };

  // Restaura o comportamento antigo (elemento parado = boca fechada) quadro a
  // quadro, sem desmontar nada — o contexto segue vivo para a próxima fala.
  const endExternal = () => {
    externalActive = false;
  };

  // Teardown: zera a boca, desconecta o source e fecha o contexto. O chamador
  // deve descartar o elemento consumido (ele não pode ser roteado de novo).
  const reset = () => {
    clear();
    releaseGraph();
    failed = false;
    // Recria o driver para limpar estado de silêncio/última atividade.
    Object.assign(driver, createVowelDriver(now));
  };

  return {
    update,
    attach,
    clear,
    reset,
    getTap,
    getContext,
    getLevel,
    prime,
    beginExternal,
    endExternal,
    get enabled() { return hasTargets && !failed; },
  };
}