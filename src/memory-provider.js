/**
 * @fileoverview Abstração IMemoryProvider + NullMemoryProvider (Toggle Opt-In)
 * para desacoplar o loop conversacional do backend de memória semântica (RAG).
 */

import { dataDir as defaultDataDir } from './data-paths.js';
import { LanceMemoryStore } from './lancedb-store.js';
import { embedText } from './local-embedder.js';

/**
 * Provedor nulo (Null Object Pattern) para personagens com `ragEnabled: false`
 * ou `storageBackend: 'none'`. Zero I/O em disco e zero inferência ONNX.
 */
export class NullMemoryProvider {
  constructor({ characterId = 'usami-classic' } = {}) {
    this.characterId = characterId;
  }

  isEnabled() {
    return false;
  }

  async initialize() {}

  async query() {
    return [];
  }

  async store() {}

  async formatContext() {
    return null;
  }

  async count() {
    return 0;
  }

  async close() {}
}

/**
 * Provedor semântico isolado por personagem em LanceDB, com fallback opcional
 * para o leitor de vault quando o índice vetorial estiver vazio.
 */
export class LanceDbMemoryProvider {
  constructor({
    characterId = 'usami-classic',
    dataDir = defaultDataDir(),
    lanceStore = null,
    embedder = embedText,
    similarityThreshold = 0.2,
    maxContextChunks = 4,
    vaultFallback = null,
  } = {}) {
    this.characterId = characterId;
    this.dataDir = dataDir;
    this.similarityThreshold = similarityThreshold;
    this.maxContextChunks = maxContextChunks;
    this.vaultFallback = typeof vaultFallback === 'function' ? vaultFallback : null;
    this.lanceStore = lanceStore || new LanceMemoryStore({
      dataDir,
      characterId,
      embedder,
    });
  }

  isEnabled() {
    return true;
  }

  async initialize() {
    await this.lanceStore.init();
  }

  async query(text, {
    limit = this.maxContextChunks,
    threshold = this.similarityThreshold,
  } = {}) {
    const clean = String(text ?? '').trim();
    if (!clean) return [];
    return this.lanceStore.search({
      query: clean,
      limit,
      minScore: threshold,
    });
  }

  async store({ file, title, chunks, text, mtime = Date.now() } = {}) {
    const resolvedChunks = Array.isArray(chunks)
      ? chunks
      : (typeof text === 'string' && text.trim() ? [text.trim()] : []);
    if (!resolvedChunks.length) return;

    await this.lanceStore.upsertFileChunks({
      file: file || `mem_${Date.now()}.md`,
      title: title || 'memory',
      chunks: resolvedChunks,
      mtime,
    });
  }

  async formatContext(queryText, options = {}) {
    try {
      const chunks = await this.query(queryText, options);
      if (Array.isArray(chunks) && chunks.length > 0) {
        return chunks
          .map(c => `### ${c.title || c.file || 'memória'}\n${c.text}`)
          .join('\n---\n');
      }
    } catch {
      // fallback abaixo se o índice falhar
    }

    if (this.vaultFallback) {
      return await this.vaultFallback(queryText);
    }

    return null;
  }

  async count() {
    return this.lanceStore.count();
  }

  async close() {
    if (typeof this.lanceStore.close === 'function') {
      await this.lanceStore.close();
    }
  }
}

/**
 * Instancia o provedor de memória semântica conforme as configurações do manifesto.
 * @param {Object} [options]
 * @returns {NullMemoryProvider | LanceDbMemoryProvider}
 */
export function createMemoryProvider({
  manifest = null,
  characterId = 'usami-classic',
  dataDir = defaultDataDir(),
  embedder = embedText,
  vaultFallback = null,
  lanceStore = null,
} = {}) {
  const ragEnabled = manifest?.memory?.ragEnabled;
  const storageBackend = manifest?.memory?.storageBackend;

  if (ragEnabled === false || storageBackend === 'none') {
    return new NullMemoryProvider({ characterId });
  }

  return new LanceDbMemoryProvider({
    characterId,
    dataDir,
    lanceStore,
    embedder,
    similarityThreshold: manifest?.memory?.similarityThreshold ?? 0.2,
    maxContextChunks: manifest?.memory?.maxContextChunks ?? 4,
    vaultFallback,
  });
}
