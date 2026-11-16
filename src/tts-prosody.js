// Prosódia emocional para o Gemini TTS (V2 69 emoções + 12 chaves legadas).
//
// Regras críticas do Gemini TTS (`gemini-2.5-flash-preview-tts`):
// 1. Direções de estilo DEVEM ir dentro de `[...]` (prosa fora de colchetes é lida em voz alta).
// 2. NUNCA usar a palavra "envergonhada" nas instruções de timidez — o modelo
//    encena a palavra repetindo sílabas; usar "com vergonha" no lugar.
// 3. `neutral`, `casual_neutral` e qualquer `styleId` desconhecido caem de forma
//    determinística na tag base (cláusula vazia '').

import {
  EMOTION_ALIASES,
  EMOTION_SETS,
  REGISTERS,
  REGISTER_ALIASES,
  VALID_EMOTIONS,
  normalizeEmotionTag,
  resolveEmotion,
} from './emotion-resolver.js';

// Tabela legada de 12 estilos + aliases diretos (mantém compatibilidade 100% com testes e clientes V1).
export const STYLE_INSTRUCTIONS = Object.freeze({
  happy: 'super animada e hiperexpressiva, aguda e saltitante, sorriso na voz, consoantes punchy',
  sad: 'triste e embargada, mais lenta e baixa, com suspiros',
  angry: 'protesto manhoso e dramatizado, aguda, emburrada, birra fofa sem agressividade',
  surprised: 'espantada e aguda, salto de pitch, animada',
  relaxed: 'calma e serena, mais baixa e lenta, sorriso suave',
  whisper: 'sussurrada bem baixinho e suave, extremamente calma, ritmo lento e reconfortante para ninar',
  soft: 'doce e apegada, sorriso na voz, tom manhoso e carinhoso',
  shy: 'baixinha, hesitante e doce, quase sussurrada, com vergonha',
  doubtful: 'desconfiada e aguda, entonação de hã?, brincalhona',
  // Aliases do guia de voz: o LLM/cliente pode pedir o modo diretamente.
  clingy: 'aguda, brilhante e apegada, sorriso na voz, tom manhoso',
  pout: 'protesto manhoso e dramatizado, agudo, emburrada, birra fofa',
  hype: 'super energetica, hiperexpressiva, consoantes punchy, aguda e empolgada',
  tsundere: 'protesto manhoso e dramatizado, aguda, emburrada mas com vergonha, birra fofa',
});

// Nuances prosódicas por registro social (Crescentine / OpenAmika V2).
// `casual` é o registro padrão da voz base da Usami, então não adiciona prefixo redundante.
export const REGISTER_PROSODY = Object.freeze({
  polite: 'tom educado, gentil e composto, dicção clara',
  casual: '',
  serious: 'tom firme, composto e contido, menos saltitante',
  intimate: 'voz próxima, doce e baixinha, tom íntimo e afetuoso',
  whisper: 'sussurrada bem baixinho ao pé do ouvido, ritmo lento, suave e reconfortante',
});

