// Histórico local da conversa. O servidor não guarda o chat; as últimas
// mensagens ficam só neste navegador, com o mesmo formato usado nos balões.
import { safeGetItem, safeRemoveItem, safeSetItem } from './storage-safe.js';

export const CONVERSATION_STORAGE_KEY = 'usami.conversation.v1';
export const MAX_STORED_TURNS = 100;

function normalizeTurn(turn) {
  if (!turn || typeof turn !== 'object') return null;
  const content = typeof turn.content === 'string' ? turn.content.trim() : '';
  if (!content) return null;
  const normalized = {
    id: Number.isFinite(Number(turn.id)) ? Number(turn.id) : 0,
    role: turn.role === 'assistant' ? 'assistant' : 'user',
    content,
    mode: turn.mode === 'voice' ? 'voice' : 'text',
  };
  // Turno de erro do chat (F2): sobrevive ao reload para o retry continuar ali.
  if (turn.error === true) normalized.error = true;
  return normalized;
}

function normalizeTurns(turns) {
  return (Array.isArray(turns) ? turns : []).map(normalizeTurn).filter(Boolean);
}

export function loadConversation(storage) {
  try {
    const raw = safeGetItem(CONVERSATION_STORAGE_KEY, storage);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return normalizeTurns(parsed).slice(-MAX_STORED_TURNS);
  } catch {
    return [];
  }
}

// Grava e, se o storage recusar (quota cheia), poda os turnos mais antigos:
// 100 → metade → 20 → 5. O retorno continua sendo a lista completa para a
// sessão atual; só o que fica no navegador encolhe.
export function saveConversation(turns, storage) {
  const safe = normalizeTurns(turns).slice(-MAX_STORED_TURNS);
  const candidates = [safe, safe.slice(-Math.max(20, Math.ceil(safe.length / 2))), safe.slice(-20), safe.slice(-5)];
  for (const candidate of candidates) {
    if (!candidate.length) break;
    if (safeSetItem(CONVERSATION_STORAGE_KEY, JSON.stringify(candidate), storage)) break;
  }
  return safe;
}

export function clearStoredConversation(storage) {
  safeRemoveItem(CONVERSATION_STORAGE_KEY, storage);
}

// Ao recarregar, o próximo id não pode colidir com o último salvo.
export function latestTurnId(turns) {
  return normalizeTurns(turns).reduce((latest, turn) => Math.max(latest, turn.id), 0);
}
