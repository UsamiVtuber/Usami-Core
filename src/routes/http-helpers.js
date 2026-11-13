/**
 * @fileoverview Utilitários HTTP compartilhados entre manipuladores de rotas.
 * Centraliza verificação de origem, token de API e leitura segura de corpo.
 */

import { checkApiToken, isAllowedRequest, readApiToken, withExtraOrigins } from '../api-security.js';

export const DEFAULT_ALLOWED_ORIGINS = withExtraOrigins([
  'http://127.0.0.1:5173',
  'http://localhost:5173',
]);

/**
 * Valida se a origem e o host da requisição pertencem à lista permitida.
 * @param {string|undefined} origin
 * @param {string|undefined} host
 * @param {string[]} [allowedOrigins]
 * @returns {boolean}
 */
export function isAllowedOrigin(origin, host, allowedOrigins = DEFAULT_ALLOWED_ORIGINS) {
  return isAllowedRequest(origin, host, allowedOrigins);
}

/**
 * Verifica o token da requisição e envia resposta 401/403 caso inválido.
 * @param {import('node:http').IncomingMessage} req
 * @param {{ apiToken?: string }} [options]
 * @param {(status: number, data: unknown) => void} send
 * @returns {boolean} True se a requisição foi negada, False se autorizada.
 */
export function denyWithoutToken(req, options, send) {
  const configuredToken = options && 'apiToken' in options ? options.apiToken : readApiToken();
  const denied = checkApiToken(req, configuredToken);
  if (!denied) return false;
  send(denied.status, { error: denied.error });
  return true;
}

/**
 * Acumula o buffer da requisição HTTP drenando o socket com segurança.
 * @param {import('node:http').IncomingMessage} req
 * @param {{ limit?: number }} [options]
 * @returns {Promise<{ ok: true, buffer: Buffer } | { ok: false, status: number }>}
 */
export async function readBodyBuffer(req, { limit = 8192 } = {}) {
  const chunks = [];
  let total = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (tooLarge) continue;
    total += buffer.length;
    if (total > limit) {
      tooLarge = true;
      chunks.length = 0;
      req.resume?.();
      continue;
    }
    chunks.push(buffer);
  }
  if (tooLarge) return { ok: false, status: 413 };
  return { ok: true, buffer: Buffer.concat(chunks) };
}

/**
 * Lê o corpo da requisição como string UTF-8.
 * @param {import('node:http').IncomingMessage} req
 * @param {{ limit?: number }} [options]
 * @returns {Promise<{ ok: true, body: string } | { ok: false, status: number }>}
 */
export async function readRequestBody(req, { limit = 8192 } = {}) {
  const result = await readBodyBuffer(req, { limit });
  if (!result.ok) return result;
  return { ok: true, body: result.buffer.toString('utf8') };
}

/**
 * Helper para envio padronizado de respostas JSON.
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} data
 */
export function sendJsonResponse(res, status, data) {
  if (res.headersSent) return;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(data));
}
