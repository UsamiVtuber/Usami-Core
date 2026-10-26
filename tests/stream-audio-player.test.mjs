import test from 'node:test';
import assert from 'node:assert/strict';
import { playPcmStream, pcm16LEToFloat32, MIN_SAMPLES_PER_BUFFER, DEFAULT_SAMPLE_RATE } from '../src/stream-audio-player.js';

// Harness no idioma dos testes locais: Web Audio e ReadableStream falsos,
// injetáveis — o player não assume nada do browser.

const SAMPLES_PER_CHUNK = 1728; // ~72 ms em 24 kHz: o chunk do provedor TTS

function pcmBytes(samples) {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  samples.forEach((sample, index) => view.setInt16(index * 2, sample, true));
  return bytes;
}

// Onda quadrada simples: suficiente para diferenciar canais/amostras sem
// depender de dados reais de voz.
function chunkBytes(seed = 1, count = SAMPLES_PER_CHUNK) {
  const samples = new Array(count);
  for (let index = 0; index < count; index += 1) samples[index] = (index + seed) % 2 === 0 ? 12000 : -12000;
  return pcmBytes(samples);
}

function makeFakeContext({ currentTime = 0, sampleRate = DEFAULT_SAMPLE_RATE, fireEnded = true } = {}) {
  const created = { buffers: [], sources: [] };
  const ctx = {
    sampleRate,
    currentTime,
    destination: { name: 'destination' },
    createBuffer(channels, length, rate) {
      const data = new Float32Array(length);
      const buffer = {
        numberOfChannels: channels,
        length,
        sampleRate: rate,
        duration: length / rate,
        getChannelData: () => data,
      };
      created.buffers.push({ buffer, data });
      return buffer;
    },
    createBufferSource() {
      const node = {
        buffer: null,
        startedAt: null,
        connects: [],
        endedFired: 0,
        onended: null,
        connect(target) { node.connects.push(target); },
        disconnect() {},
        start(when) {
          node.startedAt = when;
          created.sources.push(node);
          if (fireEnded) setTimeout(() => { node.endedFired += 1; node.onended?.(); }, 0);
        },
        stop() {},
      };
      return node;
    },
  };
  return { ctx, ...created };
}

function makeStreamResponse(chunks, { throwAfter = Infinity, onRead = null } = {}) {
  const queue = chunks.slice();
  const stats = { reads: 0, cancels: 0 };
  const reader = {
    async read() {
      stats.reads += 1;
      if (stats.reads > throwAfter) throw new Error('socket hang up');
      if (onRead) onRead();
      if (!queue.length) return { done: true, value: undefined };
      return { done: false, value: queue.shift() };
    },
    async cancel() { stats.cancels += 1; },
  };
  return { response: { ok: true, body: { getReader: () => reader } }, stats };
}

const starts = sources => sources.map(source => source.startedAt);
const durations = sources => sources.map(source => source.buffer.duration);

// --- pcm16LEToFloat32 ---

test('pcm16LEToFloat32 normaliza Int16 LE por 32768 (little-endian de verdade)', () => {
  const bytes = pcmBytes([0, 1, -1, 32767, -32768]);
  const floats = pcm16LEToFloat32(bytes);
  assert.ok(floats instanceof Float32Array);
  assert.equal(floats.length, 5);
  assert.equal(floats[0], 0);
  assert.ok(Math.abs(floats[1] - 1 / 32768) < 1e-9);
  assert.ok(Math.abs(floats[2] + 1 / 32768) < 1e-9);
  assert.ok(Math.abs(floats[3] - 32767 / 32768) < 1e-7);
  assert.ok(Math.abs(floats[4] + 1) < 1e-7, '-32768 vira -1 (fundo de escala negativo)');
});

