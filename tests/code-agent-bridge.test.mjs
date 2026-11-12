import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createCodeAgentBridge,
  createAgentBridgeHandler,
} from '../src/code-agent-bridge.js';
import { createGitAssistantTools } from '../src/git-assistant-skill.js';
import { DEFAULT_TOOL_MATCHERS, formatExecutedTurnFallbackReply } from '../src/agent-core.js';

const TEST_TOKEN = 'test-usami-token-12345';

function mockReq({ method = 'GET', url = '/api/agent/presence', headers = {}, body = '' } = {}) {
  const chunks = body ? [Buffer.from(body)] : [];
  return {
    method,
    url,
    headers: { host: '127.0.0.1:8787', 'x-usami-token': TEST_TOKEN, ...headers },
    on(event, handler) {
      if (event === 'data') {
        for (const chunk of chunks) handler(chunk);
      }
      if (event === 'end') {
        process.nextTick(handler);
      }
      return this;
    },
  };
}

function mockRes() {
  const res = { statusCode: null, headers: null, body: '' };
  res.writeHead = (status, headers) => { res.statusCode = status; res.headers = headers; };
  res.end = (data) => { res.body = data; };
  return res;
}

test('CodeAgentBridge: rastreia presença e expiração de TTL de Code Agents', () => {
  const dir = mkdtempSync(join(tmpdir(), 'usami-bridge-test-'));
  let currentTime = 100000;
  const bridge = createCodeAgentBridge({
    dataDir: dir,
    now: () => currentTime,
    ttlMs: 30000,
  });

  // Inicialmente sem agentes
  const initial = bridge.getPresence();
  assert.equal(initial.online, false);
  assert.equal(bridge.isAgentOnline(), false);

  // Registra agente Antigravity
  const reg = bridge.registerPresence({
    agent: 'antigravity',
    client: 'mcp-vscode',
    capabilities: ['read', 'write'],
  });
  assert.equal(reg.ok, true);
  assert.equal(reg.online, true);

  // Agora online
  const active = bridge.getPresence();
  assert.equal(active.online, true);
  assert.equal(bridge.isAgentOnline(), true);
  assert.equal(active.activeAgents.length, 1);
  assert.equal(active.activeAgents[0].agent, 'antigravity');

  // Avança tempo em 20 segundos (ainda dentro do TTL de 30s)
  currentTime += 20000;
  assert.equal(bridge.isAgentOnline(), true);

  // Avança mais 15 segundos (total 35s > TTL 30s)
  currentTime += 15000;
  assert.equal(bridge.isAgentOnline(), false);
  assert.equal(bridge.getPresence().activeAgents.length, 0);

  // Re-conecta e depois desconecta explicitamente
  bridge.registerPresence({ agent: 'claude-code', status: 'active' });
  assert.equal(bridge.isAgentOnline(), true);
  bridge.registerPresence({ agent: 'claude-code', status: 'inactive' });
  assert.equal(bridge.isAgentOnline(), false);

  rmSync(dir, { recursive: true, force: true });
});

test('CodeAgentBridge: CRUD de propostas com persistência atômica', () => {
  const dir = mkdtempSync(join(tmpdir(), 'usami-prop-test-'));
  let currentTime = 100000;
  const bridge = createCodeAgentBridge({
    dataDir: dir,
    now: () => currentTime,
  });

  // Cria proposta válida
  const prop = bridge.createProposal({
    title: 'Adicionar cache no n8n-queue',
    description: 'Evitar chamadas repetitivas de status.',
    files: ['src/n8n-queue.js'],
    suggestedAction: 'feature',
  });

  assert.match(prop.id, /^prop-[a-f0-9]{12}$/);
  assert.equal(prop.status, 'pending');
  assert.equal(prop.title, 'Adicionar cache no n8n-queue');
  assert.deepEqual(prop.files, ['src/n8n-queue.js']);

  // Recusa título curto
  assert.throws(() => {
    bridge.createProposal({ title: 'oi' });
  }, /title deve ter no mínimo 3 caracteres/);

  // Lista propostas
  const list = bridge.listProposals({ status: 'pending' });
  assert.equal(list.length, 1);
  assert.equal(list[0].id, prop.id);

  // Atualiza proposta
  currentTime += 5000;
  const updated = bridge.updateProposal(prop.id, {
    status: 'completed',
    resolution: 'Implementado com sucesso no commit abc1234',
    commitHash: 'abc1234',
    note: 'Testes passaram 100%',
  });
  assert.equal(updated.status, 'completed');
  assert.equal(updated.commitHash, 'abc1234');

  // Verifica que recarrega do arquivo persistido
  const bridgeReload = createCodeAgentBridge({
    dataDir: dir,
    now: () => currentTime,
  });
  const reloaded = bridgeReload.getProposal(prop.id);
  assert.equal(reloaded.id, prop.id);
  assert.equal(reloaded.status, 'completed');
  assert.equal(reloaded.commitHash, 'abc1234');

  rmSync(dir, { recursive: true, force: true });
});

