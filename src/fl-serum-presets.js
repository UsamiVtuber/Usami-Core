/**
 * Indexador, buscador e organizador de presets `.SerumPreset` do Xfer Serum 2.
 *
 * Todo `.SerumPreset` do Serum 2 inicia com o cabecalho `XferJson\0` seguido
 * por um objeto JSON UTF-8 contendo `presetName`, `presetAuthor`,
 * `presetDescription`, `tags` (ex.: Spectral, Granular, Wavetable, Poly, Mono,
 * Arp) e `productVersion`, antes do bloco binario compactado do patch.
 *
 * Este modulo:
 *  - le apenas os primeiros ~16 KB de cada `.SerumPreset` para extrair o JSON;
 *  - faz cache em memoria para buscas instantaneas;
 *  - copia presets selecionados de forma nao-destrutiva para `Presets/User/Usami/`
 *    para que possam ser alternados direto via `fl.plugin` (`next_preset`/`prev_preset`).
 */
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';

export const XFER_MAGIC = 'XferJson';
const HEADER_READ_BYTES = 24576;

export function resolveSerum2PresetRoots(userHome = homedir()) {
  return [
    join(userHome, 'OneDrive', 'Documentos', 'Xfer', 'Serum 2 Presets', 'Presets'),
    join(userHome, 'Documents', 'Xfer', 'Serum 2 Presets', 'Presets'),
    join(userHome, 'OneDrive', 'Documents', 'Xfer', 'Serum 2 Presets', 'Presets'),
  ];
}

/**
 * Extrai o primeiro objeto JSON valido apos o prefixo `XferJson` sem precisar
 * carregar blocos binarios grandes na memoria.
 */
export function parseSerumPresetHeaderBuffer(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 20) return null;
  if (buf.subarray(0, 8).toString('ascii') !== XFER_MAGIC) return null;

  const jsonStart = buf.indexOf(0x7B, 8); // '{'
  if (jsonStart < 0) return null;

  const text = buf.subarray(jsonStart).toString('utf8');
  let depth = 0;
  let inString = false;
  let escaped = false;
  let jsonEnd = -1;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        jsonEnd = i + 1;
        break;
      }
    }
  }

  if (jsonEnd <= 0) return null;
  try {
    const parsed = JSON.parse(text.slice(0, jsonEnd));
    if (!parsed || typeof parsed !== 'object' || parsed.fileType !== 'SerumPreset') {
      return null;
    }
    return {
      presetName: String(parsed.presetName || '').trim(),
      presetAuthor: String(parsed.presetAuthor || '').trim(),
      presetDescription: String(parsed.presetDescription || '').trim(),
      productVersion: String(parsed.productVersion || '').trim(),
      tags: Array.isArray(parsed.tags)
        ? parsed.tags.map(t => String(t).trim()).filter(t => t && t !== 'Preview')
        : [],
    };
  } catch {
    return null;
  }
}

function readPresetMetadata(filePath, rootDir) {
  let fd = null;
  try {
    const st = lstatSync(filePath);
    if (st.isSymbolicLink() || !st.isFile()) return null;
    fd = openSync(filePath, 'r');
    const sliceLen = Math.min(HEADER_READ_BYTES, st.size);
    const buf = Buffer.alloc(sliceLen);
    const bytesRead = readSync(fd, buf, 0, sliceLen, 0);
    const meta = parseSerumPresetHeaderBuffer(buf.subarray(0, bytesRead));
    const rel = relative(rootDir, filePath).replace(/\\/g, '/');
    const parts = rel.split('/');
    const category = parts.length > 1 ? parts[0] : 'Uncategorized';
    const fallbackName = basename(filePath, extname(filePath));
    return {
      presetName: meta?.presetName || fallbackName,
      category,
      tags: meta?.tags || [],
      author: meta?.presetAuthor || '',
      description: meta?.presetDescription || '',
      relativePath: rel,
      filePath,
    };
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch {}
    }
  }
}

function walkPresetFiles(dir, out = [], maxFiles = 2500) {
  if (out.length >= maxFiles || !existsSync(dir)) return out;
  let entries = [];
  try {
    if (lstatSync(dir).isSymbolicLink()) return out;
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (out.length >= maxFiles) break;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkPresetFiles(full, out, maxFiles);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.serumpreset')) {
      out.push(full);
    }
  }
  return out;
}

