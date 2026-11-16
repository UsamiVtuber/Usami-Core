/**
 * Meta-Agente de Engenharia & Sandbox Declarativo (Fase 2 — RFC-001).
 *
 * Separa estritamente:
 *  - Ring 0 (Core Engine imutável pelo meta-agente): `server.mjs`, `src/*`,
 *    `.env`, `vault/`, `package.json`. Qualquer tentativa de escrita é negada.
 *  - Ring 2 (User Workspace declarativo): `flows/*.flow.json`,
 *    `routes/*.route.json`, `overrides.json` sob `workspaceRoot`.
 *
 * Toda mutação em Ring 2 passa por:
 *  1) Validação estrita de schema e detecção de ciclos (DAG);
 *  2) Snapshot transacional pré-mutação em `.snapshots/`;
 *  3) Janela canary (padrão 60s) com rollback automático em caso de falha.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { AGENT_SCHEMAS } from './agent-contracts.js';

export const WORKSPACE_FLOW_SCHEMA = 'usami.workspace.flow.v1';
export const WORKSPACE_ROUTE_SCHEMA = 'usami.workspace.route.v1';
export const DEFAULT_CANARY_WINDOW_MS = 60_000;

export const ALLOWED_NODE_TYPES = Object.freeze([
  'trigger',
  'llm_prompt',
  'tool_call',
  'http_webhook',
  'condition',
  'reply',
]);

const RING0_PREFIXES = Object.freeze([
  'server.mjs',
  'package.json',
  'package-lock.json',
  '.env',
  'src/',
  'vault/',
  'tests/',
  'scripts/',
  '.git/',
]);

const ALLOWED_WORKSPACE_FILE_RE = /^(?:overrides\.json|(?:flows|routes)\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.json)$/;

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function normalizeRelPath(relPath) {
  return String(relPath ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
}

/**
 * Verifica se um caminho relativo pertence ao Ring 2 (mutável pelo meta-agente)
 * ou se viola o Ring 0 / path traversal.
 */
export function classifyWorkspacePath(relPath) {
  const rel = normalizeRelPath(relPath);
  if (!rel || isAbsolute(rel) || rel.includes('..') || rel.startsWith('/')) {
    return { allowed: false, ring: 'forbidden', reason: 'Caminho inválido ou fora do sandbox.' };
  }
  const lower = rel.toLowerCase();
  if (RING0_PREFIXES.some(prefix => lower === prefix.replace(/\/$/, '') || lower.startsWith(prefix))) {
    return { allowed: false, ring: 'ring0', reason: `Ring 0 protegido contra mutação: ${rel}` };
  }
  if (!ALLOWED_WORKSPACE_FILE_RE.test(rel)) {
    return {
      allowed: false,
      ring: 'unknown',
      reason: `Arquivo fora do schema Ring 2 permitido (use overrides.json, flows/*.json ou routes/*.json): ${rel}`,
    };
  }
  return { allowed: true, ring: 'ring2', relPath: rel };
}

/**
 * Valida um DAG declarativo (`usami.workspace.flow.v1`) garantindo nós permitidos
 * e ausência de ciclos via ordenação topológica (algoritmo de Kahn).
 */
