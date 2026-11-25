/**
 * Nucleo puro da skill fl-studio (sem I/O, sem rede, compativel com sandbox).
 *
 * Responsavel por:
 *  - protocolo SysEx 7-bit (`F0 7D U S M <ascii-json> F7`);
 *  - presets de batida para Step Sequencer (incluindo Future Bass, Kawaii e Dubstep/Riddim/Brostep/Colour Bass);
 *  - parser de notas musicais, acordes estendidos, voicings abertos (supersaw, colour_bass, spread) e progressoes de genero;
 *  - gerador de eventos de Piano Roll por estilo para exportacao `.mid`;
 *  - validacao estrita dos argumentos das 8 ferramentas `fl.*`.
 */
import { DEFAULT_TPQ } from './fl-midi-writer.mjs';

export const FL_STUDIO_SCHEMA = 'usami.skill.fl_studio.v1';

export const SYSEX_HEADER = Object.freeze([0xF0, 0x7D, 0x55, 0x53, 0x4D]); // F0 7D 'USM'
export const SYSEX_END = 0xF7;

export const STEP_PRESETS = Object.freeze({
  // Gerais
  four_on_the_floor: Object.freeze([0, 4, 8, 12]),
  backbeat: Object.freeze([4, 12]),
  trap_hihat: Object.freeze([0, 2, 4, 6, 8, 10, 11, 12, 14]),
  eighth_hat: Object.freeze([0, 2, 4, 6, 8, 10, 12, 14]),
  sixteenth_hat: Object.freeze([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]),
  offbeat_hat: Object.freeze([2, 6, 10, 14]),
  dem_bow: Object.freeze([3, 6, 11, 14]),
  boom_bap_kick: Object.freeze([0, 7, 10]),

  // Half-time / Dubstep / Riddim / Brostep / Colour Bass / Melodic Dubstep / Future Bass / Kawaii
  halftime_snare: Object.freeze([8]),
  riddim_kick: Object.freeze([0, 14]),
  riddim_stomp: Object.freeze([0, 8]),
  riddim_triplet_hat: Object.freeze([0, 3, 6, 8, 11, 14]),
  brostep_kick: Object.freeze([0, 6, 15]),
  melodic_dubstep_kick: Object.freeze([0, 3, 10, 14]),
  colour_bass_kick: Object.freeze([0, 6, 11, 14]),
  future_bass_kick: Object.freeze([0, 3, 6, 10, 14]),
  kawaii_bounce_kick: Object.freeze([0, 3, 7, 10, 12, 15]),
  kawaii_perc: Object.freeze([2, 5, 9, 11, 14]),
});

export const TRANSPORT_ACTIONS = Object.freeze([
  'play',
  'pause',
  'stop',
  'record',
  'toggle_loop',
  'pattern_mode',
  'song_mode',
  'metronome',
  'set_bpm',
  'jump_marker',
  'add_marker',
]);

export const STEPS_MODES = Object.freeze(['replace', 'add', 'clear', 'read']);
export const PLUGIN_TARGETS = Object.freeze(['channel', 'mixer']);
export const PLUGIN_ACTIONS = Object.freeze(['list_params', 'set_param', 'next_preset', 'prev_preset', 'focus']);
export const UNDO_DIRECTIONS = Object.freeze(['undo', 'redo']);
export const ROUTING_MODES = Object.freeze(['sidechain', 'bus_only', 'send', 'disconnect', 'inspect', 'channel_to_mixer']);
export const EQ_PRESETS = Object.freeze(['sub_mono_clean', 'supersaw_air', 'mud_cut', 'flat']);
export const LISTEN_SOURCES = Object.freeze(['loopback', 'file']);
export const LISTEN_GENRES = Object.freeze([
  'future_bass',
  'kawaii',
  'dubstep',
  'riddim',
  'brostep',
  'colour_bass',
  'melodic_dubstep',
]);
export const VOICING_MODES = Object.freeze(['close', 'spread', 'supersaw', 'colour_bass']);
export const MIDI_STYLES = Object.freeze([
  'sustained',
  'future_bass_pump',
  'kawaii_arp',
  'melodic_dubstep_stack',
  'riddim_bass',
  'brostep_riff',
]);

const SHARP_NAMES = Object.freeze(['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']);

const NOTE_SEMITONES = Object.freeze({
  C: 0,
  'C#': 1,
  DB: 1,
  D: 2,
  'D#': 3,
  EB: 3,
  E: 4,
  FB: 4,
  'E#': 5,
  F: 5,
  'F#': 6,
  GB: 6,
  G: 7,
  'G#': 8,
  AB: 8,
  A: 9,
  'A#': 10,
  BB: 10,
  B: 11,
  CB: 11,
  'B#': 0,
});

const CHORD_INTERVALS = Object.freeze({
  '': [0, 4, 7],
  maj: [0, 4, 7],
  M: [0, 4, 7],
  m: [0, 3, 7],
  min: [0, 3, 7],
  dim: [0, 3, 6],
  aug: [0, 4, 8],
  '+': [0, 4, 8],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
  '5': [0, 7],
  '6': [0, 4, 7, 9],
  m6: [0, 3, 7, 9],
  '69': [0, 4, 7, 9, 14],
  '7': [0, 4, 7, 10],
  '7sus4': [0, 5, 7, 10],
  maj7: [0, 4, 7, 11],
  M7: [0, 4, 7, 11],
  m7: [0, 3, 7, 10],
  min7: [0, 3, 7, 10],
  dim7: [0, 3, 6, 9],
  m7b5: [0, 3, 6, 10],
  '9': [0, 4, 7, 10, 14],
  '9sus4': [0, 5, 7, 10, 14],
  maj9: [0, 4, 7, 11, 14],
  m9: [0, 3, 7, 10, 14],
  add9: [0, 4, 7, 14],
  add11: [0, 4, 7, 17],
  '11': [0, 4, 7, 10, 14, 17],
  m11: [0, 3, 7, 10, 14, 17],
  maj11: [0, 4, 7, 11, 14, 18],
});

/**
 * Progressoes classicas dos generos (graus em semitons relativos a tonica maior
 * ou menor informada em `key`).
 */
