/**
 * Autenticação OAuth2 compartilhada para integrações Google (Calendar e Gmail).
 *
 * Lê credenciais sob demanda via `readEnvValue` (`USAMI_KEYS_FILE` / `.env` /
 * `process.env`) sem nunca imprimir ou serializar segredos em respostas/logs.
 * Suporta:
 *  - `GOOGLE_ACCESS_TOKEN` direto (útil para sessão temporária ou testes); ou
 *  - `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` + `GOOGLE_REFRESH_TOKEN`
 *    (renovação automática via `https://oauth2.googleapis.com/token`).
 */
import { readEnvValue } from './api-security.js';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const EXPIRY_SKEW_MS = 60_000;

export function createGoogleAuthClient({
  envProvider = name => readEnvValue(name),
  fetchImpl = (...args) => fetch(...args),
  now = () => Date.now(),
} = {}) {
  let cachedToken = null;
  let cachedExpiresAt = 0;

  function readCredentials() {
    const directToken = String(envProvider('GOOGLE_ACCESS_TOKEN') || '').trim();
    const clientId = String(envProvider('GOOGLE_CLIENT_ID') || '').trim();
    const clientSecret = String(envProvider('GOOGLE_CLIENT_SECRET') || '').trim();
    const refreshToken = String(envProvider('GOOGLE_REFRESH_TOKEN') || '').trim();
    const hasRefreshTuple = Boolean(clientId && clientSecret && refreshToken);
    return { directToken, clientId, clientSecret, refreshToken, hasRefreshTuple };
  }

  function isConfigured() {
    const creds = readCredentials();
    return Boolean(creds.directToken || creds.hasRefreshTuple);
  }

  async function refreshAccessToken({ signal, force = false } = {}) {
    const creds = readCredentials();
    if (!force && cachedToken && now() < cachedExpiresAt - EXPIRY_SKEW_MS) {
      return cachedToken;
    }
    if (!creds.hasRefreshTuple) {
      if (creds.directToken && !force) return creds.directToken;
      throw new Error(
        'Google OAuth não configurado: defina GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET e GOOGLE_REFRESH_TOKEN (ou GOOGLE_ACCESS_TOKEN).',
      );
    }

    const body = new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      refresh_token: creds.refreshToken,
      grant_type: 'refresh_token',
    });

    const response = await fetchImpl(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || typeof payload?.access_token !== 'string' || !payload.access_token) {
      throw new Error(`Falha ao renovar token Google OAuth (HTTP ${response.status}).`);
    }

    cachedToken = payload.access_token;
    const ttlSec = Number.isFinite(payload.expires_in) ? payload.expires_in : 3600;
    cachedExpiresAt = now() + ttlSec * 1000;
    return cachedToken;
  }

  async function requestJson(url, { method = 'GET', body, headers = {}, signal } = {}) {
    const creds = readCredentials();
    if (!creds.directToken && !creds.hasRefreshTuple) {
      throw new Error(
        'Google OAuth não configurado: defina GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET e GOOGLE_REFRESH_TOKEN (ou GOOGLE_ACCESS_TOKEN).',
      );
    }

    const executeWithToken = async token => {
      const response = await fetchImpl(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...headers,
        },
        ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
        signal,
      });
      if (response.status === 204) return { ok: true, status: 204, data: {} };
      const data = await response.json().catch(() => ({}));
      return { ok: response.ok, status: response.status, data };
    };

    let token = await refreshAccessToken({ signal });
    let result = await executeWithToken(token);
    if (result.status === 401 && creds.hasRefreshTuple) {
      token = await refreshAccessToken({ signal, force: true });
      result = await executeWithToken(token);
    }

    if (!result.ok) {
      const apiMsg = result.data?.error?.message || result.data?.error_description || `HTTP ${result.status}`;
      throw new Error(`Google API erro (${result.status}): ${String(apiMsg).slice(0, 180)}`);
    }
    return result.data;
  }

  return {
    isConfigured,
    refreshAccessToken,
    requestJson,
  };
}

