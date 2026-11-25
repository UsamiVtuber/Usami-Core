/**
 * Motor puro de composicao vocal, silabificacao fonetica CV (PT-BR / JP / EN)
 * e geracao de projetos OpenUTAU (`.ustx` YAML 1.2 + `.ust` v1.20) para a Usami.
 *
 * 100% puro JS (sem I/O, sem rede, compativel com sandbox da skill).
 */
import { DEFAULT_TPQ } from './fl-midi-writer.mjs';
import {
  GENRE_PROGRESSIONS,
  buildProgressionChords,
  expandChordName,
  parseKeySignature,
  parseNoteName,
} from './fl-core.mjs';

export const VOCAL_ACTIONS = Object.freeze(['compose', 'convert', 'status', 'open']);
export const VOCAL_ENGINES = Object.freeze(['classic', 'diffsinger']);
export const VOCAL_STYLES = Object.freeze([
  'kawaii_hook',
  'future_bass_anthem',
  'melodic_dubstep_soar',
  'colour_bass_chop',
  'dubstep_pre_drop',
]);
export const VOCAL_LANGUAGES = Object.freeze(['auto', 'pt', 'ja', 'en']);

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// Mapa Hiragana -> Romaji CV basico
const HIRAGANA_TO_CV = Object.freeze({
  '\u3042': 'a', '\u3044': 'i', '\u3046': 'u', '\u3048': 'e', '\u304a': 'o',
  '\u304b': 'ka', '\u304d': 'ki', '\u304f': 'ku', '\u3051': 'ke', '\u3053': 'ko',
  '\u3055': 'sa', '\u3057': 'shi', '\u3059': 'su', '\u305b': 'se', '\u305d': 'so',
  '\u305f': 'ta', '\u3061': 'chi', '\u3064': 'tsu', '\u3066': 'te', '\u3068': 'to',
  '\u306a': 'na', '\u306b': 'ni', '\u306c': 'nu', '\u306d': 'ne', '\u306e': 'no',
  '\u306f': 'ha', '\u3072': 'hi', '\u3075': 'fu', '\u3078': 'he', '\u307b': 'ho',
  '\u307e': 'ma', '\u307f': 'mi', '\u3080': 'mu', '\u3081': 'me', '\u3082': 'mo',
  '\u3084': 'ya', '\u3086': 'yu', '\u3088': 'yo',
  '\u3089': 'ra', '\u308a': 'ri', '\u308b': 'ru', '\u308c': 're', '\u308d': 'ro',
  '\u308f': 'wa', '\u3092': 'o', '\u3093': 'n',
  '\u304c': 'ga', '\u304e': 'gi', '\u3050': 'gu', '\u3052': 'ge', '\u3054': 'go',
  '\u3056': 'za', '\u3058': 'ji', '\u305a': 'zu', '\u305c': 'ze', '\u305e': 'zo',
  '\u3060': 'da', '\u3062': 'ji', '\u3065': 'zu', '\u3067': 'de', '\u3069': 'do',
  '\u3070': 'ba', '\u3073': 'bi', '\u3076': 'bu', '\u3079': 'be', '\u307c': 'bo',
  '\u3071': 'pa', '\u3074': 'pi', '\u3077': 'pu', '\u307a': 'pe', '\u307d': 'po',
});

// Aliases CV validos no voicebank Usami_CV (e compativeis com bancos UTAU padrao)
const VALID_CONSONANTS = new Set([
  '', 'k', 's', 'sh', 't', 'ch', 'ts', 'n', 'nh', 'h', 'f', 'm', 'y', 'r', 'l', 'lh', 'w', 'v', 'g', 'z', 'j', 'd', 'b', 'p',
]);

const DEFAULT_LYRICS_BY_STYLE = Object.freeze({
  kawaii_hook: 'vem brilhar comigo no ceu',
  future_bass_anthem: 'voa comigo ate o amanhecer',
  melodic_dubstep_soar: 'sente a luz que nasce em nos',
  colour_bass_chop: 'la la mi ra i ki ra',
  dubstep_pre_drop: 'escuta o grave cair agora',
});

function detectLanguage(text, requested = 'auto') {
  const req = String(requested || 'auto').trim().toLowerCase();
  if (req === 'pt' || req === 'ja' || req === 'en') return req;
  if (/[\u3040-\u30ff]/.test(text)) return 'ja';
  const lower = String(text || '').toLowerCase();
  if (/\b(?:kimi|boku|watashi|mirai|kokoro|sora|yume|hikari|koi|suki)\b/.test(lower)) return 'ja';
  if (/\b(?:the|you|with|night|light|dream|heart|sky|feel|tonight)\b/.test(lower)) return 'en';
  return 'pt';
}

