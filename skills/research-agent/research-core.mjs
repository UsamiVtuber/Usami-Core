export const RESEARCH_SCHEMA = 'usami.research.v1';
export const RESEARCH_SEARCH_PROVIDERS = Object.freeze(['auto', 'tinyfish', 'firecrawl', 'both']);
export const RESEARCH_FETCH_PROVIDERS = Object.freeze(['auto', 'tinyfish', 'firecrawl']);

const collapse = value => String(value ?? '').trim().replace(/\s+/g, ' ');

const PRIVATE_HOST_RE = /^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[?::1\]?|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|169\.254(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|.*\.local)$/i;

export function validatePublicUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl ?? '').trim());
  } catch {
    throw new Error(`URL inválida: ${String(rawUrl ?? '').slice(0, 80)}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('URL deve usar protocolo http ou https.');
  }
  if (!parsed.hostname || PRIVATE_HOST_RE.test(parsed.hostname)) {
    throw new Error(`URL privada ou loopback bloqueada: ${parsed.hostname || '(vazio)'}`);
  }
  return parsed.href;
}

export function normalizeTinyFishSearch(payload) {
  const rawItems = Array.isArray(payload?.results)
    ? payload.results
    : (Array.isArray(payload?.data) ? payload.data : (Array.isArray(payload) ? payload : []));
  return rawItems
    .filter(item => item && typeof item === 'object' && typeof (item.url || item.link) === 'string')
    .map(item => ({
      url: String(item.url || item.link).trim(),
      title: collapse(item.title || item.name || item.url),
      snippet: collapse(item.snippet || item.description || item.content || '').slice(0, 400),
      providers: ['tinyfish'],
    }));
}

export function normalizeFirecrawlSearch(payload) {
  const rawItems = Array.isArray(payload?.data)
    ? payload.data
    : (Array.isArray(payload?.results) ? payload.results : []);
  return rawItems
    .filter(item => item && typeof item === 'object' && typeof item.url === 'string')
    .map(item => ({
      url: String(item.url).trim(),
      title: collapse(item.title || item.metadata?.title || item.url),
      snippet: collapse(item.description || item.markdown || '').slice(0, 400),
      ...(typeof item.markdown === 'string' && item.markdown.trim()
        ? { markdown: item.markdown.trim().slice(0, 4000) }
        : {}),
      providers: ['firecrawl'],
    }));
}

export function mergeSearchResults(lists, limit = 10) {
  const byUrl = new Map();
  for (const list of lists) {
    for (const item of Array.isArray(list) ? list : []) {
      if (!item?.url) continue;
      const key = item.url.replace(/\/+$/, '').toLowerCase();
      const existing = byUrl.get(key);
      if (!existing) {
        byUrl.set(key, { ...item, providers: [...new Set(item.providers || [])] });
        continue;
      }
      existing.providers = [...new Set([...existing.providers, ...(item.providers || [])])];
      if ((!existing.snippet || item.snippet.length > existing.snippet.length) && item.snippet) {
        existing.snippet = item.snippet;
      }
      if (!existing.markdown && item.markdown) existing.markdown = item.markdown;
    }
  }
  return [...byUrl.values()].slice(0, Math.max(1, limit));
}

export function normalizeFetchedPages(payload, provider) {
  if (provider === 'tinyfish') {
    const list = Array.isArray(payload?.results)
      ? payload.results
      : (Array.isArray(payload?.pages) ? payload.pages : []);
    return list
      .filter(p => p && typeof p === 'object')
      .map(p => ({
        url: String(p.url || ''),
        title: collapse(p.title || p.url || ''),
        markdown: String(p.text || p.markdown || p.content || '').trim().slice(0, 12000),
        provider: 'tinyfish',
      }));
  }

  const data = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
  if (!data || typeof data !== 'object') return [];
  const markdown = String(data.markdown || data.content || '').trim().slice(0, 12000);
  return [{
    url: String(data.metadata?.sourceURL || data.url || ''),
    title: collapse(data.metadata?.title || data.title || ''),
    markdown,
    provider: 'firecrawl',
  }];
}

