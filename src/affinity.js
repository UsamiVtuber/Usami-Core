/**
 * Afinidade da Usami — lógica pura, sem I/O.
 *
 * O score (0–100) sobe E desce, com cap diário de ganho (`DAILY_CAP`). A
 * Usami SABE que o score existe e pode influenciar de propósito (regra 4 da
 * persona) — as heurísticas aqui são determinísticas, sem chamada extra de LLM.
 */

export const DAILY_CAP = 6;
export const STAGE_THRESHOLDS = [0, 20, 40, 60, 80, 101];
export const STAGE_LABELS = ['curiosidade_distante', 'interesse_genuíno', 'se_aproximando', 'confianca', 'apego'];

// Usuário pergunta sobre a Usami ("você gosta de...", "qual seu...", "quem é você").
// Nota: 'é' tem acento, então \b não funciona nele — o delimitador é explícito.
const ASKS_ABOUT_USAMI = /\b(voc[êe]|vc)\s+(gost\w*|ama\w*|quer\w*|prefere\w*|acha\w*|faz\w*|tem\b|é[\s,.?!])|\bqual(\s+é)?\s+(o\s+)?(seu|sua)\b|\bseu nome\b|\bquem\s+(é|e)\s+(você|voce|vc)/i;

// Elogio direto ou agradecimento carinhoso ("fofa", "legal", "obrigado").
const COMPLIMENT = /\b(fof\w+|legal|linda|bonita|gatinha|meig[ao]|ador[áa]vel|am[áa]vel|incr[íi]vel|maravilhosa|fant[áa]stica|perfeita|obrigad\w*|obg|cute|kawaii)\b/i;

// Usuário compartilha algo pessoal ("hoje eu...", "me sinto...", "eu gosto de...").
const PERSONAL_SHARE = /\b(hoje eu|ontem eu|meu dia|me sinto|me senti|me sentindo|estou (feliz|triste|cansad|animad|estressad|nervos|sozinh)|t[óo] (feliz|triste|cansad|animad|sozinh)|eu (gosto|gostei|odeio|amo|tenho|fui|mor[oei]|trabalho|estudo|consegui|perdi|ganhei|ado[lt]ei|comprei|terminei)|minha (m[ãa]e|namorada|esposa|irma|filha|filho)|meu (pai|namorado|marido|irmao|cachorro|gato|emprego)|no trabalho|na (escola|faculdade|facu))/i;

// Grosseria explícita.
const RUDE = /\b(idiot\w*|burr\w+|est[úu]pid\w*|imbecil|ot[áa]ri\w*|v[áa]i? se f\w*|foda-?se|vtnc|pqp|merda|bosta|cala a boca|cai fora|sai fora|chat[ao]|lixo|odeio (você|voce|vc))/i;

// Resposta curta que só reconhece o turno ("ok", "sim", "não").
const ACK_ONLY = /^(ok|okay|oks?|sim|n[ãa]o|nao|nah|nops?|hm+|hum+|k|blz|beleza|certo|aham|yeah|yes|no|tb|tudo bem)$/i;

// Usami se empenha na relação: exclamação ou tempero tsundere no reply dela.
const STRONG_EMOTION = /!|hmph|b-baka/i;

function clampTurn(delta) {
  return Math.max(-3, Math.min(3, delta));
}

/**
 * Quanto o turno vale para a afinidade.
 * @param {{ userMessage?: string, assistantReply?: string, rememberFact?: string|null,
 *           currentScore?: number, stage?: string, alreadyGainedToday?: number }} context
 * @returns {{ delta: number, reason: string }} delta clamp -3..+3; cap diário zera o ganho.
 */
export function calculateGain(context = {}) {
  const userMessage = typeof context.userMessage === 'string' ? context.userMessage : '';
  const assistantReply = typeof context.assistantReply === 'string' ? context.assistantReply : '';
  const alreadyGainedToday = Number.isFinite(context.alreadyGainedToday) ? context.alreadyGainedToday : 0;

  if (!canGainMore(alreadyGainedToday)) {
    return { delta: 0, reason: 'cap_diario' };
  }

  let delta = 0;
  const reasons = [];

  if (context.rememberFact) {
    delta += 2;
    reasons.push('fato_novo');
  }

  const bare = userMessage.trim().replace(/[.!?…\s]+$/, '');
  if (RUDE.test(userMessage)) {
    // Grosseria suprime os pontos positivos da mensagem: não existe elogio em insulto.
    delta -= 2;
    reasons.push('grosseiro');
  } else if (ACK_ONLY.test(bare)) {
    reasons.push('resposta_curta');
  } else {
    if (ASKS_ABOUT_USAMI.test(userMessage)) { delta += 1; reasons.push('pergunta_sobre_usami'); }
    if (COMPLIMENT.test(userMessage)) { delta += 1; reasons.push('elogio'); }
    if (PERSONAL_SHARE.test(userMessage)) { delta += 1; reasons.push('compartilhou_pessoal'); }
  }

  if (STRONG_EMOTION.test(assistantReply)) {
    delta += 1;
    reasons.push('usami_emocao_forte');
  }

  if (!reasons.length) reasons.push('neutro');
  return { delta: clampTurn(delta), reason: reasons.join('+') };
}

/**
 * Aplica o delta ao score e administra o contador diário.
 * @returns {{ score: number, lastDailyGainDate: string, totalDailyGainToday: number }}
 */
export function applyGain(current, delta, today, lastDailyGainDate, totalDailyGainToday) {
  const base = Number.isFinite(current) ? current : 0;
  const step = Number.isFinite(delta) ? delta : 0;
  const score = Math.max(0, Math.min(100, Math.round(base + step)));
  const isNewDay = today !== lastDailyGainDate;
  const dayTotal = isNewDay ? 0 : (Number.isFinite(totalDailyGainToday) ? totalDailyGainToday : 0);
  return {
    score,
    lastDailyGainDate: today,
    // só o ganho positivo consome o cap diário; queda não "devolve" pontos
    totalDailyGainToday: dayTotal + Math.max(0, step),
  };
}

/** Rótulo do estágio (STAGE_THRESHOLDS[i] <= score < STAGE_THRESHOLDS[i+1]). */
export function getStage(score) {
  const value = Number.isFinite(score) ? Math.max(0, Math.min(100, Math.trunc(score))) : 0;
  for (let index = 0; index < STAGE_LABELS.length; index += 1) {
    if (value >= STAGE_THRESHOLDS[index] && value < STAGE_THRESHOLDS[index + 1]) return STAGE_LABELS[index];
  }
  return STAGE_LABELS[STAGE_LABELS.length - 1];
}

/** Ainda dá para ganhar afinidade hoje? */
export function canGainMore(totalDailyGainToday) {
  const total = Number.isFinite(totalDailyGainToday) ? totalDailyGainToday : 0;
  return total < DAILY_CAP;
}
