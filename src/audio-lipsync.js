// Etapa 5 — lip-sync dirigido pelo áudio real.
//
// A mímica textual de `visemes.js` era um plano cego: o `/api/tts` não traz
// duração, o `audio.duration` chega depois do início da fala e o timing
// derivava. Este module lê o sinal que realmente sai nos alto-falantes:
//
//   HTMLAudioElement → MediaElementSource → AnalyserNode → destination
//   AudioBufferSourceNode (PCM em streaming) ↗
//
// As duas entradas compartilham o mesmo AnalyserNode: `getTap()` entrega
// `{ context, input }` para o `playPcmStream` tocar o PCM do `/api/tts?stream`
// sem HTMLAudioElement, e `beginExternal()`/`endExternal()` dizem a `update()`
// que a fala do momento não passa pelo elemento (senão a boca fecharia porque
// o elemento está pausado/sem src).
//
// O `AnalyserNode` (fftSize 256, smoothing 0.3) entrega o espectro em bytes;
// os bins são reduzidos a um RMS contínuo normalizado (0–1) que vira a
// "abertura da boca" aplicada igualmente aos 5 visemas do VRM (`a/I/u/e/o`).
// A suavização é a mesma rampa exponencial independente de frame rate do
// `expression-driver`: ataque rápido (30 ms) para a boca abrir junto da voz e
// release natural (80 ms) para ela fechar.
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

export const ATTACK_TAU_MS = 30;
export const RELEASE_TAU_MS = 80;

// Pausa longa entre frames (aba oculta) não pode virar salto brusco de valor.
const MAX_DT_MS = 250;

// Visemas do VRM (o modelo usa o "I" maiúsculo; a comparação é em minúsculas).
const VISEME_NAMES = ['a', 'i', 'u', 'e', 'o'];

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
  const targets = channel ? [] : (Array.isArray(morphTargets) ? morphTargets : []).filter(
    m => m && m.object && Number.isInteger(m.index) && VISEME_NAMES.includes(String(m.name || '').toLowerCase()),
  );
  const hasTargets = channel ? channel.length > 0 : targets.length > 0;

  let failed = false;
  let audioCtx = null;
  let analyser = null;
  let source = null;
  let dataArray = null;
  let boundElement = null; // elemento já roteado ao source atual
  let externalActive = false; // player de PCM usando o analyser diretamente
  let current = 0;
  let lastTime = null;

  const resolveContextCtor = () => {
    if (AudioContextCtor) return AudioContextCtor;
    const g = typeof globalThis !== 'undefined' ? globalThis : null;
    return g ? g.AudioContext || g.webkitAudioContext || null : null;
  };

  // Escrita da boca no canal dono do peso: expressão (VRM) quando injetada,
  // morphTargetInfluences (GLB/FBX) como fallback histórico.
  const writeMouth = value => {
    if (channel) {
      for (const name of channel) { try { setWeight(name, value); } catch {} }
      return;
    }
    for (const m of targets) {
      const influences = m.object ? m.object.morphTargetInfluences : null;
      if (!influences) continue;
      influences[m.index] = value;
    }
  };

  // Zera a boca e limpa o estado da rampa; só escreve se algo mudou, para não
  // brigar com as outras camadas (expression driver, painel de morphs).
  const stopMouth = () => {
    if (current !== 0) writeMouth(0);
    current = 0;
    lastTime = null;
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
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.3;
      // O analyser devolve o som ao destino, senão a fala sairia muda.
      if (typeof analyser.connect === 'function') analyser.connect(audioCtx.destination);
      dataArray = new Uint8Array(analyser.frequencyBinCount || 128);
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
    if (!hasTargets || failed) { stopMouth(); return; }
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
    let sum = 0;
    for (let i = 0; i < dataArray.length; i += 1) sum += dataArray[i] * dataArray[i];
    const count = dataArray.length || 1;
    const rms = Math.sqrt(sum / count) / 255; // byte máximo = 255
    const target = Math.min(1, rms * gain);
    const t = now();
    let dt = lastTime === null ? 0 : t - lastTime;
    lastTime = t;
    if (!(dt > 0)) dt = 0;
    else if (dt > MAX_DT_MS) dt = MAX_DT_MS;
    if (dt > 0) {
      const tau = target > current ? ATTACK_TAU_MS : RELEASE_TAU_MS;
      current += (target - current) * (1 - Math.exp(-dt / tau));
    }
    writeMouth(current);
  };

  // Liga o layer ao HTMLAudioElement real (speakReply). Trocar de elemento
  // reconstrói apenas o source — contexto e analyser são reaproveitados.
  const attach = element => {
    if (!element || element === audioElement) return;
    audioElement = element;
    if (source && typeof source.disconnect === 'function') { try { source.disconnect(); } catch {} }
    source = null;
    boundElement = null;
    current = 0;
    lastTime = null;
  };

  // Boca fechada sob demanda (fallback mudo do TTS, reset do avatar) sem
  // desmontar o grafo — o caminho de áudio continua vivo p/ a próxima fala.
  const clear = () => {
    current = 0;
    lastTime = null;
    writeMouth(0);
  };

  // Saída do grafo para um player de PCM: `{ context, input }` é exatamente o
  // par que `playPcmStream` precisa — o AudioBufferSourceNode conecta em
  // `input` (o AnalyserNode) e é medido pela mesma boca do caminho histórico.
  // Não chama createMediaElementSource: não há elemento, só amostras.
  const getTap = () => {
    if (!hasTargets || !ensureContext()) return null;
    return { context: audioCtx, input: analyser };
  };

  // Enquanto o PCM toca, `update()` lê o analyser em vez de checar o elemento.
  const beginExternal = () => {
    if (!hasTargets || failed) return false;
    externalActive = true;
    lastTime = null;
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
  };

  return {
    update,
    attach,
    clear,
    reset,
    getTap,
    beginExternal,
    endExternal,
    get enabled() { return hasTargets && !failed; },
  };
}
