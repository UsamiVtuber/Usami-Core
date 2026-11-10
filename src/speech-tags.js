// Tags não-verbais do Gemini TTS. O modelo aceita marcações como <laugh> e
// <short pause> no texto falado; elas viram som e NÃO são lidas. O LLM pode
// terminar o reply com uma delas, mas o balão precisa mostrar só a fala — este
// módulo separa as duas coisas. Puro: roda no servidor e no browser.

const TAG_ALIASES = new Map([
  ['laugh', 'laugh'],
  ['laughter', 'laugh'],
  ['can_t_help_laughing', 'laugh'],
  ['cant_help_laughing', 'laugh'],
  ['can t help laughing', 'laugh'],
  ["can't help laughing", 'laugh'],
  ['risada', 'laugh'],
  ['risos', 'laugh'],
  ['chuckle', 'chuckle'],
  ['soft_hmph', 'short pause'],
  ['soft hmph', 'short pause'],
  ['hmph', 'short pause'],
  ['giggle', 'giggle'],
  ['risadinha', 'chuckle'],
  ['risinho', 'chuckle'],
  ['sigh', 'sigh'],
  ['suspiro', 'sigh'],
  ['short pause', 'short pause'],
  ['pause', 'short pause'],
  ['pausa', 'short pause'],
  ['yawn', 'short pause'],
  ['bocejo', 'short pause'],
  ['sniff', 'short pause'],
  ['fungada', 'short pause'],
  ['light_cough', 'short pause'],
  ['light cough', 'short pause'],
  ['throat_clear', 'short pause'],
  ['throat clear', 'short pause'],
  ['breath', 'breath'],
  ['deep_breath', 'breath'],
  ['deep breath', 'breath'],
  ['respiro', 'breath'],
  ['gasp', 'gasp'],
  ['espanto', 'gasp'],
]);

// Aceita <tag>, [tag] e 【tag】; só entra no áudio o que estiver no vocabulário acima.
// Colchetes desconhecidos ficam no texto (não são tags de som conhecidas).
const TAG_PATTERN = /<([^<>\n]{1,24})>|\[([^\[\]\n]{1,24})\]|【([^【】\n]{1,24})】/gu;

export const MAX_SPEECH_TAGS = 2;

function normalizeTag(value) {
  return String(value ?? '')
    .normalize('NFC')
    .trim()
    .toLowerCase()
    .replace(/\s+/gu, ' ');
}

function tidy(text) {
  return String(text ?? '')
    .replace(/[ \t]{2,}/gu, ' ')
    .replace(/\s+([,.;:!?…])/gu, '$1')
    .trim();
}

/**
 * Separa tags não-verbais conhecidas do texto exibido.
 * @param {string} text
 * @param {{ maxTags?: number }} [options]
 * @returns {{ text: string, tags: string[] }}
 */
export function extractSpeechTags(text, { maxTags = MAX_SPEECH_TAGS } = {}) {
  const source = String(text ?? '');
  const tags = [];
  const display = source.replace(TAG_PATTERN, (match, angle, square, fullwidth) => {
    const tag = TAG_ALIASES.get(normalizeTag(angle ?? square ?? fullwidth));
    if (!tag) return match;
    if (tags.length < maxTags && !tags.includes(tag)) tags.push(tag);
    return ' ';
  });
  const cleaned = tidy(display);
  // Uma fala feita só de tag não é fala; preserva o original para o chamador
  // decidir (o parse do chat trata como reply vazio e devolve 502).
  return { text: cleaned, tags };
}

export function stripSpeechTags(text) {
  return extractSpeechTags(text).text;
}

export function appendSpeechTags(text, tags = []) {
  const base = String(text ?? '').trim();
  const valid = (Array.isArray(tags) ? tags : [])
    .map(normalizeTag)
    .filter(tag => TAG_ALIASES.has(tag) && TAG_ALIASES.get(tag) === tag);
  const unique = [...new Set(valid)].slice(0, MAX_SPEECH_TAGS);
  return [base, ...unique.map(tag => `<${tag}>`)].filter(Boolean).join(' ');
}
