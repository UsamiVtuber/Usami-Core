import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChatHandler, createChatActivityHandler } from '../server.mjs';
import { createChatActivityRegistry } from '../src/chat-activity.js';
import { createMemoryStore } from '../src/memory-store.js';
import { createPersonalityStore } from '../src/personality-store.js';

const ORIGIN = 'http://localhost:5173';

function makeReq(body, headers = {}) {
  return {
    method: 'POST',
    url: '/api/chat',
    headers: { host: '127.0.0.1:8787', 'content-type': 'application/json', ...headers },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    },
  };
}

function makeGetReq(headers = {}) {
  return {
    method: 'GET',
    url: '/api/chat/activity',
    headers: { host: '127.0.0.1:8787', ...headers },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from('');
    },
  };
}

async function call(handler, req) {
  const res = { statusCode: null, body: '' };
  res.writeHead = s => { res.statusCode = s; };
  res.end = b => { res.body = b; };
  await handler(req, res);
  return { status: res.statusCode, data: res.body ? JSON.parse(res.body) : null };
}

test('chat activity: a rota devolve inativo quando não há turno em andamento', async () => {
  const activity = createChatActivityRegistry();
  const handler = createChatActivityHandler({
    allowedOrigins: [ORIGIN],
    apiToken: 'token-teste',
    chatActivity: activity,
  });

  const res = await call(handler, makeGetReq({ origin: ORIGIN, 'x-usami-token': 'token-teste' }));
  assert.equal(res.status, 200);
  assert.equal(res.data.active, false);
  assert.equal(res.data.phase, null);
});

test('chat activity: a rota exige token e origem permitida', async () => {
  const activity = createChatActivityRegistry();
  const handler = createChatActivityHandler({
    allowedOrigins: [ORIGIN],
    apiToken: 'token-teste',
    chatActivity: activity,
  });

  const semToken = await call(handler, makeGetReq({ origin: ORIGIN }));
  assert.equal(semToken.status, 401);

  const origemErrada = await call(handler, makeGetReq({ origin: 'http://evil.local', 'x-usami-token': 'token-teste' }));
  assert.equal(origemErrada.status, 403);
});

test('chat activity: a fase tool traz o NOME real da ferramenta em execução', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'usami-activity-tool-'));
  const activity = createChatActivityRegistry();

  const memoryStore = createMemoryStore({ dataDir: dir });
  memoryStore.load();
  const personalityStore = createPersonalityStore({ dataDir: dir });
  personalityStore.load();

  let releaseTool = null;
  const toolGate = new Promise(resolve => { releaseTool = resolve; });
  const seenTools = [];

  // AgentCore de mentira: simula uma tool lenta e registra o callback.
  const agentCore = {
    runOperationalForChat: async (_message, options = {}) => {
      if (typeof options.onToolStart === 'function') options.onToolStart('git.log');
      seenTools.push('git.log');
      await toolGate;
      if (typeof options.onToolEnd === 'function') options.onToolEnd('git.log');
      return {
        id: 'trn-abcdef012345',
        intent: { kind: 'operational' },
        route: 'tool',
        status: 'executed',
        tool: 'git.log',
        tools: ['git.log'],
        result: { commits: [] },
      };
    },
  };

  const chatHandler = createChatHandler({
    agentCore,
    memoryStore,
    personalityStore,
    moodStore: null,
    chatActivity: activity,
    vaultSearch: async () => null,
    getKey: async () => null,
    generateReply: async () => '{"reply":"pronto","gesture":"nod"}',
  });

  const activityHandler = createChatActivityHandler({
    allowedOrigins: [ORIGIN],
    apiToken: 'token-teste',
    chatActivity: activity,
  });

  const pending = call(chatHandler, makeReq({ message: 'veja meu git log' }, { origin: ORIGIN }));
  await new Promise(resolve => setTimeout(resolve, 80));

  const durante = await call(activityHandler, makeGetReq({ origin: ORIGIN, 'x-usami-token': 'token-teste' }));
  assert.equal(durante.data.active, true);
  assert.equal(durante.data.phase, 'tool');
  assert.equal(durante.data.tool, 'git.log');
  assert.deepEqual(durante.data.tools, ['git.log']);
  assert.equal(seenTools.length, 1);

  releaseTool();
  await pending;

  const depois = await call(activityHandler, makeGetReq({ origin: ORIGIN, 'x-usami-token': 'token-teste' }));
  assert.equal(depois.data.active, false);

  rmSync(dir, { recursive: true, force: true });
});

test('chat activity: o turno publica thinking e tool e limpa ao final', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'usami-activity-'));
  const activity = createChatActivityRegistry();

  const memoryStore = createMemoryStore({ dataDir: dir });
  memoryStore.load();
  const personalityStore = createPersonalityStore({ dataDir: dir });
  personalityStore.load();

  let releaseTool = null;
  const toolGate = new Promise(resolve => { releaseTool = resolve; });

  const chatHandler = createChatHandler({
    memoryStore,
    personalityStore,
    moodStore: null,
    chatActivity: activity,
    vaultSearch: async () => null,
    getKey: async () => null,
    generateReply: async () => {
      // Segura o turno o suficiente para a atividade ser observável.
      await toolGate;
      return '{"reply":"pronto","gesture":"nod"}';
    },
  });

  const activityHandler = createChatActivityHandler({
    allowedOrigins: [ORIGIN],
    apiToken: 'token-teste',
    chatActivity: activity,
  });

  const pending = call(chatHandler, makeReq({ message: 'oi' }, { origin: ORIGIN }));
  await new Promise(resolve => setTimeout(resolve, 60));

  const durante = await call(activityHandler, makeGetReq({ origin: ORIGIN, 'x-usami-token': 'token-teste' }));
  assert.equal(durante.status, 200);
  assert.equal(durante.data.active, true);
  assert.equal(durante.data.phase, 'thinking');

  releaseTool();
  await pending;

  const depois = await call(activityHandler, makeGetReq({ origin: ORIGIN, 'x-usami-token': 'token-teste' }));
  assert.equal(depois.data.active, false);

  rmSync(dir, { recursive: true, force: true });
});
