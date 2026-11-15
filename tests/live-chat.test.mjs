import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// O server.mjs cria os depósitos padrão na avaliação do módulo; o diretório é
// trocado ANTES do import para nenhum teste encostar em data/.
const scratchDir = mkdtempSync(join(tmpdir(), 'usami-live-chat-'));
process.env.USAMI_DATA_DIR = scratchDir;
process.env.USAMI_KEYS_FILE = process.env.USAMI_KEYS_FILE || join(scratchDir, 'no-keys.env');

const { createLiveChatHandler } = await import('../src/live-chat/live-chat-routes.js');
const { createLiveChatStore } = await import('../src/live-chat/live-chat-routes.js');

const TEST_TOKEN = 'token-de-teste-live';

function mockReq({ method = 'GET', url = '/api/live/status', headers = {}, body = '' } = {}) {
  const chunks = body ? [Buffer.from(body)] : [];
  return {
    method,
    url,
    headers: { host: '127.0.0.1:8787', 'x-usami-token': TEST_TOKEN, ...headers },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

function mockRes() {
  const res = { statusCode: null, headers: null, body: '' };
  res.writeHead = (status, headers) => { res.statusCode = status; res.headers = headers; };
  res.end = (data) => { res.body = data; };
  return res;
}

function jsonReq(url, payload, headers = {}) {
  return mockReq({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });
}

async function call(handler, req) {
  const res = mockRes();
  await handler(req, res);
  return { status: res.statusCode, data: JSON.parse(res.body || '{}') };
}

/** Adapter falso: não toca na rede. Expõe um gatilho para simular mensagens. */
function fakeAdapter() {
  let onMessage = null;
  let onDisconnect = null;
  let connected = false;
  let connectChannel = null;
  const injected = []; // mensagens a serem "recebidas" via receive()

  return {
    async connect({ channel, token } = {}) {
      connectChannel = channel;
      connected = true;
      return;
    },
    disconnect() { connected = false; },
    isConnected() { return connected; },
    onMessage(fn) { onMessage = fn; },
    onDisconnect(fn) { onDisconnect = fn; },
    /** Simula a chegada de uma mensagem do IRC (chamado pelo teste). */
    receive(message) {
      if (onMessage) onMessage(message);
    },
    connectChannel() { return connectChannel; },
  };
}

function seeded({ token = TEST_TOKEN, store } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'usami-live-seed-'));
  const s = store || createLiveChatStore();
  const adapter = fakeAdapter();
  const handler = createLiveChatHandler({ store: s, adapter, apiToken: token });
  return { dir, store: s, adapter, handler };
}

