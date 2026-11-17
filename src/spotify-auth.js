/**
 * Autenticação OAuth2 PKCE e cliente HTTP compartilhado para a Spotify Web API.
 *
 * Lê `SPOTIFY_CLIENT_ID` (e opcionalmente `SPOTIFY_REDIRECT_URI`) sob demanda
 * via `readEnvValue` sem nunca imprimir ou serializar segredos/tokens em logs
 * ou respostas HTTP. Persiste tokens renováveis em `dataDir/spotify-tokens.json`.
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { API_PORT, isAllowedRequest, readEnvValue } from './api-security.js';
import { dataDir as resolveDataDir } from './data-paths.js';
import { buildAuthorizeUrl, exchangePkceCode, generatePkcePair, startLoopbackCallbackServer } from './oauth-pkce.js';
import { normalizePlaybackState } from '../skills/spotify-player/spotify-core.mjs';

const SPOTIFY_AUTHORIZE_URL = 'https://accounts.spotify.com/authorize';
const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
const TOKENS_FILE_NAME = 'spotify-tokens.json';
const EXPIRY_SKEW_MS = 60_000;
const PENDING_TTL_MS = 10 * 60_000;

export const SPOTIFY_DEFAULT_SCOPES = Object.freeze([
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'playlist-read-private',
  'playlist-read-collaborative',
  'user-library-read',
]);

export function createSpotifyAuthClient({
  envProvider = name => readEnvValue(name),
  dataDir = resolveDataDir(),
  tokenFilePath = join(dataDir, TOKENS_FILE_NAME),
  fetchImpl = (...args) => fetch(...args),
  now = () => Date.now(),
} = {}) {
  const pendingFlows = new Map();
  let cached = null;

  function readConfig() {
    const clientId = String(envProvider('SPOTIFY_CLIENT_ID') || '').trim();
    const redirectUri = String(
      envProvider('SPOTIFY_REDIRECT_URI') || `http://127.0.0.1:${API_PORT}/oauth/callback`,
    ).trim();
    const directToken = String(envProvider('SPOTIFY_ACCESS_TOKEN') || '').trim();
    const envRefreshToken = String(envProvider('SPOTIFY_REFRESH_TOKEN') || '').trim();
    return { clientId, redirectUri, directToken, envRefreshToken };
  }

  function loadStoredTokens() {
    if (cached) return cached;
    try {
      const raw = JSON.parse(readFileSync(tokenFilePath, 'utf8'));
      if (raw && typeof raw === 'object' && (raw.accessToken || raw.refreshToken)) {
        cached = {
          accessToken: raw.accessToken || null,
          refreshToken: raw.refreshToken || null,
          expiresAt: Number.isFinite(raw.expiresAt) ? raw.expiresAt : 0,
          scope: typeof raw.scope === 'string' ? raw.scope : '',
        };
        return cached;
      }
    } catch {
      // Arquivo ausente ou inválido: tratado como desconectado.
    }
    return null;
  }

  function persistTokens(tokens) {
    cached = {
      accessToken: tokens.accessToken || null,
      refreshToken: tokens.refreshToken || null,
      expiresAt: Number.isFinite(tokens.expiresAt) ? tokens.expiresAt : 0,
      scope: typeof tokens.scope === 'string' ? tokens.scope : '',
    };
    mkdirSync(dirname(tokenFilePath), { recursive: true });
    const tmp = `${tokenFilePath}.${process.pid}.${now()}.tmp`;
    writeFileSync(tmp, JSON.stringify({
      ...cached,
      updatedAt: new Date(now()).toISOString(),
    }, null, 2), 'utf8');
    try {
      renameSync(tmp, tokenFilePath);
    } catch (err) {
      try { unlinkSync(tmp); } catch {}
      throw err;
    }
  }

  function prunePending() {
    const cutoff = now() - PENDING_TTL_MS;
    for (const [state, flow] of pendingFlows.entries()) {
      if (flow.createdAt < cutoff) pendingFlows.delete(state);
    }
  }

  function startAuthFlow({ scopes = SPOTIFY_DEFAULT_SCOPES } = {}) {
    const { clientId, redirectUri } = readConfig();
    if (!clientId) {
      throw new Error('SPOTIFY_CLIENT_ID não configurado no .env.');
    }
    prunePending();
    const pkce = generatePkcePair();
    pendingFlows.set(pkce.state, {
      verifier: pkce.verifier,
      redirectUri,
      createdAt: now(),
    });
    const authorizeUrl = buildAuthorizeUrl({
      authorizeEndpoint: SPOTIFY_AUTHORIZE_URL,
      clientId,
      redirectUri,
      scopes,
      challenge: pkce.challenge,
      state: pkce.state,
    });
    return {
      authorizeUrl,
      redirectUri,
      state: pkce.state,
    };
  }

  async function handleCallback({ code, state, error } = {}) {
    if (error) {
      throw new Error(`Autorização Spotify recusada: ${error}`);
    }
    prunePending();
    const flow = state ? pendingFlows.get(state) : null;
    if (!flow || !code) {
      throw new Error('State OAuth inválido/expirado ou código ausente.');
    }
    pendingFlows.delete(state);

    const { clientId } = readConfig();
    if (!clientId) {
      throw new Error('SPOTIFY_CLIENT_ID não configurado no .env.');
    }

    const tokenPayload = await exchangePkceCode({
      tokenEndpoint: SPOTIFY_TOKEN_URL,
      clientId,
      code,
      codeVerifier: flow.verifier,
      redirectUri: flow.redirectUri,
      fetchImpl,
    });

    const expiresInSec = Number(tokenPayload.expires_in) || 3600;
    const expiresAt = now() + expiresInSec * 1000;
    persistTokens({
      accessToken: tokenPayload.access_token,
      refreshToken: tokenPayload.refresh_token || null,
      expiresAt,
      scope: tokenPayload.scope || '',
    });

    return {
      ok: true,
      scope: cached.scope,
      expiresAt,
    };
  }

  async function getAccessToken({ force = false, signal } = {}) {
    const cfg = readConfig();
    const stored = loadStoredTokens();

    if (!force && stored?.accessToken && now() < stored.expiresAt - EXPIRY_SKEW_MS) {
      return stored.accessToken;
    }

    const refreshToken = stored?.refreshToken || cfg.envRefreshToken;
    if (refreshToken && cfg.clientId) {
      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: cfg.clientId,
      });
      const response = await fetchImpl(SPOTIFY_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal,
      });
      if (!response.ok) {
        throw new Error(`Falha ao renovar token do Spotify (HTTP ${response.status}).`);
      }
      const data = await response.json();
      const expiresInSec = Number(data.expires_in) || 3600;
      persistTokens({
        accessToken: data.access_token,
        refreshToken: data.refresh_token || refreshToken,
        expiresAt: now() + expiresInSec * 1000,
        scope: data.scope || stored?.scope || '',
      });
      return cached.accessToken;
    }

    if (!force && cfg.directToken) {
      return cfg.directToken;
    }

    throw new Error('Spotify não conectado: conclua a autorização OAuth2 antes de usar as ferramentas.');
  }

  async function requestJson(url, { method = 'GET', body, headers = {}, signal } = {}) {
    const exec = async force => {
      const token = await getAccessToken({ force, signal });
      return await fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal,
      });
    };

    let response = await exec(false);
    if (response.status === 401) {
      response = await exec(true);
    }

    if (response.status === 204) {
      return null;
    }

    const text = await response.text();
    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }

    if (!response.ok) {
      const apiMsg = parsed?.error?.message || parsed?.error_description || `HTTP ${response.status}`;
      const err = new Error(`Spotify API falhou: ${apiMsg}`);
      err.status = response.status;
      throw err;
    }

    return parsed;
  }

  function getStatus() {
    const cfg = readConfig();
    const stored = loadStoredTokens();
    const connected = Boolean(stored?.accessToken || stored?.refreshToken || cfg.directToken || cfg.envRefreshToken);
    return {
      configured: Boolean(cfg.clientId),
      connected,
      expiresAt: stored?.expiresAt || null,
      scope: stored?.scope || '',
      redirectUri: cfg.redirectUri,
    };
  }

  function disconnect() {
    cached = null;
    try {
      unlinkSync(tokenFilePath);
    } catch {
      // já removido
    }
    return { ok: true };
  }

  function hasPendingState(state) {
    prunePending();
    return Boolean(state && pendingFlows.has(state));
  }

  return {
    startAuthFlow,
    handleCallback,
    getAccessToken,
    requestJson,
    getStatus,
    disconnect,
    hasPendingState,
  };
}

/**
 * Handler HTTP para `/oauth/callback` e `/api/connectors/spotify/*`.
 */
