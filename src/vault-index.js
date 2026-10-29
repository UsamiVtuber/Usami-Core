// Busca no vault Obsidian — Fase 3 da memória.
//
// O RAG antigo lia sempre os N arquivos mais recentes de Inbox/Responses. Isso
// funciona como "o que aconteceu por último", mas não como memória de longo
// prazo: uma resposta de duas semanas atrás sobre o mesmo assunto nunca entrava
// no prompt. Este índice resolve isso com FTS5.
//
// Travas:
//   - só a pasta de automação documentada é lida (mesma do rag.js);
//   - o SQLite é DERIVADO e descartável: apagá-lo não perde nada, refresh()
//     reconstrói a partir dos .md;
//   - refresh() é incremental por mtime/tamanho e remove do índice arquivos
//     que sumiram do disco;
//   - SQL só com parâmetros vinculados e termos normalizados ([a-z0-9]), então
//     texto do usuário nunca vira sintaxe de MATCH nem curinga de LIKE;
//   - FTS5 é detectado em runtime; sem ele a busca cai para LIKE com o mesmo
//     formato de resultado (`allowFts: false` existe para os testes).

import { mkdirSync, readFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_VAULT_RELATIVE, resolveVaultDir, stripFrontmatter } from './rag.js';

const INDEX_FILENAME = 'vault-index.sqlite';
const DEFAULT_MAX_FILES = 10;
const MAX_CHARS_PER_FILE = 2000;
const MAX_TOTAL_CHARS = 6000;
const MAX_INDEXED_CHARS = 20000;
const MAX_QUERY_TERMS = 8;

// Palavras que aparecem em quase toda frase: buscá-las traria o vault inteiro
// e afogaria o assunto real da mensagem.
const STOPWORDS = new Set([
  'a', 'as', 'o', 'os', 'um', 'uma', 'uns', 'umas', 'de', 'do', 'da', 'dos', 'das',
  'em', 'no', 'na', 'nos', 'nas', 'por', 'para', 'pra', 'com', 'sem', 'sobre',
  'e', 'ou', 'mas', 'que', 'se', 'como', 'quando', 'onde', 'porque', 'pois',
  'eu', 'tu', 'ele', 'ela', 'voce', 'voces', 'nos', 'me', 'te', 'lhe', 'meu',
  'minha', 'seu', 'sua', 'isso', 'isto', 'aquilo', 'esse', 'essa', 'este',
  'esta', 'aquele', 'aquela', 'ser', 'estar', 'ter', 'tem', 'foi', 'era',
  'sou', 'e', 'ja', 'nao', 'sim', 'muito', 'mais', 'menos', 'bem', 'mal',
  'aqui', 'ai', 'la', 'hoje', 'ontem', 'amanha', 'agora', 'entao', 'tambem',
]);

const normalizeText = (value) => String(value ?? '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase();

function queryTerms(query) {
  const terms = normalizeText(query).match(/[a-z0-9]{2,}/g) ?? [];
  const seen = new Set();
  const picked = [];
  for (const term of terms) {
    if (STOPWORDS.has(term) || seen.has(term)) continue;
    seen.add(term);
    picked.push(term);
    if (picked.length >= MAX_QUERY_TERMS) break;
  }
  return picked;
}

function clampLimit(value, fallback = DEFAULT_MAX_FILES) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number) || number < 1) return fallback;
  return Math.min(number, 50);
}