test('rotas do live-chat exigem token: sem ele 401, sem token no servidor 503', async () => {
  const { dir, store } = seeded({ store: createLiveChatStore() });
  try {
    const denied = await call(createLiveChatHandler({ store, apiToken: TEST_TOKEN }), mockReq({ headers: { 'x-usami-token': '' } }));
    assert.equal(denied.status, 401);
    const closed = await call(createLiveChatHandler({ store, apiToken: null }), mockReq());
    assert.equal(closed.status, 503);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Host fora da allowlist é 403 mesmo com token', async () => {
  const { dir, handler } = seeded();
  try {
    const res = await call(handler, mockReq({ headers: { host: 'evil.com', origin: 'http://evil.com' } }));
    assert.equal(res.status, 403);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GET /api/live/status retorna sessão inativa por padrão', async () => {
  const { dir, handler } = seeded();
  try {
    const { status, data } = await call(handler, mockReq());
    assert.equal(status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.active, false);
    assert.equal(data.platform, null);
    assert.equal(data.queueLength, 0);
    assert.deepEqual(data.stats, {
      received: 0,
      deduped: 0,
      droppedByCooldown: 0,
      droppedByCeiling: 0,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('POST /api/live/session start cria sessão e conecta o adapter', async () => {
  const { dir, store, handler, adapter } = seeded();
  try {
    const { status, data } = await call(handler, jsonReq('/api/live/session', {
      action: 'start',
      platform: 'twitch',
      channel: 'canal_teste',
      token: 'oauth:abc',
    }));
    assert.equal(status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.session.active, true);
    assert.equal(data.session.platform, 'twitch');
    assert.equal(data.session.channel, 'canal_teste');
    assert.equal(adapter.connectChannel(), 'canal_teste');
    assert.equal(adapter.isConnected(), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('start rejeita plataforma inválida e canal ausente', async () => {
  const { dir, handler } = seeded();
  try {
    const badPlatform = await call(handler, jsonReq('/api/live/session', {
      action: 'start', platform: 'tiktok', channel: 'x', token: 't',
    }));
    assert.equal(badPlatform.status, 400);

    const badChannel = await call(handler, jsonReq('/api/live/session', {
      action: 'start', platform: 'twitch', channel: '', token: 't',
    }));
    assert.equal(badChannel.status, 400);

    // sem adapter -> 500
    const noAdapter = await call(createLiveChatHandler({ store: createLiveChatStore(), apiToken: TEST_TOKEN }), jsonReq('/api/live/session', {
      action: 'start', platform: 'twitch', channel: 'x', token: 't',
    }));
    assert.equal(noAdapter.status, 500);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stop encerra a sessão, desconecta o adapter e limpa a fila', async () => {
  const { dir, store, handler, adapter } = seeded();
  try {
    await call(handler, jsonReq('/api/live/session', { action: 'start', platform: 'twitch', channel: 'c', token: 't' }));
    assert.equal(adapter.isConnected(), true);

    // injeta uma mensagem e para
    adapter.receive({ platform: 'twitch', user: 'u1', text: 'oi', ts: Date.now(), badges: {}, isMod: false, trusted: false, isCommand: false });
    assert.equal(store.getState().queueLength, 1);

    const { status, data } = await call(handler, jsonReq('/api/live/session', { action: 'stop' }));
    assert.equal(status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.session.active, false);
    assert.equal(data.session.stoppedAt !== null, true);
    assert.equal(adapter.isConnected(), false);
    assert.equal(store.getState().queueLength, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ingestão aplica dedupe, cooldown, teto da fila e trusted:false', async () => {
  const { dir, store } = seeded({ store: createLiveChatStore({ queueLimit: 3, cooldownMs: 1000, dedupWindowMs: 5000 }) });
  const ts = 1_000_000_000_000;
  const nowFn = () => ts;
  // Recria com relógio fixo para controlar dedupe/cooldown.
  const fixedStore = createLiveChatStore({ queueLimit: 3, cooldownMs: 1000, dedupWindowMs: 5000, nowFn: () => ts });
  const adapter = fakeAdapter();
  const handler = createLiveChatHandler({ store: fixedStore, adapter, apiToken: TEST_TOKEN });
  try {
    const base = { platform: 'twitch', badges: {}, isMod: false, trusted: false, isCommand: false };

    // 1ª mensagem do u1: enfileira
    let r = fixedStore.ingestMessage({ ...base, user: 'u1', text: 'oi', ts: ts });
    assert.equal(r.ok, true);
    assert.equal(r.message.trusted, false);
    assert.equal(fixedStore.getState().queueLength, 1);

    // mesmo texto do mesmo usuário na janela de dedupe -> descartado
    r = fixedStore.ingestMessage({ ...base, user: 'u1', text: 'oi', ts: ts + 1000 });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'duplicado');
    assert.equal(fixedStore.getState().stats.deduped, 1);

    // texto diferente do mesmo usuário dentro do cooldown -> descartado por cooldown
    r = fixedStore.ingestMessage({ ...base, user: 'u1', text: 'ola', ts: ts + 500 });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'cooldown do usuário');
    assert.equal(fixedStore.getState().stats.droppedByCooldown, 1);

    // outro usuário passa
    r = fixedStore.ingestMessage({ ...base, user: 'u2', text: 'ola', ts: ts + 500 });
    assert.equal(r.ok, true);
    assert.equal(fixedStore.getState().queueLength, 2);

    // enche o teto (3) e a 4ª descarta a mais antiga (backpressure)
    fixedStore.ingestMessage({ ...base, user: 'u3', text: 'a', ts: ts + 1000 });
    fixedStore.ingestMessage({ ...base, user: 'u4', text: 'b', ts: ts + 2000 });
    assert.equal(fixedStore.getState().queueLength, 3);
    r = fixedStore.ingestMessage({ ...base, user: 'u5', text: 'c', ts: ts + 3000 });
    assert.equal(r.ok, true);
    assert.equal(fixedStore.getState().queueLength, 3);
    assert.equal(fixedStore.getState().stats.droppedByCeiling, 2);
    // a mais antiga (u1 'oi') saiu, a mais recente (u5 'c') está presente
    const msgs = fixedStore.listMessages();
    assert.equal(msgs[0].user, 'u5');
    assert.equal(msgs.some((m) => m.user === 'u1'), false);

    // sanitização: caracteres de controle removidos, trusted sempre false
    r = fixedStore.ingestMessage({ ...base, user: 'u6', text: 'oi\u0000\u200b mundo', ts: ts + 4000 });
    assert.equal(r.ok, true);
    assert.equal(r.message.text, 'oi mundo');
    assert.equal(r.message.trusted, false);

    // texto vazio ou só caracteres removidos -> descartado
    assert.equal(fixedStore.ingestMessage({ ...base, user: 'u7', text: '', ts: ts + 5000 }).ok, false);
    assert.equal(fixedStore.ingestMessage({ ...base, user: 'u8', text: '\u0000\u200b', ts: ts + 6000 }).ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('comando !x é marcado como isCommand mas não é executado', async () => {
  const { dir, store } = seeded({ store: createLiveChatStore() });
  try {
    const r = store.ingestMessage({ platform: 'twitch', user: 'u1', text: '!modo_companheiro', ts: Date.now(), badges: {}, isMod: false, trusted: false });
    assert.equal(r.ok, true);
    assert.equal(r.message.isCommand, true);
    assert.equal(r.message.trusted, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