// Nuances prosódicas por emoção fina dentro do vocabulário V2.
export const EMOTION_PROSODY = Object.freeze({
  neutral: '',
  smile: 'sorriso leve e simpático na voz, calorosa e agradável',
  happy: 'super animada e hiperexpressiva, aguda e saltitante, sorriso na voz, consoantes punchy',
  very_happy: 'radiante, eufórica e super energética, aguda e saltitante, empolgação contagiante',
  playful: 'travessa, provocativa e brincalhona, sorriso maroto na voz, entonação divertida',
  laughing: 'risonha e alegre, falando entre risadinhas leves, timbre brilhante e contagiante',
  relieved: 'aliviada e serena, soltando a tensão, sorriso calmo e reconfortante',
  shy: 'baixinha, hesitante e doce, quase sussurrada, com vergonha',
  very_shy: 'muito baixinha, trêmula e hesitante, voz sumindo de tanta timidez, com vergonha',
  embarrassed: 'encabulada e sem jeito, aguda, tentando disfarçar a timidez, com vergonha',
  mumbling: 'resmungando baixinho entre os dentes, manhosa e meio emburrada',
  jealous: 'enciumada e manhosa, protesto fofo de beicinho, querendo atenção exclusiva',
  caring: 'doce, acolhedora e carinhosa, sorriso gentil na voz, tom protetor e afetuoso',
  very_caring: 'extremamente doce, devotada e maternal, voz macia, cheia de ternura e dengo',
  protective: 'firme, decidida e protetora, tom seguro de quem cuida e defende',
  surprise: 'espantada e aguda, salto de pitch súbito, reação viva de surpresa',
  angry: 'protesto manhoso e dramatizado, aguda, emburrada, birra fofa sem agressividade',
  very_angry: 'indignada e exaltada, aguda e enfática, bronca dramática de anime',
  frustrated: 'impaciente e contrariada, bufando de leve, tom de protesto manhoso',
  cold: 'distante, seca e contida, sem sorriso na voz, cadência curta',
  disappointed: 'desapontada e abatida, energia baixa, tom de queixa suave',
  sad: 'triste e embargada, mais lenta e baixa, com suspiros',
  very_sad: 'muito triste e sentido, voz embargada e frágil, ritmo lento e melancólico',
  tearful: 'voz trêmula à beira do choro, fungando de leve, frágil e emotiva',
  tired: 'cansada e lenta, pouca energia, ritmo arrastado e relaxado',
  sleepy: 'sonolenta, lenta e macia, voz pesada de sono, quase cochilando',
  fear: 'assustada e trêmula, fôlego curto, aguda e vulnerável',
  worried: 'preocupada e atenciosa, entonação inquieta e cuidadosa',
  anxious: 'ansiosa e hesitante, ritmo um pouco acelerado e inseguro',
});

const KNOWN_EMOTION_NAMES = new Set([
  ...Object.values(EMOTION_SETS).flat(),
  ...Object.keys(EMOTION_ALIASES),
]);

const KNOWN_REGISTER_NAMES = new Set([
  ...REGISTERS,
  ...Object.keys(REGISTER_ALIASES),
]);

/**
 * Verifica se uma tag normalizada pertence ao vocabulário emocional V2
 * (registro explícito, emoção conhecida ou combinação `<registro>_<emoção>`).
 * Evita que rótulos arbitrários desconhecidos (ex.: 'estranho-x') ganhem cláusula.
 */
export function isKnownEmotionStyle(rawStyleId) {
  const raw = String(rawStyleId ?? '').trim().toLowerCase();
  if (!raw) return false;
  if (Object.hasOwn(STYLE_INSTRUCTIONS, raw)) return true;

  const norm = normalizeEmotionTag(raw);
  if (!norm) return false;
  if (VALID_EMOTIONS.has(norm)) return true;
  if (KNOWN_EMOTION_NAMES.has(norm) || KNOWN_REGISTER_NAMES.has(norm)) return true;

  if (norm.startsWith('very_') && KNOWN_EMOTION_NAMES.has(norm.slice(5))) {
    return true;
  }

  const parts = norm.split('_');
  if (parts.length >= 2 && KNOWN_REGISTER_NAMES.has(parts[0])) {
    const rest = parts.slice(1).join('_');
    if (KNOWN_EMOTION_NAMES.has(rest)) return true;
    if (rest.startsWith('very_') && KNOWN_EMOTION_NAMES.has(rest.slice(5))) return true;
  }

  return false;
}

/**
 * Resolve o `styleId` recebido em `/api/tts` para a cláusula de estilo do Gemini TTS.
 * - Chaves legadas (`happy`, `shy`, `whisper`, etc.) devolvem exatamente `STYLE_INSTRUCTIONS[key]`.
 * - `neutral`, `casual_neutral` e desconhecidos devolvem `''`.
 * - Chaves V2 (`<registro>_<emoção>`, ex.: `casual_happy`, `intimate_shy`, `whisper_sleepy`)
 *   combinam a nuance do registro social com a cláusula da emoção.
 */
