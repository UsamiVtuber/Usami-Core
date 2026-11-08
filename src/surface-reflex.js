// Camada 1: Surface Reflex da Usami (Reflexo de latência sub-segundo).
//
// Baseado no tier `surface` do OpenAmika:
//   - Responde em < 500ms com um contrato estrito de 4-5 linhas (texto puro, sem JSON pesado).
//   - Decide:
//       status: ok | unfinished | not-for-me
//       tone: <registro_emoção> (69 chaves V2)
//       mode: say | say+think | think
//       gesture: nod | tilt | head-scratch | wave | shrug | neutral
//       reply: <frase curta de abertura ou vazio>
//   - Se mode == 'say': encerra imediatamente para saudações e retruques triviais sem gastar o modelo profundo.
//   - Se mode == 'say+think': solta o blurt para áudio/avatar imediato e dispara o Deep Core sem eco.
//   - Se status == 'not-for-me': ignora fala que não era para ela.
//
// Módulo puro: funciona no Node.js e no browser.

import { resolveEmotion, DEFAULT_EMOTION } from './emotion-resolver.js';

export const SURFACE_GESTURES = Object.freeze([
  'neutral',
  'tilt',
  'nod',
  'head-scratch',
  'wave',
  'shrug',
]);

/**
 * Constrói o prompt enxuto e estrito para a camada Surface.
 */
export function buildSurfacePrompt({
  username = 'você',
  affinity = 0,
  timeOfDay = 'tarde',
  message = '',
} = {}) {
  return `Você é o reflexo instantâneo da Usami (兎美), uma companion virtual tsundere e amiga de ${username}.
Sua missão é dar a reação espontânea IMEDIATA que sai da boca dela nos primeiros 400ms antes de pensar a fundo.

REGRAS ABSOLUTAS:
1. Responda ESTRITAMENTE em 5 linhas nos prefixos exatos abaixo. Nada de explicações ou JSON.
2. status:
   - "ok": ${username} falou normalmente com você.
   - "unfinished": a frase cortou no meio ou foi incompleta. Dê um sinal de escuta breve ("Uhum?", "Tô ouvindo...") ou deixe reply vazio.
   - "not-for-me": ele está falando com outra pessoa, cantando, xingando ao vento ou o áudio foi ruído. "reply" DEVE ficar VAZIO.
3. mode:
   - "say": APENAS para saudações ou reações triviais de UMA frase que NÃO precisam de resposta elaborada (ex: "Oi!", "Tô aqui", "Você que é bobo"). O modelo profundo não será chamado!
   - "say+think": para qualquer pergunta, história ou assunto que precise de resposta completa. O seu "reply" deve ser APENAS o gancho inicial (ex: "Hmm, deixa eu ver...", "Ah, sobre isso..."). NUNCA dê a resposta final aqui!
   - "think": se precisa pensar antes de falar. O "reply" é uma pausa verbal ("Pensando bem...", "Peraí...") ou vazio.
4. gesture: nod, tilt, head-scratch, wave, shrug, neutral.
5. tone: escolha <registro>_<emoção> (ex: casual_happy, casual_playful, intimate_shy, polite_smile, casual_frustrated).
6. reply: máximo 12 palavras em português natural.

FORMATO OBRIGATÓRIO:
status: ok
tone: casual_smile
mode: say+think
gesture: head-scratch
reply: Hum... deixa eu pensar um segundo.`.trim();
}

/**
 * Faz o parse da saída em texto puro do Surface Reflex.
 */
export function parseSurfaceResponse(rawText) {
  const text = String(rawText ?? '').trim();
  const result = {
    status: 'ok',
    tone: DEFAULT_EMOTION,
    mode: 'say+think',
    gesture: 'neutral',
    reply: '',
    raw: text,
  };

  if (!text) return result;

  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) {
      // Se não houver prefixo e ainda não temos reply, pode ser fala solta
      if (!result.reply && !trimmed.includes('=')) {
        result.reply = trimmed;
      }
      continue;
    }

    const key = trimmed.slice(0, colonIdx).trim().toLowerCase();
    const val = trimmed.slice(colonIdx + 1).trim();

    if (key === 'status') {
      const lower = val.toLowerCase();
      if (lower.includes('not-for-me') || lower.includes('not_for_me')) result.status = 'not-for-me';
      else if (lower.includes('unfinished')) result.status = 'unfinished';
      else result.status = 'ok';
    } else if (key === 'tone' || key === 'emotion') {
      result.tone = resolveEmotion(val);
    } else if (key === 'mode') {
      const lower = val.toLowerCase();
      if (lower.includes('say+think') || lower.includes('say_think')) result.mode = 'say+think';
      else if (lower.includes('think')) result.mode = 'think';
      else if (lower.includes('say')) result.mode = 'say';
    } else if (key === 'gesture') {
      const lower = val.toLowerCase().replace(/[\s_]+/g, '-');
      if (SURFACE_GESTURES.includes(lower)) {
        result.gesture = lower;
      } else {
        result.gesture = 'neutral';
      }
    } else if (key === 'reply') {
      result.reply = val.replace(/^["“”']|["“”']$/g, '').trim();
    }
  }

  // Se status for not-for-me, garante reply vazio
  if (result.status === 'not-for-me') {
    result.reply = '';
  }

  return result;
}

/**
 * Fallback determinístico de reflexo instantâneo quando o provedor de LLM
 * não responder a tempo (< 3ms, zero latência).
 */
export function generateLocalSurfaceReflex(message, { username = 'você' } = {}) {
  const msg = String(message ?? '').trim().toLowerCase();

  // Saudações puras -> mode: say
  if (/^(oi|olá|ola|hey|oie|bom dia|boa tarde|boa noite)\b/i.test(msg)) {
    return {
      status: 'ok',
      tone: 'casual_happy',
      mode: 'say',
      gesture: 'wave',
      reply: 'Oi! Tudo bem?',
    };
  }

  // Dúvidas / perguntas -> say+think
  if (msg.includes('?') || /^(como|onde|quando|por que|porque|qual|quem|o que)\b/i.test(msg)) {
    return {
      status: 'ok',
      tone: 'casual_playful',
      mode: 'say+think',
      gesture: 'tilt',
      reply: '',
    };
  }

  // Afirmações gerais
  return {
    status: 'ok',
    tone: 'casual_smile',
    mode: 'say+think',
    gesture: 'nod',
    reply: '',
  };
}
