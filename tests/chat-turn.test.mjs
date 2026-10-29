import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryStore } from '../src/memory-store.js';

// Mesmo isolamento do chat-server.test.mjs: sem rede NVIDIA, sem tocar em data/.
process.env.USE_NVIDIA = 'false';
const scratchDir = mkdtempSync(join(tmpdir(), 'usami-chat-turn-'));
process.env.USAMI_DATA_DIR = scratchDir;

const { createChatHandler } = await import('../server.mjs');

const store = createMemoryStore({ dataDir: scratchDir });
store.load();

const handlerWith = options => createChatHandler({ memoryStore: store, vaultSearch: async () => null, getKey: async () => 'k', ...options });

function mockReq() {
  const body = JSON.stringify({ message: 'oi' });
  return {
    method: 'POST',
    url: '/api/chat',
    headers: { 'content-type': 'application/json', host: '127.0.0.1:8787' },
    async *[Symbol.asyncIterator]() { yield Buffer.from(body); },
  };
}

// res com `on('close')`, como o do node:http, para simular o cliente que some.
function mockRes() {
  const listeners = {};
  const res = { statusCode: null, body: '', writableEnded: false, sent: false };
  res.writeHead = status => { res.statusCode = status; res.sent = true; };
  res.end = data => { res.body = data; res.writableEnded = true; };
  res.on = (event, fn) => { listeners[event] = fn; };
  res.emitClose = () => listeners.close?.();
  return res;
}

test('cliente que fecha a conexão cancela a chamada ao provedor e nada é respondido nem salvo', async () => {
  let providerSignal = null;
  const fetchImpl = (_url, init) => new Promise((_, reject) => {
    providerSignal = init.signal;
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
  });
  const before = store.getAll().dailyHistory;
  const historyBefore = JSON.stringify(before);
  const res = mockRes();
  const pending = handlerWith({ fetchImpl })(mockReq(), res);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(providerSignal, 'o provedor foi chamado');
  assert.equal(providerSignal.aborted, false);

  res.emitClose();
  await pending;

  assert.equal(providerSignal.aborted, true, 'a chamada ao provedor foi cancelada');
  assert.equal(res.sent, false, 'ninguém esperando: não responde');
  assert.equal(JSON.stringify(store.getAll().dailyHistory), historyBefore, 'o turno abandonado não entra na memória');
});

test('a chamada ao provedor carrega um deadline (não fica pendurada para sempre)', async () => {
  let providerSignal = null;
  const fetchImpl = async (_url, init) => {
    providerSignal = init.signal;
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"reply":"oi!","gesture":"neutral"}' } }] }) };
  };
  const res = mockRes();
  await handlerWith({ fetchImpl })(mockReq(), res);
  assert.equal(res.statusCode, 200);
  assert.ok(providerSignal instanceof AbortSignal);
});
