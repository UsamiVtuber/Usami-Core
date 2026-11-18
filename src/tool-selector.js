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
  ['memoria', 'lembrar', 'historico', 'rag', 'vault', 'obsidian'],
  ['musica', 'spotify', 'tocar', 'playlist', 'faixa', 'som'],
  ['workspace', 'fluxo', 'flow', 'meta', 'automacao', 'rota'],
  ['timer', 'temporizador', 'pomodoro', 'lembrete', 'lembretes', 'lembrar', 'aviso', 'avisar', 'alarme', 'foco', 'pausa', 'descanso', 'cronometro'],
]);

const STOP_WORDS = new Set([
  'a', 'o', 'e', 'de', 'da', 'do', 'em', 'um', 'uma', 'para', 'com', 'por', 'que', 'qual',
  'como', 'esta', 'estao', 'sao', 'tem', 'tenho', 'ter', 'ser', 'estar', 'fazer', 'ir', 'vir',
  'the', 'and', 'or', 'to', 'a', 'an', 'in', 'on', 'at', 'for', 'with', 'by', 'from', 'of',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did',
]);

function tokenize(text) {
  const normalized = String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9_.-]+/g, ' ')
    .trim();
  if (!normalized) return [];
  const raw = normalized.split(/\s+/).filter(w => w.length >= 2 && !STOP_WORDS.has(w));
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
 * Cache simples para tokens de ferramentas - evita re-tokenização repetida.
 * Chave: `${tool.name}:${tool.version}:${tool.description.length}:${(tool.tags||[]).join(',')}`
 */
const toolTokenCache = new Map();

function getToolTokens(tool) {
  const cacheKey = `${tool?.name}:${tool?.version || ''}:${tool?.description?.length || 0}:${(tool?.tags || []).join(',')}`;
  let tokens = toolTokenCache.get(cacheKey);
  if (!tokens) {
    const toolText = [
      tool?.name,
      tool?.description,
      ...(Array.isArray(tool?.tags) ? tool.tags : []),
    ].join(' ');
    tokens = tokenize(toolText);
    toolTokenCache.set(cacheKey, tokens);
    // Limita tamanho do cache para evitar vazamento de memória
    if (toolTokenCache.size > 1000) {
      const firstKey = toolTokenCache.keys().next().value;
      toolTokenCache.delete(firstKey);
    }
  }
  return tokens;
}

/**
 * Calcula TF-IDF-like score para melhor ranking semântico.
 * - TF: frequência do termo na ferramenta (normalizada)
 * - IDF: inverso da frequência do termo no corpus (aproximado via document frequency)
 */
function calculateTfIdfScore(queryTokens, toolTokens, toolDocFreq) {
  let score = 0;
  for (const tok of queryTokens) {
    if (toolTokens.has(tok)) {
      // TF: frequência normalizada (1 se presente)
      const tf = 1;
      // IDF: log(N / df) onde N é total de ferramentas e df é doc frequency
      const df = toolDocFreq.get(tok) || 1;
      const idf = Math.log((toolDocFreq.size + 1) / df);
      score += tf * idf;
    }
  }
  return score;
}

/**
 * Ranqueia e seleciona as Top-K ferramentas mais relevantes para a query do usuário.
 * Ferramentas marcadas com `alwaysInclude: true` (ex.: `self.describe`) são preservadas.
 * 
 * Melhorias:
 * - Cache de tokens para evitar re-tokenização
 * - Scoring TF-IDF-like para melhor discriminação
 * - Suporte a pesos configuráveis por campo (name, description, tags)
 * - Filtro de stop words
 */
export function selectTopKTools(query, tools = [], { 
  k = 6, 
  minScore = 0.05,
  weights = { name: 2.0, description: 1.0, tags: 1.5 },
  usageStats = null, // { toolName: { count, lastUsed } } para feedback loop
} = {}) {
  if (!Array.isArray(tools) || tools.length === 0) return [];
  const queryTokens = new Set(tokenize(query));
  const limit = Math.max(1, Number.isInteger(k) ? k : 6);

  // Calcula document frequency para IDF
  const toolDocFreq = new Map();
  for (const tool of tools) {
    const tokens = getToolTokens(tool);
    for (const tok of tokens) {
      toolDocFreq.set(tok, (toolDocFreq.get(tok) || 0) + 1);
    }
  }

  const scored = tools.map(tool => {
    const toolTokens = new Set(getToolTokens(tool));
    
    // Score TF-IDF-like
    let score = calculateTfIdfScore(queryTokens, toolTokens, toolDocFreq);
    
    // Boost por campo (name > tags > description)
    const nameTokens = new Set(tokenize(tool?.name || ''));
    const tagTokens = new Set((tool?.tags || []).flatMap(t => tokenize(t)));
    const descTokens = new Set(tokenize(tool?.description || ''));
    
    for (const tok of queryTokens) {
      if (nameTokens.has(tok)) score += weights.name || 0;
      if (tagTokens.has(tok)) score += weights.tags || 0;
      if (descTokens.has(tok)) score += weights.description || 0;
    }
    
    // Boost por uso recente (feedback loop)
    if (usageStats && tool?.name && usageStats[tool.name]) {
      const stats = usageStats[tool.name];
      const recencyBoost = stats.lastUsed ? Math.max(0, 1 - (Date.now() - stats.lastUsed) / (7 * 24 * 60 * 60 * 1000)) : 0;
      const frequencyBoost = Math.min(stats.count / 10, 1);
      score += (recencyBoost * 0.5) + (frequencyBoost * 0.3);
    }
    
    // Normalização suave
    const denom = Math.max(1, Math.sqrt(Math.max(1, toolTokens.size) * Math.max(1, queryTokens.size)));
    score = tool?.alwaysInclude ? 1.0 : score / denom;
    
    return { tool, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored
    .filter(item => item.tool?.alwaysInclude || item.score >= minScore)
    .slice(0, limit)
    .map(item => ({ ...item.tool, _relevanceScore: Number(item.score.toFixed(4)) }));
}

/**
 * Limpa o cache de tokens (útil para testes ou quando ferramentas são atualizadas).
 */
export function clearToolTokenCache() {
  toolTokenCache.clear();
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
