/**
 * Rotas de ingestão de chat ao vivo (S16 — streaming, read-only).
 *
 * - GET  /api/live/status     estado da sessão + estatísticas da fila
 * - POST /api/live/session    start/stop da sessão de ingestão
 *
 * Borda D2: isAllowedOrigin + x-usami-token (tanto leitura quanto escrita
 * exigem token, já que start/stop afeta o runtime da Usami). Conexão somente
 * de saída (WebSocket para o IRC da Twitch); nenhuma porta aberta.
 *
 * O adapter é injetável via options (para testes, um adapter falso sem rede).
 */

import {
  DEFAULT_ALLOWED_ORIGINS,
  isAllowedOrigin,
  denyWithoutToken,
  sendJsonResponse,
} from '../routes/http-helpers.js';
import { createLiveChatStore } from './live-chat-store.js';

export function createLiveChatHandler(options = {}) {
  const allowedOrigins = options.allowedOrigins || DEFAULT_ALLOWED_ORIGINS;
  const store = options.store || createLiveChatStore();
  const adapter = options.adapter; // injetável; se ausente, start retorna erro

  return async function handleLiveChat(req, res) {
    const send = (status, data) => sendJsonResponse(res, status, data);

    const origin = req.headers.origin;
    const host = req.headers.host;
    if (!isAllowedOrigin(origin, host, allowedOrigins)) {
      return send(403, { error: 'Origem não autorizada.' });
    }
    if (denyWithoutToken(req, options, send)) return;

    const url = new URL(req.url || '/api/live', 'http://127.0.0.1:8787');
    const path = url.pathname;

    if (req.method === 'GET' && path === '/api/live/status') {
      return send(200, { ok: true, ...store.getState() });
    }

    if (req.method === 'POST' && path === '/api/live/session') {
      const contentType = (req.headers['content-type'] || '').split(';')[0].trim();
      if (contentType !== 'application/json') {
        return send(403, { error: 'Content-Type inválido.' });
      }
      const { readRequestBody } = await import('../routes/http-helpers.js');
      const read = await readRequestBody(req, { limit: 4096 });
      if (!read.ok) return send(413, { error: 'Pedido muito longo.' });
      let payload;
      try {
        payload = JSON.parse(read.body);
      } catch {
        return send(400, { error: 'JSON inválido.' });
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return send(400, { error: 'Corpo inválido.' });
      }

      const action = payload.action;
      if (action === 'start') {
        if (!adapter || typeof adapter.connect !== 'function') {
          return send(500, { error: 'Adapter de chat não injetado.' });
        }
        const result = store.startSession({
          platform: payload.platform,
          channel: payload.channel,
          token: payload.token,
        });
        if (!result.ok) return send(400, { error: result.error });
        // O adapter conecta de forma assíncrona; falhas de rede são tratadas
        // internamente com reconexão e não derrubam a sessão.
        adapter
          .connect({
            channel: result.session.channel,
            token: payload.token,
          })
          .catch(() => {
            // Reconexão já é gerenciada pelo adapter; só logar para diagnóstico.
            console.warn('[live-chat] falha na conexão do adapter; retry interno.');
          });
        adapter.onMessage((message) => {
          store.ingestMessage(message);
        });
        adapter.onDisconnect(() => {
          console.warn('[live-chat] adapter desconectado; tenta reconectar automaticamente.');
        });
        return send(200, { ok: true, session: result.session });
      }

      if (action === 'stop') {
        adapter?.disconnect?.();
        const result = store.stopSession();
        if (!result.ok) return send(400, { error: result.error });
        return send(200, { ok: true, session: result.session, stats: result.stats });
      }

      return send(400, { error: 'action inválida (use start ou stop).' });
    }

    return send(404, { error: 'Não encontrado.' });
  };
}

export { createLiveChatStore };