function syllabifyJapanese(text) {
  const out = [];
  const raw = String(text || '').trim();
  // Se contiver Hiragana/Katakana, converte caractere por caractere
  if (/[\u3040-\u30ff]/.test(raw)) {
    for (const ch of raw) {
      const code = ch.charCodeAt(0);
      // Converte Katakana simples para Hiragana
      const normChar = (code >= 0x30A1 && code <= 0x30F6)
        ? String.fromCharCode(code - 0x60)
        : ch;
      if (HIRAGANA_TO_CV[normChar]) {
        out.push(HIRAGANA_TO_CV[normChar]);
      }
    }
    if (out.length > 0) return out;
  }

  // Romaji
  const cleaned = raw
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z\s]/g, ' ');
  const romajiRegex = /(tsu|shi|chi|sha|shu|sho|cha|chu|cho|nya|nyu|nyo|kya|kyu|kyo|ka|ki|ku|ke|ko|sa|su|se|so|ta|te|to|na|ni|nu|ne|no|ha|hi|fu|he|ho|ma|mi|mu|me|mo|ya|yu|yo|ra|ri|ru|re|ro|wa|wo|ga|gi|gu|ge|go|za|ji|zu|ze|zo|da|de|do|ba|bi|bu|be|bo|pa|pi|pu|pe|po|a|i|u|e|o|n)/g;
  for (const m of cleaned.matchAll(romajiRegex)) {
    const tok = m[1]
      .replace(/^nya$/, 'nha')
      .replace(/^nyu$/, 'nhu')
      .replace(/^nyo$/, 'nho')
      .replace(/^kya$/, 'ka')
      .replace(/^kyu$/, 'ku')
      .replace(/^kyo$/, 'ko');
    out.push(tok);
  }
  return out;
}

function syllabifyPortugueseWord(rawWord) {
  let w = rawWord
    .toLowerCase()
    .replace(/ç/g, 's')
    // Ditongos nasais finais (ex.: cancao -> kansa + u + n)
    .replace(/[ãâ]o$/g, 'aun')
    .replace(/[õô]es$/g, 'oins')
    .replace(/[ãâ]es$/g, 'ains')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z]/g, '');

  if (!w) return [];

  // Normalizacao fonetica do Portugues Brasileiro para grade CV limpa
  w = w
    .replace(/lh/g, 'L')
    .replace(/nh/g, 'N')
    .replace(/ch/g, 'S')
    .replace(/ss/g, 's')
    .replace(/rr/g, 'h')
    .replace(/^r([aeiou])/g, 'h$1')
    .replace(/qu([ei])/g, 'k$1')
    .replace(/qu([aou])/g, 'kw$1')
    .replace(/gu([ei])/g, 'g$1')
    .replace(/c([ei])/g, 's$1')
    .replace(/c([aou])/g, 'k$1')
    .replace(/g([ei])/g, 'j$1')
    .replace(/([aeiou])s([aeiou])/g, '$1z$2')
    .replace(/^x([aeiou])/g, 'S$1')
    .replace(/^h([aeiou])/g, '$1');

  const mapTokenCons = ch => {
    if (ch === 'L') return 'lh';
    if (ch === 'N') return 'nh';
    if (ch === 'S') return 'sh';
    if (ch === 'q') return 'k';
    if (ch === 'x') return 'sh';
    return VALID_CONSONANTS.has(ch) ? ch : 't';
  };

  const isVowel = ch => ch === 'a' || ch === 'e' || ch === 'i' || ch === 'o' || ch === 'u';
  const syllables = [];
  let i = 0;

  while (i < w.length) {
    const ch = w[i];
    if (isVowel(ch)) {
      syllables.push(ch);
      i += 1;
      continue;
    }

    // Encontrou consoante
    const cons = mapTokenCons(ch);
    const next = w[i + 1] || '';

    if (isVowel(next)) {
      syllables.push(`${cons}${next}`);
      i += 2;
      continue;
    }

    // Coda nasal (n ou m antes de consoante ou fim de palavra)
    if (ch === 'n' || ch === 'm') {
      syllables.push('n');
      i += 1;
      continue;
    }

    // L em final de silaba no PT-BR vocaliza para 'u' (ex.: sol -> so + u, luar/azul -> a + zu + u)
    if (ch === 'l') {
      syllables.push('u');
      i += 1;
      continue;
    }

    // R em final de palavra no canto pop brasileiro e suave/mudo ou apoio da vogal anterior
    if (ch === 'r' && i === w.length - 1) {
      i += 1;
      continue;
    }

    // S em final de silaba: leve apoio 'si' curto apenas se fim de palavra relevante, ou ignora para legato limpo
    if ((ch === 's' || ch === 'z') && i === w.length - 1) {
      i += 1;
      continue;
    }

    // Encontros consonantais (ex.: pr, br, tr, fl, cl, cr, gr, dr, vr): apoia com vogal epentetica curta ('i' ou vogal seguinte)
    const afterNext = w[i + 2] || 'i';
    const supportVowel = isVowel(afterNext) ? afterNext : 'i';
    syllables.push(`${cons}${supportVowel}`);
    i += 1;
  }

  return syllables;
}