function normalizeToken(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

export function createSerumPresetLibrary({ presetsRoot = null, userHome = homedir() } = {}) {
  let cachedRoot = null;
  let cachedIndex = null;

  function resolveRoot() {
    if (presetsRoot) {
      const explicit = resolve(presetsRoot);
      return existsSync(explicit) ? explicit : null;
    }
    return resolveSerum2PresetRoots(userHome).find(candidate => existsSync(candidate)) || null;
  }

  function ensureIndex(forceReload = false) {
    const root = resolveRoot();
    if (!root) {
      throw new Error('Pasta de presets do Serum 2 nao encontrada (esperada em Documentos\\Xfer\\Serum 2 Presets\\Presets).');
    }
    if (!forceReload && cachedIndex && cachedRoot === root) {
      return { root, presets: cachedIndex };
    }
    const files = walkPresetFiles(root);
    const parsed = files.map(f => readPresetMetadata(f, root)).filter(Boolean);
    cachedRoot = root;
    cachedIndex = parsed;
    return { root, presets: parsed };
  }

  return {
    summary({ refresh = false } = {}) {
      const { root, presets } = ensureIndex(refresh);
      const byCategory = {};
      const byTag = {};
      for (const item of presets) {
        byCategory[item.category] = (byCategory[item.category] || 0) + 1;
        for (const tag of item.tags) {
          byTag[tag] = (byTag[tag] || 0) + 1;
        }
      }
      return {
        presetsRoot: root,
        totalPresets: presets.length,
        categories: byCategory,
        tags: byTag,
      };
    },

    search({ query = '', category = null, tag = null, limit = 12, refresh = false } = {}) {
      const { root, presets } = ensureIndex(refresh);
      const qTokens = normalizeToken(query).split(/\s+/).filter(Boolean);
      const catNeedle = category ? normalizeToken(category) : null;
      const tagNeedle = tag ? normalizeToken(tag) : null;

      const scored = [];
      for (const item of presets) {
        if (catNeedle && !normalizeToken(item.category).includes(catNeedle)) continue;
        if (tagNeedle && !item.tags.some(t => normalizeToken(t).includes(tagNeedle))) continue;

        let score = 1;
        if (qTokens.length > 0) {
          const hayName = normalizeToken(item.presetName);
          const hayAll = normalizeToken(`${item.presetName} ${item.category} ${item.tags.join(' ')} ${item.author} ${item.description}`);
          score = 0;
          for (const tok of qTokens) {
            if (hayName.includes(tok)) score += 4;
            else if (hayAll.includes(tok)) score += 2;
          }
          if (score === 0) continue;
        }
        scored.push({ item, score });
      }

      scored.sort((a, b) => b.score - a.score || a.item.presetName.localeCompare(b.item.presetName));
      const safeLimit = Math.max(1, Math.min(Number(limit) || 12, 30));
      return {
        presetsRoot: root,
        totalScanned: presets.length,
        matchedCount: scored.length,
        presets: scored.slice(0, safeLimit).map(({ item }) => item),
      };
    },

    stageToUsamiBank({ presetNames = [], query = '', category = null, bankName = 'Usami', maxStage = 8 } = {}) {
      const { root, presets } = ensureIndex(false);
      const safeBank = String(bankName || 'Usami').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32) || 'Usami';
      const targetBankDir = resolve(root, 'User', safeBank);
      const relBank = relative(root, targetBankDir);
      if (!relBank || relBank.startsWith('..') || isAbsolute(relBank)) {
        throw new Error('Destino de banco User/Usami invalido.');
      }
      if (existsSync(targetBankDir) && lstatSync(targetBankDir).isSymbolicLink()) {
        throw new Error('Pasta User/Usami nao pode ser symlink.');
      }

      let selected = [];
      if (Array.isArray(presetNames) && presetNames.length > 0) {
        for (const wanted of presetNames) {
          const needle = normalizeToken(wanted);
          const found = presets.find(p => normalizeToken(p.presetName) === needle)
            || presets.find(p => normalizeToken(p.presetName).includes(needle));
          if (found) selected.push(found);
        }
      } else if (query || category) {
        selected = this.search({ query, category, limit: maxStage }).presets;
      }

      if (selected.length === 0) {
        throw new Error('Nenhum preset do Serum 2 encontrado para copiar ao banco User/Usami.');
      }

      mkdirSync(targetBankDir, { recursive: true });
      const staged = [];
      for (const item of selected.slice(0, Math.min(10, Math.max(1, maxStage)))) {
        const safeFile = `${basename(item.filePath, '.SerumPreset').replace(/[^a-zA-Z0-9 _.-]/g, '').trim() || 'Preset'}.SerumPreset`;
        const dst = join(targetBankDir, safeFile);
        if (existsSync(dst) && lstatSync(dst).isSymbolicLink()) continue;
        writeFileSync(dst, readFileSync(item.filePath));
        staged.push({
          presetName: item.presetName,
          category: item.category,
          stagedPath: dst,
        });
      }

      // Invalida cache para incluir o novo banco User/Usami
      cachedIndex = null;
      return {
        bankName: safeBank,
        bankDir: targetBankDir,
        stagedCount: staged.length,
        staged,
      };
    },
  };
}
