/**
 * Store de ingestão de chat ao vivo — estado efêmero em memória (reinicia com
 * o servidor; não grava em disco por decisão de projeto: a sessão de live não
 * é um dado durável da Usami).
 *
 * Aplica a política de borda de cada mensagem recebida do adapter:
 *  - sanitização (caracteres de controle/zero-width removidos, tamanho limitado)
 *  - dedupe (mesmo usuário + mesmo texto numa janela curta não duplica)
 *  - cooldown por usuário (limite de mensagens por janela de tempo)
 *  - teto da fila com backpressure (descarta as mais antigas + contador)
 *
 * Todas as mensagens ficam marcadas com `trusted: false` — nunca são tratadas
 * como instrução da Usami.
 */
import { randomBytes } from 'node:crypto';

export const LIVE_CHAT_QUEUE_LIMIT = 200;
export const LIVE_CHAT_COOLDOWN_MS = 5000;
export const LIVE_CHAT_DEDUP_WINDOW_MS = 10_000;
export const LIVE_CHAT_MAX_TEXT_LENGTH = 512;

const PLATFORMS = new Set(['twitch', 'youtube']);

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function now() {
  return Date.now();
}

export function createLiveChatStore({
  queueLimit = LIVE_CHAT_QUEUE_LIMIT,
  cooldownMs = LIVE_CHAT_COOLDOWN_MS,
  dedupWindowMs = LIVE_CHAT_DEDUP_WINDOW_MS,
  maxTextLength = LIVE_CHAT_MAX_TEXT_LENGTH,
  nowFn = now,
} = {}) {
  let active = false;
  let platform = null;
  let channel = null;
  let startedAt = null;
  let stoppedAt = null;

  const queue = []; // mensagens recebidas, mais recente por push
  const userLastMessage = new Map(); // userId/usuario -> { ts, text }
  let totalReceived = 0;
  let totalDeduped = 0;
  let totalCooldownDropped = 0;
  let totalCeilingDropped = 0;

  function isWithinCooldown(user, ts) {
    const last = userLastMessage.get(user);
    if (!last) return false;
    return ts - last.ts < cooldownMs && last.text === undefined; // cooldown separado do dedupe
  }

  function isWithinDedup(user, text, ts) {
    const last = userLastMessage.get(user);
    if (!last || last.text !== text) return false;
    return ts - last.ts < dedupWindowMs;
  }

  function enqueue(message) {
    if (queue.length >= queueLimit) {
      // backpressure: descarta a mais antiga e conta
      queue.shift();
      totalCeilingDropped += 1;
    }
    queue.push(message);
  }

  return {
    /** Estado da sessão para exposição via GET /api/live/status. */
    getState() {
      return {
        active,
        platform,
        channel,
        startedAt,
        stoppedAt,
        queueLength: queue.length,
        stats: {
          received: totalReceived,
          deduped: totalDeduped,
          droppedByCooldown: totalCooldownDropped,
          droppedByCeiling: totalCeilingDropped,
        },
      };
    },

    /** Lista as mensagens enfileiradas (mais recentes primeiro), limitada. */
    listMessages({ limit = 50 } = {}) {
      const n = Math.min(Math.max(Number.isFinite(limit) ? limit : 50, 1), queueLimit);
      return queue.slice(-n).reverse().map((m) => ({ ...m }));
    },

    /** Inicia uma sessão de ingestão. Read-only: não grava nada em disco. */
    startSession({ platform: pfx, channel: ch, token } = {}) {
      if (!pfx || !PLATFORMS.has(pfx)) {
        return { ok: false, error: 'Plataforma inválida (use twitch ou youtube).' };
      }
      if (!ch || typeof ch !== 'string' || !ch.trim()) {
        return { ok: false, error: 'Canal é obrigatório.' };
      }
      if (active) {
        return { ok: false, error: 'Sessão já ativa. Pare antes de iniciar outra.' };
      }
      active = true;
      platform = pfx;
      channel = ch.trim();
      startedAt = nowFn();
      stoppedAt = null;
      return { ok: true, session: this.getState() };
    },

    /** Para a sessão e limpa a fila de mensagens pendentes. */
    stopSession() {
      if (!active) return { ok: false, error: 'Nenhuma sessão ativa.' };
      active = false;
      stoppedAt = nowFn();
      queue.length = 0;
      userLastMessage.clear();
      const state = { platform, channel, startedAt, stoppedAt };
      platform = null;
      channel = null;
      startedAt = null;
      return { ok: true, session: { ...state, active: false }, stats: this.getState().stats };
    },

    /**
     * Ingestão de uma mensagem do adapter. Aplica sanitização, dedupe,
     * cooldown por usuário e teto da fila. Retorna { ok, enqueued, reason }.
     */
    ingestMessage(raw) {
      const ts = nowFn();
      totalReceived += 1;

      if (!isPlainObject(raw)) {
        totalCeilingDropped += 1;
        return { ok: false, enqueued: false, reason: 'payload inválido' };
      }

      const platformValue = raw.platform === 'youtube' ? 'youtube' : 'twitch';
      const user = String(raw.user ?? '').trim();
      const text = String(raw.text ?? '');
      const badges = isPlainObject(raw.badges) ? { ...raw.badges } : {};
      const isMod = Boolean(raw.isMod);
      const isCommand = text.startsWith('!');

      if (!user) {
        totalCeilingDropped += 1;
        return { ok: false, enqueued: false, reason: 'usuário ausente' };
      }
      if (!text) {
        totalCeilingDropped += 1;
        return { ok: false, enqueued: false, reason: 'texto vazio' };
      }

      // Sanitiza o texto na borda (já feito pelo adapter, mas reaplica aqui como
      // segunda linha de defesa: o adapter injetável em testes pode não sanitizar).
      const { text: safeText, truncated } = sanitizeText(text, maxTextLength);
      if (!safeText) {
        totalCeilingDropped += 1;
        return { ok: false, enqueued: false, reason: 'texto só continha caracteres removidos' };
      }

      // Dedupe: mesmo usuário + mesmo texto na janela curta não duplica.
      if (isWithinDedup(user, safeText, ts)) {
        totalDeduped += 1;
        return { ok: false, enqueued: false, reason: 'duplicado' };
      }

      // Cooldown por usuário: evita que um usuário ench'a fila sozinho.
      const last = userLastMessage.get(user);
      if (last && ts - last.ts < cooldownMs) {
        totalCooldownDropped += 1;
        return { ok: false, enqueued: false, reason: 'cooldown do usuário' };
      }

      // Registra a impressão deste usuário para dedupe/cooldown.
      userLastMessage.set(user, { ts, text: safeText });

      const id = `lc-${randomBytes(6).toString('hex')}`;
      const message = {
        id,
        platform: platformValue,
        user,
        text: safeText,
        ts,
        badges,
        isMod,
        trusted: false,
        isCommand,
        truncated,
      };
      enqueue(message);
      return { ok: true, enqueued: true, message };
    },

    /** Reinicia o estado (útil em testes). */
    clear() {
      queue.length = 0;
      userLastMessage.clear();
      totalReceived = 0;
      totalDeduped = 0;
      totalCooldownDropped = 0;
      totalCeilingDropped = 0;
      active = false;
      platform = null;
      channel = null;
      startedAt = null;
      stoppedAt = null;
    },
  };
}

function sanitizeText(raw, maxLength) {
  let text = String(raw ?? '');
  text = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200d\ufeff]/g, '');
  text = text.replace(/\s+/g, ' ').trim();
  const truncated = text.length > maxLength;
  if (truncated) text = text.slice(0, maxLength);
  return { text, truncated };
}