export function createSpotifyConnectorHandler({
  spotifyAuth = createSpotifyAuthClient(),
  allowedOrigins = [],
  loopbackStarter = startLoopbackCallbackServer,
} = {}) {
  let activeLoopback = null;

  function sendJson(res, status, payload) {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(JSON.stringify(payload));
  }

  function sendHtml(res, status, title, body) {
    res.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${title}</title></head><body style="font-family:sans-serif;background:#0b132b;color:#f9f9fb;padding:32px"><h1>${title}</h1><p>${body}</p></body></html>`);
  }

  return async function handleSpotify(req, res) {
    if (!isAllowedRequest(req.headers?.origin, req.headers?.host, allowedOrigins)) {
      return sendJson(res, 403, { error: 'Origem não permitida.' });
    }

    const reqUrl = new URL(req.url || '/', `http://127.0.0.1:${API_PORT}`);

    if (req.method === 'GET' && reqUrl.pathname === '/oauth/callback') {
      const code = reqUrl.searchParams.get('code');
      const state = reqUrl.searchParams.get('state');
      const error = reqUrl.searchParams.get('error');
      try {
        await spotifyAuth.handleCallback({ code, state, error });
        return sendHtml(res, 200, 'Spotify conectado!', 'Autorização concluída. Pode fechar esta aba e voltar para a Usami.');
      } catch (err) {
        return sendHtml(res, 400, 'Falha na conexão Spotify', String(err?.message || 'Erro OAuth2.'));
      }
    }

    if (req.method === 'GET' && reqUrl.pathname === '/api/connectors/spotify/status') {
      return sendJson(res, 200, { ok: true, ...spotifyAuth.getStatus() });
    }

    if (req.method === 'GET' && reqUrl.pathname === '/api/connectors/spotify/now-playing') {
      const status = spotifyAuth.getStatus();
      if (!status.connected) {
        return sendJson(res, 200, { ok: true, connected: false, playing: false, track: null });
      }
      try {
        const raw = await spotifyAuth.requestJson('https://api.spotify.com/v1/me/player');
        return sendJson(res, 200, { ok: true, connected: true, ...normalizePlaybackState(raw) });
      } catch (err) {
        return sendJson(res, err?.status || 502, {
          ok: false,
          connected: true,
          error: String(err?.message || 'Falha ao consultar Spotify.'),
        });
      }
    }

    if (req.method === 'POST' && reqUrl.pathname === '/api/connectors/spotify/connect') {
      try {
        const flow = spotifyAuth.startAuthFlow();
        const redirect = new URL(flow.redirectUri);
        const targetPort = Number(redirect.port) || 80;
        if (targetPort !== API_PORT && typeof loopbackStarter === 'function') {
          if (activeLoopback) {
            try { activeLoopback.close(); } catch {}
            activeLoopback = null;
          }
          const loopback = await loopbackStarter({ expectedState: flow.state, port: targetPort });
          activeLoopback = loopback;
          loopback.waitForCode
            .then(({ code, state }) => spotifyAuth.handleCallback({ code, state }))
            .catch(() => {})
            .finally(() => {
              if (activeLoopback === loopback) activeLoopback = null;
            });
        }
        return sendJson(res, 200, { ok: true, ...flow });
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: String(err?.message || err) });
      }
    }

    if (req.method === 'POST' && reqUrl.pathname === '/api/connectors/spotify/disconnect') {
      spotifyAuth.disconnect();
      return sendJson(res, 200, { ok: true, connected: false });
    }

    return sendJson(res, 404, { error: 'Rota Spotify não encontrada.' });
  };
}
