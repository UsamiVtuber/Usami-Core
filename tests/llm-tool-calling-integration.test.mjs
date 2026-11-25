/**
 * Testes de integração para tool calling nativo (generateReplyWithTools).
 * 
 * Estes testes verificam o fluxo completo de function calling via NVIDIA
 * com tool registry real, executor real e tool metrics.
 */

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
import { createAgentCore } from '../src/agent-core.js';
import { createToolMetrics } from '../src/tool-metrics.js';
import { selectTopKTools } from '../src/tool-selector.js';
import { toolToOpenAi } from '../src/tool-registry.js';

// Setup: isola NVIDIA e usa OpenRouter mock
process.env.USE_NVIDIA = 'false';
const prevKey = process.env.OPENROUTER_API_KEY;
process.env.OPENROUTER_API_KEY = 'mock-key-for-tests';

function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'usami-llm-tool-test-'));
  
  const memoryStore = createMemoryStore({ dataDir: dir });
  memoryStore.load();
  memoryStore.addCoreFact('Gosta de café com leite', 'preferences');
  
  const registry = createToolRegistry();
  registry.register(createMemorySearchTool({ memoryStore }));
  
  // Ferramenta de teste nível 1 (sempre executa)
  registry.register({
    schema: AGENT_SCHEMAS.tool,
    name: 'test.echo',
    version: '1.0.0',
    description: 'Repete o texto recebido.',
    origin: 'runtime',
    permissionLevel: 1,
    timeoutMs: 2000,
    parameters: [{ name: 'text', type: 'string', required: true }],
    verify: r => r?.ok === true && typeof r?.text === 'string',
    execute: async ({ text }) => ({ ok: true, text }),
  });
  
  // Ferramenta de teste nível 2
  registry.register({
    schema: AGENT_SCHEMAS.tool,
    name: 'test.get_time',
    version: '1.0.0',
    description: 'Retorna timestamp atual.',
    origin: 'runtime',
    permissionLevel: 2,
    timeoutMs: 2000,
    parameters: [],
    verify: r => r?.ok === true && typeof r?.timestamp === 'number',
    execute: async () => ({ ok: true, timestamp: Date.now() }),
  });
  
  const gate = createPermissionGate({ registry, dataDir: dir, onLoadError: () => {} });
  gate.load();
  
  const metrics = createToolMetrics();
  
  const executor = createToolExecutor({ 
    registry, 
    gate, 
    dataDir: dir, 
    onLoadError: () => {},
    metrics,
  });
  executor.load();
  
  const planner = createTaskPlanner({ dataDir: dir, onLoadError: () => {} });
  planner.load();
  
  const agentCore = createAgentCore({
    registry,
    executor,
    planner,
    turnDeadlineMs: 8000,
    metrics,
    classifyWithLlm: null, // usa só determinístico
    onError: () => {},
  });
  
  return { dir, registry, executor, agentCore, metrics, memoryStore, gate, planner };
}

function makeReq(method, url, body = {}) {
  return {
    method,
    url,
    headers: { host: '127.0.0.1:8787', 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify(body));
    },
  };
}

async function call(handler, req) {
  const res = { statusCode: null, body: '' };
  res.writeHead = (s) => { res.statusCode = s; };
  res.end = (b) => { res.body = b; };
  await handler(req, res);
  return { status: res.statusCode, data: JSON.parse(res.body) };
}

