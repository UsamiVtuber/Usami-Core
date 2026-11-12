import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

export const DOCUMENT_SCHEMA = 'usami.document.v1';
export const DOCUMENT_FORMATS = Object.freeze(['note', 'checklist', 'adr', 'summary']);
export const MAX_DOCUMENT_BYTES = 64 * 1024;

const SAFE_FILENAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,111}\.(?:md|txt)$/;
const FORBIDDEN_SEGMENTS_RE = /(?:^|\/)(?:\.env(?:\..*)?|\.git|secrets?|credentials?)(?:\/|$)/i;

const collapse = value => String(value ?? '').trim().replace(/\s+/g, ' ');

export function slugifyFilename(title, ext = '.md') {
  const base = collapse(title)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'documento';
  const safeExt = ext === '.txt' ? '.txt' : '.md';
  return `${base}${safeExt}`;
}

export function validateDocumentFilename(filename) {
  const clean = String(filename ?? '').trim();
  if (!clean) return { ok: false, error: 'filename é obrigatório' };
  if (clean.includes('/') || clean.includes('\\') || clean.includes('..')) {
    return { ok: false, error: 'filename não pode conter caminhos relativos ou separadores' };
  }
  if (!SAFE_FILENAME_RE.test(clean) || FORBIDDEN_SEGMENTS_RE.test(clean)) {
    return { ok: false, error: 'filename inválido: use apenas letras, números, ".", "_" ou "-" terminando em .md ou .txt' };
  }
  return { ok: true, filename: clean };
}

function normalizeSections(sections = []) {
  if (!Array.isArray(sections)) return [];
  const out = [];
  for (const entry of sections.slice(0, 20)) {
    if (typeof entry === 'string') {
      const text = entry.trim();
      if (text) out.push({ heading: null, body: text });
    } else if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const heading = typeof entry.heading === 'string' ? collapse(entry.heading).slice(0, 120) : null;
      const body = typeof entry.body === 'string' ? entry.body.trim().slice(0, 8000) : '';
      if (heading || body) out.push({ heading, body });
    }
  }
  return out;
}

export function buildDocumentDraft({
  title,
  format = 'note',
  body = '',
  sections = [],
  tags = [],
  filename = null,
  nowMs = Date.now(),
} = {}) {
  const cleanTitle = collapse(title);
  if (cleanTitle.length < 2 || cleanTitle.length > 200) {
    throw new Error('title deve ter entre 2 e 200 caracteres.');
  }
  const safeFormat = DOCUMENT_FORMATS.includes(format) ? format : 'note';
  const dateStr = new Date(nowMs).toISOString().slice(0, 10);
  const resolvedFilename = filename
    ? (() => {
        const checked = validateDocumentFilename(filename);
        if (!checked.ok) throw new Error(checked.error);
        return checked.filename;
      })()
    : slugifyFilename(cleanTitle, '.md');

  const safeTags = Array.isArray(tags)
    ? tags.map(t => collapse(t).slice(0, 40)).filter(Boolean).slice(0, 10)
    : [];
  const cleanBody = typeof body === 'string' ? body.trim().slice(0, 16000) : '';
  const normSections = normalizeSections(sections);

  const lines = [`# ${cleanTitle}`, '', `- Data: ${dateStr}`, `- Formato: ${safeFormat}`];
  if (safeTags.length) lines.push(`- Tags: ${safeTags.join(', ')}`);
  lines.push('');

  if (cleanBody) {
    lines.push(cleanBody, '');
  }

  if (safeFormat === 'checklist') {
    if (normSections.length) {
      for (const sec of normSections) {
        if (sec.heading) lines.push(`## ${sec.heading}`);
        if (sec.body) {
          for (const item of sec.body.split(/\r?\n/).map(l => l.trim()).filter(Boolean)) {
            lines.push(item.startsWith('- [') ? item : `- [ ] ${item}`);
          }
        }
        lines.push('');
      }
    } else if (!cleanBody) {
      lines.push('## Itens', '- [ ] Definir próximo passo', '');
    }
  } else if (safeFormat === 'adr') {
    if (normSections.length) {
      for (const sec of normSections) {
        if (sec.heading) lines.push(`## ${sec.heading}`);
        if (sec.body) lines.push(sec.body);
        lines.push('');
      }
    } else {
      lines.push('## Contexto', cleanBody || 'A definir.', '', '## Decisão', 'A definir.', '', '## Consequências', 'A definir.', '');
    }
  } else {
    for (const sec of normSections) {
      if (sec.heading) lines.push(`## ${sec.heading}`, '');
      if (sec.body) lines.push(sec.body, '');
    }
  }

  const content = `${lines.join('\n').trimEnd()}\n`;
  const byteLength = Buffer.byteLength(content, 'utf8');
  if (byteLength > MAX_DOCUMENT_BYTES) {
    throw new Error(`documento excede o teto de ${MAX_DOCUMENT_BYTES} bytes.`);
  }

  return {
    schema: DOCUMENT_SCHEMA,
    title: cleanTitle,
    format: safeFormat,
    filename: resolvedFilename,
    tags: safeTags,
    content,
    byteLength,
  };
}

/**
 * Política estrita de escrita:
 *  - só grava dentro de `allowedDir` (não segue symlink);
 *  - valida filename sem separadores, `..` ou nomes secretos;
 *  - recusa sobrescrita quando `overwrite !== true`.
 */
export function writeSafeDocument({
  allowedDir,
  filename,
  content,
  overwrite = false,
} = {}) {
  if (!allowedDir || typeof allowedDir !== 'string') {
    throw new Error('allowedDir é obrigatório.');
  }
  const checkedName = validateDocumentFilename(filename);
  if (!checkedName.ok) throw new Error(checkedName.error);
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('content não pode ser vazio.');
  }
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_DOCUMENT_BYTES) {
    throw new Error(`conteúdo excede ${MAX_DOCUMENT_BYTES} bytes.`);
  }

  const rootResolved = resolve(allowedDir);
  if (existsSync(rootResolved)) {
    const rootStat = lstatSync(rootResolved);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw new Error('diretório de documentos inválido ou symlink.');
    }
  } else {
    mkdirSync(rootResolved, { recursive: true });
  }

  const realRoot = realpathSync(rootResolved);
  const target = resolve(realRoot, checkedName.filename);
  const diff = relative(realRoot, target);
  if (!diff || diff.startsWith('..') || isAbsolute(diff)) {
    throw new Error('caminho escapa da pasta permitida.');
  }

  const existed = existsSync(target);
  if (existed) {
    const targetStat = lstatSync(target);
    if (targetStat.isSymbolicLink() || !targetStat.isFile()) {
      throw new Error('alvo existente inválido ou symlink.');
    }
    if (overwrite !== true) {
      throw new Error(`arquivo já existe (${checkedName.filename}); passe overwrite=true para substituir.`);
    }
  }

  const temporary = join(realRoot, `.tmp-${process.pid}-${Date.now()}-${checkedName.filename}`);
  writeFileSync(temporary, content, 'utf8');
  try {
    renameSync(temporary, target);
  } catch (error) {
    try { unlinkSync(temporary); } catch {}
    throw error;
  }

  return {
    written: true,
    filename: checkedName.filename,
    relativePath: checkedName.filename,
    bytes,
    overwritten: existed,
  };
}