export function resolveGeminiStyleClause(styleId) {
  const raw = String(styleId ?? '').trim().toLowerCase();
  if (!raw || raw === 'neutral' || raw === 'casual_neutral') return '';

  // 1. Prioridade total para a tabela legada (preserva contratos exatos dos testes V1)
  if (Object.hasOwn(STYLE_INSTRUCTIONS, raw)) {
    return STYLE_INSTRUCTIONS[raw];
  }

  // 2. Se não for uma tag V2 reconhecida, cai deterministicamente na instrução base ('')
  if (!isKnownEmotionStyle(raw)) {
    return '';
  }

  // 3. Resolve para uma das 69 chaves canônicas `<register>_<emotion>`
  const canonical = resolveEmotion(raw);
  if (canonical === 'casual_neutral') return '';

  const sep = canonical.indexOf('_');
  const register = sep > 0 ? canonical.slice(0, sep) : 'casual';
  const emotion = sep > 0 ? canonical.slice(sep + 1) : canonical;

  const regClause = REGISTER_PROSODY[register] || '';
  const emoClause = EMOTION_PROSODY[emotion] || '';

  return [regClause, emoClause].filter(Boolean).join(', ');
}

export const DEFAULT_USAMI_VOICE_INSTRUCTION =
  '[em português do Brasil, voz de personagem de anime, muito aguda e brilhante, timbre leve e expressivo, dicção rápida e nítida] ';

/**
 * Resolve dinamicamente as configurações de voz, modelo e prosódia a partir do
 * manifesto do personagem ativo, mantendo fallback seguro quando campos faltarem.
 * @param {object|null|undefined} manifest
 * @param {string} [styleId='neutral']
 * @param {Object} [options]
 */
export function resolveCharacterVoiceProsody(
  manifest,
  styleId = 'neutral',
  {
    fallbackVoice = 'Kore',
    fallbackInstruction = DEFAULT_USAMI_VOICE_INSTRUCTION,
  } = {},
) {
  const voiceCfg = manifest?.voice && typeof manifest.voice === 'object' ? manifest.voice : {};
  const rawStyle = String(styleId ?? 'neutral').trim().toLowerCase() || 'neutral';
  const prosodyMap = voiceCfg.prosodyMap && typeof voiceCfg.prosodyMap === 'object' ? voiceCfg.prosodyMap : null;

  let override = null;
  if (prosodyMap) {
    if (Object.hasOwn(prosodyMap, rawStyle)) {
      override = prosodyMap[rawStyle];
    } else {
      const sep = rawStyle.indexOf('_');
      if (sep > 0) {
        const baseEmotion = rawStyle.slice(sep + 1);
        if (Object.hasOwn(prosodyMap, baseEmotion)) {
          override = prosodyMap[baseEmotion];
        }
      }
    }
  }

  const engine = typeof voiceCfg.engine === 'string' && voiceCfg.engine.trim()
    ? voiceCfg.engine.trim()
    : 'gemini_multimodal';
  const voice = (typeof override?.voice === 'string' && override.voice.trim())
    ? override.voice.trim()
    : (typeof voiceCfg.defaultVoice === 'string' && voiceCfg.defaultVoice.trim()
      ? voiceCfg.defaultVoice.trim()
      : fallbackVoice);
  const model = typeof voiceCfg.model === 'string' && voiceCfg.model.trim()
    ? voiceCfg.model.trim()
    : null;
  const pitchOffset = Number.isFinite(override?.pitchOffset)
    ? override.pitchOffset
    : (Number.isFinite(voiceCfg.pitchOffset) ? voiceCfg.pitchOffset : 0);
  const speakingRate = Number.isFinite(override?.rate)
    ? override.rate
    : (Number.isFinite(voiceCfg.speakingRate) ? voiceCfg.speakingRate : 1.0);
  const styleClause = override?.styleClause !== undefined
    ? String(override.styleClause)
    : resolveGeminiStyleClause(rawStyle);
  const baseInstruction = voiceCfg.baseInstruction !== undefined
    ? String(voiceCfg.baseInstruction)
    : fallbackInstruction;

  return {
    engine,
    voice,
    model,
    pitchOffset,
    speakingRate,
    styleClause,
    baseInstruction,
  };
}

