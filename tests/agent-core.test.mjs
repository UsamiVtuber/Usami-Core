import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_SCHEMAS } from '../src/agent-contracts.js';
import { createMemoryStore } from '../src/memory-store.js';
import { createMemorySearchTool } from '../src/memory-search-tool.js';
import { createToolRegistry } from '../src/tool-registry.js';
import { createPermissionGate } from '../src/permission-gate.js';
import { createToolExecutor } from '../src/tool-executor.js';
import { createTaskPlanner } from '../src/task-planner.js';
import { classifyDeterministic, createAgentCore, extractMemoryQuery } from '../src/agent-core.js';

// Isolamento: impede NVIDIA real e aponta USAMI_DATA_DIR antes de importar server.mjs.
process.env.USE_NVIDIA = 'false';
const scratchDir = mkdtempSync(join(tmpdir(), 'usami-agent-core-api-'));
process.env.USAMI_DATA_DIR = scratchDir;
process.env.USAMI_KEYS_FILE = process.env.USAMI_KEYS_FILE || join(scratchDir, 'no-keys.env');

const { createAgentTurnHandler, createChatHandler } = await import('../server.mjs');

const TEST_TOKEN = 'token-de-teste';

function setup(t, { classifyWithLlm, turnDeadlineMs, withExternalTool = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'usami-agent-core-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const memoryStore = createMemoryStore({ dataDir: dir });
  memoryStore.load();
  memoryStore.addCoreFact('Gosta de café com leite', 'preferences');

  const registry = createToolRegistry();
  assert.equal(registry.register(createMemorySearchTool({ memoryStore })).ok, true);
  if (withExternalTool) {
    assert.equal(registry.register({
      schema: AGENT_SCHEMAS.tool,
      name: 'mail.send',
      version: '1.0.0',
      description: 'Ferramenta de nível 4 para teste.',
      origin: 'runtime',
      permissionLevel: 4,
      timeoutMs: 500,
      parameters: [{ name: 'body', type: 'string', required: true }],
      verify: result => result?.sent === true,
      execute: ({ body }) => ({ sent: true, body }),
    }).ok, true);
  }

  let clock = Date.parse('2026-11-11T15:00:00.000Z');
  const gate = createPermissionGate({ registry, dataDir: dir, now: () => clock, onLoadError: () => {} });
  gate.load();
  const executor = createToolExecutor({ registry, gate, dataDir: dir, now: () => clock, onLoadError: () => {} });
  executor.load();
  const planner = createTaskPlanner({ dataDir: dir, now: () => clock, onLoadError: () => {} });
  planner.load();

  const agentCore = createAgentCore({
    registry,
    executor,
    planner,
    classifyWithLlm,
    turnDeadlineMs,
    now: () => clock,
    onError: () => {},
  });

  const turnHandler = createAgentTurnHandler({ agentCore, apiToken: TEST_TOKEN });
  const chatHandler = createChatHandler({
    memoryStore,
    vaultSearch: async () => null,
    agentCore,
    getKey: async () => 'fake-openrouter-key',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ reply: 'Tudo certo por aqui!', gesture: 'neutral', actions: [] }) } }],
      }),
    }),
  });

  return { dir, memoryStore, registry, gate, executor, planner, agentCore, turnHandler, chatHandler };
}

