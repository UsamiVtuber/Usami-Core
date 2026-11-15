import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createLiveCompanionService,
  createLiveCompanionTools,
  LIVE_COMPANION_SKILL_ID,
  LIVE_COMPANION_TOOLS,
} from '../src/live-companion.js';
import { createToolRegistry } from '../src/tool-registry.js';

const MAX_SAY_CHARS = 220;

function mockStore({ active = true } = {}) {
  return { getState: () => ({ active }) };
}

async function waitFor(fn, timeout = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (fn()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('condição não atingida a tempo');
}

function flush() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

test('skill id e ferramentas esperadas', () => {
  assert.equal(LIVE_COMPANION_SKILL_ID, 'live-companion');
  assert.deepEqual([...LIVE_COMPANION_TOOLS], ['live.say', 'live.caption']);
});

test('os ToolSpecs são válidos para registro no registry', () => {
  const service = createLiveCompanionService({ liveChatStore: mockStore(), synthesize: async () => ({ ok: true, streamed: true }) });
  const tools = createLiveCompanionTools({ service, toolExecutor: { execute: async () => ({ ok: true }) } });
  const registry = createToolRegistry();
  for (const tool of tools) {
    const registered = registry.register(tool);
    assert.equal(registered.ok, true, `registro falhou para ${tool.name}: ${registered.errors.join('; ')}`);
  }
});

test('enqueue rejeita quando a sessão do chat não está ativa', () => {
  const service = createLiveCompanionService({
    liveChatStore: mockStore({ active: false }),
    synthesize: async () => ({ ok: true, streamed: true }),
  });
  const result = service.enqueue({ user: 'u1', text: 'oi' });
  assert.equal(result.ok, false);
  assert.equal(result.queued, false);
  assert.equal(result.reason, 'sessão de chat ao vivo não ativa');
});

test('enqueue rejeita usuário ou texto ausente', async () => {
  const service = createLiveCompanionService({
    liveChatStore: mockStore(),
    synthesize: async () => ({ ok: true, streamed: true }),
  });
  assert.equal((await service.enqueue({ text: 'oi' })).ok, false);
  assert.equal((await service.enqueue({ user: 'u1' })).ok, false);
  assert.equal((await service.enqueue({ user: 'u1', text: '' })).ok, false);
  assert.equal((await service.enqueue({ user: 'u1', text: '   ' })).ok, false);
});

test('enqueue respeita cooldown por usuário', async () => {
  const service = createLiveCompanionService({
    liveChatStore: mockStore(),
    synthesize: async () => ({ ok: true, streamed: true }),
    cooldownMs: 1000,
    now: () => 1000,
  });
  const r1 = await service.enqueue({ user: 'u1', text: 'oi' });
  assert.equal(r1.ok, true);
  const r2 = await service.enqueue({ user: 'u1', text: 'ola' });
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, 'cooldown/limite por usuário');
  // outro usuário não sofre cooldown do primeiro
  const r3 = await service.enqueue({ user: 'u2', text: 'ola' });
  assert.equal(r3.ok, true);
});

test('enqueue trunca texto ao limite MAX_SAY_CHARS', async () => {
  const calls = [];
  const service = createLiveCompanionService({
    liveChatStore: mockStore(),
    synthesize: async (text) => { calls.push(text); return { ok: true, streamed: true }; },
  });
  const long = 'a'.repeat(400);
  await service.enqueue({ user: 'u1', text: long });
  await waitFor(() => calls.length === 1);
  assert.equal(calls[0].length, MAX_SAY_CHARS);
  assert.equal(calls[0], 'a'.repeat(MAX_SAY_CHARS));
});

