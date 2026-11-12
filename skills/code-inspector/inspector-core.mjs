import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

export const CODE_INSPECT_SCHEMA = 'usami.code.inspect.v1';
export const CODE_SEARCH_SCOPES = Object.freeze(['all', 'src', 'skills', 'docs', 'desktop']);
const MAX_FILE_BYTES = 256 * 1024;
const MAX_WINDOW_LINES = 120;
const DEFAULT_SEARCH_LIMIT = 15;
const MAX_SEARCH_LIMIT = 30;

const ALLOWED_FILE_PATTERNS = Object.freeze([
  /^package\.json$/,
  /^server\.mjs$/,
  /^src\/[a-zA-Z0-9._-]+\.(?:js|mjs|jsx|ts)$/,
  /^docs\/[a-zA-Z0-9._-]+\.md$/,
  /^tests\/[a-zA-Z0-9._-]+\.test\.mjs$/,
  /^skills\/[a-z][a-z0-9-]{2,39}\/(?:test\/)?[a-zA-Z0-9._-]+\.(?:mjs|js|json)$/,
]);

const ALLOWED_DESKTOP_PATTERNS = Object.freeze([
  /^Cargo\.toml$/,
  /^README\.md$/,
  /^src\/(?:[a-zA-Z0-9._-]+\/)*[a-zA-Z0-9._-]+\.rs$/,
  /^docs\/[a-zA-Z0-9._-]+\.md$/,
]);

const FORBIDDEN_SEGMENT_RE = /(?:^|\/)(?:\.env(?:\..*)?|\.git|vault|data|tmp|dist|target|node_modules|secrets?|credentials?|keys?\.env)(?:\/|$)/i;

const SECRET_PATTERNS = Object.freeze([
  /\bsk-(?:or-)?[a-zA-Z0-9_-]{8,}\b/g,
  /\bnvapi-[a-zA-Z0-9_-]{8,}\b/gi,
  /\b(?:ghp|gho|ghu|ghs)_[a-zA-Z0-9]{10,}\b/g,
  /\bgithub_pat_[a-zA-Z0-9_]{12,}\b/g,
  /\bBearer\s+[a-zA-Z0-9._-]{8,}\b/gi,
  /\b(?:USAMI_API_TOKEN|OPENROUTER_API_KEY|NVIDIA_API_KEY|ELEVENLABS_API_KEY|GEMINI_API_KEY|PLANE_API_KEY|GITHUB_TOKEN|GH_TOKEN|API_KEY|SECRET|PASSWORD|ACCESS_TOKEN)\s*[:=]\s*\S+/gi,
]);

export function redactLine(text) {
  let out = String(text ?? '');
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[redigido]');
  return out;
}

export function normalizeRelPath(relPath) {
  const clean = String(relPath ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
  return clean.startsWith('usami-desktop/') ? `desktop/${clean.slice('usami-desktop/'.length)}` : clean;
}

export function isAllowlistedCodePath(relPath) {
  const norm = normalizeRelPath(relPath);
  if (!norm || norm.startsWith('/') || norm.includes('..') || FORBIDDEN_SEGMENT_RE.test(norm)) {
    return false;
  }
  if (norm.startsWith('desktop/')) {
    const inner = norm.slice('desktop/'.length);
    return ALLOWED_DESKTOP_PATTERNS.some(re => re.test(inner));
  }
  return ALLOWED_FILE_PATTERNS.some(re => re.test(norm));
}

function readSafeAllowlisted(rootDir, relPath, { desktopRoot = resolve(rootDir, '../usami-desktop') } = {}) {
  const norm = normalizeRelPath(relPath);
  if (!isAllowlistedCodePath(norm)) {
    throw new Error(`caminho fora da allowlist: ${norm || '(vazio)'}`);
  }
  const isDesktop = norm.startsWith('desktop/');
  const baseDir = isDesktop ? desktopRoot : rootDir;
  const innerPath = isDesktop ? norm.slice('desktop/'.length) : norm;

  const baseReal = realpathSync(resolve(baseDir));
  const target = resolve(baseReal, innerPath);
  const diff = relative(baseReal, target).replace(/\\/g, '/');
  if (!diff || diff.startsWith('..') || isAbsolute(diff) || FORBIDDEN_SEGMENT_RE.test(diff)) {
    throw new Error(`caminho inválido: ${norm}`);
  }
  const stat = lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`alvo inválido (symlink ou não-arquivo): ${norm}`);
  }
  if (realpathSync(target) !== target) {
    throw new Error(`symlink não permitido: ${norm}`);
  }
  if (stat.size > MAX_FILE_BYTES) {
    throw new Error(`arquivo excede limite de ${MAX_FILE_BYTES} bytes: ${norm}`);
  }
  return { norm, content: readFileSync(target, 'utf8') };
}