test('CodeAgentBridge: dispatchProposal roteia direto para Code Agent se ONLINE', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'usami-dispatch-online-'));
  const bridge = createCodeAgentBridge({
    dataDir: dir,
    now: () => 100000,
  });

  // Agente online
  bridge.registerPresence({ agent: 'antigravity', status: 'active' });

  let githubCalled = false;
  const mockGitClient = {
    createIssue: async () => {
      githubCalled = true;
      return { number: 99 };
    },
  };

  const result = await bridge.dispatchProposal({
    title: 'Refatorar tts-cache',
    description: 'Melhorar controle de concorrência.',
    files: ['src/tts-cache.js'],
  });

  assert.equal(result.ok, true);
  assert.equal(result.routedTo, 'code_agent');
  assert.equal(result.agent, 'antigravity');
  assert.equal(githubCalled, false, 'Não deve chamar GitHub se o agente está online');
  assert.equal(result.proposal.status, 'pending');

  rmSync(dir, { recursive: true, force: true });
});

test('CodeAgentBridge: dispatchProposal abre Issue no GitHub se Code Agent estiver OFFLINE', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'usami-dispatch-offline-'));
  let gitPayload = null;
  const mockGitClient = {
    createIssue: async payload => {
      gitPayload = payload;
      return {
        number: 45,
        title: payload.title,
        htmlUrl: 'https://github.com/UsamiVtuber/Usami-Core/issues/45',
        labels: ['usami-proposal'],
      };
    },
  };

  const bridge = createCodeAgentBridge({
    dataDir: dir,
    gitClient: mockGitClient,
    now: () => 100000,
  });

  // Nenhum agente registrado -> OFFLINE
  const result = await bridge.dispatchProposal({
    title: 'Adicionar suporte a novo avatar',
    description: 'Carregar modelo VRM customizado.',
    files: ['src/avatar-cache.js'],
  });

  assert.equal(result.ok, true);
  assert.equal(result.routedTo, 'github_issue');
  assert.equal(result.issue.number, 45);
  assert.equal(gitPayload.labels[0], 'usami-proposal');
  assert.match(gitPayload.title, /\[Usami Proposal\] Adicionar suporte a novo avatar/);
  assert.equal(result.proposal.routedTo, 'github_issue');
  assert.equal(result.proposal.issueNumber, 45);

  rmSync(dir, { recursive: true, force: true });
});

test('HTTP Bridge Handler: endpoints de presença e propostas com autenticação', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'usami-bridge-http-'));
  const bridge = createCodeAgentBridge({ dataDir: dir });
  const handler = createAgentBridgeHandler({
    bridge,
    apiToken: TEST_TOKEN,
  });

  // 1. Recusa sem token (401)
  {
    const req = mockReq({ method: 'GET', url: '/api/agent/presence', headers: { 'x-usami-token': 'token-errado' } });
    const res = mockRes();
    await handler(req, res);
    assert.equal(res.statusCode, 401);
  }

  // 2. GET /api/agent/presence (inicialmente offline)
  {
    const req = mockReq({ method: 'GET', url: '/api/agent/presence' });
    const res = mockRes();
    await handler(req, res);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.online, false);
  }

  // 3. POST /api/agent/presence (heartbeat)
  {
    const req = mockReq({
      method: 'POST',
      url: '/api/agent/presence',
      body: JSON.stringify({ agent: 'antigravity', client: 'mcp-test', capabilities: ['read', 'write'] }),
    });
    const res = mockRes();
    await handler(req, res);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.registered, true);
    assert.equal(body.online, true);
  }

  // 4. POST /api/agent/proposals (cria proposta)
  let createdId = null;
  {
    const req = mockReq({
      method: 'POST',
      url: '/api/agent/proposals',
      body: JSON.stringify({
        title: 'Criar teste de integração para n8n',
        description: 'Testar nós HTTP do n8n com mock do server.',
        files: ['tests/n8n.test.mjs'],
      }),
    });
    const res = mockRes();
    await handler(req, res);
    assert.equal(res.statusCode, 201);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.routedTo, 'code_agent');
    createdId = body.proposal.id;
  }

  // 5. GET /api/agent/proposals (lista propostas)
  {
    const req = mockReq({ method: 'GET', url: '/api/agent/proposals' });
    const res = mockRes();
    await handler(req, res);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.count, 1);
    assert.equal(body.proposals[0].id, createdId);
  }

  // 6. PATCH /api/agent/proposals/:id (atualiza status)
  {
    const req = mockReq({
      method: 'PATCH',
      url: `/api/agent/proposals/${createdId}`,
      body: JSON.stringify({
        status: 'completed',
        resolution: 'Implementado com sucesso.',
        commitHash: 'deadbeef123',
      }),
    });
    const res = mockRes();
    await handler(req, res);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.proposal.status, 'completed');
    assert.equal(body.proposal.commitHash, 'deadbeef123');
  }

  rmSync(dir, { recursive: true, force: true });
});

