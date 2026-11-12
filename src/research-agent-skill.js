/**
 * Skill operacional Research Agent (Firecrawl + TinyFish + Vault local).
 *
 * Publica `skills/research-agent` em `dataDir/skills` quando ausente e
 * registra ferramentas nível 3:
 *  - `research.search`: pesquisa web via TinyFish Search (`api.search.tinyfish.ai`)
 *    e/ou Firecrawl Search (`api.firecrawl.dev/v1/search`), com opção de incluir
 *    notas locais do vault;
 *  - `research.fetch`: extrai páginas públicas em Markdown via TinyFish Fetch
 *    (`api.fetch.tinyfish.ai`) ou Firecrawl Scrape (`api.firecrawl.dev/v1/scrape`).
 */
import { AGENT_SCHEMAS } from './agent-contracts.js';
import { readEnvValue } from './api-security.js';
import { publishSkillPackage } from './skill-package.js';
import {
  RESEARCH_FETCH_PROVIDERS,
  RESEARCH_SCHEMA,
  RESEARCH_SEARCH_PROVIDERS,
  mergeSearchResults,
  normalizeFetchedPages,
  normalizeFirecrawlSearch,
  normalizeTinyFishSearch,
  validatePublicUrl,
} from '../skills/research-agent/research-core.mjs';

export const RESEARCH_AGENT_SKILL_ID = 'research-agent';
export const RESEARCH_AGENT_TOOLS = Object.freeze(['research.search', 'research.fetch']);

const TINYFISH_SEARCH_URL = 'https://api.search.tinyfish.ai';
const TINYFISH_FETCH_URL = 'https://api.fetch.tinyfish.ai';
const FIRECRAWL_SEARCH_URL = 'https://api.firecrawl.dev/v1/search';
const FIRECRAWL_SCRAPE_URL = 'https://api.firecrawl.dev/v1/scrape';

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export function publishResearchAgentSkill({ dataDir, bundledDir } = {}) {
  return publishSkillPackage({ skillId: RESEARCH_AGENT_SKILL_ID, dataDir, bundledDir });
}