test('pcm16LEToFloat32 descarta o byte ímpar sobrando e aceita Buffer/subarray', () => {
  const withOdd = new Uint8Array([...pcmBytes([1000, -1000]), 0x7f]);
  const floats = pcm16LEToFloat32(withOdd);
  assert.equal(floats.length, 2, 'byte ímpar não vira amostra fantasma');
  assert.ok(Math.abs(floats[0] - 1000 / 32768) < 1e-7);
  const fromBuffer = pcm16LEToFloat32(Buffer.from(pcmBytes([16000, -16000])));
  assert.ok(Math.abs(fromBuffer[0] - 16000 / 32768) < 1e-6);
  assert.ok(Math.abs(fromBuffer[1] + 16000 / 32768) < 1e-6);
  // subarray com byteOffset próprio: o DataView precisa respeitar o deslocamento.
  const pool = new Uint8Array(4 + 6);
  pool.set(pcmBytes([500, 600, 700]), 4);
  const offset = pcm16LEToFloat32(pool.subarray(4));
  assert.equal(offset.length, 3);
  assert.ok(Math.abs(offset[1] - 600 / 32768) < 1e-7, 'lê a amostra certa, não o recheio do pool');
});

test('pcm16LEToFloat32 com entrada vazia ou ausente devolve array vazio', () => {
  assert.equal(pcm16LEToFloat32(new Uint8Array(0)).length, 0);
  assert.equal(pcm16LEToFloat32(undefined).length, 0);
});

// --- playPcmStream: quantum e agendamento ---

test('vários chunks de 72 ms viram buffers de ~100 ms, não um source por chunk', async () => {
  const chunks = [1, 2, 3, 4, 5, 6].map(seed => chunkBytes(seed));
  const { ctx, sources } = makeFakeContext();
  const analyser = { name: 'analyser' };
  const { response } = makeStreamResponse(chunks);
  const result = await playPcmStream({ response, audioContext: ctx, input: analyser, fallbackWaitMs: 0 });

  // 6 × 1728 = 10368 amostras: 4 quanta de 2400 + flush final de 768.
  assert.equal(sources.length, 5, `5 sources, não 6 (veio ${sources.length})`);
  assert.deepEqual(sources.map(source => source.buffer.length), [2400, 2400, 2400, 2400, 768]);
  assert.equal(result.streamed, true);
  assert.equal(result.buffers, 5);
  assert.ok(Math.abs(result.seconds - 10368 / 24000) < 1e-9, 'seconds = áudio total agendado');
  assert.ok(sources.every(source => source.connects[0] === analyser), 'cada source conecta na boca');
});

test('agendamento encostado: nenhum silêncio e nenhuma sobreposição entre chunks', async () => {
  const { ctx, sources } = makeFakeContext();
  const { response } = makeStreamResponse([chunkBytes(1), chunkBytes(2), chunkBytes(3)]);
  await playPcmStream({ response, audioContext: ctx, input: ctx.destination, fallbackWaitMs: 0 });
  const times = starts(sources);
  const spans = durations(sources);
  assert.deepEqual(times.map(t => Number(t.toFixed(6))), [0, 0.1, 0.2], 'começa em 0 e encosta 100 ms em 100 ms');
  for (let index = 1; index < times.length; index += 1) {
    assert.ok(times[index] >= times[index - 1] + spans[index - 1] - 1e-9, 'sem sobreposição de buffers');
    assert.ok(times[index] - (times[index - 1] + spans[index - 1]) < 1e-9, 'sem buraco de silêncio');
  }
});

test('stream atrasado: o start é ancorado em currentTime e nunca no passado', async () => {
  // currentTime avança 300 ms a cada leitura — o player perdeu o bonde e
  // precisaria empurrar nextStart para frente em vez de sobrepor áudio.
  const { ctx, sources } = makeFakeContext();
  const { response } = makeStreamResponse([chunkBytes(1), chunkBytes(2), chunkBytes(3), chunkBytes(4)], {
    onRead: () => { ctx.currentTime += 0.3; },
  });
  await playPcmStream({ response, audioContext: ctx, input: ctx.destination, fallbackWaitMs: 0 });
  const times = starts(sources);
  assert.ok(times.every((time, index) => time >= (index === 0 ? 0 : times[index - 1] + durations(sources)[index - 1]) - 1e-9));
  assert.ok(times.every(time => time >= 0), 'nada é agendado antes do tempo zero');
  assert.ok(Math.max(...times) >= 1, 'o agendamento acompanhou o relógio');
});