function mockReq({ method = 'POST', url = '/api/agent/turn', headers = {}, body = '' } = {}) {
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

function jsonReq(url, payload, { method = 'POST', headers = {} } = {}) {
  return mockReq({
    method,
    url,
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
}

function mockRes() {
  const res = { statusCode: null, headers: null, body: '' };
  res.writeHead = (status, headers) => { res.statusCode = status; res.headers = headers; };
  res.end = (data) => { res.body = data; };
  return res;
}

async function call(handler, req) {
  const res = mockRes();
  await handler(req, res);
  return { status: res.statusCode, data: JSON.parse(res.body) };
}

test('classificação determinística separa conversa, operacional e complexa', () => {
  assert.equal(classifyDeterministic('Oi Usami, tudo bem?').kind, 'conversation');
  assert.equal(classifyDeterministic('Estou cansado hoje, vamos conversar').kind, 'conversation');
  assert.equal(classifyDeterministic('Busca na memória sobre café').kind, 'operational');
  assert.equal(classifyDeterministic('O que você lembra sobre meu café?').kind, 'operational');
  assert.equal(classifyDeterministic('memory.search café', { toolNames: ['memory.search'] }).kind, 'operational');
  assert.equal(classifyDeterministic('Organize minha semana de estudos').kind, 'complex');
  assert.equal(classifyDeterministic('Crie um plano em etapas para entregar o projeto').kind, 'complex');

  assert.equal(extractMemoryQuery('Busca na memória sobre café?'), 'café');
  assert.equal(extractMemoryQuery('O que você sabe sobre o meu café?'), 'café');
});

test('casos ambíguos consultam LLM injetável e caem em conversa se falhar ou expirar', async t => {
  let llmCalls = 0;
  const { agentCore } = setup(t, {
    turnDeadlineMs: 40,
    classifyWithLlm: async ({ message }) => {
      llmCalls += 1;
      assert.equal(message, 'Faz isso agora');
      return { kind: 'complex', goal: 'Organizar o dia agora', confidence: 0.85 };
    },
  });

  // Caso claro não chama o LLM.
  const clear = await agentCore.classifyIntent('Oi, boa noite!');
  assert.equal(clear.intent.kind, 'conversation');
  assert.equal(clear.intent.origin, 'classifier');
  assert.equal(llmCalls, 0);

  // Caso ambíguo usa o LLM injetado.
  const ambiguous = await agentCore.classifyIntent('Faz isso agora');
  assert.equal(llmCalls, 1);
  assert.equal(ambiguous.intent.kind, 'complex');
  assert.equal(ambiguous.intent.origin, 'llm');
  assert.equal(ambiguous.intent.goal, 'Organizar o dia agora');

  // Falha / timeout do LLM cai para fallback determinístico sem quebrar.
  const brokenCore = setup(t, {
    turnDeadlineMs: 30,
    classifyWithLlm: async ({ signal }) => {
      await new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(new Error('deadline estourado')), { once: true });
      });
    },
  }).agentCore;

  const fallback = await brokenCore.classifyIntent('Resolve isso');
  assert.equal(fallback.intent.kind, 'conversation');
  assert.equal(fallback.intent.origin, 'classifier');
});

test('processTurn roteia operacional para Tool Executor e complexo para Planner + briefing', async t => {
  const { gate, executor, planner, agentCore } = setup(t, { withExternalTool: true });

  const chat = await agentCore.processTurn('Oi Usami, como você está?');
  assert.equal(chat.ok, true);
  assert.equal(chat.turn.route, 'conversation');
  assert.equal(chat.turn.status, 'idle');
  assert.equal(executor.list().length, 0);
  assert.equal(planner.list().length, 0);

  const search = await agentCore.processTurn('Busca na memória sobre café');
  assert.equal(search.ok, true);
  assert.equal(search.turn.route, 'tool');
  assert.equal(search.turn.status, 'executed');
  assert.equal(search.turn.tool, 'memory.search');
  assert.equal(search.turn.result.count, 1);
  assert.match(search.turn.result.results[0].text, /café com leite/i);
  assert.equal(executor.list().length, 1);
  assert.equal(executor.list()[0].status, 'ok');

  // Ferramenta nível 4 respeita gate S5.
  const deniedTool = await agentCore.processTurn('mail.send enviar aviso');
  assert.equal(deniedTool.turn.route, 'tool');
  assert.equal(deniedTool.turn.status, 'awaiting_confirmation');
  assert.equal(deniedTool.turn.execution.status, 'denied');

  const conf = gate.createConfirmation('mail.send');
  const allowedTool = await agentCore.processTurn('mail.send enviar aviso', { confirmation: conf.confirmation.token });
  assert.equal(allowedTool.turn.status, 'executed');
  assert.equal(allowedTool.turn.result.sent, true);

  // Operacional sem ferramenta correspondente não inventa execução.
  const unmatched = await agentCore.processTurn('Liste minhas pendências para amanhã');
  assert.equal(unmatched.turn.route, 'unmatched');
  assert.equal(unmatched.turn.status, 'no_matching_tool');
  assert.equal(unmatched.turn.missingCapability, true);

  // Tarefa complexa gera plano com briefing.
  const planned = await agentCore.processTurn('Organize minha semana de estudos em etapas');
  assert.equal(planned.ok, true);
  assert.equal(planned.turn.route, 'plan');
  assert.equal(planned.turn.status, 'planned');
  assert.match(planned.turn.plan.id, /^pl-[0-9a-f]{12}$/);
  assert.equal(planned.turn.briefing.summary.length > 0, true);
  assert.equal(planner.list().length, 1);
});