export function createVaultIndex({ vaultDir, dataDir = 'data', allowFts = true } = {}) {
  const dir = vaultDir || resolveVaultDir(DEFAULT_VAULT_RELATIVE);
  const dbPath = path.join(dataDir, INDEX_FILENAME);
  mkdirSync(dataDir, { recursive: true });

  let db = null;
  let ftsEnabled = false;
  let closed = false;

  function open() {
    db = new DatabaseSync(dbPath);
    try {
      const row = db.prepare('PRAGMA journal_mode = WAL;').get();
      if (String(row?.journal_mode ?? '').toLowerCase() !== 'wal') db.exec('PRAGMA journal_mode = DELETE;');
    } catch {
      try { db.exec('PRAGMA journal_mode = DELETE;'); } catch { /* default do build */ }
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS vault_files (
        path TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        mtime REAL NOT NULL,
        size INTEGER NOT NULL,
        content TEXT NOT NULL,
        search_text TEXT NOT NULL
      );
    `);
    ftsEnabled = false;
    if (allowFts) {
      try {
        db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS vault_fts USING fts5(path UNINDEXED, search_text)');
        ftsEnabled = true;
      } catch {
        ftsEnabled = false;
      }
    }
  }

  try {
    open();
  } catch {
    // Índice derivado: corrompido, a recuperação correta é recriar do zero.
    try { db?.close(); } catch { /* já era */ }
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${dbPath}${suffix}`, { force: true });
    open();
  }

  function assertOpen() {
    if (closed) throw new Error('índice do vault fechado: crie outra instância com createVaultIndex');
  }

  function writeRow({ filePath, name, mtime, size, content }) {
    const searchText = normalizeText(content);
    db.prepare(`
      INSERT INTO vault_files (path, name, mtime, size, content, search_text)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        name = excluded.name, mtime = excluded.mtime, size = excluded.size,
        content = excluded.content, search_text = excluded.search_text
    `).run(filePath, name, mtime, size, content, searchText);
    if (ftsEnabled) {
      db.prepare('DELETE FROM vault_fts WHERE path = ?').run(filePath);
      db.prepare('INSERT INTO vault_fts (path, search_text) VALUES (?, ?)').run(filePath, searchText);
    }
  }

  function removeRow(filePath) {
    db.prepare('DELETE FROM vault_files WHERE path = ?').run(filePath);
    if (ftsEnabled) db.prepare('DELETE FROM vault_fts WHERE path = ?').run(filePath);
  }

  /** Reconcilia o índice com o disco. Incremental: só mexe no que mudou. */
  function refresh() {
    assertOpen();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      // Pasta ausente/ilegível agora não é motivo para apagar memória boa.
      return { indexed: 0, updated: 0, removed: 0, available: false };
    }

    const known = new Map(
      db.prepare('SELECT path, mtime, size FROM vault_files').all().map((row) => [row.path, row]),
    );
    const seen = new Set();
    let indexed = 0;
    let updated = 0;
    let removed = 0;

    db.exec('BEGIN');
    try {
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
        const filePath = path.join(dir, entry.name);
        let stats;
        try {
          stats = statSync(filePath);
        } catch {
          continue;
        }
        seen.add(filePath);
        const previous = known.get(filePath);
        if (previous && previous.mtime === stats.mtimeMs && previous.size === stats.size) continue;
        let content;
        try {
          content = stripFrontmatter(readFileSync(filePath, 'utf8')).slice(0, MAX_INDEXED_CHARS);
        } catch {
          continue;
        }
        if (!content) {
          removeRow(filePath);
          continue;
        }
        writeRow({ filePath, name: entry.name, mtime: stats.mtimeMs, size: stats.size, content });
        if (previous) updated += 1;
        else indexed += 1;
      }
      for (const filePath of known.keys()) {
        if (seen.has(filePath)) continue;
        removeRow(filePath);
        removed += 1;
      }
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* transação já desfeita */ }
      throw error;
    }
    return { indexed, updated, removed, available: true };
  }

  function rowsToContext(rows, { maxCharsPerFile = MAX_CHARS_PER_FILE, maxTotalChars = MAX_TOTAL_CHARS } = {}) {
    const parts = [];
    let total = 0;
    for (const row of rows) {
      let text = row.content;
      if (text.length > maxCharsPerFile) text = `${text.slice(0, maxCharsPerFile)}…`;
      const block = `\n### ${row.name}\n${text}\n`;
      if (total + block.length > maxTotalChars && parts.length > 0) break;
      parts.push(block);
      total += block.length;
    }
    return parts.length ? parts.join('\n---\n') : null;
  }

  function recentRows(limit) {
    return db.prepare('SELECT name, content FROM vault_files ORDER BY mtime DESC LIMIT ?').all(limit);
  }

  function matchRows(terms, limit, operator) {
    if (!terms.length) return [];
    if (ftsEnabled) {
      const match = terms.map((term) => `"${term.replace(/"/g, '""')}"*`).join(` ${operator} `);
      return db.prepare(`
        SELECT f.name, f.content
        FROM vault_fts JOIN vault_files f ON f.path = vault_fts.path
        WHERE vault_fts MATCH ?
        ORDER BY vault_fts.rank, f.mtime DESC
        LIMIT ?
      `).all(match, limit);
    }
    const where = terms.map(() => 'search_text LIKE ?').join(` ${operator} `);
    return db.prepare(`
      SELECT name, content FROM vault_files
      WHERE ${where}
      ORDER BY mtime DESC LIMIT ?
    `).all(...terms.map((term) => `%${term}%`), limit);
  }

  /**
   * Contexto pronto para o prompt.
   * Com termos: melhores matches (AND primeiro, OR se o AND não achar nada);
   * sem termos ou sem nenhum match: arquivos mais recentes, que era o
   * comportamento do RAG antigo.
   */
  function search({ query = '', maxFiles = DEFAULT_MAX_FILES, maxCharsPerFile, maxTotalChars } = {}) {
    assertOpen();
    refresh();
    const limit = clampLimit(maxFiles);
    const terms = queryTerms(query);
    let rows = terms.length ? matchRows(terms, limit, 'AND') : [];
    if (!rows.length && terms.length) rows = matchRows(terms, limit, 'OR');
    if (!rows.length) rows = recentRows(limit);
    return rowsToContext(rows, { maxCharsPerFile, maxTotalChars });
  }

  function close() {
    if (closed) return;
    closed = true;
    try { db?.close(); } catch { /* já fechado */ }
  }

  return {
    refresh,
    search,
    close,
    get backend() { return ftsEnabled ? 'fts5' : 'like'; },
    get vaultDir() { return dir; },
  };
}