test('sobra abaixo do quantum sai como um buffer curto final no fim do stream', async () => {
  const { ctx, sources } = makeFakeContext();
  const { response } = makeStreamResponse([chunkBytes(7, 1000), chunkBytes(8, 400)]);
  const result = await playPcmStream({ response, audioContext: ctx, input: ctx.destination, fallbackWaitMs: 0 });
  assert.equal(sources.length, 1, '1400 amostras < 2400: só o flush do fim');
  assert.equal(sources[0].buffer.length, 1400);
  assert.equal(Number(result.seconds.toFixed(4)), Number((1400 / 24000).toFixed(4)));
  assert.equal(result.streamed, true);
});

test('o byte ímpar no fim do stream não entra no último buffer', async () => {
  const { ctx, sources } = makeFakeContext();
  const tail = new Uint8Array([...chunkBytes(1, 500), 0x2a]); // 1001 bytes
  const { response } = makeStreamResponse([tail]);
  await playPcmStream({ response, audioContext: ctx, input: ctx.destination, fallbackWaitMs: 0 });
  assert.equal(sources.length, 1);
  assert.equal(sources[0].buffer.length, 500, '500 amostras inteiras, o meio byte fica fora');
});

test('os samples vão para o AudioBuffer no valor certo (canal 0 preenchido)', async () => {
  const { ctx, buffers } = makeFakeContext();
  const { response } = makeStreamResponse([pcmBytes([8000, -8000, 16000, -16000])]);
  await playPcmStream({ response, audioContext: ctx, input: ctx.destination, sampleRate: 24000, minSamplesPerBuffer: 4, fallbackWaitMs: 0 });
  assert.equal(buffers.length, 1);
  const { buffer, data } = buffers[0];
  assert.equal(buffer.numberOfChannels, 1, 'mono');
  assert.equal(buffer.sampleRate, 24000);
  assert.ok(Math.abs(data[0] - 8000 / 32768) < 1e-6);
  assert.ok(Math.abs(data[1] + 8000 / 32768) < 1e-6);
  assert.ok(Math.abs(data[3] + 16000 / 32768) < 1e-6);
});

test('sampleRate e minSamplesPerBuffer são respeitados (voz em 16 kHz)', async () => {
  const { ctx, sources } = makeFakeContext();
  const { response } = makeStreamResponse([chunkBytes(1, 3000), chunkBytes(2, 3000)]);
  const result = await playPcmStream({ response, audioContext: ctx, input: ctx.destination, sampleRate: 16000, minSamplesPerBuffer: 1600, fallbackWaitMs: 0 });
  assert.deepEqual(sources.map(source => source.buffer.length), [1600, 1600, 1600, 1200]);
  assert.ok(sources.every(source => source.buffer.sampleRate === 16000));
  assert.ok(Math.abs(result.seconds - 6000 / 16000) < 1e-9);
});

test('onFirstAudio dispara exatamente uma vez, no agendamento do primeiro source', async () => {
  let calls = 0;
  const { ctx } = makeFakeContext();
  const { response } = makeStreamResponse([chunkBytes(1), chunkBytes(2), chunkBytes(3), chunkBytes(4), chunkBytes(5)]);
  await playPcmStream({ response, audioContext: ctx, input: ctx.destination, onFirstAudio: () => { calls += 1; }, fallbackWaitMs: 0 });
  assert.equal(calls, 1, 'o balão só pode aparecer uma vez');
});

