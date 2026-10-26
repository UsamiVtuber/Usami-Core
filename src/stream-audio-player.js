// TTS em streaming: toca PCM cru (Int16 LE, mono) conforme ele chega.
//
// O caminho antigo (resposta completa → blob → HTMLAudioElement) só faz ouvir
// depois que o provedor sintetiza a frase inteira: ~5-6 s medidas. Aqui o
// servidor despeja chunks de ~72 ms e o primeiro som sai ~1 s depois do pedido.
//
// Por que o quantum é de ~100 ms (2400 amostras em 24 kHz) e não o chunk da
// rede: um AudioBufferSourceNode por fragmento de 72 ms significa ~14 nós por
// segundo de fala, cada um com seu próprio start() agendado no thread de áudio.
// Além do custo, a jitter da rede passaria a virar buraco de silêncio. Agrupar
// em ~100 ms dá folga para o buffer do navegador sem adicionar latência
// perceptível — só na primeira vez, e ela é o preço de ter áudio estável.
//
// Módulos deste arquivo são puros: AudioContext, reader e callbacks entram
// injetados, então tudo roda em `node --test` sem browser.
//
// Nada aqui pode lançar: quem chama é a fila de respostas e um reject viraria
// unhandled rejection no meio de uma fala. Toda falha (sem body, rede cortada,
// Web Audio indisponível) vira resultado `{ streamed: false, reason }`.

export const DEFAULT_SAMPLE_RATE = 24000;
export const MIN_SAMPLES_PER_BUFFER = 2400; // 100 ms em 24 kHz
const SAFETY_GRACE_MS = 400; // folga do timer de segurança sobre o resto do áudio

// Int16 LE → Float32 normalizado por 32768 (faixa do AudioBuffer).
// Byte ímpar sobrando é descartado: amostra truncada no meio do streaming
// viraria um estouro em fundo de escala no fim do buffer.
export function pcm16LEToFloat32(bytes) {
  const source = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? []);
  const count = Math.floor(source.length / 2);
  const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
  const samples = new Float32Array(count);
  for (let index = 0; index < count; index += 1) {
    samples[index] = view.getInt16(index * 2, true) / 32768;
  }
  return samples;
}

const concatBytes = (a, b) => {
  if (!a.length) return b;
  if (!b.length) return a;
  const merged = new Uint8Array(a.length + b.length);
  merged.set(a, 0);
  merged.set(b, a.length);
  return merged;
};

const asBytes = value => {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (value?.buffer instanceof ArrayBuffer) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return new Uint8Array(0);
};