test('não fala enquanto o usuário está falando', async () => {
  const speaking = { value: true };
  const calls = [];
  const service = createLiveCompanionService({
    liveChatStore: mockStore(),
    synthesize: async (text) => { calls.push(text); return { ok: true, streamed: true }; },
    isUserSpeaking: () => speaking.value,
  });
  await service.enqueue({ user: 'u1', text: 'oi enquanto o usuário fala' });
  await flush();
  // não deve ter iniciado síntese enquanto o usuário falava
  assert.equal(calls.length, 0);
  assert.equal(service.getState().queueLength, 1);

  speaking.value = false;
  await waitFor(() => calls.length === 1);
  assert.equal(calls[0], 'oi enquanto o usuário fala');
});

test('exatamente uma síntese por vez (sem sobreposição)', async () => {
  let inflight = 0;
  let peak = 0;
  const calls = [];
  const service = createLiveCompanionService({
    liveChatStore: mockStore(),
    synthesize: async (text) => {
      calls.push(text);
      inflight += 1;
      peak = Math.max(peak, inflight);
      await new Promise(resolve => setTimeout(resolve, 30));
      inflight -= 1;
      return { ok: true, streamed: true };
    },
  });
  await service.enqueue({ user: 'u1', text: 'primeira' });
  await service.enqueue({ user: 'u2', text: 'segunda' });
  await service.enqueue({ user: 'u3', text: 'terceira' });
  await waitFor(() => calls.length === 3);
  assert.equal(peak, 1, 'no máximo uma síntese em voo');
  assert.equal(calls.length, 3);
});

test('stop para a fala e limpa a fila', async () => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const calls = [];
  const service = createLiveCompanionService({
    liveChatStore: mockStore(),
    synthesize: async (text) => {
      calls.push(text);
      await held;
      return { ok: true, streamed: true };
    },
  });
  await service.enqueue({ user: 'u1', text: 'uma' });
  await service.enqueue({ user: 'u2', text: 'dois' });
  await flush();
  assert.equal(service.getState().queueLength, 1);

  service.stop();
  assert.equal(service.getState().queueLength, 0);
  release();
  await waitFor(() => calls.length === 1);
  assert.equal(calls[0], 'uma');

  // o serviço continua aceitando novas mensagens após o stop
  await service.enqueue({ user: 'u1', text: 'apos stop' });
  await flush();
  await waitFor(() => calls.length === 2);
  assert.equal(calls[1], 'apos stop');
});

test('live.caption devolve texto sanitizado sem falar', async () => {
  const calls = [];
  const service = createLiveCompanionService({
    liveChatStore: mockStore(),
    synthesize: async (text) => { calls.push(text); return { ok: true, streamed: true }; },
  });
  const tools = createLiveCompanionTools({ service, toolExecutor: { execute: async () => ({ ok: true }) } });
  const [sayTool, captionTool] = tools;

  const res = captionTool.execute({ text: 'oi  \u0000mundo   ' });
  assert.equal(res.ok, true);
  assert.equal(res.text, 'oi mundo');
  assert.equal(res.spoken, false);
  assert.equal(calls.length, 0, 'caption não deve disparar síntese');

  // texto longo é truncado
  const long = 'b'.repeat(400);
  const res2 = captionTool.execute({ text: long });
  assert.equal(res2.text.length, MAX_SAY_CHARS);
});

test('live.say enfileira e devolve id + queueLength', async () => {
  const service = createLiveCompanionService({
    liveChatStore: mockStore(),
    synthesize: async () => ({ ok: true, streamed: true }),
  });
  const tools = createLiveCompanionTools({ service, toolExecutor: { execute: async () => ({ ok: true }) } });
  const [sayTool] = tools;

  const res = await sayTool.execute({ text: 'ola', user: 'u1', channel: 'twitch' });
  assert.equal(res.ok, true);
  assert.equal(res.queued, true);
  assert.equal(typeof res.id, 'string');
  assert.equal(res.queueLength, 1);

  // razão de repasse quando o serviço rejeita
  const empty = await sayTool.execute({ text: '', user: 'u1' });
  assert.equal(empty.ok, false);
  assert.equal(empty.queued, false);
});
