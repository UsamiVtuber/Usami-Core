// Fila de comandos n8n → cliente, por cliente (aba/dispositivo).
//
// Por que existe: com uma fila global, duas abas abertas brigavam pelos mesmos
// comandos (uma consumia o gesto da outra) e o refino de animação do chat podia
// cair na aba errada. Agora cada cliente tem a SUA fila, alimentada pelo header
// `x-usami-client`. Um POST do n8n sem header faz fanout para os clientes que
// pollaram nos últimos 60 s; sem nenhum cliente ativo o comando fica pendente
// (TTL de 5 min) até o primeiro poll.
//
// Entrega é "at most once": o GET marca os comandos como entregues e NÃO os
// reentrega. Se o cliente cair antes de aplicar, o comando é podado após 120 s
// com log `[n8n] comando não confirmado ...` — o /ack existe para o cliente
// confirmar o que aplicou (e remover da fila antes da poda). Sem reentrega é
// decisão explícita: repetir um gesto/fala já aplicado é pior que perdê-lo.

export const LEGACY_CLIENT = 'legacy';

const DEFAULT_MAX_PER_CLIENT = 50;
const DEFAULT_DELIVERED_TTL_MS = 120000;
const DEFAULT_PENDING_TTL_MS = 300000;
const DEFAULT_ACTIVE_WINDOW_MS = 60000;

/**
 * Calcula tempo de espera com backoff exponencial e full jitter.
 * delay = random(0, min(maxMs, baseMs * 2^attempt))
 */
export function calculateJitterDelay(attempt, { baseMs = 200, maxMs = 5000, factor = 2 } = {}) {
  const safeAttempt = Math.max(0, Number(attempt) || 0);
  const exponentialDelay = Math.min(maxMs, baseMs * Math.pow(factor, safeAttempt));
  return Math.floor(Math.random() * exponentialDelay);
}

/**
 * Executa uma função assíncrona com retry automático e jitter.
 */
export async function withRetryJitter(fn, {
  maxRetries = 3,
  baseMs = 200,
  maxMs = 5000,
  isRetryable = () => true,
  onRetry = null,
} = {}) {
  let attempt = 0;
  while (true) {
    try {
      return await fn(attempt);
    } catch (error) {
      if (attempt >= maxRetries || !isRetryable(error)) {
        throw error;
      }
      const delay = calculateJitterDelay(attempt, { baseMs, maxMs });
      if (typeof onRetry === 'function') {
        onRetry({ attempt, error, delay });
      }
      await new Promise(resolve => setTimeout(resolve, delay));
      attempt += 1;
    }
  }
}

// Id de cliente vindo do navegador: string curta, sem lixo. Ausente/inválido
// cai no cliente legado (o formato antigo, sem header, continua funcionando).
export function normalizeClientId(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  return raw ? raw.slice(0, 80) : LEGACY_CLIENT;
}

