// Resolução e validação de emoções em 5 registros sociais (Crescentine / OpenAmika V2).
//
// Vocabulário fechado de 69 chaves no formato `<registro>_<emoção>`.
// Garante resolução determinística com preservação de registro e fallback intra-registro.
// Módulo puro: roda no Node.js e no browser sem dependências.

export const REGISTERS = Object.freeze([
  'polite',
  'casual',
  'serious',
  'intimate',
  'whisper',
]);

export const EMOTION_SETS = Object.freeze({
  polite: Object.freeze([
    'neutral', 'smile', 'happy', 'caring', 'sad', 'worried',
    'cold', 'angry', 'embarrassed', 'surprise', 'fear',
  ]),
  casual: Object.freeze([
    'neutral', 'smile', 'happy', 'very_happy', 'playful', 'laughing',
    'relieved', 'shy', 'embarrassed', 'mumbling', 'jealous', 'caring',
    'surprise', 'angry', 'frustrated', 'sad', 'tired', 'fear', 'worried',
  ]),
  serious: Object.freeze([
    'neutral', 'cold', 'disappointed', 'surprise', 'angry', 'very_angry',
    'protective', 'worried', 'anxious', 'sad', 'fear',
  ]),
  intimate: Object.freeze([
    'neutral', 'happy', 'very_happy', 'smile', 'playful', 'shy',
    'very_shy', 'caring', 'very_caring', 'jealous', 'mumbling',
    'relieved', 'tearful', 'sad', 'very_sad', 'sleepy', 'tired', 'worried',
  ]),
  whisper: Object.freeze([
    'neutral', 'happy', 'smile', 'caring', 'relieved', 'shy',
    'sad', 'worried', 'tearful', 'sleepy',
  ]),
});

const ALL_EMOTIONS = [];
for (const [reg, set] of Object.entries(EMOTION_SETS)) {
  for (const emo of set) {
    ALL_EMOTIONS.push(`${reg}_${emo}`);
  }
}
export const VALID_EMOTIONS = Object.freeze(new Set(ALL_EMOTIONS));
export const DEFAULT_EMOTION = 'casual_neutral';
const DEFAULT_REGISTER = 'casual';

export const EMOTION_ALIASES = Object.freeze({
  curious: 'smile', friendly: 'smile', warm: 'caring', gentle: 'caring',
  soft: 'caring', tender: 'caring', excited: 'very_happy', amused: 'laughing',
  teasing: 'playful', mischievous: 'playful', proud: 'smile', grateful: 'smile',
  thankful: 'smile', calm: 'relieved', annoyed: 'frustrated', irritated: 'frustrated',
  pout: 'frustrated', sulky: 'frustrated', grumpy: 'frustrated', nervous: 'anxious',
  scared: 'fear', afraid: 'fear', confused: 'surprise', shocked: 'surprise',
  surprised: 'surprise', delighted: 'very_happy', furious: 'angry', mad: 'angry',
  flustered: 'embarrassed', thoughtful: 'neutral', serious: 'neutral', lonely: 'sad',
  hurt: 'sad', upset: 'sad', bored: 'tired', sleepy: 'sleepy', sigh: 'tired',
  giggle: 'laughing', giggling: 'laughing', laugh: 'laughing', smiling: 'smile',
  crying: 'tearful', cry: 'tearful', anger: 'angry', fearful: 'fear',
  embarrased: 'embarrassed', embarassed: 'embarrassed', suprise: 'surprise',
  surprize: 'surprise', worry: 'worried', happiness: 'happy', joy: 'happy',
  joyful: 'happy', sadness: 'sad', relief: 'relieved', tease: 'playful',
  shyness: 'shy', jealousy: 'jealous', mumble: 'mumbling', protect: 'protective',
  disappoint: 'disappointed', disapointed: 'disappointed', anxiety: 'anxious',
});

export const REGISTER_ALIASES = Object.freeze({
  formal: 'polite', public: 'polite', friendly: 'casual', normal: 'casual',
  relaxed: 'casual', stern: 'serious', firm: 'serious', close: 'intimate',
  soft: 'intimate', private: 'intimate', quiet: 'whisper', whispering: 'whisper',
  whispered: 'whisper', hushed: 'whisper',
});

