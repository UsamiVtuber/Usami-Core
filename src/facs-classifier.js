// Classificador de frase para Action Units FACS (pt-BR).
//
// Puro e sem dependências: nada de I/O, estado, relógio ou aleatoriedade.
// A mesma frase sempre devolve o mesmo resultado. Analisa a frase do USUÁRIO
// (não a resposta da Usami) e devolve AUs com intensidades, para aplicar
// canais de rosto no avatar enquanto o LLM processa a resposta.
//
// Regras:
// - Case-insensitive. Cada padrão casado vale 0.6 de intensidade base;
//   negação em até 3 tokens antes do match reduz para 0.25 (conservador,
//   não inverte a AU).
// - Intensidade global sobe com intensificadores e emojis repetidos.
// - Confiança = média das intensidades dos AUs detectados (0 se nenhum).

const BASE_INTENSITY = 0.6;
const NEGATED_INTENSITY = 0.25;
const INTENSITY_STEP = 0.15;
const MAX_INTENSITY = 0.95;

// Léxico pt-BR por Action Unit FACS.
// Cada padrão casado conta 1 match para a AU.
const AU_KEYWORDS = {
  'AU1':   [/triste/gi, /chor/gi, /saudade/gi, /sozinho/gi, /lágrima/gi, /melancol/gi, /deprim/gi, /desconsol/gi],
  'AU2':   [/surpre/gi, /n[ãa]o acredito/gi, /uau/gi, /wow/gi, /meu deus/gi, /susto/gi, /inacred/gi, /assomb/gi],
  'AU4':   [/bra/gi, /irrit/gi, /fur/gi, /odeio/gi, /chega/gi, /basta/gi, /put/gi, /chatead/gi, /nunca mais/gi, /arrepi/gi],
  'AU5':   [/surpre/gi, /susto/gi, /n[ãa]o acredito/gi, /uau/gi, /wow/gi, /meu deus/gi, /assomb/gi],
  'AU6':   [/feliz/gi, /bom/gi, /legal/gi, /ótimo/gi, /maravil/gi, /ador/gi, /amo/gi, /obrig/gi, /rsrs/gi, /kkk/gi, /haha/gi, /que bom/gi],
  'AU9':   [/noj/gi, /desgost/gi, /arrot/gi, /fed/gi, /rancor/gi],
  'AU12':  [/feliz/gi, /sorris/gi, /rindo/gi, /que bom/gi, /estou bem/gi, /ótimo/gi, /maravil/gi, /ador/gi, /amo/gi, /obrig/gi],
  'AU15':  [/triste/gi, /chor/gi, /saudade/gi, /sozinho/gi, /pena/gi, /deprim/gi, /desconsol/gi, /desilud/gi],
  'AU20':  [/medo/gi, /assust/gi, /nervos/gi, /pânico/gi, /horror/gi, /trem/gi, /apavor/gi],
  'AU24':  [/bra/gi, /irrit/gi, /fur/gi, /determin/gi, /firme/gi, /contido/gi, /reprima/gi],
  'AU25':  [/surpre/gi, /susto/gi, /falando/gi, /dizendo/gi, /uau/gi, /wow/gi, /meu deus/gi, /nossa/gi],
  'AU26':  [/grit/gi, /susto/gi, /surpre/gi, /n[ãa]o acredito/gi, /meu deus/gi, /gritou/gi],
  'AU43':  [/sono/gi, /cansa/gi, /sonol/gi, /adormeci/gi, /dormindo/gi, /fechou os olhos/gi],
  'AU45':  [/pisc/gi, /blink/gi, /olho fech/gi, /piscando/gi],
};

const NEGATION_WORDS = new Set(['nao', 'não', 'nunca', 'jamais']);
const INTENSIFIERS = [/\bmuit[ao]s?\b/gi, /\bsuper\b/gi, /\bdemais\b/gi, /\bpr[ao] caramba\b/gi, /!{3,}/g];
const EMOJIS = ['❤️', '😊', '😄', '🥰', '😂', '🤣', '😍', '🎉', '😅', '😳', '🙈', '😭', '😢', '😞', '💔', '😴', '🌙', '😡', '😠', '🤬', '😱', '😲', '❗', '🤔', '🧐'];

const clamp01 = value => Math.min(1, Math.max(0, value));
const letters = raw => raw.toLowerCase().replace(/[^a-zà-ÿ]/g, '');

function leadingTokens(text) {
  return [...text.matchAll(/\S+/g)].map(match => ({ word: letters(match[0]), end: match.index + match[0].length }));
}

function isNegated(tokens, matchStart) {
  return tokens.filter(token => token.end <= matchStart).slice(-3).some(token => NEGATION_WORDS.has(token.word));
}

export function classifyFacs(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return { aus: [], intensity: 0, confidence: 0 };
  }

  const tokens = leadingTokens(text);
  const aus = [];

  for (const [au, patterns] of Object.entries(AU_KEYWORDS)) {
    let bestIntensity = 0;
    let matched = false;
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        const neg = isNegated(tokens, match.index);
        matched = true;
        const base = neg ? NEGATED_INTENSITY : BASE_INTENSITY;
        bestIntensity = Math.max(bestIntensity, base);
      }
    }
    if (matched) {
      aus.push({ au, intensity: clamp01(bestIntensity) });
    }
  }

  // Intensidade global por intensificadores e emojis repetidos.
  let intensifierCount = 0;
  for (const pattern of INTENSIFIERS) intensifierCount += [...text.matchAll(pattern)].length;
  for (const emoji of EMOJIS) {
    const occurrences = text.split(emoji).length - 1;
    if (occurrences >= 2) intensifierCount += occurrences - 1;
  }
  const intensity = clamp01(BASE_INTENSITY + INTENSITY_STEP * intensifierCount);

  // Confiança = média das intensidades dos AUs detectados.
  const confidence = aus.length > 0
    ? clamp01(aus.reduce((sum, au) => sum + au.intensity, 0) / aus.length)
    : 0;

  return { aus, intensity, confidence };
}