export function validateDeclarativeFlow(flow) {
  const errors = [];
  if (!isPlainObject(flow)) {
    return { ok: false, errors: ['Flow deve ser um objeto JSON.'] };
  }
  if (flow.schema !== WORKSPACE_FLOW_SCHEMA) {
    errors.push(`schema deve ser '${WORKSPACE_FLOW_SCHEMA}'.`);
  }
  if (typeof flow.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,63}$/.test(flow.id)) {
    errors.push('id inválido (2..64 caracteres alfanuméricos, ".", "_" ou "-").');
  }
  if (!Array.isArray(flow.nodes) || flow.nodes.length === 0) {
    errors.push('nodes deve ser um array não vazio.');
  }
  if (!Array.isArray(flow.edges)) {
    errors.push('edges deve ser um array.');
  }
  if (errors.length > 0) return { ok: false, errors };

  const nodeIds = new Set();
  const inDegree = new Map();
  const adj = new Map();

  for (const node of flow.nodes) {
    if (!isPlainObject(node) || typeof node.id !== 'string' || !node.id.trim()) {
      errors.push('Cada nó precisa de id não vazio.');
      continue;
    }
    if (nodeIds.has(node.id)) {
      errors.push(`Nó duplicado: ${node.id}`);
      continue;
    }
    if (!ALLOWED_NODE_TYPES.includes(node.type)) {
      errors.push(`Tipo de nó proibido no sandbox: ${String(node.type)}`);
      continue;
    }
    nodeIds.add(node.id);
    inDegree.set(node.id, 0);
    adj.set(node.id, []);
  }

  for (const edge of flow.edges) {
    if (!isPlainObject(edge) || typeof edge.from !== 'string' || typeof edge.to !== 'string') {
      errors.push('Cada edge precisa de { from, to }.');
      continue;
    }
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
      errors.push(`Edge referencia nó inexistente: ${edge.from} -> ${edge.to}`);
      continue;
    }
    if (edge.from === edge.to) {
      errors.push(`Auto-ciclo detectado em ${edge.from}.`);
      continue;
    }
    adj.get(edge.from).push(edge.to);
    inDegree.set(edge.to, (inDegree.get(edge.to) || 0) + 1);
  }

  if (errors.length > 0) return { ok: false, errors };

  // Ordenação topológica de Kahn para garantir aciclicidade (DAG)
  const queue = [];
  for (const [id, deg] of inDegree.entries()) {
    if (deg === 0) queue.push(id);
  }
  const order = [];
  while (queue.length > 0) {
    const cur = queue.shift();
    order.push(cur);
    for (const next of adj.get(cur) || []) {
      const nextDeg = (inDegree.get(next) || 0) - 1;
      inDegree.set(next, nextDeg);
      if (nextDeg === 0) queue.push(next);
    }
  }
  if (order.length !== nodeIds.size) {
    return { ok: false, errors: ['Ciclo detectado no grafo do flow (DAG inválido).'] };
  }

  return { ok: true, errors: [], order };
}

export function validateDeclarativeRoute(route) {
  const errors = [];
  if (!isPlainObject(route)) {
    return { ok: false, errors: ['Route deve ser um objeto JSON.'] };
  }
  if (route.schema !== WORKSPACE_ROUTE_SCHEMA) {
    errors.push(`schema deve ser '${WORKSPACE_ROUTE_SCHEMA}'.`);
  }
  if (typeof route.path !== 'string' || !/^\/workspace\/[a-zA-Z0-9/_-]+$/.test(route.path)) {
    errors.push('path deve começar com /workspace/ e conter apenas caracteres seguros.');
  }
  const method = String(route.method || 'GET').toUpperCase();
  if (!['GET', 'POST'].includes(method)) {
    errors.push('method deve ser GET ou POST.');
  }
  if (typeof route.flowId !== 'string' || !route.flowId.trim()) {
    errors.push('flowId é obrigatório.');
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, errors: [] };
}

export function validateWorkspaceFileContent(relPath, content) {
  let parsed;
  try {
    parsed = typeof content === 'string' ? JSON.parse(content) : content;
  } catch {
    return { ok: false, errors: [`JSON inválido em ${relPath}.`] };
  }
  if (relPath.startsWith('flows/')) return validateDeclarativeFlow(parsed);
  if (relPath.startsWith('routes/')) return validateDeclarativeRoute(parsed);
  if (relPath === 'overrides.json') {
    return isPlainObject(parsed)
      ? { ok: true, errors: [] }
      : { ok: false, errors: ['overrides.json deve ser um objeto JSON.'] };
  }
  return { ok: false, errors: [`Tipo de arquivo não suportado: ${relPath}`] };
}

function listWorkspaceFilesRecursive(rootDir, currentDir = rootDir, out = []) {
  if (!existsSync(currentDir)) return out;
  for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
    if (entry.name === '.snapshots') continue;
    const full = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      listWorkspaceFilesRecursive(rootDir, full, out);
    } else if (entry.isFile()) {
      const rel = normalize(relative(rootDir, full)).replace(/\\/g, '/');
      out.push(rel);
    }
  }
  return out.sort();
}

