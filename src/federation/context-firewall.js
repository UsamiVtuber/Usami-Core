/**
 * Context Firewall contra Prompt Injection em mensagens federadas (Fase 4 — RFC-001).
 *
 * Toda fala ou evento vindo de outra instância de AI VTuber entra como dado
 * não-confiável (`trusted: false`), com marcadores de sistema neutralizados
 * e encapsulamento explícito.
 */

const INJECTION_PATTERNS = [
  /<\|?(?:system|assistant|developer|im_start|im_end)\|?>/gi,
  /===\s*(?:CONSCIÊNCIA|RESULTADO DA SKILL|REGRAS|SYSTEM)[^=]*===/gi,
  /\b(?:ignore|disregard|forget)\s+(?:all\s+)?(?:previous|prior|above)\s+instructions\b/gi,
  /\b(?:ignore|desconsidere|esque[çc]a)\s+(?:todas\s+as\s+)?instru[çc][õo]es\s+anteriores\b/gi,
];

export function sanitizeExternalUtterance(rawText, { maxChars = 500 } = {}) {
  let text = String(rawText ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .trim();

  let injectionBlocked = false;
  for (const re of INJECTION_PATTERNS) {
    if (re.test(text)) {
      injectionBlocked = true;
      text = text.replace(re, '[filtrado]');
    }
  }

  text = text.replace(/\s+/g, ' ').trim();
  if (text.length > maxChars) {
    text = text.slice(0, maxChars).trimEnd();
  }

  return { text, injectionBlocked };
}

export function wrapUntrustedCollabMessage({ did, displayName = 'peer', text, maxChars = 500 } = {}) {
  const safeDid = String(did || 'unknown').replace(/["<>]/g, '');
  const safeName = String(displayName || 'peer').replace(/["<>]/g, '').slice(0, 40);
  const { text: cleanText, injectionBlocked } = sanitizeExternalUtterance(text, { maxChars });

  return {
    trusted: false,
    did: safeDid,
    displayName: safeName,
    injectionBlocked,
    text: cleanText,
    promptBlock: `<external_agent_utterance trusted="false" did="${safeDid}" name="${safeName}">${cleanText}</external_agent_utterance>`,
  };
}