/**
 * Converte letra em lista de silabas CV compativeis com `Usami_CV` e bancos OpenUTAU.
 */
export function syllabifyLyricsToCv(lyricsInput, language = 'auto') {
  const raw = String(lyricsInput || '').trim();
  if (!raw) return ['la', 'la', 'lu', 'la'];

  const lang = detectLanguage(raw, language);
  if (lang === 'ja') {
    const ja = syllabifyJapanese(raw);
    return ja.length > 0 ? ja : ['la', 'la'];
  }

  const words = raw.split(/\s+/).filter(Boolean);
  const syllables = [];
  for (const word of words) {
    const parts = syllabifyPortugueseWord(word);
    syllables.push(...parts);
  }
  return syllables.length > 0 ? syllables : ['la', 'la', 'lu', 'la'];
}

/**
 * Gera uma melodia vocal cantavel sincronizada a harmonia no registro ideal da Usami (C4..F5).
 */
export function buildVocalMelodyScore(options = {}) {
  const style = String(options.style || 'kawaii_hook').trim().toLowerCase();
  if (!VOCAL_STYLES.includes(style)) {
    throw new Error(`Estilo vocal invalido: "${options.style}". Disponiveis: ${VOCAL_STYLES.join(', ')}.`);
  }

  const language = String(options.language || 'auto').trim().toLowerCase();
  if (!VOCAL_LANGUAGES.includes(language)) {
    throw new Error(`Idioma invalido: "${options.language}". Use auto, pt, ja ou en.`);
  }

  const keyInput = String(options.key || 'F').trim();
  const parsedKey = parseKeySignature(keyInput);

  // Resolve acordes base para ancorar notas da melodia nas tercas, quintas, setimas e nonas
  const defaultProgByStyle = {
    kawaii_hook: 'kawaii_royal_road',
    future_bass_anthem: 'future_bass_anthem',
    melodic_dubstep_soar: 'melodic_dubstep_epic',
    colour_bass_chop: 'colour_bass_prism',
    dubstep_pre_drop: 'brostep_drop',
  };
  const progName = options.progression
    ? String(options.progression).trim().toLowerCase()
    : defaultProgByStyle[style];

  const chordNames = Array.isArray(options.chords) && options.chords.length > 0
    ? options.chords.map(c => String(c).trim())
    : buildProgressionChords(progName in GENRE_PROGRESSIONS ? progName : 'kawaii_royal_road', keyInput);

  const defaultBpmByStyle = {
    kawaii_hook: 156,
    future_bass_anthem: 150,
    melodic_dubstep_soar: 145,
    colour_bass_chop: 148,
    dubstep_pre_drop: 148,
  };
  const bpm = options.bpm !== undefined ? Number(options.bpm) : defaultBpmByStyle[style];
  if (!Number.isFinite(bpm) || bpm < 40 || bpm > 300) {
    throw new Error('bpm vocal deve estar entre 40 e 300.');
  }

  const lyricsRaw = String(options.lyrics || DEFAULT_LYRICS_BY_STYLE[style]).trim();
  const syllables = syllabifyLyricsToCv(lyricsRaw, language);

  const barTicks = DEFAULT_TPQ * 4;
  const sixteenth = DEFAULT_TPQ / 4; // 120 ticks

  // Modo 1: Notas customizadas explicitas fornecidas pelo usuario/agente
  if (Array.isArray(options.notes) && options.notes.length > 0) {
    let cursor = 0;
    const customNotes = options.notes.map((item, idx) => {
      const tone = isPlainObject(item)
        ? parseNoteName(item.note ?? item.tone ?? item.pitch ?? 'F4')
        : parseNoteName(item);
      const durTicks = isPlainObject(item) && Number.isFinite(Number(item.durationTicks))
        ? Math.max(60, Math.round(Number(item.durationTicks)))
        : (isPlainObject(item) && Number.isFinite(Number(item.durationBeats))
          ? Math.max(60, Math.round(Number(item.durationBeats) * DEFAULT_TPQ))
          : 240);
      const startTick = isPlainObject(item) && Number.isFinite(Number(item.startTick))
        ? Math.max(0, Math.round(Number(item.startTick)))
        : cursor;
      cursor = startTick + durTicks;
      const lyric = isPlainObject(item) && typeof item.lyric === 'string' && item.lyric.trim()
        ? syllabifyLyricsToCv(item.lyric.trim(), language)[0]
        : syllables[idx % syllables.length];
      return {
        startTick,
        durationTicks: durTicks,
        pitch: tone,
        velocity: 106,
        lyric,
        vibratoLength: durTicks >= 480 ? 55 : 0,
      };
    });
    const totalBars = Math.max(1, Math.ceil(cursor / barTicks));
    return {
      style,
      language: detectLanguage(lyricsRaw, language),
      bpm,
      key: parsedKey.label,
      chordsUsed: chordNames,
      lyricsOriginal: lyricsRaw,
      syllables,
      barsTotal: totalBars,
      notes: customNotes,
    };
  }

  // Modo 2: Composicao melodica automatica ancorada nos acordes e no estilo
  // Padroes ritmicos por compasso: pares [stepOffset16th, length16th, contourDegreeIndex]
  const rhythmTemplates = {
    kawaii_hook: [
      [[0, 2, 2], [2, 2, 3], [4, 3, 4], [7, 3, 2], [10, 2, 1], [12, 4, 3]],
      [[0, 2, 3], [2, 2, 4], [4, 2, 5], [6, 4, 4], [10, 2, 2], [12, 4, 1]],
    ],
    future_bass_anthem: [
      [[0, 3, 1], [3, 3, 2], [6, 4, 3], [10, 2, 2], [12, 4, 1]],
      [[0, 4, 3], [4, 2, 2], [6, 4, 4], [10, 6, 3]],
    ],
    melodic_dubstep_soar: [
      [[0, 6, 1], [6, 4, 2], [10, 6, 3]],
      [[0, 8, 4], [8, 4, 3], [12, 4, 2]],
    ],
    colour_bass_chop: [
      [[0, 2, 2], [3, 2, 4], [6, 2, 3], [8, 2, 5], [11, 2, 3], [14, 2, 2]],
      [[0, 2, 3], [2, 1, 4], [4, 3, 5], [8, 2, 3], [11, 3, 2], [14, 2, 1]],
    ],
    dubstep_pre_drop: [
      [[0, 2, 0], [2, 2, 0], [4, 2, 1], [6, 2, 2], [8, 3, 1], [11, 5, 0]],
    ],
  };

  const activeChords = style === 'dubstep_pre_drop' ? chordNames.slice(0, 2) : chordNames;
  const templates = rhythmTemplates[style];
  const notes = [];
  let sylIdx = 0;

  // Mantem todas as notas da Usami na zona cristalina de canto (MIDI 62 = D4 ate MIDI 79 = G5)
  const clampVocalRegister = midi => {
    let m = midi;
    while (m < 62) m += 12;
    while (m > 79) m -= 12;
    return m;
  };

  activeChords.forEach((chordStr, barIdx) => {
    const chordPitches = expandChordName(chordStr, 4, { voicing: 'close', includeSub: false });
    // Constroi paleta melodica do compasso (notas do acorde + 9a/passagem na oitava aguda)
    const root = chordPitches[0] || 65;
    const palette = [
      clampVocalRegister(root),
      clampVocalRegister(chordPitches[1] ?? (root + 4)),
      clampVocalRegister(chordPitches[2] ?? (root + 7)),
      clampVocalRegister((chordPitches[3] ?? (root + 11))),
      clampVocalRegister(root + 14),
      clampVocalRegister((chordPitches[1] ?? (root + 4)) + 12),
    ].sort((a, b) => a - b);

    const pattern = templates[barIdx % templates.length];
    const barStart = barIdx * barTicks;

    for (const [step16, len16, degreeIdx] of pattern) {
      const pitch = palette[Math.min(palette.length - 1, degreeIdx)];
      const startTick = barStart + Math.round(step16 * sixteenth);
      // Respiro de 15 ticks entre silabas para articulacao natural das consoantes no OpenUTAU
      const durationTicks = Math.max(90, Math.round(len16 * sixteenth) - 15);
      const lyric = syllables[sylIdx % syllables.length];
      sylIdx += 1;

      notes.push({
        startTick,
        durationTicks,
        pitch,
        velocity: len16 >= 4 ? 112 : 102,
        lyric,
        vibratoLength: durationTicks >= 450 ? 60 : 0,
      });
    }
  });

  return {
    style,
    language: detectLanguage(lyricsRaw, language),
    bpm,
    key: parsedKey.label,
    chordsUsed: activeChords,
    lyricsOriginal: lyricsRaw,
    syllables,
    barsTotal: activeChords.length,
    notes,
  };
}

