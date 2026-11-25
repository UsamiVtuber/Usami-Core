/**
 * Primeira ferramenta somente-leitura do domínio agêntico: `memory.search`.
 *
 * Reaproveita o `memory-store` (fatos por seção, recentes e resumos) em vez de
 * criar outro índice. A busca ignora caixa e acento e casa todos os termos.
 * Com um `episodicStore` disponível, completa o resultado com turnos antigos
 * recuperados por similaridade semântica.
 * O vault fica de fora: é conteúdo privado e só entra em ferramenta própria
 * com autorização explícita.
 */
import { AGENT_SCHEMAS } from './agent-contracts.js';

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;

const normalize = value => String(value ?? '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase();

export function createMemorySearchTool({
  memoryStore,
  episodicStore = null,
  defaultLimit = DEFAULT_LIMIT,
  maxLimit = MAX_LIMIT,
} = {}) {
  if (!memoryStore || typeof memoryStore.getSections !== 'function') {
    throw new Error('createMemorySearchTool: memoryStore é obrigatório.');
  }

  const candidates = () => {
    const items = [];
    const sections = memoryStore.getSections();
    for (const [section, facts] of Object.entries(sections)) {
      for (const text of facts) items.push({ source: 'section', section, text });
    }
    for (const text of memoryStore.getRecentFacts()) items.push({ source: 'recent', text });
    for (const item of memoryStore.getSummaries()) items.push({ source: 'summary', date: item.date, text: item.summary });
    return items;
  };

  return {
    schema: AGENT_SCHEMAS.tool,
    name: 'memory.search',
    version: '1.0.0',
    description: 'Busca fatos, lembretes recentes, resumos e o histórico de conversas para lembrar o que já foi dito, sem alterar nada.',
    origin: 'runtime',
    permissionLevel: 1,
    timeoutMs: 3000,
    parameters: [
      { name: 'query', type: 'string', required: true, description: 'Texto procurado (ignora caixa e acento).' },
      { name: 'limit', type: 'number', required: false, description: `Máximo de resultados (1 a ${maxLimit}; padrão ${defaultLimit}).` },
    ],
    verify(result) {
      return Boolean(result)
        && typeof result.query === 'string'
        && Array.isArray(result.results)
        && result.count === result.results.length
        && result.results.every(item => item && typeof item.text === 'string' && item.text.length > 0);
    },
    async execute(args) {
      const query = String(args.query).trim();
      if (!query) throw new Error('query: informe ao menos um termo');

      const limit = args.limit === undefined ? defaultLimit : args.limit;
      if (!Number.isInteger(limit) || limit < 1 || limit > maxLimit) {
        throw new Error(`limit: inteiro entre 1 e ${maxLimit}`);
      }

      const terms = normalize(query).split(/\s+/).filter(Boolean);
      const results = candidates()
        .filter(item => {
          const haystack = normalize(item.text);
          return terms.every(term => haystack.includes(term));
        })
        .slice(0, limit);

      // Complemento semântico: turnos antigos que a busca lexical não alcança.
      if (episodicStore && results.length < limit) {
        try {
          const episodes = await episodicStore.search({ query, limit: limit - results.length });
          for (const episode of episodes) {
            if (results.length >= limit) break;
            results.push({
              source: 'episode',
              date: (episode.isoDate || '').slice(0, 10),
              text: episode.text,
              score: episode.score,
            });
          }
        } catch {
          // memória episódica é opcional: segue com o resultado lexical
        }
      }

      return { query, results, count: results.length };
    },
  };
}
