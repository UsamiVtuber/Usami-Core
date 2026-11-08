import test from 'node:test';
import assert from 'node:assert/strict';

// Nenhuma escrita em data/: a proatividade roda com engine injetado e a borda
// é checada antes de qualquer acesso a store.
process.env.USE_NVIDIA = 'false';

const { createProactiveHandler, clampRagNumber } = await import('../server.mjs');

const API_TOKEN = 'token-teste';
const ALLOWED = ['http://127.0.0.1:5173'];
const headers = { origin: 'http://127.0.0.1:5173', host: '127.0.0.1:8787', 'x-usami-token': API_TOKEN };

function mockRes() {
  const res = { statusCode: null, body: '' };
  res.writeHead = status => { res.statusCode = status; };
  res.end = data => { res.body = data; };
  return res;
}

function mockReq({ method = 'POST', url = '/api/proactive/trigger', hdrs = headers } = {}) {
  return { method, url, headers: hdrs };
}

function fixture(overrides = {}) {
  const calls = [];
  const engine = {
    checkAndTrigger: async () => { calls.push('trigger'); return { ok: true, triggered: true }; },
    getState: () => { calls.push('state'); return { mood: 'calm', affinity: 50 }; },
  };
  return {
    calls,
    handler: createProactiveHandler({ allowedOrigins: ALLOWED, apiToken: API_TOKEN, proactiveEngine: engine, ...overrides }),
  };
}

test('/api/proactive/*: origem hostil é 403 mesmo com token (borda fechada)', async () => {
  const { handler } = fixture();
  const res = mockRes();
  await handler(mockReq({ hdrs: { ...headers, origin: 'https://evil.com' } }), res);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(JSON.parse(res.body), { error: 'Origem não autorizada.' });

  const rebinding = mockRes();
  await handler(mockReq({ hdrs: { ...headers, host: 'evil.com:8787' } }), rebinding);
  assert.equal(rebinding.statusCode, 403, 'Host fora da allowlist não passa pela borda');
});

test('/api/proactive/*: sem token é 401; com token responde trigger e state', async () => {
  const { handler, calls } = fixture();
  const denied = mockRes();
  await handler(mockReq({ hdrs: { origin: 'http://127.0.0.1:5173', host: '127.0.0.1:8787' } }), denied);
  assert.equal(denied.statusCode, 401);
  assert.deepEqual(JSON.parse(denied.body), { error: 'Token ausente ou inválido.' });
  assert.deepEqual(calls, []);

  const trigger = mockRes();
  await handler(mockReq(), trigger);
  assert.equal(trigger.statusCode, 200);
  assert.deepEqual(JSON.parse(trigger.body), { ok: true, triggered: true });

  const state = mockRes();
  await handler(mockReq({ method: 'GET', url: '/api/proactive/state' }), state);
  assert.equal(state.statusCode, 200);
  assert.deepEqual(JSON.parse(state.body), { mood: 'calm', affinity: 50 });
  assert.deepEqual(calls, ['trigger', 'state']);
});

test('/api/proactive/*: falha do engine vira 500 curto, método/rota errados são 404', async () => {
  const { handler } = fixture({
    proactiveEngine: {
      checkAndTrigger: async () => { throw new Error('boom com segredo'); },
      getState: () => { throw new Error('boom'); },
    },
  });
  const trigger = mockRes();
  await handler(mockReq(), trigger);
  assert.equal(trigger.statusCode, 500);
  assert.deepEqual(JSON.parse(trigger.body), { error: 'Falha ao disparar a proatividade.' });

  const state = mockRes();
  await handler(mockReq({ method: 'GET', url: '/api/proactive/state' }), state);
  assert.equal(state.statusCode, 500);
  assert.deepEqual(JSON.parse(state.body), { error: 'Falha ao ler o estado da proatividade.' });

  const wrong = mockRes();
  await handler(mockReq({ method: 'DELETE', url: '/api/proactive/trigger' }), wrong);
  assert.equal(wrong.statusCode, 404);
});

test('clampRagNumber (B18): fallback para inválido e teto por grandeza', () => {
  assert.equal(clampRagNumber(undefined, 10, 50), 10);
  assert.equal(clampRagNumber('não-número', 10, 50), 10);
  assert.equal(clampRagNumber('0', 10, 50), 10);
  assert.equal(clampRagNumber('-5', 10, 50), 10);
  assert.equal(clampRagNumber('Infinity', 10, 50), 10);
  assert.equal(clampRagNumber('7', 10, 50), 7);
  assert.equal(clampRagNumber('7.9', 10, 50), 7, 'floor como no vault-index');
  assert.equal(clampRagNumber('1e9', 10, 50), 50);
  assert.equal(clampRagNumber(999, 2000, 20000), 999);
});