export const GENRE_PROGRESSIONS = Object.freeze({
  // Royal Road (Oudou Shinkou): IVmaj7 - V7 - iii7 - vi9 (Kawaii Future Bass / J-Pop)
  kawaii_royal_road: Object.freeze({
    mode: 'major',
    defaultVoicing: 'supersaw',
    defaultBpm: 156,
    steps: [
      { offset: 5, quality: 'maj7' },
      { offset: 7, quality: '7' },
      { offset: 4, quality: 'm7' },
      { offset: 9, quality: 'm9' },
    ],
  }),
  // Kawaii Sparkle: IVmaj9 - V9sus4 - iii7 - vi11
  kawaii_sparkle: Object.freeze({
    mode: 'major',
    defaultVoicing: 'spread',
    defaultBpm: 160,
    steps: [
      { offset: 5, quality: 'maj9' },
      { offset: 7, quality: '9sus4' },
      { offset: 4, quality: 'm7' },
      { offset: 9, quality: 'm11' },
    ],
  }),
  // Future Bass Anthem: vi9 - IVmaj9 - Imaj7 - Vadd9
  future_bass_anthem: Object.freeze({
    mode: 'major',
    defaultVoicing: 'supersaw',
    defaultBpm: 150,
    steps: [
      { offset: 9, quality: 'm9' },
      { offset: 5, quality: 'maj9' },
      { offset: 0, quality: 'maj7' },
      { offset: 7, quality: 'add9' },
    ],
  }),
  // Melodic Dubstep Epic (base menor): i(m9) - bVImaj7 - bIIIadd9 - bVIIsus4
  melodic_dubstep_epic: Object.freeze({
    mode: 'minor',
    defaultVoicing: 'supersaw',
    defaultBpm: 145,
    steps: [
      { offset: 0, quality: 'm9' },
      { offset: 8, quality: 'maj7' },
      { offset: 3, quality: 'add9' },
      { offset: 10, quality: 'sus4' },
    ],
  }),
  // Colour Bass Prism (base menor): im11 - bVImaj9 - bIIImaj11 - bVII69
  colour_bass_prism: Object.freeze({
    mode: 'minor',
    defaultVoicing: 'colour_bass',
    defaultBpm: 145,
    steps: [
      { offset: 0, quality: 'm11' },
      { offset: 8, quality: 'maj9' },
      { offset: 3, quality: 'maj11' },
      { offset: 10, quality: '69' },
    ],
  }),
  // Riddim Phrygian Dark (base menor): i5 - i5 - bII5 - i5
  riddim_dark: Object.freeze({
    mode: 'minor',
    defaultVoicing: 'close',
    defaultBpm: 142,
    steps: [
      { offset: 0, quality: '5' },
      { offset: 0, quality: '5' },
      { offset: 1, quality: '5' },
      { offset: 0, quality: '5' },
    ],
  }),
  // Brostep Drop (base menor): im - bVImaj7 - bII5 - V7
  brostep_drop: Object.freeze({
    mode: 'minor',
    defaultVoicing: 'spread',
    defaultBpm: 148,
    steps: [
      { offset: 0, quality: 'm' },
      { offset: 8, quality: 'maj7' },
      { offset: 1, quality: '5' },
      { offset: 7, quality: '7' },
    ],
  }),
});

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const clampMidi = note => Math.max(0, Math.min(127, Math.round(note)));

function escapeJsonToAscii(jsonText) {
  let out = '';
  for (let i = 0; i < jsonText.length; i += 1) {
    const code = jsonText.charCodeAt(i);
    if (code < 0x80) {
      out += jsonText[i];
    } else {
      out += `\\u${code.toString(16).padStart(4, '0')}`;
    }
  }
  return out;
}

export function encodeSysexMessage(payload) {
  if (!isPlainObject(payload)) {
    throw new Error('encodeSysexMessage: payload deve ser um objeto.');
  }
  const ascii = escapeJsonToAscii(JSON.stringify(payload));
  const bytes = new Uint8Array(SYSEX_HEADER.length + ascii.length + 1);
  for (let i = 0; i < SYSEX_HEADER.length; i += 1) {
    bytes[i] = SYSEX_HEADER[i];
  }
  for (let i = 0; i < ascii.length; i += 1) {
    const code = ascii.charCodeAt(i);
    if (code >= 0x80) {
      throw new Error(`Byte nao-7bit encontrado no payload SysEx (${code}).`);
    }
    bytes[SYSEX_HEADER.length + i] = code;
  }
  bytes[bytes.length - 1] = SYSEX_END;
  return bytes;
}

export function decodeSysexMessage(input) {
  const bytes = input instanceof Uint8Array ? input : Uint8Array.from(input || []);
  if (bytes.length < SYSEX_HEADER.length + 3) {
    throw new Error('Mensagem SysEx muito curta.');
  }
  for (let i = 0; i < SYSEX_HEADER.length; i += 1) {
    if (bytes[i] !== SYSEX_HEADER[i]) {
      throw new Error('Cabecalho SysEx invalido (esperado Usami USM).');
    }
  }
  if (bytes[bytes.length - 1] !== SYSEX_END) {
    throw new Error('Mensagem SysEx sem terminador 0xF7.');
  }
  let text = '';
  for (let i = SYSEX_HEADER.length; i < bytes.length - 1; i += 1) {
    if (bytes[i] >= 0x80) {
      throw new Error(`Byte invalido em corpo SysEx: ${bytes[i]}`);
    }
    text += String.fromCharCode(bytes[i]);
  }
  const parsed = JSON.parse(text);
  if (!isPlainObject(parsed)) {
    throw new Error('Corpo SysEx deve decodificar para um objeto JSON.');
  }
  return parsed;
}

