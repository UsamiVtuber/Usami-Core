// Classificador determinístico de emoção por frase (pt-BR, com fallback en).
//
// Puro e sem dependências: nada de I/O, estado, relógio ou aleatoriedade —
// a mesma frase sempre devolve o mesmo resultado. Os rótulos são os 8 do
// `emotion-map.js`; `neutral` NÃO tem detector aqui — só aparece quando nada
// casa ou quando a entrada é vazia/não-string (ausência de emoção confiável).
//
// Regras:
// - Case-insensitive. Por rótulo: o primeiro match vale 0.55, cada match
//   adicional do MESMO rótulo soma 0.15, teto de 0.95. Vencedor = maior soma;
//   empate fica com o rótulo alfabeticamente menor (determinístico).
// - Negação (`não|nunca|jamais`) em até 3 tokens antes do match corta o peso
//   do match pela metade — não troca de rótulo (conservador).
// - Intensidade: 0.7 base + 0.15 por intensificador (`muito|super|demais|
//   pra caramba|!!!` — cada ocorrência conta 1); emojis repetidos contam
//   como intensificador (cada repetição além da primeira); clamp 0..1.
// - `demais` NÃO é match de happy de propósito: em pt-BR é mais intensificador
//   do que emoção ("triste demais" não é alegria) — só entra na intensidade.

// Um único indício explícito vale 0.55; o limiar precisa aceitar esse caso
// para respostas naturais curtas ("estou bem", "que bom", "estou feliz").
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.55;

const FIRST_MATCH_WEIGHT = 0.55;
const EXTRA_MATCH_WEIGHT = 0.15;
const MAX_CONFIDENCE = 0.95;
const BASE_INTENSITY = 0.7;
const INTENSIFIER_STEP = 0.15;

// Léxico pt-BR por rótulo (com alguns termos en de fallback). Cada ocorrência
// casada conta 1 match para o rótulo; emojis também são matches.
const LEXICON = {
  angry: [
    /\braiva\b/gi,
    /chatead/gi,
    /irritad/gi,
    /\bput[ao]s?\b/gi,
    /\bchega\b/gi,
    /\bpara com isso\b/gi,
    /nunca mais/gi,
    /odeio|odeiad/gi,
    /\bbasta\b/gi,
    /furios|revoltad/gi,
    /😡|😠|🤬/g,
  ],
  doubtful: [
    /\bhmm+\b/gi,
    /\bser[áa]\b/gi,
    /duvid/gi,
    /acho que n[ãa]o/gi,
    /estranh/gi,
    /\bn[ãa]o sei\b/gi,
    /quem sabe/gi,
    /\bpode ser\b/gi,
    /\bcerteza\b\s*\?/gi,
    /n[ãa]o tenho certeza/gi,
    /🤔|🧐/g,
  ],
  happy: [
    /(?:\bhaha+|\brsrs+|\bkkk+)|🤣/gi,
    /\bador[oa]s?\b/gi,
    /(?:\bte amo\b|\bamo (?:voc[êe]|vc|tu)\b)/gi,
    /\bque bom\b/gi,
    /\bestou (?:muito )?bem\b/gi,
    /\bt[oô] (?:muito )?bem\b/gi,
    /\bbem[,! ]+(?:sim|obrigad[ao]s?)\b/gi,
    /obrigad[ao] por perguntar/gi,
    /\b(?:[óo]tim[ao]|maravilh[ao]|animad[ao])\b/gi,
    /\bfeliz\b/gi,
    /\boba\b/gi,
    /\bincr[íi]vel\b/gi,
    /\blegal\b/gi,
    /❤️|😊|😄|🥰|😂|😍|🎉/g,
  ],
  sad: [
    /triste/gi,
    /saudade/gi,
    /sinto (?:muito )?falta/gi,
    /\bque pena\b/gi,
    /poxa/gi,
    /(?:\bchor(?:o|ar|ei)\b|chorando)/gi,
    /l[áa]grima/gi,
    /\bsozinh[ao]s?\b/gi,
    /melanc|deprimid|desanimad|arrependid/gi,
    /😭|😢|😞|💔/g,
  ],
  shy: [
    /vergonha/gi,
    /sem gra[çc]a/gi,
    /\bque isso\b/gi,
    /\beled\b/gi,
    /corada/gi,
    /\boops?\b/gi,
    /\bdesculp[ae]s?\b/gi,
    /\bperd[ãa]o\b/gi,
    /sem querer/gi,
    /atrapalhad/gi,
    /😅|😳|🙈/g,
  ],
  soft: [
    /\bcalm[ao]s?\b|\bcalminh[ao]\b/gi,
    /tranquil/gi,
    /relaxa/gi,
    /\btudo bem\b/gi,
    /descans/gi,
    /(?:\bsono\b|com sono|sonol[êe]nci)/gi,
    /boinha/gi,
    /\bmaci[oa]s?\b|\bmaciez\b/gi,
    /peaceful/gi,
    /boa noite/gi,
    /\bseren[oa]\b|serenidade/gi,
    /\brespira\b/gi,
    /😴|🌙/g,
  ],
  surprised: [
    /n[ãa]o acredito/gi,
    /\bs[ée]rio\s*[?!]+/gi,
    /\bmeu deus\b/gi,
    /\buau\b|\bwow\b/gi,
    /(?<!pr[ao] )caramba/gi,
    /\bopa\s*[!]/gi,
    /\bnossa\s*[?!]/gi,
    /\bsusto\b/gi,
    /inacredit[áa]vel/gi,
    /😱|😲|❗/g,
  ],
};