test('sem body, body vazio ou context ausente: streamed false e nada de exceção', async () => {
  const { ctx, sources } = makeFakeContext();
  const noBody = await playPcmStream({ response: { ok: true }, audioContext: ctx, input: ctx.destination });
  assert.equal(noBody.streamed, false);
  assert.equal(noBody.reason, 'no-body');
  assert.equal(noBody.buffers, 0);

  const nullResponse = await playPcmStream({ response: null, audioContext: ctx, input: ctx.destination });
  assert.equal(nullResponse.streamed, false);
  assert.equal(nullResponse.reason, 'no-body');

  const emptyBody = makeStreamResponse([]);
  const drained = await playPcmStream({ response: emptyBody.response, audioContext: ctx, input: ctx.destination });
  assert.equal(drained.streamed, false);
  assert.equal(drained.reason, 'empty');

  const noCtx = await playPcmStream({ response: makeStreamResponse([chunkBytes(1)]).response, audioContext: null, input: null });
  assert.equal(noCtx.streamed, false);
  assert.equal(sources.length, 0, 'nenhum source criado nos caminhos de falha');
});

test('reader que lança na hora devolve streamed false em vez de rejeitar', async () => {
  const { ctx, sources } = makeFakeContext();
  const { response } = makeStreamResponse([chunkBytes(1), chunkBytes(2)], { throwAfter: 0 });
  const result = await playPcmStream({ response, audioContext: ctx, input: ctx.destination, fallbackWaitMs: 0 });
  assert.equal(result.streamed, false);
  assert.equal(result.reason, 'read-failed');
  assert.equal(sources.length, 0);
});

test('rede cortada no meio mantém o que já foi agendado (incomplete, sem reject)', async () => {
  const { ctx, sources } = makeFakeContext();
  const chunks = [chunkBytes(1), chunkBytes(2), chunkBytes(3), chunkBytes(4), chunkBytes(5)];
  const { response, stats } = makeStreamResponse(chunks, { throwAfter: 2 });
  const result = await playPcmStream({ response, audioContext: ctx, input: ctx.destination, fallbackWaitMs: 0 });
  assert.equal(result.streamed, true, 'já havia áudio tocando — não re-sintetizar');
  assert.equal(result.incomplete, true);
  assert.equal(result.reason, 'read-failed');
  assert.ok(result.buffers >= 1);
  assert.equal(sources.length, result.buffers);
  assert.equal(stats.cancels, 0, 'leitura morreu sozinha, sem cancel');
});

test('shouldContinue falso interrompe a leitura, cancela o reader e resolve', async () => {
  const { ctx, sources } = makeFakeContext();
  const chunks = [1, 2, 3, 4, 5, 6, 7, 8].map(seed => chunkBytes(seed));
  const { response, stats } = makeStreamResponse(chunks);
  let checks = 0;
  const result = await playPcmStream({
    response,
    audioContext: ctx,
    input: ctx.destination,
    shouldContinue: () => { checks += 1; return checks <= 3; },
    fallbackWaitMs: 0,
  });
  assert.equal(result.cancelled, true);
  assert.equal(stats.cancels, 1, 'reader liberado (body não fica pendurado)');
  assert.ok(stats.reads < chunks.length, 'parou de ler antes do fim do stream');
  assert.ok(sources.length < 6, `não agenda o backlog inteiro (veio ${sources.length})`);
  assert.equal(result.buffers, sources.length);
});

test('mute antes de qualquer amostra: streamed false e sem crash', async () => {
  const { ctx, sources } = makeFakeContext();
  const { response, stats } = makeStreamResponse([chunkBytes(1)]);
  const result = await playPcmStream({ response, audioContext: ctx, input: ctx.destination, shouldContinue: () => false });
  assert.equal(result.streamed, false);
  assert.equal(result.cancelled, true);
  assert.equal(sources.length, 0);
  assert.equal(stats.cancels, 1);
});

test('sem onended no contexto o timer de segurança resolve (a fila não trava)', async () => {
  const { ctx, sources } = makeFakeContext({ fireEnded: false });
  const { response } = makeStreamResponse([chunkBytes(1), chunkBytes(2), chunkBytes(3), chunkBytes(4)]);
  const begun = Date.now();
  const result = await playPcmStream({ response, audioContext: ctx, input: ctx.destination, fallbackWaitMs: 10 });
  const elapsed = Date.now() - begun;
  assert.equal(result.streamed, true);
  assert.ok(sources.length >= 1);
  assert.ok(elapsed < 1000, `resolveu pelo timer em ${elapsed} ms`);
});