// Consome `response.body` e agenda um AudioBufferSourceNode por quantum.
// `input` é o AnalyserNode do lip-sync (ou o destination, quando não há boca
// para dirigir): o mesmo grafo que mede o RMS continua medindo o áudio streamed.
export async function playPcmStream({
  response = null,
  audioContext = null,
  input = null,
  sampleRate = DEFAULT_SAMPLE_RATE,
  minSamplesPerBuffer = MIN_SAMPLES_PER_BUFFER,
  onFirstAudio = null,
  // Toda a rede chegou, mas o último quantum ainda vai tocar: sinal de que o
  // chamador pode pedir a próxima frase sem pôr duas sínteses em voo.
  onStreamEnd = null,
  shouldContinue = () => true,
  fallbackWaitMs = null,
} = {}) {
  const result = { streamed: false, buffers: 0, seconds: 0, reason: null };
  try {
    if (!audioContext || typeof audioContext.createBuffer !== 'function') {
      result.reason = 'no-audio-context';
      return result;
    }
    const sink = input || audioContext.destination || null;
    if (!sink || typeof audioContext.createBufferSource !== 'function') {
      result.reason = 'no-audio-sink';
      return result;
    }
    const reader = response?.body?.getReader?.() ?? null;
    if (!reader || typeof reader.read !== 'function') {
      result.reason = 'no-body';
      return result;
    }

    const rate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : DEFAULT_SAMPLE_RATE;
    const quantum = Math.max(2, Math.floor(minSamplesPerBuffer) || MIN_SAMPLES_PER_BUFFER) * 2;
    let pending = new Uint8Array(0);
    // nextStart avança com a duração de cada buffer: os source nasce um atrás
    // do outro sem buraco de silêncio. Quando o stream atrasa e nextStart fica
    // atrás de currentTime, o próximo start é ancorado em currentTime — senão
    // os buffers passariam a sobrepor e a fala adiantaria para sempre.
    let nextStart = Number(audioContext.currentTime) || 0;
    let lastSource = null;
    let firstSignaled = false;

    const schedule = bytes => {
      const samples = pcm16LEToFloat32(bytes);
      if (!samples.length) return;
      const buffer = audioContext.createBuffer(1, samples.length, rate);
      buffer.getChannelData(0).set(samples);
      const node = audioContext.createBufferSource();
      node.buffer = buffer;
      node.connect(sink);
      const start = Math.max(nextStart, Number(audioContext.currentTime) || 0);
      nextStart = start + buffer.duration;
      if (!firstSignaled) {
        firstSignaled = true;
        try { if (typeof onFirstAudio === 'function') onFirstAudio(); } catch {}
      }
      node.start(start);
      result.buffers += 1;
      result.seconds += buffer.duration;
      lastSource = node;
    };

    let cancelled = false;
    let readFailed = false;
    for (;;) {
      // Checar antes de ler E antes de agendar: mute ou resposta nova assume na
      // hora, sem soltar mais um quantum que já estava acumulado.
      if (shouldContinue() === false) { cancelled = true; break; }
      let chunk = null;
      try {
        chunk = await reader.read();
      } catch {
        // Rede cortada no meio da fala: o que já foi agendado continua tocando;
        // perder o resto é melhor que calar tudo ou rejeitar a fila.
        readFailed = true;
        break;
      }
      const { done, value } = chunk ?? {};
      if (done === true) break;
      if (value === undefined || value === null) continue;
      pending = concatBytes(pending, asBytes(value));
      while (pending.length >= quantum) {
        if (shouldContinue() === false) { cancelled = true; break; }
        schedule(pending.subarray(0, quantum));
        pending = pending.slice(quantum);
      }
      if (cancelled) break;
    }

    if (cancelled) {
      try { if (typeof reader.cancel === 'function') await reader.cancel(); } catch {}
      result.streamed = result.buffers > 0;
      result.cancelled = true;
      // Áudio já agendado é curto (no máximo o último quantum) e o chamador
      // mandou parar: resolver na hora para a fila não ficar presa esperando.
      return result;
    }

    // Fim da rede, não do playback: o chamador usa isto para pedir a próxima
    // frase sem pôr duas sínteses em voo. Falha de leitura não dispara — quem
    // retrya precisa saber que a fala quebrou.
    if (!readFailed) { try { if (typeof onStreamEnd === 'function') onStreamEnd(); } catch {} }

    // Sobra abaixo do quantum sai como um buffer curto final — é o fim da fala,
    // não há mais dados chegando para agrupar. O byte ímpar fica fora (pcm16).
    if (pending.length > 0) schedule(pending);

    if (result.buffers === 0) {
      result.reason = readFailed ? 'read-failed' : 'empty';
      return result;
    }

    result.streamed = true;
    if (readFailed) {
      result.reason = 'read-failed';
      result.incomplete = true;
    }

    // Resolve só quando o áudio agendado terminou: a fila de balões precisa do
    // fim real da fala. onended é o caminho normal; o timer de segurança existe
    // porque um contexto falso (teste) ou um node sem onended nunca dispara.
    const remainingMs = Math.max(0, ((Number(nextStart) || 0) - (Number(audioContext.currentTime) || 0)) * 1000);
    const waitMs = Number.isFinite(fallbackWaitMs) && fallbackWaitMs !== null
      ? Math.max(0, fallbackWaitMs)
      : remainingMs + SAFETY_GRACE_MS;
    await new Promise(resolve => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, waitMs);
      if (lastSource) {
        try { lastSource.onended = finish; } catch {}
      }
    });
    return result;
  } catch {
    // Nunca deixa a fila rejeitar: o que já tocou conta como streamed.
    result.reason = result.reason || 'stream-failed';
    result.streamed = result.buffers > 0;
    return result;
  }
}