/**
 * Gerenciador transacional do Ring 2 com snapshots em disco, janela canary
 * configurável e rollback automático em caso de falha.
 */
export function createMetaTransactionManager({
  workspaceRoot,
  canaryWindowMs = DEFAULT_CANARY_WINDOW_MS,
  now = () => Date.now(),
} = {}) {
  if (!workspaceRoot || typeof workspaceRoot !== 'string') {
    throw new Error('createMetaTransactionManager: workspaceRoot é obrigatório.');
  }
  const rootResolved = resolve(workspaceRoot);
  const snapshotsDir = join(rootResolved, '.snapshots');
  const transactions = new Map();

  function ensureDirs() {
    mkdirSync(rootResolved, { recursive: true });
    mkdirSync(snapshotsDir, { recursive: true });
  }

  function safeTarget(relPath) {
    const check = classifyWorkspacePath(relPath);
    if (!check.allowed) {
      const err = new Error(check.reason);
      err.code = check.ring === 'ring0' ? 'E_RING0_PROTECTED' : 'E_FORBIDDEN_PATH';
      throw err;
    }
    const target = resolve(rootResolved, check.relPath);
    const diff = relative(rootResolved, target).replace(/\\/g, '/');
    if (!diff || diff.startsWith('..') || isAbsolute(diff)) {
      const err = new Error('Caminho escapou do workspaceRoot.');
      err.code = 'E_FORBIDDEN_PATH';
      throw err;
    }
    return { relPath: check.relPath, target };
  }

  function captureSnapshot(txId) {
    ensureDirs();
    const files = listWorkspaceFilesRecursive(rootResolved);
    const snapshot = {};
    for (const rel of files) {
      const full = resolve(rootResolved, rel);
      if (statSync(full).isFile()) {
        snapshot[rel] = readFileSync(full, 'utf8');
      }
    }
    writeFileSync(join(snapshotsDir, `${txId}.json`), JSON.stringify({ txId, createdAt: now(), files: snapshot }, null, 2), 'utf8');
    return snapshot;
  }

  function restoreSnapshot(snapshotFiles) {
    ensureDirs();
    const currentFiles = listWorkspaceFilesRecursive(rootResolved);
    for (const rel of currentFiles) {
      if (!Object.hasOwn(snapshotFiles, rel)) {
        rmSync(resolve(rootResolved, rel), { force: true });
      }
    }
    for (const [rel, content] of Object.entries(snapshotFiles)) {
      const full = resolve(rootResolved, rel);
      mkdirSync(resolve(full, '..'), { recursive: true });
      writeFileSync(full, content, 'utf8');
    }
  }

  function applyMutation({ description = 'meta-mutation', files = [] } = {}) {
    if (!Array.isArray(files) || files.length === 0) {
      throw new Error('files deve ser um array não vazio de { path, content }.');
    }

    // 1. Valida TODOS os caminhos e conteúdos antes de tocar no disco
    const validated = [];
    for (const item of files) {
      const { relPath, target } = safeTarget(item?.path);
      const rawContent = typeof item.content === 'string'
        ? item.content
        : JSON.stringify(item.content, null, 2);
      const check = validateWorkspaceFileContent(relPath, rawContent);
      if (!check.ok) {
        const err = new Error(`Validação declarativa falhou (${relPath}): ${check.errors.join('; ')}`);
        err.code = 'E_INVALID_DECLARATIVE_SPEC';
        throw err;
      }
      validated.push({ relPath, target, content: rawContent });
    }

    // 2. Snapshot pré-mutação
    const txId = `tx-${randomUUID().slice(0, 12)}`;
    const snapshot = captureSnapshot(txId);

    // 3. Aplica mutação no Ring 2
    for (const item of validated) {
      mkdirSync(resolve(item.target, '..'), { recursive: true });
      writeFileSync(item.target, item.content, 'utf8');
    }

    const startedAt = now();
    const record = {
      id: txId,
      description: String(description || ''),
      status: 'canary',
      startedAt,
      canaryUntil: startedAt + canaryWindowMs,
      appliedPaths: validated.map(v => v.relPath),
      snapshot,
      rollbackReason: null,
    };
    transactions.set(txId, record);
    return {
      ok: true,
      txId,
      status: record.status,
      canaryUntil: record.canaryUntil,
      appliedPaths: record.appliedPaths,
    };
  }

  function rollback(txId, reason = 'manual_rollback') {
    const record = transactions.get(txId);
    if (!record) {
      throw new Error(`Transação desconhecida: ${txId}`);
    }
    if (record.status === 'rolled_back') {
      return { ok: true, txId, status: 'rolled_back', reason: record.rollbackReason };
    }
    restoreSnapshot(record.snapshot);
    record.status = 'rolled_back';
    record.rollbackReason = String(reason);
    record.rolledBackAt = now();
    return { ok: true, txId, status: record.status, reason: record.rollbackReason };
  }

  function reportCanaryHealth(txId, { ok = true, error = null } = {}) {
    const record = transactions.get(txId);
    if (!record) throw new Error(`Transação desconhecida: ${txId}`);
    if (record.status !== 'canary') {
      return { ok: record.status === 'committed', txId, status: record.status };
    }
    if (!ok) {
      return rollback(txId, error || 'canary_health_failed');
    }
    if (now() >= record.canaryUntil) {
      record.status = 'committed';
      record.committedAt = now();
    }
    return { ok: true, txId, status: record.status };
  }

  function listFiles() {
    ensureDirs();
    return listWorkspaceFilesRecursive(rootResolved);
  }

  function getTransaction(txId) {
    const rec = transactions.get(txId);
    if (!rec) return null;
    const { snapshot: _omit, ...summary } = rec;
    return summary;
  }

  return {
    workspaceRoot: rootResolved,
    applyMutation,
    rollback,
    reportCanaryHealth,
    listFiles,
    getTransaction,
  };
}

