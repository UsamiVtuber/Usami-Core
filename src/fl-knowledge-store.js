/**
 * Deposito persistente de notas de producao musical aprendidas pela Usami
 * (`data/fl-producer-notes.json`).
 *
 * - Nunca cria arquivo no disco apenas ao ler base vazia (preserva testes limpos).
 * - Redige eventuais segredos antes de gravar.
 * - Mantem teto de 200 notas.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { dataDir as resolveDefaultDataDir } from './data-paths.js';
import { redactSecrets } from './self-introspection.js';

export const FL_KNOWLEDGE_STORE_SCHEMA = 'usami.fl_studio.knowledge.v1';
const MAX_NOTES = 200;

export function createFlKnowledgeStore({ dataDir = null, now = () => Date.now() } = {}) {
  function resolveFile() {
    const base = typeof dataDir === 'function' ? dataDir() : (dataDir || resolveDefaultDataDir());
    return resolve(join(base, 'fl-producer-notes.json'));
  }

  function readAll() {
    const filePath = resolveFile();
    if (!existsSync(filePath)) return [];
    const st = lstatSync(filePath);
    if (st.isSymbolicLink() || !st.isFile()) {
      throw new Error('Arquivo fl-producer-notes.json invalido (symlink nao permitido).');
    }
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
      return Array.isArray(parsed?.notes) ? parsed.notes : [];
    } catch {
      return [];
    }
  }

  function writeAll(notes) {
    const filePath = resolveFile();
    const parent = dirname(filePath);
    mkdirSync(parent, { recursive: true });
    if (existsSync(filePath) && lstatSync(filePath).isSymbolicLink()) {
      throw new Error('Arquivo fl-producer-notes.json nao pode ser symlink.');
    }
    const payload = {
      schema: FL_KNOWLEDGE_STORE_SCHEMA,
      updatedAt: new Date(now()).toISOString(),
      notes: notes.slice(-MAX_NOTES),
    };
    writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  }

  return {
    list({ genre = null, topic = null, query = '', limit = 25 } = {}) {
      const all = readAll();
      const q = String(query || '').trim().toLowerCase();
      const filtered = all.filter(item => {
        if (genre && genre !== 'general' && item.genre !== genre && item.genre !== 'general') return false;
        if (topic && topic !== 'all' && item.topic !== topic) return false;
        if (q) {
          const hay = `${item.title || ''} ${item.content || ''} ${item.genre || ''}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      });
      const safeLimit = Math.max(1, Math.min(Number(limit) || 25, 100));
      return filtered.slice(-safeLimit).reverse();
    },

    save({ genre = 'general', topic = 'sound_design', title, content, source = 'user' } = {}) {
      const cleanTitle = redactSecrets(String(title ?? '').trim()).slice(0, 120);
      const cleanContent = redactSecrets(String(content ?? '').trim()).slice(0, 1200);
      if (cleanTitle.length < 3 || cleanContent.length < 5) {
        throw new Error('Nota de producao precisa de title (>=3) e content (>=5).');
      }
      const existing = readAll();
      const entry = {
        id: `fln-${randomBytes(4).toString('hex')}`,
        genre: String(genre || 'general').trim().toLowerCase(),
        topic: String(topic || 'sound_design').trim().toLowerCase(),
        title: cleanTitle,
        content: cleanContent,
        source: String(source || 'user').trim().slice(0, 32),
        createdAt: new Date(now()).toISOString(),
      };
      existing.push(entry);
      writeAll(existing);
      return entry;
    },

    remove(noteId) {
      const id = String(noteId ?? '').trim();
      const existing = readAll();
      const next = existing.filter(item => item.id !== id);
      if (next.length === existing.length) {
        return { removed: false, id };
      }
      writeAll(next);
      return { removed: true, id };
    },
  };
}
