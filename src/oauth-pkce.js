/**
 * Fluxo OAuth2 PKCE com servidor loopback efêmero local (Fase 3 — RFC-001).
 *
 * Permite conectar serviços Plug-and-Play (Google, Spotify, GitHub) sem
 * client_secret no frontend e sem expor tokens em URLs/logs.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

function base64Url(buffer) {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

export function generatePkcePair() {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash('sha256').update(verifier).digest());
  const state = base64Url(randomBytes(16));
  return { verifier, challenge, state, method: 'S256' };
}

export function buildAuthorizeUrl({
  authorizeEndpoint,
  clientId,
  redirectUri,
  scopes = [],
  challenge,
  state,
} = {}) {
  if (!authorizeEndpoint || !clientId || !redirectUri || !challenge || !state) {
    throw new Error('Parâmetros obrigatórios ausentes para buildAuthorizeUrl.');
  }
  const url = new URL(authorizeEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  if (Array.isArray(scopes) && scopes.length > 0) {
    url.searchParams.set('scope', scopes.join(' '));
  }
  return url.toString();
}

/**
 * Inicia um servidor loopback efêmero em `127.0.0.1:0` para receber o callback
 * `/oauth/callback?code=...&state=...` com validação estrita de `state` (CSRF).
 */
export async function startLoopbackCallbackServer({
  expectedState,
  port = 0,
  timeoutMs = 120_000,
} = {}) {
  if (!expectedState) throw new Error('expectedState é obrigatório.');

  let resolveCode;
  let rejectCode;
  const waitForCode = new Promise((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const server = createServer((req, res) => {
    const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
    if (reqUrl.pathname !== '/oauth/callback') {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }

    const err = reqUrl.searchParams.get('error');
    const state = reqUrl.searchParams.get('state');
    const code = reqUrl.searchParams.get('code');

    if (err) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>Autorização recusada.</h1>');
      rejectCode(new Error(`OAuth error: ${err}`));
      server.close();
      return;
    }
    if (state !== expectedState || !code) {
      res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>State inválido ou código ausente.</h1>');
      rejectCode(new Error('State CSRF inválido ou código ausente.'));
      server.close();
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h1>Conectado! Pode voltar para a Usami.</h1>');
    resolveCode({ code, state });
    server.close();
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });

  const addr = server.address();
  const redirectUri = `http://127.0.0.1:${addr.port}/oauth/callback`;
  const timer = setTimeout(() => {
    rejectCode(new Error('Timeout aguardando callback OAuth2 PKCE.'));
    server.close();
  }, timeoutMs);
  waitForCode.finally(() => clearTimeout(timer)).catch(() => {});

  return {
    port: addr.port,
    redirectUri,
    waitForCode,
    close: () => {
      clearTimeout(timer);
      server.close();
    },
  };
}

export async function exchangePkceCode({
  tokenEndpoint,
  clientId,
  code,
  codeVerifier,
  redirectUri,
  fetchImpl = (...args) => fetch(...args),
} = {}) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: clientId,
    code,
    code_verifier: codeVerifier,
    redirect_uri: redirectUri,
  });

  const response = await fetchImpl(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!response.ok) {
    throw new Error(`Falha na troca do código OAuth2 (HTTP ${response.status}).`);
  }
  return await response.json();
}