test('code.propose Tool: integrada em git-assistant-skill e reconhecida por agent-core', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'usami-tool-prop-'));
  const bridge = createCodeAgentBridge({ dataDir: dir });
  bridge.registerPresence({ agent: 'antigravity', status: 'active' });

  const tools = createGitAssistantTools({
    gitClient: { createIssue: async () => ({ number: 1 }) },
    codeBridge: bridge,
  });

  const proposeTool = tools.find(t => t.name === 'code.propose');
  assert.ok(proposeTool, 'code.propose deve existir nas ferramentas de git-assistant');
  assert.equal(proposeTool.permissionLevel, 3);

  // Executa ferramenta
  const toolResult = await proposeTool.execute({
    title: 'Otimizar inicialização da Usami',
    description: 'Evitar parsing redundante de arquivos no boot.',
    files: ['server.mjs'],
  });

  assert.equal(toolResult.ok, true);
  assert.equal(toolResult.routedTo, 'code_agent');
  assert.equal(proposeTool.verify(toolResult), true);

  // Testa Matcher em agent-core
  const matcher = DEFAULT_TOOL_MATCHERS.find(m => m.toolName === 'code.propose');
  assert.ok(matcher, 'Matcher para code.propose deve existir');
  assert.equal(matcher.matches('usami, sugira uma melhoria de codigo pro code agent'), true);
  assert.equal(matcher.matches('manda pro antigravity criar uma funcao nova'), true);

  // Testa fallback reply
  const replyOnline = formatExecutedTurnFallbackReply({
    status: 'executed',
    tool: 'code.propose',
    result: { ok: true, routedTo: 'code_agent', agent: 'antigravity', proposal: { title: 'Otimizar inicialização' } },
  });
  assert.match(replyOnline, /antigravity/i);
  assert.match(replyOnline, /online via MCP/i);

  const replyOffline = formatExecutedTurnFallbackReply({
    status: 'executed',
    tool: 'code.propose',
    result: { ok: true, routedTo: 'github_issue', issue: { number: 42 }, proposal: { issueNumber: 42 } },
  });
  assert.match(replyOffline, /issue #42/i);
  assert.match(replyOffline, /usami-proposal/i);

  rmSync(dir, { recursive: true, force: true });
});

test('MCP Stdio Server: responde a initialize e tools/list via JSON-RPC 2.0', async () => {
  const { spawn } = await import('node:child_process');
  const mcpScript = join(process.cwd(), 'scripts', 'usami-mcp.mjs');

  const proc = spawn(process.execPath, [mcpScript], {
    env: { ...process.env, USAMI_API_TOKEN: 'token-dummy' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const responses = [];

  proc.stdout.on('data', chunk => {
    const raw = chunk.toString('utf8');
    for (const line of raw.split('\n')) {
      if (line.trim()) {
        try {
          responses.push(JSON.parse(line.trim()));
        } catch {}
      }
    }
  });

  // Envia initialize
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
  // Envia tools/list
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');

  // Aguarda respostas
  await new Promise(resolve => setTimeout(resolve, 800));

  proc.kill('SIGINT');

  assert.ok(responses.length >= 2, 'Deve ter recebido ao menos 2 respostas');
  const initRes = responses.find(r => r.id === 1);
  assert.equal(initRes?.result?.serverInfo?.name, 'usami-bridge');
  assert.equal(initRes?.result?.protocolVersion, '2024-11-05');

  const toolsRes = responses.find(r => r.id === 2);
  assert.ok(Array.isArray(toolsRes?.result?.tools));
  const toolNames = toolsRes.result.tools.map(t => t.name);
  assert.ok(toolNames.includes('usami_status'));
  assert.ok(toolNames.includes('usami_list_proposals'));
  assert.ok(toolNames.includes('usami_update_proposal'));
});