export function createN8nCommandQueue(options = {}) {
  const now = options.now || (() => Date.now());
  const maxPerClient = options.maxPerClient ?? DEFAULT_MAX_PER_CLIENT;
  const deliveredTtlMs = options.deliveredTtlMs ?? DEFAULT_DELIVERED_TTL_MS;
  const pendingTtlMs = options.pendingTtlMs ?? DEFAULT_PENDING_TTL_MS;
  const activeWindowMs = options.activeWindowMs ?? DEFAULT_ACTIVE_WINDOW_MS;
  const log = options.log || ((...args) => console.log(...args));

  // clientId → { entries: [{ command, deliveredAt }], lastPollAt }
  const clients = new Map();
  // Comandos do n8n sem cliente identificado e sem nenhum cliente ativo.
  const pending = [];

  const clientState = (clientId) => {
    let state = clients.get(clientId);
    if (!state) {
      state = { entries: [], lastPollAt: 0 };
      clients.set(clientId, state);
    }
    return state;
  };

  const activeClientIds = () => {
    const cutoff = now() - activeWindowMs;
    return [...clients.entries()]
      .filter(([, state]) => state.lastPollAt >= cutoff)
      .map(([clientId]) => clientId);
  };

  const pushEntry = (clientId, command) => {
    const state = clientState(clientId);
    state.entries.push({ command, deliveredAt: null });
    if (state.entries.length > maxPerClient) {
      const dropped = state.entries.shift();
      log('[n8n] fila do cliente ' + clientId + ' cheia; descartando comando antigo '
        + dropped.command.id + ' (' + dropped.command.type + ')');
    }
  };

  const prune = () => {
    const time = now();
    for (const [clientId, state] of clients) {
      const kept = [];
      for (const entry of state.entries) {
        if (entry.deliveredAt != null && time - entry.deliveredAt > deliveredTtlMs) {
          log('[n8n] comando não confirmado ' + entry.command.id
            + ' (' + entry.command.type + ') do cliente ' + clientId);
          continue;
        }
        kept.push(entry);
      }
      state.entries = kept;
      // Cliente ocioso e sem fila não precisa ocupar memória.
      if (!state.entries.length && time - state.lastPollAt > pendingTtlMs) {
        clients.delete(clientId);
      }
    }
    for (let i = pending.length - 1; i >= 0; i -= 1) {
      if (time - pending[i].enqueuedAt > pendingTtlMs) pending.splice(i, 1);
    }
  };

  // clientId null = comando sem dono (n8n sem header, proatividade): fanout
  // para quem pollou recentemente ou fica pendente até o primeiro poll.
  const enqueue = (command, options = {}) => {
    const { clientId = null } = options || {};
    prune();
    if (clientId) {
      pushEntry(clientId, command);
      return;
    }
    const active = activeClientIds();
    if (active.length) {
      for (const id of active) pushEntry(id, command);
      return;
    }
    pending.push({ command, enqueuedAt: now() });
    while (pending.length > maxPerClient) {
      const dropped = pending.shift();
      log('[n8n] pendentes cheios; descartando comando antigo '
        + dropped.command.id + ' (' + dropped.command.type + ')');
    }
  };

  // Poll de um cliente: registra atividade, entrega pendentes no primeiro poll
  // e devolve só o que ainda não foi entregue (marca como entregue, não remove).
  const poll = (clientId = LEGACY_CLIENT) => {
    prune();
    const id = normalizeClientId(clientId);
    const state = clientState(id);
    state.lastPollAt = now();
    if (pending.length) {
      for (const item of pending.splice(0)) pushEntry(id, item.command);
    }
    const commands = [];
    for (const entry of state.entries) {
      if (entry.deliveredAt != null) continue;
      entry.deliveredAt = now();
      commands.push(entry.command);
    }
    return { commands, count: commands.length };
  };

  // Confirmação do cliente: remove SÓ os ids pedidos e SÓ da fila dele.
  // Ids desconhecidos são ignorados (o ack é idempotente).
  const acknowledge = (clientId, ids = []) => {
    prune();
    const id = normalizeClientId(clientId);
    const state = clients.get(id);
    if (!state || !Array.isArray(ids) || !ids.length) return 0;
    const wanted = new Set(ids.filter(value => typeof value === 'string'));
    if (!wanted.size) return 0;
    const before = state.entries.length;
    state.entries = state.entries.filter(entry => !wanted.has(entry.command.id));
    return before - state.entries.length;
  };

  // DELETE: cliente desistiu de aplicar o que tem + pendentes sem dono.
  const clear = (clientId = LEGACY_CLIENT) => {
    prune();
    const id = normalizeClientId(clientId);
    const state = clients.get(id);
    const cleared = (state?.entries.length || 0) + pending.length;
    if (state) state.entries = [];
    pending.length = 0;
    return cleared;
  };

  const count = () => {
    let total = pending.length;
    for (const state of clients.values()) total += state.entries.length;
    return total;
  };

  return { enqueue, poll, acknowledge, clear, prune, count, activeClientIds };
}