function yamlEscapeString(text) {
  const clean = String(text ?? '').replace(/[\r\n]+/g, ' ').trim();
  return `"${clean.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Gera conteudo YAML 1.2 nativo de projeto OpenUTAU (`.ustx` versao 0.6).
 */
export function buildUstxYaml({
  projectName = 'Usami Vocal Hook',
  singerName = 'Usami',
  engine = 'classic',
  bpm = 150,
  keySemitone = 0,
  barsTotal = 4,
  notes = [],
} = {}) {
  if (!Array.isArray(notes) || notes.length === 0) {
    throw new Error('buildUstxYaml: lista de notas nao pode ser vazia.');
  }
  const isDiffSinger = String(engine || 'classic').trim().toLowerCase() === 'diffsinger';
  const effectiveSinger = isDiffSinger && singerName === 'Usami' ? 'Evelyn DS v110' : singerName;
  const phonemizer = isDiffSinger
    ? 'OpenUtau.Core.DiffSinger.DiffSingerPhonemizer'
    : 'OpenUtau.Core.DefaultPhonemizer';
  const renderer = isDiffSinger ? 'DIFFSINGER' : 'WORLDLINE-R';
  const voiceColor = isDiffSinger ? '01 Normal' : '';

  const partDuration = Math.max(
    barsTotal * DEFAULT_TPQ * 4,
    ...notes.map(n => (Number(n.startTick) || 0) + (Number(n.durationTicks) || 240) + DEFAULT_TPQ),
  );

  const lines = [
    `name: ${yamlEscapeString(projectName)}`,
    'comment: "Generated by Usami FL Studio Co-Producer"',
    'output_dir: Vocal',
    'cache_dir: UCache',
    'ustx_version: "0.6"',
    `resolution: ${DEFAULT_TPQ}`,
    `bpm: ${Number(bpm.toFixed(2))}`,
    'beat_per_bar: 4',
    'beat_unit: 4',
    'expressions:',
    '  dyn:',
    '    name: dynamics (curve)',
    '    abbr: dyn',
    '    type: Curve',
    '    min: -240',
    '    max: 120',
    '    default_value: 0',
    '    is_flag: false',
    '    flag: ""',
    '  pitd:',
    '    name: pitch deviation (curve)',
    '    abbr: pitd',
    '    type: Curve',
    '    min: -1200',
    '    max: 1200',
    '    default_value: 0',
    '    is_flag: false',
    '    flag: ""',
    '  vel:',
    '    name: velocity',
    '    abbr: vel',
    '    type: Numerical',
    '    min: 0',
    '    max: 200',
    '    default_value: 100',
    '    is_flag: false',
    '    flag: ""',
    '  vol:',
    '    name: volume',
    '    abbr: vol',
    '    type: Numerical',
    '    min: 0',
    '    max: 200',
    '    default_value: 100',
    '    is_flag: false',
    '    flag: ""',
    '  atk:',
    '    name: attack',
    '    abbr: atk',
    '    type: Numerical',
    '    min: 0',
    '    max: 200',
    '    default_value: 100',
    '    is_flag: false',
    '    flag: ""',
    '  dec:',
    '    name: decay',
    '    abbr: dec',
    '    type: Numerical',
    '    min: 0',
    '    max: 100',
    '    default_value: 0',
    '    is_flag: false',
    '    flag: ""',
    '  gen:',
    '    name: gender',
    '    abbr: gen',
    '    type: Numerical',
    '    min: -100',
    '    max: 100',
    '    default_value: 0',
    '    is_flag: true',
    '    flag: g',
    '  bre:',
    '    name: breath',
    '    abbr: bre',
    '    type: Numerical',
    '    min: 0',
    '    max: 100',
    '    default_value: 0',
    '    is_flag: true',
    '    flag: B',
    'exp_selectors:',
    '  - dyn',
    '  - pitd',
    '  - vel',
    '  - vol',
    '  - gen',
    'exp_primary: 0',
    'exp_secondary: 1',
    `key: ${Math.max(0, Math.min(11, Math.round(Number(keySemitone) || 0)))}`,
    'time_signatures:',
    '  - bar_position: 0',
    '    beat_per_bar: 4',
    '    beat_unit: 4',
    'tempos:',
    '  - position: 0',
    `    bpm: ${Number(bpm.toFixed(2))}`,
    'tracks:',
    `  - singer: ${yamlEscapeString(effectiveSinger)}`,
    `    phonemizer: ${phonemizer}`,
    '    renderer_settings:',
    `      renderer: ${renderer}`,
    `    track_name: ${yamlEscapeString(`${effectiveSinger} Lead`)}`,
    '    track_color: Pink',
    '    mute: false',
    '    solo: false',
    '    volume: 0',
    '    pan: 0',
    '    track_expressions: []',
    '    voice_color_names:',
    `      - ${yamlEscapeString(voiceColor)}`,
    'voice_parts:',
    `  - duration: ${partDuration}`,
    `    name: ${yamlEscapeString(projectName)}`,
    '    comment: ""',
    '    track_no: 0',
    '    position: 0',
    '    notes:',
  ];

  const sortedNotes = [...notes].sort((a, b) => (a.startTick - b.startTick) || (a.pitch - b.pitch));
  for (const n of sortedNotes) {
    const pos = Math.max(0, Math.round(Number(n.startTick) || 0));
    const dur = Math.max(60, Math.round(Number(n.durationTicks) || 240));
    const tone = Math.max(24, Math.min(108, Math.round(Number(n.pitch) || 65)));
    const lyric = String(n.lyric || 'la').trim() || 'la';
    const vibLen = Math.max(0, Math.min(90, Math.round(Number(n.vibratoLength) || 0)));

    lines.push(
      `      - position: ${pos}`,
      `        duration: ${dur}`,
      `        tone: ${tone}`,
      `        lyric: ${yamlEscapeString(lyric)}`,
      '        pitch:',
      '          data:',
      '            - {x: -40, y: 0, shape: io}',
      '            - {x: 40, y: 0, shape: io}',
      '          snap_first: true',
      `        vibrato: {length: ${vibLen}, period: 175, depth: ${vibLen > 0 ? 28 : 0}, in: 20, out: 20, shift: 0, drift: 0, vol_link: 0}`,
      '        phoneme_expressions: []',
      '        phoneme_overrides: []',
    );
  }

  lines.push('wave_parts: []', '');
  return lines.join('\n');
}

/**
 * Gera tambem arquivo `.ust` classico (UST Version1.20) universalmente aceito por
 * OpenUTAU, UTAU classico, DiffSinger e Synthesizer V.
 */
export function buildUstText({
  projectName = 'Usami Vocal Hook',
  bpm = 150,
  notes = [],
} = {}) {
  const lines = [
    '[#VERSION]',
    'UST Version1.20',
    '[#SETTING]',
    `Tempo=${Number(bpm.toFixed(2))}`,
    'Tracks=1',
    `ProjectName=${String(projectName).replace(/[\r\n]+/g, ' ')}`,
    'VoiceDir=%DATA%Usami_CV',
    'Mode2=True',
  ];

  const sorted = [...notes].sort((a, b) => a.startTick - b.startTick);
  let cursor = 0;
  let idx = 0;

  const pushEntry = (lengthTicks, lyric, noteNum) => {
    const tag = `[#${String(idx).padStart(4, '0')}]`;
    idx += 1;
    lines.push(
      tag,
      `Length=${Math.max(15, Math.round(lengthTicks))}`,
      `Lyric=${lyric}`,
      `NoteNum=${noteNum}`,
      'PreUtterance=',
    );
  };

  for (const n of sorted) {
    if (n.startTick > cursor) {
      pushEntry(n.startTick - cursor, 'R', 60);
    }
    pushEntry(n.durationTicks, String(n.lyric || 'la'), Math.max(24, Math.min(108, Math.round(n.pitch))));
    cursor = n.startTick + n.durationTicks;
  }

  lines.push('[#TRACKEND]', '');
  return lines.join('\r\n');
}