export function createMetaAgentTools({ manager } = {}) {
  if (!manager) throw new Error('createMetaAgentTools: manager é obrigatório.');

  const listTool = {
    schema: AGENT_SCHEMAS.tool,
    name: 'meta.workspace.list',
    version: '1.0.0',
    description: 'Lista os arquivos declarativos do Ring 2 (User Workspace).',
    origin: 'runtime',
    permissionLevel: 1,
    timeoutMs: 2000,
    parameters: [],
    verify: r => isPlainObject(r) && r.ok === true && Array.isArray(r.files),
    execute() {
      return { ok: true, files: manager.listFiles() };
    },
  };

  const applyTool = {
    schema: AGENT_SCHEMAS.tool,
    name: 'meta.workspace.apply',
    version: '1.0.0',
    description: 'Aplica mutação declarativa validada em Ring 2 com snapshot e canary 60s (nunca toca Ring 0).',
    origin: 'runtime',
    permissionLevel: 3,
    timeoutMs: 5000,
    parameters: [
      { name: 'description', type: 'string', required: false, description: 'Resumo da mudança.' },
      { name: 'files', type: 'array', required: true, description: 'Lista de { path, content } em Ring 2.' },
    ],
    verify: r => isPlainObject(r) && r.ok === true && typeof r.txId === 'string',
    execute(args = {}) {
      return manager.applyMutation({ description: args.description, files: args.files });
    },
  };

  const rollbackTool = {
    schema: AGENT_SCHEMAS.tool,
    name: 'meta.workspace.rollback',
    version: '1.0.0',
    description: 'Reverte imediatamente uma transação do workspace para o snapshot pré-mutação.',
    origin: 'runtime',
    permissionLevel: 3,
    timeoutMs: 5000,
    parameters: [
      { name: 'txId', type: 'string', required: true, description: 'ID da transação.' },
      { name: 'reason', type: 'string', required: false, description: 'Motivo do rollback.' },
    ],
    verify: r => isPlainObject(r) && r.ok === true && r.status === 'rolled_back',
    execute(args = {}) {
      return manager.rollback(args.txId, args.reason || 'requested_rollback');
    },
  };

  return [listTool, applyTool, rollbackTool];
}