export function createResearchClient({
  envProvider = name => readEnvValue(name),
  fetchImpl = (...args) => fetch(...args),
} = {}) {
  const keys = () => ({
    tinyfish: String(envProvider('TINYFISH_API_KEY') || envProvider('TINIFISH_API_KEY') || '').trim(),
    firecrawl: String(envProvider('FIRECRAWL_API_KEY') || envProvider('FIRECLAW_API_KEY') || '').trim(),
  });

  async function runTinyFishSearch(query, { limit = 5, location = null } = {}) {
    const apiKey = keys().tinyfish;
    if (!apiKey) throw new Error('TINYFISH_API_KEY não configurada.');
    const params = new URLSearchParams({ query, num_results: String(limit) });
    if (location) params.set('location', String(location).trim().slice(0, 4).toUpperCase());
    const res = await fetchImpl(`${TINYFISH_SEARCH_URL}?${params.toString()}`, {
      method: 'GET',
      headers: { 'X-API-Key': apiKey },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`TinyFish Search erro (HTTP ${res.status}).`);
    return normalizeTinyFishSearch(data);
  }

  async function runFirecrawlSearch(query, { limit = 5, scrape = false } = {}) {
    const apiKey = keys().firecrawl;
    if (!apiKey) throw new Error('FIRECRAWL_API_KEY não configurada.');
    const res = await fetchImpl(FIRECRAWL_SEARCH_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        query,
        limit,
        ...(scrape ? { scrapeOptions: { formats: ['markdown'] } } : {}),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Firecrawl Search erro (HTTP ${res.status}).`);
    return normalizeFirecrawlSearch(data);
  }

  async function runTinyFishFetch(urls) {
    const apiKey = keys().tinyfish;
    if (!apiKey) throw new Error('TINYFISH_API_KEY não configurada.');
    const res = await fetchImpl(TINYFISH_FETCH_URL, {
      method: 'POST',
      headers: {
        'X-API-Key': apiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ urls, format: 'markdown', links: false }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`TinyFish Fetch erro (HTTP ${res.status}).`);
    return normalizeFetchedPages(data, 'tinyfish');
  }

  async function runFirecrawlFetch(urls) {
    const apiKey = keys().firecrawl;
    if (!apiKey) throw new Error('FIRECRAWL_API_KEY não configurada.');
    const pages = [];
    for (const url of urls) {
      const res = await fetchImpl(FIRECRAWL_SCRAPE_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ url, formats: ['markdown'] }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`Firecrawl Scrape erro (HTTP ${res.status}).`);
      pages.push(...normalizeFetchedPages(data, 'firecrawl'));
    }
    return pages;
  }

  return {
    async search({ query, provider = 'auto', limit = 5, location = null, scrape = false } = {}) {
      const cleanQuery = String(query ?? '').trim();
      if (cleanQuery.length < 2 || cleanQuery.length > 300) {
        throw new Error('query deve ter entre 2 e 300 caracteres.');
      }
      const safeLimit = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 15) : 5;
      const { tinyfish, firecrawl } = keys();

      if (provider === 'tinyfish') {
        const results = await runTinyFishSearch(cleanQuery, { limit: safeLimit, location });
        return { providersUsed: ['tinyfish'], results: results.slice(0, safeLimit) };
      }
      if (provider === 'firecrawl') {
        const results = await runFirecrawlSearch(cleanQuery, { limit: safeLimit, scrape });
        return { providersUsed: ['firecrawl'], results: results.slice(0, safeLimit) };
      }
      if (provider === 'both') {
        if (!tinyfish && !firecrawl) {
          throw new Error('Pesquisa web não configurada: defina TINYFISH_API_KEY e/ou FIRECRAWL_API_KEY.');
        }
        const tasks = [];
        const names = [];
        if (tinyfish) {
          names.push('tinyfish');
          tasks.push(runTinyFishSearch(cleanQuery, { limit: safeLimit, location }));
        }
        if (firecrawl) {
          names.push('firecrawl');
          tasks.push(runFirecrawlSearch(cleanQuery, { limit: safeLimit, scrape }));
        }
        const settled = await Promise.allSettled(tasks);
        const lists = [];
        const providersUsed = [];
        const errors = [];
        settled.forEach((entry, idx) => {
          if (entry.status === 'fulfilled') {
            lists.push(entry.value);
            providersUsed.push(names[idx]);
          } else {
            errors.push(`${names[idx]}: ${entry.reason?.message || entry.reason}`);
          }
        });
        if (lists.length === 0) throw new Error(errors.join('; '));
        return {
          providersUsed,
          results: mergeSearchResults(lists, safeLimit),
          ...(errors.length ? { partialErrors: errors } : {}),
        };
      }

      // provider === 'auto': prefere TinyFish pela latência e cai para Firecrawl.
      const order = [];
      if (tinyfish) order.push(['tinyfish', () => runTinyFishSearch(cleanQuery, { limit: safeLimit, location })]);
      if (firecrawl) order.push(['firecrawl', () => runFirecrawlSearch(cleanQuery, { limit: safeLimit, scrape })]);
      if (order.length === 0) {
        throw new Error('Pesquisa web não configurada: defina TINYFISH_API_KEY ou FIRECRAWL_API_KEY.');
      }

      const errors = [];
      for (const [name, fn] of order) {
        try {
          const results = await fn();
          return { providersUsed: [name], results: results.slice(0, safeLimit) };
        } catch (error) {
          errors.push(`${name}: ${error?.message || error}`);
        }
      }
      throw new Error(errors.join('; '));
    },

    async fetchPages({ urls, provider = 'auto' } = {}) {
      const safeUrls = (Array.isArray(urls) ? urls : [urls])
        .filter(Boolean)
        .slice(0, 5)
        .map(validatePublicUrl);
      if (safeUrls.length === 0) throw new Error('Informe ao menos uma URL pública válida.');

      const { tinyfish, firecrawl } = keys();
      if (provider === 'tinyfish') {
        return { providerUsed: 'tinyfish', pages: await runTinyFishFetch(safeUrls) };
      }
      if (provider === 'firecrawl') {
        return { providerUsed: 'firecrawl', pages: await runFirecrawlFetch(safeUrls) };
      }

      const order = [];
      if (tinyfish) order.push(['tinyfish', () => runTinyFishFetch(safeUrls)]);
      if (firecrawl) order.push(['firecrawl', () => runFirecrawlFetch(safeUrls)]);
      if (order.length === 0) {
        throw new Error('Extração web não configurada: defina TINYFISH_API_KEY ou FIRECRAWL_API_KEY.');
      }
      const errors = [];
      for (const [name, fn] of order) {
        try {
          const pages = await fn();
          return { providerUsed: name, pages };
        } catch (error) {
          errors.push(`${name}: ${error?.message || error}`);
        }
      }
      throw new Error(errors.join('; '));
    },
  };
}

export function createResearchAgentTools({
  researchClient = createResearchClient(),
  vaultSearch = null,
} = {}) {
  const searchTool = {
    schema: AGENT_SCHEMAS.tool,
    name: 'research.search',
    version: '1.0.0',
    description: 'Pesquisa na web via TinyFish e/ou Firecrawl (com fusão e deduplicação) e opcionalmente no vault local.',
    origin: 'skill',
    permissionLevel: 3,
    timeoutMs: 20000,
    parameters: [
      { name: 'query', type: 'string', required: true, description: 'Pergunta ou termos da busca.' },
      { name: 'provider', type: 'string', required: false, enum: [...RESEARCH_SEARCH_PROVIDERS], description: 'auto, tinyfish, firecrawl ou both.' },
      { name: 'limit', type: 'number', required: false, description: 'Máximo de resultados (1 a 15, padrão 5).' },
      { name: 'location', type: 'string', required: false, description: 'Código de país ISO-2 opcional para TinyFish (ex.: BR, US).' },
      { name: 'scrape', type: 'boolean', required: false, description: 'No Firecrawl, inclui markdown resumido nos resultados.' },
      { name: 'includeLocalVault', type: 'boolean', required: false, description: 'Também consulta notas locais do vault.' },
    ],
    verify(result) {
      return isPlainObject(result)
        && result.ok === true
        && result.schema === RESEARCH_SCHEMA
        && Array.isArray(result.providersUsed)
        && Array.isArray(result.results);
    },
    async execute(args = {}) {
      const web = await researchClient.search({
        query: args.query,
        provider: args.provider || 'auto',
        limit: args.limit ?? 5,
        location: args.location ?? null,
        scrape: args.scrape === true,
      });

      let localNotes = [];
      if (args.includeLocalVault === true && typeof vaultSearch === 'function') {
        try {
          const found = await vaultSearch(args.query);
          if (Array.isArray(found)) localNotes = found.slice(0, 3);
        } catch {
          localNotes = [];
        }
      }

      return {
        ok: true,
        schema: RESEARCH_SCHEMA,
        mode: 'search',
        query: String(args.query).trim(),
        providersUsed: web.providersUsed,
        count: web.results.length,
        results: web.results,
        ...(web.partialErrors ? { partialErrors: web.partialErrors } : {}),
        ...(args.includeLocalVault === true ? { localNotes } : {}),
      };
    },
  };

  const fetchTool = {
    schema: AGENT_SCHEMAS.tool,
    name: 'research.fetch',
    version: '1.0.0',
    description: 'Extrai o conteúdo em Markdown de URLs públicas via TinyFish Fetch ou Firecrawl Scrape.',
    origin: 'skill',
    permissionLevel: 3,
    timeoutMs: 30000,
    parameters: [
      { name: 'url', type: 'string', required: false, description: 'URL pública única para extrair.' },
      { name: 'urls', type: 'array', required: false, description: 'Lista de até 5 URLs públicas.' },
      { name: 'provider', type: 'string', required: false, enum: [...RESEARCH_FETCH_PROVIDERS], description: 'auto, tinyfish ou firecrawl.' },
    ],
    verify(result) {
      return isPlainObject(result)
        && result.ok === true
        && result.schema === RESEARCH_SCHEMA
        && result.mode === 'fetch'
        && Array.isArray(result.pages)
        && result.pages.length > 0;
    },
    async execute(args = {}) {
      const targetUrls = Array.isArray(args.urls) && args.urls.length > 0
        ? args.urls
        : (args.url ? [args.url] : []);
      const fetched = await researchClient.fetchPages({
        urls: targetUrls,
        provider: args.provider || 'auto',
      });
      return {
        ok: true,
        schema: RESEARCH_SCHEMA,
        mode: 'fetch',
        providerUsed: fetched.providerUsed,
        count: fetched.pages.length,
        pages: fetched.pages,
      };
    },
  };

  return [searchTool, fetchTool];
}

