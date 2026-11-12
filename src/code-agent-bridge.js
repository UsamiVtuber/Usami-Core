/**
 * Ponte de integração entre a Usami e Code Agents (Antigravity, Claude Code, Cursor, Qoder).
 *
 * Gerencia a presença em tempo real dos Code Agents (via MCP heartbeat) e a fila de propostas
 * de código geradas pela Usami.
 *
 * Se um Code Agent estiver ONLINE:
 *   A proposta é despachada diretamente para a fila em tempo real (consumida via MCP).
 * Se nenhum Code Agent estiver ONLINE:
 *   A proposta é registrada como uma Issue no GitHub com a label `[usami-proposal]`
 *   para revisão assíncrona.
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { dataDir as resolveDataDir } from './data-paths.js';
import { checkApiToken, isAllowedRequest, readApiToken, withExtraOrigins } from './api-security.js';

export const PROPOSALS_SCHEMA = 'usami.agent_proposals.v1';
export const PROPOSALS_VERSION = '1.0.0';
export const DEFAULT_HEARTBEAT_TTL_MS = 60000; // 60 segundos
export const PROPOSAL_STATUSES = Object.freeze(['pending', 'in_progress', 'completed', 'rejected']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function createCodeAgentBridge({
  dataDir = resolveDataDir(),
  gitClient = null,
  now = () => Date.now(),
  ttlMs = DEFAULT_HEARTBEAT_TTL_MS,
} = {}) {
  const filePath = join(dataDir, 'agent-proposals.json');
  const agents = new Map(); // agentId -> { agent, client, capabilities, status, lastSeen }

  let cache = null;

  function load() {
    try {
      const raw = readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (isPlainObject(parsed) && Array.isArray(parsed.proposals)) {
        cache = parsed;
        return cache;
      }
    } catch {
      // Arquivo inexistente ou corrompido: inicializa vazio
    }
    cache = {
      schema: PROPOSALS_SCHEMA,
      version: PROPOSALS_VERSION,
      updatedAt: new Date(now()).toISOString(),
      proposals: [],
    };
    return cache;
  }

  function persist() {
    if (!cache) load();
    mkdirSync(dirname(filePath), { recursive: true });
    cache.updatedAt = new Date(now()).toISOString();
    const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temporary, JSON.stringify(cache, null, 2), 'utf8');
    try {
      renameSync(temporary, filePath);
    } catch (error) {
      try { unlinkSync(temporary); } catch {}
      if (error?.code !== 'EEXIST' && error?.code !== 'EPERM') throw error;
      writeFileSync(filePath, JSON.stringify(cache, null, 2), 'utf8');
    }
    return cache;
  }

  // --- Presença de Code Agents (MCP Heartbeat) ------------------------------

  function registerPresence({ agent = 'code-agent', client = 'unknown', capabilities = [], status = 'active' } = {}) {
    const safeAgent = String(agent || 'code-agent').trim().slice(0, 64) || 'code-agent';
    const safeClient = String(client || 'unknown').trim().slice(0, 64) || 'unknown';
    const currentTime = now();

    if (status === 'inactive' || status === 'offline') {
      agents.delete(safeAgent);
      return { ok: true, registered: false, agent: safeAgent, online: false };
    }

    const entry = {
      agent: safeAgent,
      client: safeClient,
      capabilities: Array.isArray(capabilities) ? capabilities.map(c => String(c).trim()).filter(Boolean).slice(0, 20) : [],
      status: 'active',
      lastSeen: currentTime,
      lastSeenIso: new Date(currentTime).toISOString(),
    };

    agents.set(safeAgent, entry);
    return { ok: true, registered: true, agent: safeAgent, online: true };
  }

  function getPresence() {
    const currentTime = now();
    const activeList = [];

    for (const [key, entry] of agents.entries()) {
      if (currentTime - entry.lastSeen <= ttlMs && entry.status === 'active') {
        activeList.push({
          agent: entry.agent,
          client: entry.client,
          capabilities: entry.capabilities,
          lastSeen: entry.lastSeenIso,
          ageMs: Math.max(0, currentTime - entry.lastSeen),
        });
      } else {
        agents.delete(key);
      }
    }

    return {
      ok: true,
      online: activeList.length > 0,
      activeAgents: activeList,
    };
  }

  function isAgentOnline() {
    return getPresence().online;
  }

  // --- Fila de Propostas ---------------------------------------------------

  function createProposal({
    title,
    description = '',
    files = [],
    suggestedAction = 'feature',
    repo = 'UsamiVtuber/Usami-Core',
    origin = 'usami',
    routedTo = 'code_agent',
    issueNumber = null,
    issueUrl = null,
  } = {}) {
    if (!cache) load();

    const safeTitle = String(title || '').trim().slice(0, 200);
    if (safeTitle.length < 3) throw new Error('title deve ter no mínimo 3 caracteres.');

    const proposalId = `prop-${randomBytes(6).toString('hex')}`;
    const isoDate = new Date(now()).toISOString();

    const proposal = {
      id: proposalId,
      title: safeTitle,
      description: String(description || '').slice(0, 4000),
      files: Array.isArray(files) ? files.map(f => String(f).trim()).filter(Boolean).slice(0, 20) : [],
      suggestedAction: String(suggestedAction || 'feature').slice(0, 50),
      repo: String(repo || 'UsamiVtuber/Usami-Core').slice(0, 100),
      origin: String(origin || 'usami').slice(0, 50),
      status: 'pending',
      routedTo: routedTo === 'github_issue' ? 'github_issue' : 'code_agent',
      issueNumber: typeof issueNumber === 'number' ? issueNumber : null,
      issueUrl: typeof issueUrl === 'string' ? issueUrl : null,
      resolution: null,
      commitHash: null,
      prUrl: null,
      note: null,
      createdAt: isoDate,
      updatedAt: isoDate,
    };

    cache.proposals.unshift(proposal);
    // Limite preventivo de 200 propostas
    if (cache.proposals.length > 200) cache.proposals.pop();

    persist();
    return proposal;
  }

  function listProposals({ status = null, limit = 50 } = {}) {
    if (!cache) load();
    let result = cache.proposals;
    if (status && status !== 'all') {
      result = result.filter(p => p.status === status);
    }
    const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 100));
    return result.slice(0, safeLimit);
  }

  function getProposal(id) {
    if (!cache) load();
    return cache.proposals.find(p => p.id === id) || null;
  }

  function updateProposal(id, { status, resolution = null, commitHash = null, prUrl = null, note = null } = {}) {
    if (!cache) load();
    const proposal = cache.proposals.find(p => p.id === id);
    if (!proposal) return null;

    if (status && PROPOSAL_STATUSES.includes(status)) {
      proposal.status = status;
    }
    if (resolution !== null) proposal.resolution = String(resolution).slice(0, 2000);
    if (commitHash !== null) proposal.commitHash = String(commitHash).trim().slice(0, 100);
    if (prUrl !== null) proposal.prUrl = String(prUrl).trim().slice(0, 300);
    if (note !== null) proposal.note = String(note).slice(0, 2000);

    proposal.updatedAt = new Date(now()).toISOString();
    persist();
    return proposal;
  }

  // --- Roteamento Inteligente (Agente Online vs GitHub Issue) --------------

  async function dispatchProposal({
    title,
    description = '',
    files = [],
    suggestedAction = 'feature',
    repo = 'UsamiVtuber/Usami-Core',
    origin = 'usami',
  } = {}) {
    const presence = getPresence();

    if (presence.online) {
      // Code Agent está online (MCP conectado)
      const proposal = createProposal({
        title,
        description,
        files,
        suggestedAction,
        repo,
        origin,
        routedTo: 'code_agent',
      });
      const activeAgent = presence.activeAgents[0]?.agent || 'code-agent';
      return {
        ok: true,
        routedTo: 'code_agent',
        agent: activeAgent,
        proposal,
        message: `Proposta enviada diretamente ao Code Agent ativo (${activeAgent}) via MCP.`,
      };
    }

    // Code Agent está OFFLINE -> Envia como Issue no GitHub
    if (gitClient && typeof gitClient.createIssue === 'function') {
      try {
        const fileListMarkdown = files.length
          ? files.map(f => `- \`${f}\``).join('\n')
          : '_Nenhum arquivo especificado_';

        const issueBody = `### 💡 Proposta de Código da Usami\n\n`
          + `**Título:** ${title}\n`
          + `**Ação sugerida:** ${suggestedAction}\n\n`
          + `**Descrição / Contexto:**\n${description || 'Sem descrição adicional.'}\n\n`
          + `**Arquivos envolvidos:**\n${fileListMarkdown}\n\n`
          + `---\n`
          + `_Esta issue foi aberta automaticamente pela Usami porque nenhum Code Agent estava online em tempo real via MCP._`;

        const issue = await gitClient.createIssue({
          repo,
          title: `[Usami Proposal] ${title}`,
          body: issueBody,
          labels: ['usami-proposal'],
        });

        const proposal = createProposal({
          title,
          description,
          files,
          suggestedAction,
          repo,
          origin,
          routedTo: 'github_issue',
          issueNumber: issue.number,
          issueUrl: issue.htmlUrl,
        });

        return {
          ok: true,
          routedTo: 'github_issue',
          proposal,
          issue,
          message: `Nenhum Code Agent ativo no momento. Abri a issue #${issue.number} no GitHub com a tag [usami-proposal].`,
        };
      } catch (err) {
        // Falha no GitHub (sem token ou rede): fallback salvando localmente
        const proposal = createProposal({
          title,
          description,
          files,
          suggestedAction,
          repo,
          origin,
          routedTo: 'code_agent',
        });
        return {
          ok: true,
          routedTo: 'code_agent',
          offline: true,
          proposal,
          warning: `GitHub indisponível (${err.message}). Proposta salva na fila local para quando um agente se conectar.`,
          message: 'Nenhum Code Agent online e GitHub indisponível. Salvei a proposta na fila local.',
        };
      }
    }

    // Sem gitClient configurado: salva na fila local
    const proposal = createProposal({
      title,
      description,
      files,
      suggestedAction,
      repo,
      origin,
      routedTo: 'code_agent',
    });
    return {
      ok: true,
      routedTo: 'code_agent',
      proposal,
      message: 'Proposta registrada na fila local para ser consumida quando um Code Agent se conectar.',
    };
  }

  return {
    registerPresence,
    getPresence,
    isAgentOnline,
    createProposal,
    listProposals,
    getProposal,
    updateProposal,
    dispatchProposal,
    load,
  };
}

// --- Handler HTTP para o servidor Usami -------------------------------------

export function createAgentBridgeHandler(options = {}) {
  const bridge = options.bridge;
  if (!bridge) throw new Error('createAgentBridgeHandler: bridge é obrigatório.');

  const apiToken = options.apiToken !== undefined ? options.apiToken : readApiToken();
  const allowedOrigins = options.allowedOrigins || withExtraOrigins(['http://127.0.0.1:5173', 'http://localhost:5173', 'http://127.0.0.1:8787', 'http://localhost:8787']);

  return async function handleBridgeRequest(req, res) {
    function send(status, body) {
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(JSON.stringify(body));
    }

    const origin = req.headers?.origin;
    const host = req.headers?.host;
    if (!isAllowedRequest(origin, host, allowedOrigins)) {
      return send(403, { error: 'Origem ou Host não autorizados.' });
    }

    const denied = checkApiToken(req, apiToken);
    if (denied) {
      return send(denied.status, { error: denied.error });
    }

    const url = new URL(req.url || '/api/agent/presence', 'http://127.0.0.1:8787');
    const path = url.pathname;

    async function readJson(maxBytes = 65536) {
      return new Promise(resolve => {
        let raw = '';
        let bytes = 0;
        req.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > maxBytes) {
            resolve(null);
            return;
          }
          raw += chunk.toString('utf8');
        });
        req.on('end', () => {
          if (!raw.trim()) return resolve({});
          try {
            resolve(JSON.parse(raw));
          } catch {
            resolve(null);
          }
        });
      });
    }

    // Rota: /api/agent/presence
    if (path === '/api/agent/presence') {
      if (req.method === 'GET') {
        return send(200, bridge.getPresence());
      }
      if (req.method === 'POST') {
        const payload = await readJson();
        if (!payload || !isPlainObject(payload)) {
          return send(400, { error: 'Payload JSON inválido.' });
        }
        const result = bridge.registerPresence(payload);
        return send(200, result);
      }
      return send(405, { error: 'Método não permitido.' });
    }

    // Rota: /api/agent/proposals
    if (path === '/api/agent/proposals') {
      if (req.method === 'GET') {
        const status = url.searchParams.get('status') || null;
        const limit = url.searchParams.get('limit') || 50;
        const list = bridge.listProposals({ status, limit });
        return send(200, { ok: true, proposals: list, count: list.length });
      }
      if (req.method === 'POST') {
        const payload = await readJson();
        if (!payload || !isPlainObject(payload)) {
          return send(400, { error: 'Payload JSON inválido.' });
        }
        try {
          const result = await bridge.dispatchProposal(payload);
          return send(201, result);
        } catch (error) {
          return send(400, { error: error.message || 'Falha ao registrar proposta.' });
        }
      }
      return send(405, { error: 'Método não permitido.' });
    }

    // Rota: /api/agent/proposals/:id
    const proposalMatch = /^\/api\/agent\/proposals\/([a-zA-Z0-9_-]+)$/.exec(path);
    if (proposalMatch) {
      const id = proposalMatch[1];
      if (req.method === 'GET') {
        const item = bridge.getProposal(id);
        if (!item) return send(404, { error: 'Proposta não encontrada.' });
        return send(200, { ok: true, proposal: item });
      }
      if (req.method === 'PATCH') {
        const payload = await readJson();
        if (!payload || !isPlainObject(payload)) {
          return send(400, { error: 'Payload JSON inválido.' });
        }
        const updated = bridge.updateProposal(id, payload);
        if (!updated) return send(404, { error: 'Proposta não encontrada.' });
        return send(200, { ok: true, proposal: updated });
      }
      return send(405, { error: 'Método não permitido.' });
    }

    return send(404, { error: 'Rota não encontrada.' });
  };
}