export function inspectUstxText(yamlText) {
  const text = String(yamlText || '');
  if (!text.includes('ustx_version: "0.6"')) {
    return { valid: false, reason: 'ustx_version ausente' };
  }
  if (!text.includes('voice_parts:') || !text.includes('notes:')) {
    return { valid: false, reason: 'voice_parts/notes ausentes' };
  }
  if (!text.includes('tempos:') || !text.includes('tracks:')) {
    return { valid: false, reason: 'tempos/tracks ausentes' };
  }
  return { valid: true, byteLength: Buffer.byteLength(text, 'utf8') };
}

export function sanitizeVocalFileName(rawName, fallbackBase = 'usami_vocal_hook') {
  const cleaned = String(rawName || fallbackBase)
    .trim()
    .replace(/\.(?:ustx|ust|mid)$/i, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
  return cleaned || fallbackBase;
}

export function validateVocalArgs(args = {}) {
  if (!isPlainObject(args)) {
    throw new Error('Argumentos de fl.vocal devem ser um objeto.');
  }
  const action = String(args.action || 'compose').trim().toLowerCase();
  if (!VOCAL_ACTIONS.includes(action)) {
    throw new Error(`action invalida em fl.vocal: "${args.action}". Use compose, convert, status ou open.`);
  }
  const engine = String(args.engine || 'classic').trim().toLowerCase();
  if (!VOCAL_ENGINES.includes(engine)) {
    throw new Error(`engine invalida em fl.vocal: "${args.engine}". Use classic ou diffsinger.`);
  }
  const style = String(args.style || 'kawaii_hook').trim().toLowerCase();
  if (!VOCAL_STYLES.includes(style)) {
    throw new Error(`style invalido em fl.vocal: "${args.style}". Disponiveis: ${VOCAL_STYLES.join(', ')}.`);
  }
  const language = String(args.language || 'auto').trim().toLowerCase();
  if (!VOCAL_LANGUAGES.includes(language)) {
    throw new Error(`language invalido em fl.vocal: "${args.language}". Use auto, pt, ja ou en.`);
  }
  const pitchShift = args.pitchShift !== undefined ? Math.round(Number(args.pitchShift)) : 0;
  if (!Number.isInteger(pitchShift) || pitchShift < -24 || pitchShift > 24) {
    throw new Error('pitchShift em fl.vocal deve estar entre -24 e 24 semitons.');
  }
  const diffusionSteps = args.diffusionSteps !== undefined ? Math.round(Number(args.diffusionSteps)) : 30;
  if (!Number.isInteger(diffusionSteps) || diffusionSteps < 10 || diffusionSteps > 80) {
    throw new Error('diffusionSteps em fl.vocal deve estar entre 10 e 80.');
  }
  const defaultSinger = engine === 'diffsinger' ? 'Evelyn DS v110' : 'Usami';
  return {
    action,
    engine,
    style,
    language,
    lyrics: typeof args.lyrics === 'string' ? args.lyrics.trim().slice(0, 400) : '',
    key: typeof args.key === 'string' && args.key.trim() ? args.key.trim() : 'F',
    bpm: args.bpm !== undefined ? Number(args.bpm) : undefined,
    progression: typeof args.progression === 'string' && args.progression.trim() ? args.progression.trim() : undefined,
    chords: Array.isArray(args.chords) ? args.chords : undefined,
    notes: Array.isArray(args.notes) ? args.notes : undefined,
    singerName: typeof args.singerName === 'string' && args.singerName.trim()
      ? args.singerName.trim().slice(0, 48)
      : defaultSinger,
    fileName: sanitizeVocalFileName(args.fileName, `usami_${style}`),
    openInUtau: args.openInUtau === true,
    sourceWav: typeof args.sourceWav === 'string' && args.sourceWav.trim() ? args.sourceWav.trim() : null,
    referenceWav: typeof args.referenceWav === 'string' && args.referenceWav.trim() ? args.referenceWav.trim() : null,
    pitchShift,
    diffusionSteps,
  };
}