test('regressão /api/chat: conversa idêntica e pedido operacional/complexo sem bloquear o balão', async t => {
  const { executor, planner, chatHandler, turnHandler } = setup(t);

  // 1) Conversa normal: resposta idêntica, sem agentTurn, nada no executor/planner.
  const convRes = await call(chatHandler, jsonReq('/api/chat', { message: 'Oi Usami, tudo bem?' }));
  assert.equal(convRes.status, 200);
  assert.equal(convRes.data.reply, 'Tudo certo por aqui!');
  assert.equal('agentTurn' in convRes.data, false);
  assert.equal(executor.list().length, 0);
  assert.equal(planner.list().length, 0);

  // 2) Pedido operacional via /api/chat: devolve o balão na hora com campo opcional agentTurn.
  const opRes = await call(chatHandler, jsonReq('/api/chat', { message: 'Busca na memória sobre café' }));
  assert.equal(opRes.status, 200);
  assert.equal(opRes.data.reply, 'Tudo certo por aqui!');
  assert.equal(opRes.data.agentTurn.kind, 'operational');
  assert.equal(opRes.data.agentTurn.route, 'tool');
  assert.match(opRes.data.agentTurn.id, /^trn-[0-9a-f]{12}$/);

  // 3) Pedido complexo via /api/chat: dispara Planner em background sem atrasar o balão.
  const planRes = await call(chatHandler, jsonReq('/api/chat', { message: 'Organize minha semana de trabalho' }));
  assert.equal(planRes.status, 200);
  assert.equal(planRes.data.agentTurn.kind, 'complex');
  assert.equal(planRes.data.agentTurn.route, 'plan');

  await new Promise(resolve => setTimeout(resolve, 40));

  const polledOp = await call(turnHandler, mockReq({ method: 'GET', url: `/api/agent/turns/${opRes.data.agentTurn.id}` }));
  assert.equal(polledOp.status, 200);
  assert.equal(polledOp.data.turn.status, 'executed');
  assert.equal(polledOp.data.turn.result.count, 1);

  const polledPlan = await call(turnHandler, mockReq({ method: 'GET', url: `/api/agent/turns/${planRes.data.agentTurn.id}` }));
  assert.equal(polledPlan.status, 200);
  assert.equal(polledPlan.data.turn.status, 'planned');
  assert.equal(polledPlan.data.turn.briefing.summary.length > 0, true);
});

test('rotas HTTP /api/agent/turn e /api/agent/turns respeitam borda de segurança e validação', async t => {
  const { agentCore, turnHandler } = setup(t);

  assert.equal((await call(createAgentTurnHandler({ agentCore, apiToken: TEST_TOKEN }), jsonReq('/api/agent/turn', { message: 'oi' }, { headers: { 'x-usami-token': '' } }))).status, 401);
  assert.equal((await call(createAgentTurnHandler({ agentCore, apiToken: null }), jsonReq('/api/agent/turn', { message: 'oi' }))).status, 503);
  assert.equal((await call(turnHandler, jsonReq('/api/agent/turn', { message: 'oi' }, { headers: { host: 'evil.example' } }))).status, 403);
  assert.equal((await call(turnHandler, mockReq({ url: '/api/agent/turn', body: '{}' }))).status, 403);
  assert.equal((await call(turnHandler, jsonReq('/api/agent/turn', '{ quebrado'))).status, 400);
  assert.equal((await call(turnHandler, jsonReq('/api/agent/turn', { message: 'oi', extra: 1 }))).status, 400);
  assert.equal((await call(turnHandler, jsonReq('/api/agent/turn', { message: '   ' }))).status, 400);
  assert.equal((await call(turnHandler, jsonReq('/api/agent/turn', { message: 'oi', origin: 'desconhecida' }))).status, 400);

  const ok = await call(turnHandler, jsonReq('/api/agent/turn', { message: 'Busca na memória sobre café', origin: 'user' }));
  assert.equal(ok.status, 200);
  assert.equal(ok.data.ok, true);
  assert.equal(ok.data.turn.status, 'executed');

  const listed = await call(turnHandler, mockReq({ method: 'GET', url: '/api/agent/turns?limit=5' }));
  assert.equal(listed.status, 200);
  assert.equal(listed.data.count, 1);

  assert.equal((await call(turnHandler, mockReq({ method: 'GET', url: '/api/agent/turns?limit=99' }))).status, 400);
  assert.equal((await call(turnHandler, mockReq({ method: 'GET', url: '/api/agent/turns/trn-000000000000' }))).status, 404);
  assert.equal((await call(turnHandler, mockReq({ method: 'DELETE', url: '/api/agent/turn' }))).status, 404);
});

