import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONNECTOR_SCHEMA,
  createConnectorRegistry,
  selectTopKTools,
} from '../src/tool-selector.js';
import {
  buildAuthorizeUrl,
  exchangePkceCode,
  generatePkcePair,
  startLoopbackCallbackServer,
} from '../src/oauth-pkce.js';

test('selectTopKTools: ranqueia semanticamente por domínio/sinônimos e preserva alwaysInclude', () => {
  const tools = [
    { name: 'self.describe', description: 'Lista módulos e ferramentas', alwaysInclude: true },
    { name: 'email.list', description: 'Lista mensagens recentes no Gmail' },
    { name: 'email.send', description: 'Envia um e-mail via Gmail' },
    { name: 'calendar.list', description: 'Lista eventos na agenda do Google' },
    { name: 'finance.accounts', description: 'Consulta saldo bancário Open Finance' },
    { name: 'research.search', description: 'Pesquisa notícias na web' },
  ];

  const picked = selectTopKTools('checa meu inbox do gmail por favor', tools, { k: 3 });
  const names = picked.map(t => t.name);
  assert.ok(names.includes('self.describe'), 'alwaysInclude preservado');
  assert.ok(names.includes('email.list'), 'email.list ranqueado');
  assert.ok(!names.includes('finance.accounts'), 'tools irrelevantes filtradas');
});

test('createConnectorRegistry: ativa/desativa conectores plug-and-play e expõe apenas tools habilitadas', () => {
  const reg = createConnectorRegistry([
    {
      schema: CONNECTOR_SCHEMA,
      id: 'gmail',
      name: 'Gmail',
      enabled: true,
      connected: true,
      tools: [{ name: 'email.list' }, { name: 'email.send' }],
    },
    {
      schema: CONNECTOR_SCHEMA,
      id: 'spotify',
      name: 'Spotify',
      enabled: true,
      connected: false,
      tools: [{ name: 'spotify.play' }],
    },
  ]);

  assert.deepEqual(reg.activeTools().map(t => t.name), ['email.list', 'email.send']);
  reg.setConnected('spotify', true);
  assert.equal(reg.activeTools().length, 3);
  reg.setEnabled('gmail', false);
  assert.deepEqual(reg.activeTools().map(t => t.name), ['spotify.play']);
});

test('OAuth2 PKCE loopback: gera S256, valida state CSRF no callback e troca code por token', async () => {
  const pkce = generatePkcePair();
  assert.equal(pkce.method, 'S256');
  assert.ok(pkce.verifier.length >= 43);

  const loopback = await startLoopbackCallbackServer({ expectedState: pkce.state, timeoutMs: 5000 });
  try {
    const authUrl = buildAuthorizeUrl({
      authorizeEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      clientId: 'client-123',
      redirectUri: loopback.redirectUri,
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
      challenge: pkce.challenge,
      state: pkce.state,
    });
    assert.match(authUrl, /code_challenge_method=S256/);

    // Simula callback do navegador
    const cbRes = await fetch(`${loopback.redirectUri}?code=auth-code-xyz&state=${encodeURIComponent(pkce.state)}`);
    assert.equal(cbRes.status, 200);

    const { code } = await loopback.waitForCode;
    assert.equal(code, 'auth-code-xyz');

    const tokens = await exchangePkceCode({
      tokenEndpoint: 'https://oauth2.googleapis.com/token',
      clientId: 'client-123',
      code,
      codeVerifier: pkce.verifier,
      redirectUri: loopback.redirectUri,
      fetchImpl: async (_url, opts) => {
        assert.match(opts.body, /code_verifier=/);
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: 'tok-ok', token_type: 'Bearer' }),
        };
      },
    });
    assert.equal(tokens.access_token, 'tok-ok');
  } finally {
    loopback.close();
  }
});
