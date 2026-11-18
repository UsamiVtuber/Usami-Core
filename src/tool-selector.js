/**
 * Seletor Semântico de Tools (Top-K) & Registro de Conectores Plug-and-Play (Fase 3 — RFC-001).
 *
 * Evita explosão de contexto no prompt do LLM quando dezenas de conectores
 * estão instalados, selecionando apenas os Top-K mais relevantes para o turno.
 */

export const CONNECTOR_SCHEMA = 'usami.connector.v1';

const SYNONYM_GROUPS = Object.freeze([
  ['email', 'emails', 'e-mail', 'gmail', 'inbox', 'correio', 'mensagem', 'rascunho'],
  ['agenda', 'calendario', 'calendar', 'evento', 'eventos', 'reuniao', 'horario'],
  ['codigo', 'code', 'arquivo', 'src', 'git', 'github', 'commit', 'diff', 'branch', 'pr', 'issue', 'agent', 'agente', 'proposta', 'propose', 'antigravity'],
  ['financas', 'finance', 'banco', 'saldo', 'extrato', 'pluggy', 'belvo', 'gasto', 'conta'],
  ['pesquisa', 'web', 'internet', 'buscar', 'procurar', 'noticias', 'site', 'tinyfish', 'firecrawl'],
  ['memoria', 'lembrar', 'lembra', 'lembrei', 'lembrava', 'comentei', 'falamos', 'conversamos', 'historico', 'rag', 'vault', 'obsidian'],
  ['musica', 'spotify', 'tocar', 'playlist', 'faixa', 'som'],
  ['workspace', 'fluxo', 'flow', 'meta', 'automacao', 'rota'],
  ['timer', 'temporizador', 'pomodoro', 'lembrete', 'lembretes', 'lembrar', 'aviso', 'avisar', 'alarme', 'foco', 'pausa', 'descanso', 'cronometro'],
]);

function tokenize(text) {
  const normalized = String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9_.-]+/g, ' ')
    .trim();
  if (!normalized) return [];
  const raw = normalized.split(/\s+/).filter(w => w.length >= 2);
  const expanded = new Set(raw);
  for (const token of raw) {
    for (const group of SYNONYM_GROUPS) {
      if (group.includes(token)) {
        for (const syn of group) expanded.add(syn);
      }
    }
  }
  return [...expanded];
}

/**
 * Ranqueia e seleciona as Top-K ferramentas mais relevantes para a query do usuário.
 * Ferramentas marcadas com `alwaysInclude: true` (ex.: `self.describe`) são preservadas.
 */
export function selectTopKTools(query, tools = [], { k = 6, minScore = 0.05 } = {}) {
  if (!Array.isArray(tools) || tools.length === 0) return [];
  const queryTokens = new Set(tokenize(query));
  const limit = Math.max(1, Number.isInteger(k) ? k : 6);

  const scored = tools.map(tool => {
    const toolText = [
      tool?.name,
      tool?.description,
      ...(Array.isArray(tool?.tags) ? tool.tags : []),
    ].join(' ');
    const toolTokens = tokenize(toolText);
    let matches = 0;
    for (const tok of toolTokens) {
      if (queryTokens.has(tok)) matches += 1;
    }
    const denom = Math.max(1, Math.sqrt(Math.max(1, toolTokens.length) * Math.max(1, queryTokens.size)));
    const score = tool?.alwaysInclude ? 1.0 : matches / denom;
    return { tool, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored
    .filter(item => item.tool?.alwaysInclude || item.score >= minScore)
    .slice(0, limit)
    .map(item => ({ ...item.tool, _relevanceScore: Number(item.score.toFixed(4)) }));
}

/**
 * Registro declarativo de Conectores Plug-and-Play (`usami.connector.v1`).
 */
export function createConnectorRegistry(initialConnectors = []) {
  const connectors = new Map();

  function register(manifest) {
    if (!manifest || typeof manifest !== 'object') {
      throw new Error('Manifesto de conector inválido.');
    }
    if (manifest.schema && manifest.schema !== CONNECTOR_SCHEMA) {
      throw new Error(`schema inválido: esperado ${CONNECTOR_SCHEMA}`);
    }
    const id = String(manifest.id || '').trim();
    if (!id) throw new Error('id do conector é obrigatório.');
    connectors.set(id, {
      schema: CONNECTOR_SCHEMA,
      id,
      name: String(manifest.name || id),
      enabled: manifest.enabled !== false,
      connected: Boolean(manifest.connected),
      scopes: Array.isArray(manifest.scopes) ? [...manifest.scopes] : [],
      tools: Array.isArray(manifest.tools) ? [...manifest.tools] : [],
      oauth: manifest.oauth && typeof manifest.oauth === 'object' ? { ...manifest.oauth } : null,
    });
    return connectors.get(id);
  }

  for (const c of initialConnectors) register(c);

  function setEnabled(id, enabled) {
    const entry = connectors.get(id);
    if (!entry) throw new Error(`Conector desconhecido: ${id}`);
    entry.enabled = Boolean(enabled);
    return { ...entry };
  }

  function setConnected(id, connected) {
    const entry = connectors.get(id);
    if (!entry) throw new Error(`Conector desconhecido: ${id}`);
    entry.connected = Boolean(connected);
    return { ...entry };
  }

  function list() {
    return [...connectors.values()].map(c => ({ ...c }));
  }

  function activeTools() {
    const out = [];
    for (const c of connectors.values()) {
      if (c.enabled && c.connected) {
        out.push(...c.tools);
      }
    }
    return out;
  }

  return { register, setEnabled, setConnected, list, activeTools };
}
