// Histórico local da conversa. O servidor não guarda o chat; as últimas
// mensagens ficam só neste navegador, com o mesmo formato usado nos balões.
export const CONVERSATION_STORAGE_KEY = 'usami.conversation.v1';
export const MAX_STORED_TURNS = 100;

function defaultStorage() {
  try {
    return globalThis.localStorage;
  } catch {
    // Navegador com storage bloqueado: o chat segue em memória.
    return null;
  }
}

function normalizeTurn(turn) {
  if (!turn || typeof turn !== 'object') return null;
  const content = typeof turn.content === 'string' ? turn.content.trim() : '';
  if (!content) return null;
  return {
    id: Number.isFinite(Number(turn.id)) ? Number(turn.id) : 0,
    role: turn.role === 'assistant' ? 'assistant' : 'user',
    content,
    mode: turn.mode === 'voice' ? 'voice' : 'text',
  };
}

function normalizeTurns(turns) {
  return (Array.isArray(turns) ? turns : []).map(normalizeTurn).filter(Boolean);
}

export function loadConversation(storage = defaultStorage()) {
  try {
    const raw = storage?.getItem(CONVERSATION_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return normalizeTurns(parsed).slice(-MAX_STORED_TURNS);
  } catch {
    return [];
  }
}

export function saveConversation(turns, storage = defaultStorage()) {
  const safe = normalizeTurns(turns).slice(-MAX_STORED_TURNS);
  try {
    storage?.setItem(CONVERSATION_STORAGE_KEY, JSON.stringify(safe));
  } catch {
    // Sem quota/storage: não impede a conversa de continuar.
  }
  return safe;
}

export function clearStoredConversation(storage = defaultStorage()) {
  try {
    storage?.removeItem(CONVERSATION_STORAGE_KEY);
  } catch {
    // idem: limpar a tela não pode falhar por causa do storage.
  }
}

// Ao recarregar, o próximo id não pode colidir com o último salvo.
export function latestTurnId(turns) {
  return normalizeTurns(turns).reduce((latest, turn) => Math.max(latest, turn.id), 0);
}