export const REGISTER_FALLBACK = Object.freeze({
  polite: {
    anxious: 'worried', disappointed: 'sad', protective: 'caring',
    laughing: 'happy', frustrated: 'cold', shy: 'embarrassed',
    relieved: 'smile', playful: 'smile', mumbling: 'embarrassed',
    jealous: 'cold', tearful: 'sad', tired: 'neutral', sleepy: 'neutral',
  },
  casual: {
    anxious: 'worried', disappointed: 'sad', cold: 'frustrated',
    protective: 'caring', tearful: 'sad', sleepy: 'tired',
  },
  serious: {
    caring: 'protective', frustrated: 'cold', jealous: 'cold',
    tearful: 'sad', embarrassed: 'neutral', tired: 'neutral',
  },
  intimate: {
    anxious: 'worried', fear: 'worried', angry: 'mumbling',
    disappointed: 'sad', cold: 'sad', protective: 'caring',
    embarrassed: 'shy', laughing: 'happy', frustrated: 'mumbling',
  },
  whisper: {
    anxious: 'worried', fear: 'worried', angry: 'worried',
    disappointed: 'sad', cold: 'sad', protective: 'caring',
    embarrassed: 'shy', laughing: 'smile', frustrated: 'worried',
    playful: 'smile', mumbling: 'shy', jealous: 'worried',
    tired: 'sleepy', very_happy: 'happy',
  },
});

export function normalizeEmotionTag(raw) {
  let t = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/^[\[【]+|[\]】]+$/g, '')
    .trim();
  if (!t) return '';
  t = t.replace(/[-\s\/\.]+/g, '_');
  t = t.split(/[,，]/)[0];
  t = t.replace(/_?\d+(?:_\d+)?$/, ''); // remove intensity like shy_0.4 -> shy
  t = t.replace(/_+/g, '_').replace(/^_|_$/g, '');
  return t;
}

function canonEmotion(emotion) {
  if (EMOTION_ALIASES[emotion]) return EMOTION_ALIASES[emotion];
  if (emotion.startsWith('very_')) {
    const base = emotion.slice(5);
    if (EMOTION_ALIASES[base]) return `very_${EMOTION_ALIASES[base]}`;
  }
  return emotion;
}

function splitRegister(tag) {
  for (const reg of REGISTERS) {
    if (tag.startsWith(`${reg}_`)) {
      return [reg, tag.slice(reg.length + 1)];
    }
    if (tag === reg) {
      return [reg, 'neutral'];
    }
  }
  const parts = tag.split('_');
  const head = parts[0];
  const rest = parts.slice(1).join('_');
  if (REGISTER_ALIASES[head] && rest) {
    return [REGISTER_ALIASES[head], rest];
  }
  return [null, tag];
}

/**
 * Converte qualquer texto de tag em uma das 69 chaves válidas.
 * Se o registro ou a emoção não existir, aplica fallback intra-registro.
 * Se for nulo/vazio, devolve DEFAULT_EMOTION ('casual_neutral').
 */
export function resolveEmotion(tag, defaultEmotion = DEFAULT_EMOTION) {
  const normalized = normalizeEmotionTag(tag);
  if (!normalized) return defaultEmotion;

  let [register, emotion] = splitRegister(normalized);
  if (!register) {
    register = DEFAULT_REGISTER;
    emotion = normalized;
  }

  const avail = new Set(EMOTION_SETS[register] || []);
  emotion = canonEmotion(emotion);

  if (avail.has(emotion)) {
    return `${register}_${emotion}`;
  }

  if (emotion.startsWith('very_')) {
    const base = emotion.slice(5);
    if (avail.has(base)) return `${register}_${base}`;
    emotion = base;
  }

  const fallback = REGISTER_FALLBACK[register]?.[emotion];
  if (fallback && avail.has(fallback)) {
    return `${register}_${fallback}`;
  }

  return `${register}_neutral`;
}
