// Fase 4: índice de busca das técnicas — DERIVADO dos JSON de `<dataDir>/techniques/`.
// A fonte da verdade continua sendo o arquivo validado por `validateTechnique`;
// este SQLite é descartável: apagá-lo não perde nada, refresh() reconstrói tudo,
// e o índice nunca apaga arquivos JSON.
//
// Travas:
//   - nada entra no índice sem passar por validateTechnique (modo estrito): um JSON
//     adulterado é REPORTADO em `invalid` e removido do índice, nunca "reparado"
//     em silêncio; linha órfã (arquivo sumiu) é reconciliada na mesma;
//   - SQL exclusivamente com parâmetros vinculados: texto de tutorial é dado,
//     não sintaxe;
//   - FTS5 é detectado em runtime (nem todo build do Node o traz). Sem ele, a
//     busca cai para LIKE sobre texto normalizado (minúsculo, sem acentos) e
//     devolve exatamente a mesma forma de resultado. `allowFts: false` existe só
//     para os testes exercitarem o caminho de fallback neste build, que tem FTS5.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TECHNIQUE_STATUSES, summarizeTechnique, validateTechnique } from './technique-schema.js';
import { dataDir as defaultDataDir } from './data-paths.js';

const TECH_ID_RE = /^tc-[0-9a-f]{12}$/;
const INDEX_FILENAME = 'techniques-index.sqlite';
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS techniques (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0,
  engine TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  payload TEXT NOT NULL,
  mtime REAL NOT NULL,
  sha256 TEXT NOT NULL,
  search_text TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS technique_tags (
  technique_id TEXT NOT NULL,
  tag TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS technique_tags_tag ON technique_tags (tag);
CREATE TABLE IF NOT EXISTS technique_sources (
  technique_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  kind TEXT,
  title TEXT
);
CREATE INDEX IF NOT EXISTS technique_sources_source ON technique_sources (source_id);
CREATE TABLE IF NOT EXISTS technique_motions (
  technique_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT
);
CREATE INDEX IF NOT EXISTS technique_motions_kind_name ON technique_motions (kind, name);
CREATE TABLE IF NOT EXISTS invalid_files (
  id TEXT PRIMARY KEY,
  file TEXT NOT NULL,
  errors TEXT NOT NULL,
  mtime REAL NOT NULL,
  sha256 TEXT NOT NULL
);
`;

const normalizeText = value => String(value ?? '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase();

// Termos só com [a-z0-9]: nunca viram sintaxe de MATCH nem curinga de LIKE (% _).
function queryTerms(query) {
  return normalizeText(query).match(/[a-z0-9]+/g) ?? [];
}

function clampLimit(value) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number) || number < 1) return DEFAULT_LIMIT;
  return Math.min(number, MAX_LIMIT);
}

export function createTechniqueIndex({ dataDir = defaultDataDir(), allowFts = true } = {}) {
  const techniquesDir = path.join(dataDir, 'techniques');
  const dbPath = path.join(dataDir, INDEX_FILENAME);
  mkdirSync(dataDir, { recursive: true });

  let db = null;
  let ftsEnabled = false;
  let journalMode = 'delete';
  let closed = false;

  function open() {
    db = new DatabaseSync(dbPath);
    try {
      const row = db.prepare('PRAGMA journal_mode = WAL;').get();
      journalMode = String(row?.journal_mode ?? '').toLowerCase() === 'wal' ? 'wal' : 'delete';
      if (journalMode !== 'wal') db.exec('PRAGMA journal_mode = DELETE;');
    } catch {
      journalMode = 'delete';
      try { db.exec('PRAGMA journal_mode = DELETE;'); } catch { /* default do build */ }
    }
    db.exec(SCHEMA);
    ftsEnabled = false;
    if (allowFts) {
      try {
        db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS techniques_fts USING fts5(tech_id UNINDEXED, search_text)');
        ftsEnabled = true;
      } catch {
        ftsEnabled = false;
      }
    }
  }

  try {
    open();
  } catch {
    // Arquivo do índice corrompido: o índice é derivado, então a recuperação
    // correta é deitar fora e reabrir — nunca "consertar" dados na marra.
    try { db?.close(); } catch { /* já era */ }
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${dbPath}${suffix}`, { force: true });
    open();
  }

  function assertOpen() {
    if (closed) throw new Error('índice fechado: crie outra instância com createTechniqueIndex');
  }

  function clearIndexedRows(id) {
    db.prepare('DELETE FROM technique_tags WHERE technique_id = ?').run(id);
    db.prepare('DELETE FROM technique_sources WHERE technique_id = ?').run(id);
    db.prepare('DELETE FROM technique_motions WHERE technique_id = ?').run(id);
    db.prepare('DELETE FROM techniques WHERE id = ?').run(id);
    if (ftsEnabled) db.prepare('DELETE FROM techniques_fts WHERE tech_id = ?').run(id);
  }

  function indexTechnique(technique, { mtimeMs, sha256 }) {
    clearIndexedRows(technique.id);
    const searchText = normalizeText([
      technique.name, technique.summary,
      ...(technique.steps || []), ...(technique.tags || []), technique.notes,
    ].join('\n'));
    db.prepare(`
      INSERT INTO techniques (id, name, summary, status, confidence, engine, created_at, payload, mtime, sha256, search_text)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      technique.id, technique.name, technique.summary, technique.status,
      Number(technique.confidence) || 0,
      `${technique.engine.provider}/${technique.engine.model}`,
      technique.createdAt, JSON.stringify(technique), mtimeMs, sha256, searchText,
    );
    for (const tag of technique.tags || []) {
      db.prepare('INSERT INTO technique_tags (technique_id, tag) VALUES (?, ?)').run(technique.id, normalizeText(tag));
    }
    for (const source of technique.sources || []) {
      db.prepare('INSERT INTO technique_sources (technique_id, source_id, kind, title) VALUES (?, ?, ?, ?)')
        .run(technique.id, source.sourceId, source.kind ?? null, source.title ?? null);
    }
    for (const motion of technique.motions || []) {
      const name = motion.kind === 'shape' ? (motion.shape ?? motion.request?.shape ?? null) : (motion.name ?? null);
      db.prepare('INSERT INTO technique_motions (technique_id, kind, name) VALUES (?, ?, ?)').run(technique.id, motion.kind, name);
    }
    if (ftsEnabled) {
      db.prepare('INSERT INTO techniques_fts (tech_id, search_text) VALUES (?, ?)').run(technique.id, searchText);
    }
  }

  function recordInvalid(id, file, errors, { mtimeMs, sha256 }) {
    db.prepare(`
      INSERT INTO invalid_files (id, file, errors, mtime, sha256) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET file = excluded.file, errors = excluded.errors, mtime = excluded.mtime, sha256 = excluded.sha256
    `).run(id, file, JSON.stringify(errors), mtimeMs, sha256);
  }

  // Idempotente e barato: carimbo (mtime + sha256) por arquivo; só re-indexa o
  // conteúdo que mudou de verdade (touch sem mudança atualiza o carimbo, não o índice).
  function refresh() {
    assertOpen();
    let names = [];
    try { names = readdirSync(techniquesDir); } catch { /* sem pasta = índice vazio */ }
    const files = names.filter(name => name.endsWith('.json') && TECH_ID_RE.test(name.slice(0, -'.json'.length)));

    const invalid = [];
    const addedIds = [];
    const updatedIds = [];
    const removedIds = [];
    const seen = new Set();

    db.exec('BEGIN');
    try {
      for (const name of files) {
        const id = name.slice(0, -'.json'.length);
        seen.add(id);
        const filePath = path.join(techniquesDir, name);
        let buffer;
        let mtimeMs;
        try {
          buffer = readFileSync(filePath);
          mtimeMs = statSync(filePath).mtimeMs;
        } catch {
          invalid.push({ id, file: name, errors: ['arquivo ilegível'] });
          continue;
        }
        const sha256 = createHash('sha256').update(buffer).digest('hex');

        const known = db.prepare('SELECT mtime, sha256 FROM techniques WHERE id = ?').get(id);
        if (known && known.sha256 === sha256) {
          if (known.mtime !== mtimeMs) db.prepare('UPDATE techniques SET mtime = ? WHERE id = ?').run(mtimeMs, id);
          continue;
        }
        const stale = db.prepare('SELECT sha256, mtime, errors FROM invalid_files WHERE id = ?').get(id);
        if (stale && stale.sha256 === sha256) {
          if (stale.mtime !== mtimeMs) db.prepare('UPDATE invalid_files SET mtime = ? WHERE id = ?').run(mtimeMs, id);
          invalid.push({ id, file: name, errors: JSON.parse(stale.errors) });
          continue;
        }

        let candidate = null;
        try { candidate = JSON.parse(buffer.toString('utf8')); } catch { /* vira inválida abaixo */ }
        const check = candidate ? validateTechnique(candidate) : { ok: false, errors: ['JSON ilegível'] };
        if (check.ok && check.technique.id === id) {
          db.prepare('DELETE FROM invalid_files WHERE id = ?').run(id);
          indexTechnique(check.technique, { mtimeMs, sha256 });
          (known ? updatedIds : addedIds).push(id);
        } else {
          // arquivo adulterado: sai do índice e é REPORTADO, nunca reparado em silêncio
          const errors = check.ok ? [`conteúdo do arquivo não bate com o próprio id (${check.technique.id} ≠ ${id})`] : check.errors;
          if (known) { clearIndexedRows(id); removedIds.push(id); }
          recordInvalid(id, name, errors, { mtimeMs, sha256 });
          invalid.push({ id, file: name, errors });
        }
      }

      // índice divergindo dos arquivos (linha órfã): o JSON é a verdade, a linha
      // órfã se descarta; arquivos nunca são tocados por aqui.
      for (const row of db.prepare('SELECT id FROM techniques').all()) {
        if (!seen.has(row.id)) { clearIndexedRows(row.id); removedIds.push(row.id); }
      }
      for (const row of db.prepare('SELECT id FROM invalid_files').all()) {
        if (!seen.has(row.id)) db.prepare('DELETE FROM invalid_files WHERE id = ?').run(row.id);
      }
      db.exec('COMMIT');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* estado já inconsistente; refresh reconstrói */ }
      throw err;
    }

    const total = db.prepare('SELECT COUNT(*) AS n FROM techniques').get().n;
    return { total, added: addedIds.length, updated: updatedIds.length, removed: removedIds.length, invalid };
  }

  // Busca: NUNCA interpola parâmetros em SQL; tudo vinculado por `?`.
  function search(params = {}) {
    assertOpen();
    const { query = '', shape, tag, status, sourceId } = params || {};
    const hasStatus = status !== undefined && status !== null;
    if (hasStatus && !TECHNIQUE_STATUSES.includes(status)) {
      throw new Error(`status de busca inválido: ${JSON.stringify(String(status))} (esperado um de ${TECHNIQUE_STATUSES.join('|')})`);
    }
    const limit = clampLimit(params.limit);
    const where = [];
    const args = [];
    if (hasStatus) {
      where.push('t.status = ?');
      args.push(status);
    } else {
      // padrão exclui o lixo do ciclo de vida; nada aqui é texto do usuário
      where.push("t.status NOT IN ('rejeitada', 'obsoleta')");
    }
    if (typeof shape === 'string' && shape) {
      where.push('EXISTS (SELECT 1 FROM technique_motions m WHERE m.technique_id = t.id AND m.kind = ? AND m.name = ?)');
      args.push('shape', shape);
    }
    if (typeof tag === 'string' && tag) {
      where.push('EXISTS (SELECT 1 FROM technique_tags g WHERE g.technique_id = t.id AND g.tag = ?)');
      args.push(normalizeText(tag));
    }
    if (typeof sourceId === 'string' && sourceId) {
      where.push('EXISTS (SELECT 1 FROM technique_sources s WHERE s.technique_id = t.id AND s.source_id = ?)');
      args.push(sourceId);
    }

    const terms = queryTerms(query);
    const filterSql = where.length ? ` AND ${where.join(' AND ')}` : '';
    let rows;
    let backend = null;
    if (terms.length && ftsEnabled) {
      backend = 'fts5';
      const match = terms.map(term => `"${term.replace(/"/g, '""')}"*`).join(' AND ');
      rows = db.prepare(`
        SELECT t.* FROM techniques_fts JOIN techniques t ON t.id = techniques_fts.tech_id
        WHERE techniques_fts MATCH ?${filterSql} ORDER BY techniques_fts.rank LIMIT ?
      `).all(match, ...args, limit);
    } else {
      if (terms.length) backend = 'like';
      for (const term of terms) {
        where.push('t.search_text LIKE ?');
        args.push(`%${term}%`);
      }
      const sql = `SELECT t.* FROM techniques t${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY t.created_at DESC LIMIT ?`;
      rows = db.prepare(sql).all(...args, limit);
    }

    const entries = rows.map(row => {
      const technique = JSON.parse(row.payload);
      let score = 0;
      const why = [];
      for (const term of terms) {
        if (normalizeText(row.name).includes(term)) { score += 3; why.push(`nome contém "${term}"`); }
        else if ((technique.tags || []).some(item => normalizeText(item).includes(term))) { score += 2; why.push(`tag contém "${term}"`); }
        else if (normalizeText(row.summary).includes(term)
          || (technique.steps || []).some(item => normalizeText(item).includes(term))
          || normalizeText(technique.notes).includes(term)) { score += 1; why.push(`resumo/passos/notas contêm "${term}"`); }
        else if (backend === 'fts5') { score += 1; why.push(`texto bateu "${term}" (fts)`); }
      }
      return {
        item: { ...summarizeTechnique(technique), score, why },
        created: String(row.created_at),
        id: row.id,
      };
    });
    entries.sort((a, b) => (b.item.score - a.item.score)
      || b.created.localeCompare(a.created)
      || String(a.id).localeCompare(String(b.id)));
    return entries.map(entry => entry.item);
  }

  // A resposta vem do JSON (fonte da verdade), não do índice: um arquivo
  // adulterado depois do refresh é recusado aqui imediatamente.
  function get(id) {
    assertOpen();
    if (!TECH_ID_RE.test(String(id ?? ''))) return { ok: false, errors: ['id de técnica inválido'] };
    let buffer;
    try { buffer = readFileSync(path.join(techniquesDir, `${id}.json`)); }
    catch { return { ok: false, errors: ['técnica não encontrada'] }; }
    let candidate = null;
    try { candidate = JSON.parse(buffer.toString('utf8')); } catch { /* abaixo */ }
    if (!candidate) return { ok: false, errors: ['JSON ilegível'] };
    const check = validateTechnique(candidate);
    if (!check.ok) return { ok: false, errors: [`técnica armazenada inválida: ${check.errors.join('; ')}`] };
    return { ok: true, technique: check.technique };
  }

  function stats() {
    assertOpen();
    const byStatus = {};
    for (const row of db.prepare('SELECT status, COUNT(*) AS n FROM techniques GROUP BY status').all()) {
      byStatus[row.status] = row.n;
    }
    const invalid = db.prepare('SELECT id, file, errors FROM invalid_files ORDER BY file').all()
      .map(row => ({ id: row.id, file: row.file, errors: JSON.parse(row.errors) }));
    return {
      total: db.prepare('SELECT COUNT(*) AS n FROM techniques').get().n,
      byStatus,
      invalid,
      tags: db.prepare('SELECT COUNT(*) AS n FROM technique_tags').get().n,
      sources: db.prepare('SELECT COUNT(DISTINCT source_id) AS n FROM technique_sources').get().n,
      backend: ftsEnabled ? 'fts5' : 'like',
      journalMode,
      indexFile: dbPath,
    };
  }

  function close() {
    if (closed) return;
    closed = true;
    try { db.close(); } catch { /* índice descartável */ }
  }

  return { refresh, search, get, stats, close };
}
