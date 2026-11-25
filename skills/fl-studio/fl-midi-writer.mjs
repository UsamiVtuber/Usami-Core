/**
 * Codificador e leitor minimalista de Standard MIDI File (SMF Format 0, 480 TPQ),
 * 100% puro JS (sem dependencias externas e sem I/O), projetado para arrastar
 * acordes de Future Bass, arpejos Kawaii, beds de Colour Bass e riffs de Dubstep
 * direto para o Piano Roll do FL Studio 2026.
 */

export const DEFAULT_TPQ = 480; // 1 seminima = 480 ticks; 1 semicolcheia (1/16) = 120 ticks

export function encodeVlq(value) {
  let num = Math.max(0, Math.floor(Number(value) || 0));
  const bytes = [num & 0x7F];
  num >>>= 7;
  while (num > 0) {
    bytes.unshift((num & 0x7F) | 0x80);
    num >>>= 7;
  }
  return bytes;
}

function writeUint16BE(value) {
  return [(value >>> 8) & 0xFF, value & 0xFF];
}

function writeUint32BE(value) {
  return [
    (value >>> 24) & 0xFF,
    (value >>> 16) & 0xFF,
    (value >>> 8) & 0xFF,
    value & 0xFF,
  ];
}

function asciiBytes(text) {
  const clean = String(text ?? '').replace(/[^\x20-\x7E]/g, '?').slice(0, 64);
  const out = [];
  for (let i = 0; i < clean.length; i += 1) {
    out.push(clean.charCodeAt(i));
  }
  return out;
}

/**
 * Gera um buffer Uint8Array de arquivo `.mid` (Format 0, 1 track polifonica).
 *
 * @param {Object} params
 * @param {number} [params.bpm=145]
 * @param {number} [params.tpq=480]
 * @param {string} [params.trackName='Usami Bass Pack']
 * @param {Array<{startTick: number, durationTicks: number, pitch: number, velocity?: number, channel?: number}>} params.notes
 * @returns {Uint8Array}
 */
export function buildMidiFileBytes({
  bpm = 145,
  tpq = DEFAULT_TPQ,
  trackName = 'Usami Pattern',
  notes = [],
} = {}) {
  if (!Number.isFinite(bpm) || bpm < 20 || bpm > 522) {
    throw new Error('buildMidiFileBytes: bpm deve estar entre 20 e 522.');
  }
  if (!Array.isArray(notes) || notes.length === 0) {
    throw new Error('buildMidiFileBytes: lista de notas nao pode ser vazia.');
  }

  const trackBytes = [];

  // Meta: Track Name em tick 0
  const nameRaw = asciiBytes(trackName);
  trackBytes.push(0x00, 0xFF, 0x03, ...encodeVlq(nameRaw.length), ...nameRaw);

  // Meta: Time Signature 4/4 em tick 0
  trackBytes.push(0x00, 0xFF, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08);

  // Meta: Set Tempo em tick 0 (microsegundos por seminima)
  const mpqn = Math.max(1, Math.round(60_000_000 / bpm));
  trackBytes.push(
    0x00,
    0xFF,
    0x51,
    0x03,
    (mpqn >>> 16) & 0xFF,
    (mpqn >>> 8) & 0xFF,
    mpqn & 0xFF,
  );

  // Converte notas em eventos pontuais On/Off ordenados
  const pointEvents = [];
  for (const n of notes) {
    const startTick = Math.max(0, Math.round(Number(n.startTick) || 0));
    const durationTicks = Math.max(15, Math.round(Number(n.durationTicks) || 120));
    const pitch = Math.max(0, Math.min(127, Math.round(Number(n.pitch))));
    const velocity = Math.max(1, Math.min(127, Math.round(Number(n.velocity ?? 100))));
    const channel = Math.max(0, Math.min(15, Math.round(Number(n.channel ?? 0))));

    pointEvents.push({
      tick: startTick,
      kindOrder: 1, // Note On depois de Note Off no mesmo tick
      status: 0x90 | channel,
      data1: pitch,
      data2: velocity,
    });
    pointEvents.push({
      tick: startTick + durationTicks,
      kindOrder: 0, // Note Off primeiro evita sobreposicao/cancelamento em acordes seguidos
      status: 0x80 | channel,
      data1: pitch,
      data2: 0,
    });
  }

  pointEvents.sort((a, b) => (a.tick - b.tick) || (a.kindOrder - b.kindOrder) || (a.data1 - b.data1));

  let lastTick = 0;
  for (const ev of pointEvents) {
    const delta = Math.max(0, ev.tick - lastTick);
    lastTick = ev.tick;
    trackBytes.push(...encodeVlq(delta), ev.status, ev.data1, ev.data2);
  }

  // Meta: End of Track
  trackBytes.push(0x00, 0xFF, 0x2F, 0x00);

  const header = [
    0x4D, 0x54, 0x68, 0x64, // "MThd"
    ...writeUint32BE(6),
    ...writeUint16BE(0), // Format 0
    ...writeUint16BE(1), // 1 track
    ...writeUint16BE(tpq),
  ];

  const trackHeader = [
    0x4D, 0x54, 0x72, 0x6B, // "MTrk"
    ...writeUint32BE(trackBytes.length),
  ];

  return Uint8Array.from([...header, ...trackHeader, ...trackBytes]);
}

/**
 * Inspeciona um buffer `.mid` gerado para validacao deterministica em `verify()` e testes.
 */
export function inspectMidiFileBytes(input) {
  const bytes = input instanceof Uint8Array ? input : Uint8Array.from(input || []);
  if (bytes.length < 22) {
    return { valid: false, reason: 'arquivo MIDI muito curto' };
  }
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (magic !== 'MThd') {
    return { valid: false, reason: 'cabecalho MThd ausente' };
  }
  const format = (bytes[8] << 8) | bytes[9];
  const tracks = (bytes[10] << 8) | bytes[11];
  const tpq = (bytes[12] << 8) | bytes[13];
  const trkMagic = String.fromCharCode(bytes[14], bytes[15], bytes[16], bytes[17]);
  if (trkMagic !== 'MTrk') {
    return { valid: false, reason: 'bloco MTrk ausente' };
  }
  const trkLen = ((bytes[18] << 24) >>> 0) + (bytes[19] << 16) + (bytes[20] << 8) + bytes[21];
  if (22 + trkLen !== bytes.length) {
    return { valid: false, reason: 'tamanho MTrk inconsistente' };
  }
  return {
    valid: true,
    format,
    tracks,
    tpq,
    byteLength: bytes.length,
  };
}