function extractExports(content) {
  const names = [];
  const jsRe = /^export\s+(?:async\s+)?(?:function|const|let|class)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/gm;
  const rsRe = /^\s*pub(?:\([^)]*\))?\s+(?:async\s+)?(?:fn|struct|enum|trait|mod|const)\s+([a-zA-Z_][a-zA-Z0-9_]*)/gm;
  for (const re of [jsRe, rsRe]) {
    let match;
    while ((match = re.exec(content)) !== null) {
      if (!names.includes(match[1])) names.push(match[1]);
      if (names.length >= 60) return names;
    }
  }
  return names;
}

export function inspectAllowlistedFile({
  rootDir,
  desktopRoot,
  path,
  startLine = 1,
  endLine = 80,
} = {}) {
  if (!rootDir || typeof rootDir !== 'string') throw new Error('rootDir é obrigatório.');
  const { norm, content } = readSafeAllowlisted(rootDir, path, { desktopRoot });
  const allLines = content.split(/\r?\n/);
  const totalLines = allLines.length;
  const start = Number.isInteger(startLine) && startLine >= 1 ? Math.min(startLine, totalLines) : 1;
  const requestedEnd = Number.isInteger(endLine) && endLine >= start ? endLine : start + 79;
  const end = Math.min(totalLines, start + MAX_WINDOW_LINES - 1, requestedEnd);

  const lines = [];
  for (let i = start; i <= end; i += 1) {
    lines.push({ line: i, text: redactLine(allLines[i - 1]) });
  }

  return {
    schema: CODE_INSPECT_SCHEMA,
    mode: 'inspect',
    path: norm,
    totalLines,
    exports: extractExports(content),
    snippet: { startLine: start, endLine: end, lines },
  };
}

function listFilesInScope(rootDir, scope, { desktopRoot = resolve(rootDir, '../usami-desktop') } = {}) {
  const collected = [];

  function walk(absDir, relPrefix) {
    let entries;
    try {
      const st = lstatSync(absDir);
      if (st.isSymbolicLink() || !st.isDirectory()) return;
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (FORBIDDEN_SEGMENT_RE.test(rel)) continue;
      const abs = join(absDir, entry.name);
      let st;
      try {
        st = lstatSync(abs);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        walk(abs, rel);
      } else if (st.isFile() && isAllowlistedCodePath(rel)) {
        collected.push(rel);
      }
    }
  }

  if (scope === 'desktop' || scope === 'all') {
    for (const sub of ['src', 'docs']) walk(join(desktopRoot, sub), `desktop/${sub}`);
  }
  if (scope !== 'desktop') {
    const roots = scope === 'all' ? ['src', 'skills', 'docs'] : [scope];
    for (const dir of roots) walk(join(rootDir, dir), dir);
  }
  return collected.sort();
}

export function searchAllowlistedCode({
  rootDir,
  desktopRoot,
  query,
  scope = 'src',
  limit = DEFAULT_SEARCH_LIMIT,
} = {}) {
  if (!rootDir || typeof rootDir !== 'string') throw new Error('rootDir é obrigatório.');
  const cleanQuery = String(query ?? '').trim();
  if (cleanQuery.length < 2 || cleanQuery.length > 100) {
    throw new Error('query deve ter entre 2 e 100 caracteres.');
  }
  const safeScope = CODE_SEARCH_SCOPES.includes(scope) ? scope : 'src';
  const safeLimit = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), MAX_SEARCH_LIMIT) : DEFAULT_SEARCH_LIMIT;
  const needle = cleanQuery.toLowerCase();

  const files = listFilesInScope(rootDir, safeScope, { desktopRoot });
  const matches = [];

  for (const rel of files) {
    let content;
    try {
      content = readSafeAllowlisted(rootDir, rel, { desktopRoot }).content;
    } catch {
      continue;
    }
    const lines = content.split(/\r?\n/);
    for (let idx = 0; idx < lines.length; idx += 1) {
      if (!lines[idx].toLowerCase().includes(needle)) continue;
      matches.push({
        path: rel,
        line: idx + 1,
        preview: redactLine(lines[idx].trim()).slice(0, 160),
      });
      if (matches.length >= safeLimit) break;
    }
    if (matches.length >= safeLimit) break;
  }

  return {
    schema: CODE_INSPECT_SCHEMA,
    mode: 'search',
    query: cleanQuery,
    scope: safeScope,
    totalMatches: matches.length,
    matches,
  };
}