export function parseNoteName(input) {
  if (Number.isInteger(input)) {
    if (input < 0 || input > 127) {
      throw new Error(`Nota MIDI fora do intervalo 0..127: ${input}`);
    }
    return input;
  }
  const raw = String(input ?? '').trim();
  const match = /^([A-Ga-g])([#bB]?)(-?\d)$/.exec(raw);
  if (!match) {
    throw new Error(`Nota invalida: "${raw}". Use formato como C4, F#3, Bb5 ou numero MIDI 0..127.`);
  }
  const letter = match[1].toUpperCase();
  const accidental = match[2] === '#' ? '#' : (match[2] ? 'B' : '');
  const octave = Number.parseInt(match[3], 10);
  const semitone = NOTE_SEMITONES[`${letter}${accidental}`];
  if (semitone === undefined) {
    throw new Error(`Nota invalida: "${raw}".`);
  }
  const midiNote = (octave + 1) * 12 + semitone;
  if (midiNote < 0 || midiNote > 127) {
    throw new Error(`Nota fora do intervalo MIDI 0..127: "${raw}" (${midiNote}).`);
  }
  return midiNote;
}

export function parseKeySignature(keyInput = 'C') {
  const raw = String(keyInput ?? 'C').trim();
  const match = /^([A-Ga-g])([#b]?)(m|min|maj)?$/i.exec(raw);
  if (!match) {
    throw new Error(`Tonalidade invalida: "${raw}". Use formato como C, F, D#, Bb, Am ou F#m.`);
  }
  const letter = match[1].toUpperCase();
  const accidental = match[2] === '#' ? '#' : (match[2] ? 'B' : '');
  const semitone = NOTE_SEMITONES[`${letter}${accidental}`];
  const isMinor = Boolean(match[3] && /^m(in)?$/i.test(match[3]));
  return {
    rootSemitone: semitone,
    mode: isMinor ? 'minor' : 'major',
    label: `${SHARP_NAMES[semitone]}${isMinor ? 'm' : ''}`,
  };
}

export function buildProgressionChords(progressionKey, keyInput = 'C') {
  const name = String(progressionKey ?? '').trim().toLowerCase();
  const spec = GENRE_PROGRESSIONS[name];
  if (!spec) {
    throw new Error(`Progressao desconhecida: "${progressionKey}". Disponiveis: ${Object.keys(GENRE_PROGRESSIONS).join(', ')}.`);
  }
  const parsedKey = parseKeySignature(keyInput);
  // Se o usuario informou uma tonalidade menor (ex.: Am) para uma progressao maior (ex.: Royal Road),
  // converte para a relativa maior (+3 semitons -> C) e vice-versa (-3 semitons), mantendo as notas na escala!
  let baseSemitone = parsedKey.rootSemitone;
  if (spec.mode === 'major' && parsedKey.mode === 'minor') {
    baseSemitone = (baseSemitone + 3) % 12;
  } else if (spec.mode === 'minor' && parsedKey.mode === 'major') {
    baseSemitone = (baseSemitone + 9) % 12;
  }
  return spec.steps.map(step => {
    const noteName = SHARP_NAMES[(baseSemitone + step.offset) % 12];
    return `${noteName}${step.quality}`;
  });
}

function applyVoicing(rootMidi, intervals, voicing = 'close', includeSub = false) {
  const mode = String(voicing || 'close').trim().toLowerCase();
  if (!VOICING_MODES.includes(mode)) {
    throw new Error(`voicing invalido: "${voicing}". Use um de: ${VOICING_MODES.join(', ')}.`);
  }

  let notes = [];
  if (mode === 'close') {
    notes = intervals.map(iv => rootMidi + iv);
  } else if (mode === 'spread') {
    // Baixo 1 oitava abaixo + 5a no centro + 3a/7a/extensoes abertas acima
    const bass = Math.max(24, rootMidi - 12);
    notes.push(bass);
    for (const iv of intervals) {
      if (iv === 0) continue;
      if (iv === 3 || iv === 4) notes.push(rootMidi + iv + 12);
      else notes.push(rootMidi + iv);
    }
  } else if (mode === 'supersaw') {
    // Wall-of-sound Future Bass / Melodic Dubstep: sub + oitava grave + 5a + acorde cheio + brilho no topo
    const sub = rootMidi - 24 >= 24 ? rootMidi - 24 : Math.max(24, rootMidi - 12);
    const lowRoot = Math.max(36, rootMidi - 12);
    const lowFifth = lowRoot + 7;
    const topLead = rootMidi + (intervals[intervals.length - 1] || 12) + (intervals[intervals.length - 1] < 12 ? 12 : 0);
    notes.push(sub, lowRoot, lowFifth, ...intervals.map(iv => rootMidi + iv), topLead);
  } else if (mode === 'colour_bass') {
    // Carrier limpo para Vocoder / PitchMap / Resonator: fundamental sub profunda + extensoes altas sem embolar medio-grave
    const sub = rootMidi - 24 >= 24 ? rootMidi - 24 : Math.max(24, rootMidi - 12);
    notes.push(sub, rootMidi);
    for (const iv of intervals) {
      if (iv === 0) continue;
      if (iv <= 4) notes.push(rootMidi + iv + 12); // joga a 3a pra oitava de cima pra nao sujar o grave
      else notes.push(rootMidi + iv + (iv < 10 ? 12 : 0));
    }
  }

  if (includeSub) {
    const sub = rootMidi - 24 >= 24 ? rootMidi - 24 : Math.max(24, rootMidi - 12);
    notes.unshift(sub);
  }

  return [...new Set(notes.map(clampMidi).filter(n => n >= 0 && n <= 127))].sort((a, b) => a - b);
}

export function expandChordName(chordInput, defaultOctave = 4, options = {}) {
  const raw = String(chordInput ?? '').trim();
  const match = /^([A-Ga-g])([#b]?)(.*?)(-?\d)?$/.exec(raw);
  if (!match) {
    throw new Error(`Acorde invalido: "${raw}". Exemplos validos: C, Am, F#m7, Bbmaj9, G7sus4, Dm11.`);
  }
  const letter = match[1].toUpperCase();
  const accidental = match[2] === '#' ? '#' : (match[2] ? 'B' : '');
  let quality = (match[3] || '').trim();
  let octave = match[4] !== undefined ? Number.parseInt(match[4], 10) : defaultOctave;

  // Caso especial de acorde com sufixos numericos ('5', '6', '69', '7', '9', '11', '7sus4', '9sus4', 'm7b5') sem oitava separada
  if (match[4] !== undefined && Object.prototype.hasOwnProperty.call(CHORD_INTERVALS, `${quality}${match[4]}`)) {
    quality = `${quality}${match[4]}`;
    octave = defaultOctave;
  }

  const intervals = CHORD_INTERVALS[quality];
  if (!intervals) {
    throw new Error(`Qualidade de acorde nao suportada em "${raw}": "${quality}".`);
  }
  const rootSemitone = NOTE_SEMITONES[`${letter}${accidental}`];
  const rootMidi = (octave + 1) * 12 + rootSemitone;
  const voicing = options?.voicing || 'close';
  const includeSub = Boolean(options?.includeSub);
  return applyVoicing(rootMidi, intervals, voicing, includeSub);
}

export function validateTransportArgs(args = {}) {
  const action = String(args.action ?? '').trim().toLowerCase();
  if (!TRANSPORT_ACTIONS.includes(action)) {
    throw new Error(`action invalida: "${action}". Use um de: ${TRANSPORT_ACTIONS.join(', ')}.`);
  }
  const out = { action };
  if (action === 'set_bpm') {
    const bpm = Number(args.bpm);
    if (!Number.isFinite(bpm) || bpm < 20 || bpm > 522) {
      throw new Error('bpm deve ser um numero entre 20 e 522.');
    }
    out.bpm = Math.round(bpm * 1000) / 1000;
  }
  if (action === 'jump_marker') {
    const delta = args.delta === undefined ? 1 : Number(args.delta);
    if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 64) {
      throw new Error('delta deve ser inteiro diferente de zero entre -64 e 64.');
    }
    out.delta = delta;
    if (args.select !== undefined) out.select = Boolean(args.select);
  }
  if (action === 'add_marker' && args.markerName !== undefined) {
    const clean = String(args.markerName).trim().slice(0, 48);
    if (!clean) throw new Error('markerName nao pode ser vazio.');
    out.markerName = clean;
  }
  return out;
}

export function validateMixerArgs(args = {}) {
  const out = {};
  if (args.track !== undefined) {
    if (!Number.isInteger(args.track) || args.track < 0 || args.track > 126) {
      throw new Error('track deve ser inteiro entre 0 (Master) e 126.');
    }
    out.track = args.track;
  }
  if (args.trackName !== undefined) {
    const clean = String(args.trackName).trim();
    if (!clean) throw new Error('trackName nao pode ser vazio.');
    out.trackName = clean.slice(0, 64);
  }
  if (args.volumePercent !== undefined) {
    const pct = Number(args.volumePercent);
    if (!Number.isFinite(pct) || pct < 0 || pct > 125) {
      throw new Error('volumePercent deve ser entre 0 e 125 (100 = 0 dB / 0.8 no FL).');
    }
    out.volume = Math.min(1, Math.max(0, Math.round((pct * 0.008) * 10000) / 10000));
  } else if (args.volume !== undefined) {
    const vol = Number(args.volume);
    if (!Number.isFinite(vol) || vol < 0 || vol > 1) {
      throw new Error('volume deve ser um numero entre 0.0 e 1.0.');
    }
    out.volume = Math.round(vol * 10000) / 10000;
  }
  if (args.pan !== undefined) {
    const pan = Number(args.pan);
    if (!Number.isFinite(pan) || pan < -1 || pan > 1) {
      throw new Error('pan deve ser um numero entre -1.0 (esquerda) e 1.0 (direita).');
    }
    out.pan = Math.round(pan * 10000) / 10000;
  }
  if (args.mute !== undefined) {
    if (typeof args.mute !== 'boolean') throw new Error('mute deve ser booleano.');
    out.mute = args.mute;
  }
  if (args.solo !== undefined) {
    if (typeof args.solo !== 'boolean') throw new Error('solo deve ser booleano.');
    out.solo = args.solo;
  }
  if (args.name !== undefined) {
    const name = String(args.name).trim().slice(0, 48);
    if (!name) throw new Error('name nao pode ser vazio.');
    out.name = name;
  }
  if (args.select !== undefined) {
    if (typeof args.select !== 'boolean') throw new Error('select deve ser booleano.');
    out.select = args.select;
  }
  const hasMutation = out.volume !== undefined || out.pan !== undefined || out.mute !== undefined
    || out.solo !== undefined || out.name !== undefined || out.select !== undefined;
  if (!hasMutation) {
    throw new Error('Informe ao menos uma alteracao no mixer (volumePercent, volume, pan, mute, solo, name ou select).');
  }
  return out;
}

export function validateStepsArgs(args = {}) {
  const mode = String(args.mode || 'replace').trim().toLowerCase();
  if (!STEPS_MODES.includes(mode)) {
    throw new Error(`mode invalido: "${mode}". Use um de: ${STEPS_MODES.join(', ')}.`);
  }
  const length = args.length === undefined ? 16 : Number(args.length);
  if (!Number.isInteger(length) || length < 1 || length > 64) {
    throw new Error('length deve ser inteiro entre 1 e 64.');
  }
  const out = { mode, length };
  if (args.channel !== undefined) {
    if (!Number.isInteger(args.channel) || args.channel < 0 || args.channel > 127) {
      throw new Error('channel deve ser inteiro entre 0 e 127.');
    }
    out.channel = args.channel;
  }
  if (args.channelName !== undefined) {
    const clean = String(args.channelName).trim();
    if (!clean) throw new Error('channelName nao pode ser vazio.');
    out.channelName = clean.slice(0, 64);
  }
  if (args.pattern !== undefined) {
    if (!Number.isInteger(args.pattern) || args.pattern < 1 || args.pattern > 999) {
      throw new Error('pattern deve ser inteiro entre 1 e 999.');
    }
    out.pattern = args.pattern;
  }

  let steps = [];
  if (args.preset !== undefined) {
    const key = String(args.preset).trim().toLowerCase();
    const presetSteps = STEP_PRESETS[key];
    if (!presetSteps) {
      throw new Error(`preset desconhecido: "${args.preset}". Disponiveis: ${Object.keys(STEP_PRESETS).join(', ')}.`);
    }
    // Se length for multiplo de 16 (ex.: 32 ou 64), repete o padrao de 16 steps nos compassos seguintes
    const tiled = [];
    const bars = Math.max(1, Math.ceil(length / 16));
    for (let bar = 0; bar < bars; bar += 1) {
      for (const s of presetSteps) {
        const idx = bar * 16 + s;
        if (idx < length) tiled.push(idx);
      }
    }
    steps = [...new Set(tiled)].sort((a, b) => a - b);
  } else if (args.steps !== undefined) {
    if (!Array.isArray(args.steps)) {
      throw new Error('steps deve ser uma lista de indices inteiros (0 a 63).');
    }
    for (const s of args.steps) {
      if (!Number.isInteger(s) || s < 0 || s >= length) {
        throw new Error(`Step invalido (${s}) para length=${length}.`);
      }
    }
    steps = [...new Set(args.steps)].sort((a, b) => a - b);
  } else if (mode === 'replace' || mode === 'add') {
    throw new Error('Informe steps (lista de indices) ou preset para mode replace/add.');
  }

  out.steps = steps.filter(s => s < length);
  return out;
}

export function validatePluginArgs(args = {}) {
  const target = String(args.target || 'channel').trim().toLowerCase();
  if (!PLUGIN_TARGETS.includes(target)) {
    throw new Error(`target invalido: "${target}". Use channel ou mixer.`);
  }
  const action = String(args.action || 'list_params').trim().toLowerCase();
  if (!PLUGIN_ACTIONS.includes(action)) {
    throw new Error(`action invalida: "${action}". Use um de: ${PLUGIN_ACTIONS.join(', ')}.`);
  }

  const out = { target, action };
  if (target === 'channel') {
    if (args.channel !== undefined) {
      if (!Number.isInteger(args.channel) || args.channel < 0 || args.channel > 127) {
        throw new Error('channel deve ser inteiro entre 0 e 127.');
      }
      out.channel = args.channel;
    }
    if (args.channelName !== undefined) {
      const clean = String(args.channelName).trim();
      if (!clean) throw new Error('channelName nao pode ser vazio.');
      out.channelName = clean.slice(0, 64);
    }
  } else {
    if (args.track !== undefined) {
      if (!Number.isInteger(args.track) || args.track < 0 || args.track > 126) {
        throw new Error('track deve ser inteiro entre 0 e 126.');
      }
      out.track = args.track;
    }
    if (args.trackName !== undefined) {
      const clean = String(args.trackName).trim();
      if (!clean) throw new Error('trackName nao pode ser vazio.');
      out.trackName = clean.slice(0, 64);
    }
    const slot = args.slot === undefined ? 0 : Number(args.slot);
    if (!Number.isInteger(slot) || slot < 0 || slot > 9) {
      throw new Error('slot deve ser inteiro entre 0 e 9.');
    }
    out.slot = slot;
  }

  if (action === 'list_params') {
    if (args.filter !== undefined) out.filter = String(args.filter).trim().slice(0, 48);
    if (args.limit !== undefined) {
      if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 40) {
        throw new Error('limit deve ser inteiro entre 1 e 40.');
      }
      out.limit = args.limit;
    }
    if (args.offset !== undefined) {
      if (!Number.isInteger(args.offset) || args.offset < 0) {
        throw new Error('offset deve ser inteiro >= 0.');
      }
      out.offset = args.offset;
    }
  }

  if (action === 'set_param') {
    if (args.paramIndex === undefined && !args.paramName) {
      throw new Error('Informe paramIndex ou paramName para action=set_param.');
    }
    if (args.paramIndex !== undefined) {
      if (!Number.isInteger(args.paramIndex) || args.paramIndex < 0) {
        throw new Error('paramIndex deve ser inteiro >= 0.');
      }
      out.paramIndex = args.paramIndex;
    }
    if (args.paramName !== undefined) {
      const clean = String(args.paramName).trim();
      if (!clean) throw new Error('paramName nao pode ser vazio.');
      out.paramName = clean.slice(0, 64);
    }
    const val = Number(args.value);
    if (!Number.isFinite(val) || val < 0 || val > 1) {
      throw new Error('value deve ser numero normalizado entre 0.0 e 1.0.');
    }
    out.value = Math.round(val * 10000) / 10000;
  }

  return out;
}

export function validateMidiArgs(args = {}) {
  const midiChannel = args.midiChannel === undefined ? 0 : Number(args.midiChannel);
  if (!Number.isInteger(midiChannel) || midiChannel < 0 || midiChannel > 15) {
    throw new Error('midiChannel deve ser inteiro entre 0 e 15.');
  }
  const velocity = args.velocity === undefined ? 100 : Number(args.velocity);
  if (!Number.isInteger(velocity) || velocity < 1 || velocity > 127) {
    throw new Error('velocity deve ser inteiro entre 1 e 127.');
  }
  const durationMs = args.durationMs === undefined ? 400 : Number(args.durationMs);
  if (!Number.isInteger(durationMs) || durationMs < 40 || durationMs > 4000) {
    throw new Error('durationMs deve ser inteiro entre 40 e 4000.');
  }
  const octave = args.octave === undefined ? 4 : Number(args.octave);
  if (!Number.isInteger(octave) || octave < 0 || octave > 8) {
    throw new Error('octave deve ser inteiro entre 0 e 8.');
  }
  const voicing = args.voicing === undefined ? 'close' : String(args.voicing).trim().toLowerCase();
  if (!VOICING_MODES.includes(voicing)) {
    throw new Error(`voicing invalido: "${voicing}". Use um de: ${VOICING_MODES.join(', ')}.`);
  }
  const arpeggio = Boolean(args.arpeggio);
  const events = [];

  const resolvedChords = Array.isArray(args.chords) && args.chords.length > 0
    ? args.chords
    : (args.progression ? buildProgressionChords(args.progression, args.key || 'C') : []);

  if (resolvedChords.length > 0) {
    for (const chord of resolvedChords) {
      const chordNotes = expandChordName(chord, octave, { voicing, includeSub: Boolean(args.includeSub) });
      if (arpeggio) {
        const noteDur = Math.max(40, Math.min(4000, Math.round(durationMs / Math.max(1, chordNotes.length))));
        for (const note of chordNotes) {
          events.push({ notes: [note], velocity, durationMs: noteDur, delayMs: 0 });
        }
      } else {
        events.push({ notes: chordNotes, velocity, durationMs, delayMs: 0 });
      }
    }
  }

  if (Array.isArray(args.notes) && args.notes.length > 0) {
    for (const item of args.notes) {
      if (Array.isArray(item)) {
        const parsedGroup = item.map(parseNoteName);
        events.push({ notes: parsedGroup, velocity, durationMs, delayMs: 0 });
      } else {
        events.push({ notes: [parseNoteName(item)], velocity, durationMs, delayMs: 0 });
      }
    }
  }

  if (events.length === 0) {
    throw new Error('Informe notes, chords ou progression (ex.: kawaii_royal_road, colour_bass_prism).');
  }
  if (events.length > 64) {
    throw new Error(`Limite de 64 eventos MIDI excedido (${events.length}).`);
  }
  const totalMs = events.reduce((acc, ev) => acc + ev.durationMs + ev.delayMs, 0);
  if (totalMs > 15000) {
    throw new Error(`Duracao total da sequencia (${totalMs} ms) excede o limite de 15000 ms.`);
  }

  const out = { channel: midiChannel, events };
  if (args.targetChannel !== undefined) {
    if (!Number.isInteger(args.targetChannel) || args.targetChannel < 0 || args.targetChannel > 127) {
      throw new Error('targetChannel deve ser inteiro entre 0 e 127.');
    }
    out.targetChannel = args.targetChannel;
  }
  if (args.targetChannelName !== undefined) {
    const clean = String(args.targetChannelName).trim();
    if (!clean) throw new Error('targetChannelName nao pode ser vazio.');
    out.targetChannelName = clean.slice(0, 64);
  }
  return out;
}

export function sanitizeMidiFileName(rawName, fallbackSlug = 'usami-pattern') {
  const base = String(rawName ?? fallbackSlug)
    .trim()
    .replace(/\.midi?$/i, '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 60);
  const safe = base || fallbackSlug;
  return `${safe}.mid`;
}

/**
 * Gera a lista de notas agendadas em ticks para exportacao `.mid` nos estilos
 * Future Bass, Kawaii Future Bass, Colour Bass, Melodic Dubstep, Riddim e Brostep.
 */
export function buildMidiScoreEvents(args = {}) {
  const style = String(args.style || 'future_bass_pump').trim().toLowerCase();
  if (!MIDI_STYLES.includes(style)) {
    throw new Error(`style invalido: "${style}". Use um de: ${MIDI_STYLES.join(', ')}.`);
  }

  const progSpec = args.progression ? GENRE_PROGRESSIONS[String(args.progression).trim().toLowerCase()] : null;
  if (args.progression && !progSpec) {
    throw new Error(`progression desconhecida: "${args.progression}". Disponiveis: ${Object.keys(GENRE_PROGRESSIONS).join(', ')}.`);
  }

  const bpm = args.bpm === undefined ? (progSpec?.defaultBpm || 145) : Number(args.bpm);
  if (!Number.isFinite(bpm) || bpm < 20 || bpm > 522) {
    throw new Error('bpm deve ser um numero entre 20 e 522.');
  }

  const barsPerChord = args.barsPerChord === undefined ? 1 : Number(args.barsPerChord);
  if (!Number.isInteger(barsPerChord) || barsPerChord < 1 || barsPerChord > 8) {
    throw new Error('barsPerChord deve ser inteiro entre 1 e 8.');
  }

  const defaultOctave = (style === 'riddim_bass' || style === 'brostep_riff') ? 1 : 4;
  const octave = args.octave === undefined ? defaultOctave : Number(args.octave);
  if (!Number.isInteger(octave) || octave < 0 || octave > 7) {
    throw new Error('octave deve ser inteiro entre 0 e 7.');
  }

  const velocity = args.velocity === undefined ? 105 : Number(args.velocity);
  if (!Number.isInteger(velocity) || velocity < 1 || velocity > 127) {
    throw new Error('velocity deve ser inteiro entre 1 e 127.');
  }

  const defaultVoicing = style === 'colour_bass' || args.progression === 'colour_bass_prism'
    ? 'colour_bass'
    : (style === 'future_bass_pump' || style === 'melodic_dubstep_stack' ? 'supersaw' : (progSpec?.defaultVoicing || 'spread'));
  const voicing = args.voicing ? String(args.voicing).trim().toLowerCase() : defaultVoicing;
  if (!VOICING_MODES.includes(voicing)) {
    throw new Error(`voicing invalido: "${voicing}". Use um de: ${VOICING_MODES.join(', ')}.`);
  }

  const keyInfo = parseKeySignature(args.key || 'C');
  const sixteenth = DEFAULT_TPQ / 4; // 120 ticks
  const barTicks = sixteenth * 16;   // 1920 ticks (4/4)
  const scheduledNotes = [];

  // Caso 1: notas soltas customizadas (melodia/riff explicito)
  if (Array.isArray(args.notes) && args.notes.length > 0 && (!args.chords || args.chords.length === 0) && !args.progression) {
    let cursor = 0;
    const stepTicks = sixteenth * 2; // colcheias por padrao
    for (const item of args.notes.slice(0, 128)) {
      const pitches = Array.isArray(item) ? item.map(parseNoteName) : [parseNoteName(item)];
      for (const pitch of pitches) {
        scheduledNotes.push({ startTick: cursor, durationTicks: stepTicks - 10, pitch, velocity });
      }
      cursor += stepTicks;
    }
    const barsTotal = Math.max(1, Math.ceil(cursor / barTicks));
    const fileName = sanitizeMidiFileName(args.fileName, `usami-custom-${Math.round(bpm)}bpm`);
    return {
      fileName,
      style,
      bpm: Math.round(bpm * 100) / 100,
      key: keyInfo.label,
      voicing,
      chordsUsed: [],
      barsTotal,
      notes: scheduledNotes,
    };
  }

  // Caso 2: progressao de acordes (explicita ou por preset de genero)
  const chordsUsed = Array.isArray(args.chords) && args.chords.length > 0
    ? args.chords.slice(0, 16)
    : buildProgressionChords(
      args.progression || (
        style === 'kawaii_arp' ? 'kawaii_royal_road'
          : style === 'melodic_dubstep_stack' ? 'melodic_dubstep_epic'
            : style === 'riddim_bass' ? 'riddim_dark'
              : style === 'brostep_riff' ? 'brostep_drop'
                : 'future_bass_anthem'
      ),
      args.key || 'C',
    );

  const includeSub = Boolean(args.includeSub);

  chordsUsed.forEach((chordName, chordIdx) => {
    const chordStart = chordIdx * barsPerChord * barTicks;
    const spanTicks = barsPerChord * barTicks;
    const chordPitches = expandChordName(chordName, octave, { voicing, includeSub });
    const rootPitch = expandChordName(chordName, Math.min(2, octave), { voicing: 'close' })[0];

    if (style === 'sustained') {
      for (const pitch of chordPitches) {
        scheduledNotes.push({
          startTick: chordStart,
          durationTicks: spanTicks - 15,
          pitch,
          velocity,
        });
      }
      return;
    }

    if (style === 'future_bass_pump') {
      // Chops sincopados classicos de Future Bass em cada compasso (steps: 0..3, 3..6, 6..10, 10..12, 12..14, 14..16)
      const slices = [
        [0, 3],
        [3, 6],
        [6, 10],
        [10, 12],
        [12, 14],
        [14, 16],
      ];
      for (let b = 0; b < barsPerChord; b += 1) {
        const barBase = chordStart + b * barTicks;
        for (const [s0, s1] of slices) {
          const st = barBase + s0 * sixteenth;
          const dur = (s1 - s0) * sixteenth - 20; // gate leve para retrigger de LFO/envelope
          for (const pitch of chordPitches) {
            scheduledNotes.push({ startTick: st, durationTicks: dur, pitch, velocity });
          }
        }
      }
      return;
    }

    if (style === 'melodic_dubstep_stack') {
      // Half-time wall-of-sound: impacto longo ate o snare (0..8), sustentacao pos-snare (8..14) e pickup (14..16)
      const slices = [
        [0, 8, velocity],
        [8, 14, Math.max(70, velocity - 8)],
        [14, 16, Math.min(127, velocity + 6)],
      ];
      for (let b = 0; b < barsPerChord; b += 1) {
        const barBase = chordStart + b * barTicks;
        for (const [s0, s1, vel] of slices) {
          const st = barBase + s0 * sixteenth;
          const dur = (s1 - s0) * sixteenth - 15;
          for (const pitch of chordPitches) {
            scheduledNotes.push({ startTick: st, durationTicks: dur, pitch, velocity: vel });
          }
        }
      }
      return;
    }

    if (style === 'kawaii_arp') {
      // Cama harmonica suave + arpejo cintilante 1/16 subindo e descendo nas oitavas altas
      const arpPool = expandChordName(chordName, Math.min(6, octave + 1), { voicing: 'close' });
      const sparkling = [...arpPool, clampMidi(arpPool[0] + 12), clampMidi(arpPool[Math.min(1, arpPool.length - 1)] + 12)];
      const totalSixteenths = barsPerChord * 16;

      // Sub/base suave sustentada
      scheduledNotes.push({
        startTick: chordStart,
        durationTicks: spanTicks - 20,
        pitch: clampMidi(rootPitch),
        velocity: Math.max(60, velocity - 25),
      });

      for (let step = 0; step < totalSixteenths; step += 1) {
        // Movimento up-down
        const cycleLen = Math.max(1, sparkling.length * 2 - 2);
        const pos = step % cycleLen;
        const idx = pos < sparkling.length ? pos : cycleLen - pos;
        const pitch = sparkling[idx % sparkling.length];
        const accent = (step % 4 === 0) ? Math.min(127, velocity + 8) : Math.max(65, velocity - 10);
        scheduledNotes.push({
          startTick: chordStart + step * sixteenth,
          durationTicks: sixteenth - 15,
          pitch,
          velocity: accent,
        });
      }
      return;
    }

    if (style === 'riddim_bass') {
      // Stabs ritmicos graves em colcheias/semicolcheias para disparar LFO de Serum/Vital, com salto de semitom no fim
      const baseBass = clampMidi(((octave + 1) * 12) + (rootPitch % 12));
      const pattern = [
        [0, 2, 0],
        [2, 2, 0],
        [4, 2, 0],
        [6, 2, 0],
        [8, 2, 0],
        [10, 2, 0],
        [12, 2, 1], // tensao frigia (+1 semitom)
        [14, 1, 0],
        [15, 1, 12], // oitava acima no turnaround
      ];
      for (let b = 0; b < barsPerChord; b += 1) {
        const barBase = chordStart + b * barTicks;
        for (const [s0, lenSteps, semiOffset] of pattern) {
          scheduledNotes.push({
            startTick: barBase + s0 * sixteenth,
            durationTicks: lenSteps * sixteenth - 15,
            pitch: clampMidi(baseBass + semiOffset),
            velocity,
          });
        }
      }
      return;
    }

    if (style === 'brostep_riff') {
      // Riff agressivo com growl downbeat longo + stabs de oitava e cromatismo pre-caixa
      const baseBass = clampMidi(((octave + 1) * 12) + (rootPitch % 12));
      const pattern = [
        [0, 4, 0, Math.min(127, velocity + 10)],
        [4, 2, 12, velocity],
        [6, 2, 1, velocity],
        [8, 3, 0, Math.min(127, velocity + 8)], // impacto junto ao snare half-time
        [11, 1, 7, velocity],
        [12, 2, 3, velocity],
        [14, 1, 1, velocity],
        [15, 1, 12, Math.min(127, velocity + 6)],
      ];
      for (let b = 0; b < barsPerChord; b += 1) {
        const barBase = chordStart + b * barTicks;
        for (const [s0, lenSteps, semiOffset, vel] of pattern) {
          scheduledNotes.push({
            startTick: barBase + s0 * sixteenth,
            durationTicks: lenSteps * sixteenth - 15,
            pitch: clampMidi(baseBass + semiOffset),
            velocity: vel,
          });
        }
      }
    }
  });

  const barsTotal = chordsUsed.length * barsPerChord;
  const slugStyle = style.replace(/_/g, '-');
  const fileName = sanitizeMidiFileName(args.fileName, `${slugStyle}-${keyInfo.label}-${Math.round(bpm)}bpm`);

  return {
    fileName,
    style,
    bpm: Math.round(bpm * 100) / 100,
    key: keyInfo.label,
    voicing,
    chordsUsed,
    barsTotal,
    notes: scheduledNotes,
  };
}

export function validateUndoArgs(args = {}) {
  const direction = String(args.direction || 'undo').trim().toLowerCase();
  if (!UNDO_DIRECTIONS.includes(direction)) {
    throw new Error(`direction invalido: "${direction}". Use undo ou redo.`);
  }
  return { direction };
}

export function validateRoutingArgs(args = {}) {
  const mode = String(args.mode || 'sidechain').trim().toLowerCase();
  if (!ROUTING_MODES.includes(mode)) {
    throw new Error(`mode invalido: "${mode}". Use um de: ${ROUTING_MODES.join(', ')}.`);
  }

  if (mode === 'channel_to_mixer') {
    const rawList = Array.isArray(args.assignments) && args.assignments.length > 0
      ? args.assignments
      : [{
          channel: args.channel,
          channelName: args.channelName,
          track: args.track ?? args.destTrack,
          trackName: args.trackName ?? args.destTrackName,
        }];
    if (rawList.length > 16) {
      throw new Error('assignments suporta no maximo 16 canais por chamada.');
    }
    const assignments = rawList.map((item, idx) => {
      if (!item || typeof item !== 'object') {
        throw new Error(`assignment[${idx}] invalido.`);
      }
      const entry = {};
      if (item.channel !== undefined) {
        if (!Number.isInteger(item.channel) || item.channel < 0 || item.channel > 255) {
          throw new Error(`assignment[${idx}].channel deve ser inteiro entre 0 e 255.`);
        }
        entry.channel = item.channel;
      }
      if (item.channelName !== undefined) {
        const chName = String(item.channelName).trim();
        if (!chName) throw new Error(`assignment[${idx}].channelName nao pode ser vazio.`);
        entry.channelName = chName.slice(0, 64);
      }
      if (entry.channel === undefined && !entry.channelName) {
        throw new Error(`assignment[${idx}] precisa de channel ou channelName.`);
      }
      const tr = item.track ?? item.destTrack;
      const trName = item.trackName ?? item.destTrackName;
      if (tr !== undefined) {
        if (!Number.isInteger(tr) || tr < 0 || tr > 126) {
          throw new Error(`assignment[${idx}].track deve ser inteiro entre 0 e 126.`);
        }
        entry.track = tr;
      }
      if (trName !== undefined) {
        const cleanTr = String(trName).trim();
        if (!cleanTr) throw new Error(`assignment[${idx}].trackName nao pode ser vazio.`);
        entry.trackName = cleanTr.slice(0, 64);
      }
      if (entry.track === undefined && !entry.trackName) {
        throw new Error(`assignment[${idx}] precisa de track ou trackName.`);
      }
      return entry;
    });
    return { mode, assignments };
  }

  const out = { mode };
  if (args.sourceTrack !== undefined) {
    if (!Number.isInteger(args.sourceTrack) || args.sourceTrack < 0 || args.sourceTrack > 126) {
      throw new Error('sourceTrack deve ser inteiro entre 0 e 126.');
    }
    out.sourceTrack = args.sourceTrack;
  }
  if (args.sourceTrackName !== undefined) {
    const clean = String(args.sourceTrackName).trim();
    if (!clean) throw new Error('sourceTrackName nao pode ser vazio.');
    out.sourceTrackName = clean.slice(0, 64);
  }
  if (out.sourceTrack === undefined && !out.sourceTrackName) {
    throw new Error('Informe sourceTrack ou sourceTrackName.');
  }

  if (mode === 'inspect') {
    return out;
  }

  if (Array.isArray(args.destTracks) && args.destTracks.length > 0) {
    for (const dt of args.destTracks) {
      if (!Number.isInteger(dt) || dt < 0 || dt > 126) {
        throw new Error(`destTracks contem indice invalido: ${dt}`);
      }
    }
    out.destTracks = [...new Set(args.destTracks)];
  } else if (Array.isArray(args.destTrackNames) && args.destTrackNames.length > 0) {
    out.destTrackNames = args.destTrackNames
      .map(s => String(s ?? '').trim().slice(0, 64))
      .filter(Boolean);
    if (out.destTrackNames.length === 0) {
      throw new Error('destTrackNames nao pode conter apenas strings vazias.');
    }
  } else if (args.destTrack !== undefined) {
    if (!Number.isInteger(args.destTrack) || args.destTrack < 0 || args.destTrack > 126) {
      throw new Error('destTrack deve ser inteiro entre 0 e 126.');
    }
    out.destTrack = args.destTrack;
  } else if (args.destTrackName !== undefined) {
    const clean = String(args.destTrackName).trim();
    if (!clean) throw new Error('destTrackName nao pode ser vazio.');
    out.destTrackName = clean.slice(0, 64);
  } else {
    throw new Error('Informe o destino da rota (destTrack, destTrackName, destTracks ou destTrackNames).');
  }

  if (args.levelPercent !== undefined) {
    const pct = Number(args.levelPercent);
    if (!Number.isFinite(pct) || pct < 0 || pct > 125) {
      throw new Error('levelPercent deve estar entre 0 e 125.');
    }
    out.level = Math.min(1, Math.max(0, Math.round((pct * 0.008) * 10000) / 10000));
  } else if (args.level !== undefined) {
    const lvl = Number(args.level);
    if (!Number.isFinite(lvl) || lvl < 0 || lvl > 1) {
      throw new Error('level deve estar entre 0.0 e 1.0.');
    }
    out.level = Math.round(lvl * 10000) / 10000;
  }

  return out;
}

export function validateEqArgs(args = {}) {
  const out = {};
  if (args.track !== undefined) {
    if (!Number.isInteger(args.track) || args.track < 0 || args.track > 126) {
      throw new Error('track deve ser inteiro entre 0 e 126.');
    }
    out.track = args.track;
  }
  if (args.trackName !== undefined) {
    const clean = String(args.trackName).trim();
    if (!clean) throw new Error('trackName nao pode ser vazio.');
    out.trackName = clean.slice(0, 64);
  }
  if (args.preset !== undefined) {
    const preset = String(args.preset).trim().toLowerCase();
    if (!EQ_PRESETS.includes(preset)) {
      throw new Error(`preset de EQ invalido: "${args.preset}". Use um de: ${EQ_PRESETS.join(', ')}.`);
    }
    out.preset = preset;
  }
  for (const bandField of ['lowGainDb', 'midGainDb', 'highGainDb']) {
    if (args[bandField] !== undefined) {
      const val = Number(args[bandField]);
      if (!Number.isFinite(val) || val < -18 || val > 18) {
        throw new Error(`${bandField} deve ser numero entre -18 e 18 dB.`);
      }
      out[bandField] = Math.round(val * 100) / 100;
    }
  }
  if (args.mono !== undefined) {
    if (typeof args.mono !== 'boolean') throw new Error('mono deve ser booleano.');
    out.mono = args.mono;
  }
  if (args.stereoWidth !== undefined) {
    const w = Number(args.stereoWidth);
    if (!Number.isFinite(w) || w < -100 || w > 100) {
      throw new Error('stereoWidth deve estar entre -100 (100% Mono) e 100 (100% Aberto).');
    }
    out.stereoWidth = Math.round(w * 10) / 10;
  }

  const hasChange = Boolean(out.preset)
    || out.lowGainDb !== undefined
    || out.midGainDb !== undefined
    || out.highGainDb !== undefined
    || out.mono !== undefined
    || out.stereoWidth !== undefined;
  if (!hasChange) {
    throw new Error('Informe ao menos um ajuste em fl.eq (preset, lowGainDb, midGainDb, highGainDb, mono ou stereoWidth).');
  }
  return out;
}

export function validateListenArgs(args = {}) {
  const source = String(args.source || (args.filePath ? 'file' : 'loopback')).trim().toLowerCase();
  if (!LISTEN_SOURCES.includes(source)) {
    throw new Error(`source invalido: "${source}". Use loopback ou file.`);
  }
  const durationSec = args.durationSec === undefined ? 2.5 : Number(args.durationSec);
  if (!Number.isFinite(durationSec) || durationSec < 0.5 || durationSec > 8.0) {
    throw new Error('durationSec deve ser numero entre 0.5 e 8.0 segundos.');
  }
  const genre = String(args.genre || 'future_bass').trim().toLowerCase();
  if (!LISTEN_GENRES.includes(genre)) {
    throw new Error(`genre invalido: "${genre}". Use um de: ${LISTEN_GENRES.join(', ')}.`);
  }
  const out = { source, durationSec: Math.round(durationSec * 100) / 100, genre };
  if (source === 'file') {
    const clean = String(args.filePath ?? '').trim();
    if (!clean) {
      throw new Error('filePath e obrigatorio quando source=file.');
    }
    if (!/\.wav$/i.test(clean)) {
      throw new Error('fl.listen em modo file aceita apenas arquivos .wav.');
    }
    out.filePath = clean;
  }
  return out;
}