test('sem fallbackWaitMs o timer é calculado do áudio restante (e o onended ainda vence)', async () => {
  const { ctx, sources } = makeFakeContext({ fireEnded: false });
  const { response } = makeStreamResponse([chunkBytes(1), chunkBytes(2)]);
  const begun = Date.now();
  const result = await playPcmStream({ response, audioContext: ctx, input: ctx.destination });
  assert.equal(result.streamed, true);
  assert.ok(sources.length >= 1);
  assert.ok(Date.now() - begun < 2000, 'o timer de segurança tem teto, não fica em NaN');

  const ended = makeFakeContext({ fireEnded: true });
  const endedResponse = makeStreamResponse([chunkBytes(1), chunkBytes(2)]);
  await playPcmStream({ response: endedResponse.response, audioContext: ended.ctx, input: ended.ctx.destination });
  const last = ended.sources[ended.sources.length - 1];
  assert.equal(last.endedFired, 1, 'o último source foi escutado via onended');
});

test('input ausente cai no destination (áudio audível mesmo sem lip-sync)', async () => {
  const { ctx, sources } = makeFakeContext();
  const { response } = makeStreamResponse([chunkBytes(1, 100)]);
  const result = await playPcmStream({ response, audioContext: ctx, input: null, fallbackWaitMs: 0 });
  assert.equal(result.streamed, true);
  assert.equal(sources[0].connects[0], ctx.destination);
});

test('constantes exportadas: quantum de 100 ms em 24 kHz', () => {
  assert.equal(DEFAULT_SAMPLE_RATE, 24000);
  assert.equal(MIN_SAMPLES_PER_BUFFER, 2400);
});

// --- onStreamEnd: a próxima frase é pedida com a rede encerrada ---

test('onStreamEnd dispara uma vez, com a rede terminada e antes do playback acabar', async () => {
  const chunks = [1, 2, 3].map(seed => chunkBytes(seed));
  const { ctx } = makeFakeContext({ fireEnded: false });
  const { response } = makeStreamResponse(chunks);
  let calls = 0;
  // O playback aqui é o timer de segurança (nenhum onended); o sinal da rede
  // tem que vir antes, senão a fila fica com dois pedidos em voo ou com buraco.
  const result = await playPcmStream({
    response,
    audioContext: ctx,
    input: { name: 'analyser' },
    fallbackWaitMs: 30,
    onStreamEnd: () => { calls += 1; },
  });
  assert.equal(calls, 1);
  assert.equal(result.streamed, true);
});

test('onStreamEnd não dispara quando a fila abandonou nem quando a leitura quebrou', async () => {
  const { ctx } = makeFakeContext({ fireEnded: false });
  let cancelledCalls = 0;
  const cancelled = makeStreamResponse([chunkBytes(1), chunkBytes(2)]);
  await playPcmStream({
    response: cancelled.response,
    audioContext: ctx,
    input: { name: 'analyser' },
    fallbackWaitMs: 0,
    shouldContinue: () => false,
    onStreamEnd: () => { cancelledCalls += 1; },
  });
  assert.equal(cancelledCalls, 0, 'abutou no meio: a próxima frase não pode ser pedida');

  let failedCalls = 0;
  const broken = makeStreamResponse([chunkBytes(1)], { throwAfter: 0 });
  const result = await playPcmStream({
    response: broken.response,
    audioContext: ctx,
    input: { name: 'analyser' },
    fallbackWaitMs: 0,
    onStreamEnd: () => { failedCalls += 1; },
  });
  assert.equal(failedCalls, 0, 'rede cortada: quem retrya precisa saber, não seguir o pipeline');
  assert.equal(result.reason, 'read-failed');
});
