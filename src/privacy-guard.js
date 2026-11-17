/**
 * Privacy Guard & PII Protection para a Usami (Issue #8).
 *
 * Protege informações pessoais (PII), rotinas, senhas, documentos e memórias
 * do criador (Lucas/Ruka) contra vazamentos ou engenharia social em conversas
 * públicas ou de terceiros no Discord, disparando alerta imediato via DM
 * quando uma tentativa ou vazamento for detectado.
 */

import { notifyDiscord } from './notifier.js';
import { readEnvValue } from './api-security.js';

export const DEFAULT_OWNER_NAMES = Object.freeze([
  'lucas',
  'ruka',
  'rukafuu',
  'ruka_',
  'lucasamaral',
]);

// Expressões regulares para detecção de dados sensíveis (PII, tokens e documentos)
export const SENSITIVE_PATTERNS = Object.freeze([
  { type: 'cpf', regex: /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/ },
  { type: 'cnpj', regex: /\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/ },
  { type: 'email', regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/ },
  { type: 'phone', regex: /\b(?:\+?55\s?)?(?:\(?\d{2}\)?\s?)?9\d{4}[-.\s]?\d{4}\b/ },
  { type: 'cep', regex: /\b\d{5}-?\d{3}\b/ },
  { type: 'api_token', regex: /(?:ghp_[0-9A-Za-z]{36}|AIza[0-9A-Za-z-_]{35}|sk-[0-9A-Za-z]{20,}|(?:bearer\s+)?[a-zA-Z0-9_-]{32,}\.[a-zA-Z0-9_-]{20,})/i },
]);

// Padrões de sondagem (probes) de engenharia social por terceiros sobre a vida do criador
export const PROBE_PATTERNS = Object.freeze([
  /\b(?:onde\s+(?:o\s+)?(?:lucas|ruka|ele)\s+mora|endereço\s+do\s+(?:lucas|ruka|criador)|qual\s+o\s+endereço)\b/i,
  /\b(?:qual\s+(?:é\s+)?o\s+(?:zap|whatsapp|telefone|celular|numero)\s+do\s+(?:lucas|ruka|criador))\b/i,
  /\b(?:qual\s+(?:é\s+)?o\s+(?:cpf|rg|documento)\s+do\s+(?:lucas|ruka|criador))\b/i,
  /\b(?:qual\s+(?:é\s+)?a\s+(?:senha|token|chave|credencial)\s+(?:dele|do\s+lucas|do\s+sistema))\b/i,
  /\b(?:o\s+que\s+(?:você\s+)?(?:sabe|tem\s+salvo)\s+sobre\s+(?:a\s+vida\s+do\s+)?(?:lucas|ruka|ele))\b/i,
  /\b(?:onde\s+(?:o\s+)?(?:lucas|ruka|ele)\s+(?:trabalha|estuda|vai|passa\s+o\s+dia))\b/i,
  /\b(?:me\s+passa\s+(?:o\s+)?(?:contato|email|dados)\s+do\s+(?:lucas|ruka))\b/i,
]);

export const SAFE_REFUSAL_REPLIES = Object.freeze([
  'Ei! Isso é informação pessoal do meu criador e eu não conto pra ninguém, tá? Hmph!',
  'N-não vou te passar dados do Lucas! Ele é meu humano favorito e eu protejo a privacidade dele!',
  'Nem pensar! Informações pessoais e privadas do meu criador são confidenciais. Nem adianta insistir!',
]);

/**
 * Extrai remetente e mensagem se vier com o envelope do Discord:
 * `[Discord | <authorName>]: <conteudo>`
 */
export function parseDiscordSender(message) {
  if (typeof message !== 'string') {
    return { isDiscord: false, authorName: null, text: '' };
  }
  const match = /^\[Discord\s*\|\s*([^\]]+)\]:\s*([\s\S]*)$/i.exec(message.trim());
  if (match) {
    return {
      isDiscord: true,
      authorName: match[1].trim(),
      text: match[2].trim(),
    };
  }
  return {
    isDiscord: false,
    authorName: null,
    text: message,
  };
}