// Intensificadores: cada ocorrência soma INTENSIFIER_STEP na intensidade.
const INTENSIFIERS = [/\bmuit[ao]s?\b/gi, /\bsuper\b/gi, /\bdemais\b/gi, /\bpr[ao] caramba\b/gi, /!{3,}/g];

// Emojis do léxico — usados só para detectar repetição ("😊😊" intensifica).
const EMOJIS = ['❤️', '😊', '😄', '🥰', '😂', '🤣', '😍', '🎉', '😅', '😳', '🙈', '😭', '😢', '😞', '💔', '😴', '🌙', '😡', '😠', '🤬', '😱', '😲', '❗', '🤔', '🧐'];

const NEGATION_WORDS = new Set(['nao', 'não', 'nunca', 'jamais']);
const round3 = value => Math.round(value * 1000) / 1000;
const clamp01 = value => Math.min(1, Math.max(0, value));
const letters = raw => raw.toLowerCase().replace(/[^a-zà-ÿ]/g, '');

function leadingTokens(text) {
  return [...text.matchAll(/\S+/g)].map(match => ({ word: letters(match[0]), end: match.index + match[0].length }));
}

// Negação dentro da janela dos 3 tokens que terminam antes do match.
function isNegated(tokens, matchStart) {
  return tokens.filter(token => token.end <= matchStart).slice(-3).some(token => NEGATION_WORDS.has(token.word));
}

function scoreLabel(text, tokens, patterns) {
  const starts = [];
  for (const pattern of patterns) for (const match of text.matchAll(pattern)) starts.push(match.index);
  if (!starts.length) return 0;
  starts.sort((a, b) => a - b);
  let total = 0;
  starts.forEach((start, position) => {
    const base = position === 0 ? FIRST_MATCH_WEIGHT : EXTRA_MATCH_WEIGHT;
    total += isNegated(tokens, start) ? base / 2 : base;
  });
  return Math.min(MAX_CONFIDENCE, total);
}

function countIntensifiers(text) {
  let count = 0;
  for (const pattern of INTENSIFIERS) count += [...text.matchAll(pattern)].length;
  for (const emoji of EMOJIS) {
    const occurrences = text.split(emoji).length - 1;
    if (occurrences >= 2) count += occurrences - 1;
  }
  return count;
}

export function classifyEmotion(text) {
  if (typeof text !== 'string' || !text.trim()) return { label: 'neutral', intensity: 0, confidence: 0 };
  const tokens = leadingTokens(text);
  let label = 'neutral';
  let confidence = 0;
  // Rótulos em ordem alfabética: empate fica com o primeiro (determinístico).
  for (const candidate of Object.keys(LEXICON).sort()) {
    const score = round3(scoreLabel(text, tokens, LEXICON[candidate]));
    if (score > confidence) { confidence = score; label = candidate; }
  }
  if (confidence <= 0) return { label: 'neutral', intensity: 0, confidence: 0 };
  const intensity = round3(clamp01(BASE_INTENSITY + INTENSIFIER_STEP * countIntensifiers(text)));
  return { label, intensity, confidence };
}