test('integração: selectTopKTools escolhe ferramentas corretas do registry real', () => {
  const { dir, registry, metrics } = setupTest();
  try {
    const tools = registry.list();
    assert.ok(tools.length >= 2);
    
    const topK = selectTopKTools('busca na memoria sobre cafe', tools, { k: 3 });
    assert.ok(topK.length > 0);
    assert.equal(topK[0].name, 'memory.search');
    assert.ok(topK[0]._relevanceScore > 0);
    
    const topK2 = selectTopKTools('repetir texto', tools, { k: 3 });
    assert.ok(topK2.some(t => t.name === 'test.echo'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('integração: toolToOpenAi converte spec do registry para formato OpenAI', () => {
  const { dir, registry } = setupTest();
  try {
    const tools = registry.list();
    const memoryTool = tools.find(t => t.name === 'memory.search');
    assert.ok(memoryTool);
    
    const openAiTool = toolToOpenAi(memoryTool);
    assert.equal(openAiTool.type, 'function');
    // OpenAI function calling format converte . para _
    assert.equal(openAiTool.function.name, 'memory_search');
    assert.ok(openAiTool.function.description.includes('Busca'));
    assert.ok(openAiTool.function.parameters.type === 'object');
    assert.ok(openAiTool.function.parameters.properties.query);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('integração: agentCore processTurn executa ferramenta via executor real', async () => {
  const { dir, agentCore, metrics } = setupTest();
  try {
    const result = await agentCore.processTurn('busca na memoria sobre cafe', { origin: 'agent' });
    
    assert.equal(result.ok, true);
    assert.equal(result.turn.route, 'tool');
    assert.equal(result.turn.status, 'executed');
    assert.equal(result.turn.tool, 'memory.search');
    assert.ok(result.turn.result);
    
    // Verifica métricas
    const summary = metrics.getSummary();
    assert.ok(summary.tools['memory.search'].executions >= 1);
    assert.ok(summary.tools['memory.search'].success >= 1);
    assert.ok(summary.intent.operational.total >= 1);
    assert.ok(summary.intent.origin.classifier >= 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('integração: agentCore processTurn encadeia múltiplas ferramentas operacionais', async () => {
  const { dir, agentCore, metrics } = setupTest();
  try {
    // Primeiro busca na memória
    const result1 = await agentCore.processTurn('busca na memoria sobre cafe', { origin: 'agent' });
    assert.equal(result1.turn.tool, 'memory.search');
    
    // Depois eco (usa nome da ferramenta para classifier determinístico reconhecer)
    const result2 = await agentCore.processTurn('test.echo isso', { origin: 'agent' });
    assert.equal(result2.turn.tool, 'test.echo');
    
    // Verifica métricas de ambas
    const summary = metrics.getSummary();
    assert.ok(summary.tools['memory.search'].executions >= 1);
    assert.ok(summary.tools['test.echo'].executions >= 1);
    assert.ok(summary.intent.operational.total >= 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('integração: permission gate bloqueia nível 4 sem confirmação', async () => {
  const { dir, registry, executor, gate, metrics } = setupTest();
  try {
    // Registra ferramenta nível 4
    registry.register({
      schema: AGENT_SCHEMAS.tool,
      name: 'test.dangerous',
      version: '1.0.0',
      description: 'Ferramenta perigosa.',
      origin: 'runtime',
      permissionLevel: 4,
      timeoutMs: 2000,
      parameters: [{ name: 'action', type: 'string', required: true }],
      verify: r => r?.ok === true,
      execute: async ({ action }) => ({ ok: true, action }),
    });
    executor.load(); // recarrega
    
    const result = await executor.execute('test.dangerous', { action: 'delete_all' }, { origin: 'agent' });
    assert.equal(result.ok, false);
    assert.equal(result.denied, true);
    // O registro de execução tem status 'denied'; o status 'awaiting_confirmation' é no nível do turn (agent-core)
    assert.equal(result.record.status, 'denied');
    
    // Verifica métricas de permission gate
    const summary = metrics.getSummary();
    assert.ok(summary.permission['test.dangerous'].checks >= 1);
    assert.ok(summary.permission['test.dangerous'].denied >= 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('integração: permission gate aprova nível 4 com confirmação', async () => {
  const { dir, registry, executor, gate, metrics } = setupTest();
  try {
    registry.register({
      schema: AGENT_SCHEMAS.tool,
      name: 'test.dangerous2',
      version: '1.0.0',
      description: 'Ferramenta perigosa 2.',
      origin: 'runtime',
      permissionLevel: 4,
      timeoutMs: 2000,
      parameters: [{ name: 'action', type: 'string', required: true }],
      verify: r => r?.ok === true,
      execute: async ({ action }) => ({ ok: true, action }),
    });
    executor.load();
    
    // Primeiro pedido sem confirmação - deve ser negado
    const denied = await executor.execute('test.dangerous2', { action: 'delete_all' }, { origin: 'agent' });
    assert.equal(denied.denied, true);
    
    // Cria confirmação válida via gate
    const confirmationResult = gate.createConfirmation('test.dangerous2');
    assert.equal(confirmationResult.ok, true);
    const confirmationToken = confirmationResult.confirmation.token;
    
    // Segundo pedido com confirmação válida
    const authorized = await executor.execute('test.dangerous2', { action: 'delete_all' }, { 
      origin: 'agent', 
      confirmation: confirmationToken 
    });
    assert.equal(authorized.ok, true);
    assert.equal(authorized.record.status, 'ok');
    
    const summary = metrics.getSummary();
    assert.ok(summary.permission['test.dangerous2'].granted >= 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('integração: tool metrics registra latência e timeout', async () => {
  const { dir, registry, executor, metrics } = setupTest();
  try {
    // Ferramenta lenta (timeout) - timeoutMs mínimo é 100
    registry.register({
      schema: AGENT_SCHEMAS.tool,
      name: 'test.slow',
      version: '1.0.0',
      description: 'Ferramenta lenta.',
      origin: 'runtime',
      permissionLevel: 1,
      timeoutMs: 100, // timeout curto (mínimo 100ms)
      parameters: [],
      verify: () => true,
      execute: async () => {
        await new Promise(r => setTimeout(r, 200)); // mais lento que timeout
        return { ok: true };
      },
    });
    executor.load();
    
    const result = await executor.execute('test.slow', {}, { origin: 'agent' });
    assert.equal(result.ok, false);
    assert.equal(result.record.status, 'timeout');
    
    const summary = metrics.getSummary();
    assert.ok(summary.tools['test.slow'].timeout >= 1);
    assert.ok(summary.tools['test.slow'].latency.count >= 1);
    assert.ok(summary.tools['test.slow'].latency.p50 > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('integração: tool metrics exporta formato Prometheus', () => {
  const { dir, metrics } = setupTest();
  try {
    metrics.recordToolExecution('test.tool', 100, true, { permissionLevel: 1 });
    metrics.recordToolExecution('test.tool', 200, false, { permissionLevel: 1 });
    metrics.recordIntentClassification('operational', 'llm');
    metrics.recordIntentClassification('conversation', 'classifier');
    
    const prometheus = metrics.toPrometheus();
    assert.ok(prometheus.includes('usami_tool_executions_total{tool="test.tool"} 2'));
    assert.ok(prometheus.includes('usami_tool_success_total{tool="test.tool"} 1'));
    assert.ok(prometheus.includes('usami_tool_error_total{tool="test.tool"} 1'));
    assert.ok(prometheus.includes('usami_intent_total{kind="operational",origin="llm"} 1'));
    assert.ok(prometheus.includes('usami_intent_total{kind="conversation",origin="classifier"} 1'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Limpa variável de ambiente
process.env.OPENROUTER_API_KEY = prevKey;