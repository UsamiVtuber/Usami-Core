#!/usr/bin/env node

/**
 * Servidor MCP (Model Context Protocol) da Usami para Code Agents.
 *
 * Comunica via JSON-RPC 2.0 sobre stdin/stdout com Antigravity, Claude Code, Cursor, Qoder, etc.
 * Envia heartbeats periódicos de presença para a Usami e expõe ferramentas para consultar
 * e resolver propostas de código criadas pela Usami.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, '..', '..');

function readToken() {
  if (process.env.USAMI_API_TOKEN) return process.env.USAMI_API_TOKEN;
  try {
    const envPath = resolve(ROOT_DIR, '.env');
    const content = readFileSync(envPath, 'utf8');
    const match = /^\s*USAMI_API_TOKEN\s*=\s*(.+?)\s*$/m.exec(content);
    if (match) return match[1].replace(/^["']|["']$/g, '');
  } catch {}
  return '';
}

const API_URL = process.env.USAMI_API_URL || 'http://127.0.0.1:8787';
const API_TOKEN = readToken();
const AGENT_NAME = process.env.MCP_AGENT_NAME || 'antigravity';

const TOOLS = [
  {
    name: 'usami_status',
    description: 'Verifica o status da Usami, presença do Code Agent e quantidade de propostas pendentes.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'usami_list_proposals',
    description: 'Lista as propostas de código geradas pela Usami para os Code Agents.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['pending', 'in_progress', 'completed', 'rejected', 'all'],
          description: 'Filtrar por status da proposta (padrão: pending).',
        },
        limit: {
          type: 'number',
          description: 'Número máximo de propostas a retornar (padrão: 20).',
        },
      },
    },
  },
  {
    name: 'usami_get_proposal',
    description: 'Obtém detalhes completos de uma proposta específica da Usami pelo seu ID.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'ID da proposta (ex: "prop-a1b2c3d4e5f6").',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'usami_update_proposal',
    description: 'Atualiza o status de uma proposta após implementação ou revisão pelo Code Agent.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'ID da proposta.',
        },
        status: {
          type: 'string',
          enum: ['in_progress', 'completed', 'rejected'],
          description: 'Novo status da proposta.',
        },
        resolution: {
          type: 'string',
          description: 'Resumo da implementação ou motivo da rejeição.',
        },
        commitHash: {
          type: 'string',
          description: 'Hash do commit Git realizado (se houver).',
        },
        prUrl: {
          type: 'string',
          description: 'URL do Pull Request gerado (se houver).',
        },
        note: {
          type: 'string',
          description: 'Nota técnica ou feedback adicional para a Usami.',
        },
      },
      required: ['id', 'status'],
    },
  },
  {
    name: 'usami_send_message',
    description: 'Envia uma mensagem direta ou notificação para a Usami (ex: informando término de tarefa).',
    inputSchema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'Mensagem para a Usami.',
        },
      },
      required: ['message'],
    },
  },
  {
    name: 'usami_ping_heartbeat',
    description: 'Envia um heartbeat manual de presença para manter o Code Agent registrado como ONLINE na Usami.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'usami_list_executions',
    description: 'Lista as execuções recentes de ferramentas da Usami com status, duração, parâmetros e erros.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Número máximo de execuções a retornar (padrão: 20).',
        },
      },
    },
  },
];

async function apiRequest(path, { method = 'GET', body = null } = {}) {
  const headers = {
    'Accept': 'application/json',
    'x-usami-token': API_TOKEN,
  };
  if (body) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  try {
    return { status: res.status, ok: res.ok, data: JSON.parse(text) };
  } catch {
    return { status: res.status, ok: res.ok, raw: text };
  }
}

async function sendHeartbeat(status = 'active') {
  try {
    const payload = {
      agent: AGENT_NAME,
      client: 'usami-mcp',
      capabilities: ['read', 'write', 'mcp'],
      status,
    };
    await apiRequest('/api/agent/presence', { method: 'POST', body: payload });
  } catch (err) {
    process.stderr.write(`[usami-mcp] Heartbeat error: ${err.message}\n`);
  }
}

// Inicia heartbeat automático a cada 25 segundos
const heartbeatTimer = setInterval(() => sendHeartbeat('active'), 25000);
sendHeartbeat('active').catch(() => {});

process.on('SIGINT', async () => {
  clearInterval(heartbeatTimer);
  await sendHeartbeat('inactive').catch(() => {});
  process.exit(0);
});

process.on('SIGTERM', async () => {
  clearInterval(heartbeatTimer);
  await sendHeartbeat('inactive').catch(() => {});
  process.exit(0);
});

function sendJsonRpc(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

async function handleToolCall(name, args) {
  switch (name) {
    case 'usami_status': {
      const presence = await apiRequest('/api/agent/presence');
      const proposals = await apiRequest('/api/agent/proposals?status=pending&limit=10');
      return {
        usamiOnline: presence.ok,
        agentPresence: presence.data || null,
        pendingProposalsCount: Array.isArray(proposals.data?.proposals) ? proposals.data.proposals.length : 0,
        pendingProposals: proposals.data?.proposals || [],
      };
    }
    case 'usami_list_proposals': {
      const status = args.status || 'pending';
      const limit = args.limit || 20;
      const res = await apiRequest(`/api/agent/proposals?status=${encodeURIComponent(status)}&limit=${encodeURIComponent(limit)}`);
      return res.data || { ok: false, error: 'Falha ao buscar propostas' };
    }
    case 'usami_get_proposal': {
      if (!args.id) throw new Error('Parâmetro id é obrigatório.');
      const res = await apiRequest(`/api/agent/proposals/${encodeURIComponent(args.id)}`);
      return res.data || { ok: false, error: 'Proposta não encontrada' };
    }
    case 'usami_update_proposal': {
      if (!args.id || !args.status) throw new Error('Parâmetros id e status são obrigatórios.');
      const res = await apiRequest(`/api/agent/proposals/${encodeURIComponent(args.id)}`, {
        method: 'PATCH',
        body: {
          status: args.status,
          resolution: args.resolution,
          commitHash: args.commitHash,
          prUrl: args.prUrl,
          note: args.note,
        },
      });
      return res.data || { ok: false, error: 'Falha ao atualizar proposta' };
    }
    case 'usami_send_message': {
      if (!args.message) throw new Error('Parâmetro message é obrigatório.');
      const res = await apiRequest('/api/n8n/command', {
        method: 'POST',
        body: {
          type: 'say',
          text: `[Code Agent]: ${args.message}`,
        },
      });
      return res.data || { ok: true, sent: true };
    }
    case 'usami_ping_heartbeat': {
      await sendHeartbeat('active');
      return { ok: true, ping: 'pong', agent: AGENT_NAME, timestamp: new Date().toISOString() };
    }
    case 'usami_list_executions': {
      const limit = Math.min(Math.max(Number(args?.limit) || 20, 1), 50);
      const res = await apiRequest(`/api/agent/executions?limit=${limit}`);
      return res.data || { ok: false, executions: [] };
    }
    default:
      throw new Error(`Ferramenta desconhecida: ${name}`);
  }
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

rl.on('line', async line => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let request;
  try {
    request = JSON.parse(trimmed);
  } catch (err) {
    sendJsonRpc({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error: JSON inválido' },
    });
    return;
  }

  const { id, method, params } = request;

  // Notificações (sem id) não exigem resposta JSON-RPC
  if (id === undefined || id === null) {
    if (method === 'notifications/initialized') {
      process.stderr.write(`[usami-mcp] Inicializado pelo cliente MCP.\n`);
    }
    return;
  }

  try {
    if (method === 'initialize') {
      sendJsonRpc({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: 'usami-bridge',
            version: '1.0.0',
          },
        },
      });
      return;
    }

    if (method === 'ping') {
      sendJsonRpc({
        jsonrpc: '2.0',
        id,
        result: {},
      });
      return;
    }

    if (method === 'tools/list') {
      sendJsonRpc({
        jsonrpc: '2.0',
        id,
        result: {
          tools: TOOLS,
        },
      });
      return;
    }

    if (method === 'tools/call') {
      const toolName = params?.name;
      const toolArgs = params?.arguments || {};
      const result = await handleToolCall(toolName, toolArgs);
      sendJsonRpc({
        jsonrpc: '2.0',
        id,
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        },
      });
      return;
    }

    sendJsonRpc({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Método não encontrado: ${method}` },
    });
  } catch (error) {
    sendJsonRpc({
      jsonrpc: '2.0',
      id,
      error: { code: -32000, message: error.message || 'Erro interno no MCP' },
    });
  }
});