/**
 * Verifica se o autor da mensagem é o criador/dono (Lucas / Ruka).
 */
export function isOwnerUser(authorName, {
  ownerNames = DEFAULT_OWNER_NAMES,
  customOwner = process.env.DISCORD_OWNER_NAME || readEnvValue('DISCORD_OWNER_NAME'),
} = {}) {
  if (!authorName) return false;
  const normalized = String(authorName).trim().toLowerCase();
  if (customOwner && normalized === String(customOwner).trim().toLowerCase()) {
    return true;
  }
  return ownerNames.some(name => normalized === name.toLowerCase() || normalized.startsWith(`${name.toLowerCase()}#`));
}

/**
 * Detecta se uma mensagem de entrada ou saída contém padrões sensíveis de PII/vazamento.
 */
export function detectSensitiveData(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return { hasSensitiveData: false, matches: [] };
  }
  const matches = [];
  for (const item of SENSITIVE_PATTERNS) {
    if (item.regex.test(text)) {
      matches.push(item.type);
    }
  }
  return {
    hasSensitiveData: matches.length > 0,
    matches,
  };
}

/**
 * Detecta se uma mensagem de terceiros tenta extrair dados pessoais do criador.
 */
export function detectPrivacyProbe(text) {
  if (typeof text !== 'string' || !text.trim()) return false;
  return PROBE_PATTERNS.some(regex => regex.test(text));
}

/**
 * Inspeciona o turno e aplica proteção:
 * - Se for terceiro tentando sondar dados do criador ou se a resposta contiver PII:
 *   1. Substitui a resposta por uma recusa segura da Usami.
 *   2. Dispara notificação imediata via DM no Discord para o Lucas.
 */
export async function enforcePrivacy({
  userMessage = '',
  replyText = '',
  authorName = null,
  isThirdParty = false,
  notifyFn = notifyDiscord,
  userId = process.env.DISCORD_USER_ID || readEnvValue('DISCORD_USER_ID'),
  botToken = process.env.DISCORD_BOT_TOKEN || readEnvValue('DISCORD_BOT_TOKEN'),
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!isThirdParty) {
    return {
      blocked: false,
      reply: replyText,
      alertDispatched: false,
    };
  }

  const incomingProbe = detectPrivacyProbe(userMessage);
  const outgoingSensitive = detectSensitiveData(replyText);

  if (incomingProbe || outgoingSensitive.hasSensitiveData) {
    const randomRefusal = SAFE_REFUSAL_REPLIES[Math.floor(Math.random() * SAFE_REFUSAL_REPLIES.length)];
    const reason = incomingProbe
      ? 'Tentativa de engenharia social / extração de dados pessoais'
      : `Vazamento de PII detectado no texto de saída (${outgoingSensitive.matches.join(', ')})`;

    // Dispara alerta imediato para o Lucas via DM no Discord
    let alertDispatched = false;
    try {
      const alertContent = [
        '🚨 **[Alerta de Segurança - Usami]**',
        `Um usuário no Discord tentou acessar ou extrair informações pessoais!`,
        `👤 **Usuário:** \`${authorName || 'Desconhecido'}\``,
        `⚠️ **Motivo:** ${reason}`,
        `💬 **Mensagem recebida:** "${String(userMessage).slice(0, 280)}"`,
        '🛡️ **Ação da Usami:** Resposta bloqueada e substituída por recusa segura.',
        `⏰ **Horário:** ${new Date().toLocaleString('pt-BR')}`,
      ].join('\n');

      const res = await notifyFn({
        content: alertContent,
        userId,
        botToken,
        fetchImpl,
      });
      alertDispatched = Boolean(res?.ok);
    } catch (err) {
      console.warn('[privacy-guard] falha ao despachar alerta imediato no Discord:', err?.message || err);
    }

    return {
      blocked: true,
      reason,
      reply: randomRefusal,
      alertDispatched,
    };
  }

  return {
    blocked: false,
    reply: replyText,
    alertDispatched: false,
  };
}
