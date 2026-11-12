// Repositório de Memória Vetorial em LanceDB para notas do Obsidian da Usami.
//
// Combina busca vetorial de alta velocidade com filtragem temporal e por metadados.

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import * as lancedb from '@lancedb/lancedb';
import { embedText, EMBEDDING_DIMENSION } from './local-embedder.js';
import { dataDir as defaultDataDir } from './data-paths.js';

const TABLE_NAME = 'vault_memory';

export class LanceMemoryStore {
  constructor({ dataDir = defaultDataDir() } = {}) {
    this.dataDir = dataDir;
    this.dbDir = path.join(this.dataDir, 'lancedb');
    this.db = null;
    this.table = null;
  }

  async init() {
    if (this.table) return this.table;
    mkdirSync(this.dbDir, { recursive: true });
    this.db = await lancedb.connect(this.dbDir);

    const tables = await this.db.tableNames();
    if (tables.includes(TABLE_NAME)) {
      this.table = await this.db.openTable(TABLE_NAME);
    } else {
      // Cria a tabela inicial com schema padrão
      const dummyVector = new Array(EMBEDDING_DIMENSION).fill(0);
      this.table = await this.db.createTable(TABLE_NAME, [
        {
          id: '__init__',
          file: '',
          title: 'init',
          text: 'initialization marker',
          vector: dummyVector,
          mtime: 0,
          updatedAt: new Date().toISOString(),
        },
      ]);
    }

    return this.table;
  }

  /**
   * Busca semântica vetorial por proximidade.
   */
  async search({ query, limit = 5, minScore = 0.2 } = {}) {
    await this.init();
    const queryVector = await embedText(query);

    const rows = await this.table
      .vectorSearch(queryVector)
      .limit(limit + 1)
      .toArray();

    // Filtra marker de inicialização e mapeia resultados com score
    return rows
      .filter((row) => row.id !== '__init__')
      .slice(0, limit)
      .map((row) => {
        // LanceDB retorna _distance (L2 distance por padrão)
        // Score de similaridade invertido: 1 / (1 + distance)
        const distance = row._distance ?? 0;
        const score = Number((1 / (1 + distance)).toFixed(4));
        return {
          id: row.id,
          file: row.file,
          title: row.title,
          text: row.text,
          mtime: row.mtime,
          score,
          updatedAt: row.updatedAt,
        };
      })
      .filter((r) => r.score >= minScore);
  }

  /**
   * Upsert de chunks para um arquivo específico do Vault.
   */
  async upsertFileChunks({ file, title, chunks = [], mtime = Date.now() }) {
    await this.init();
    if (!chunks.length) return;

    // Remove entradas antigas deste mesmo arquivo antes de adicionar as novas
    try {
      await this.table.delete(`file = '${file.replace(/'/g, "''")}'`);
    } catch {
      // Caso a tabela ainda não suporte delete na versão instalada, segue com append
    }

    const records = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunkText = chunks[i];
      const vector = await embedText(chunkText);
      records.push({
        id: `${file}#${i}`,
        file,
        title: title || path.basename(file, '.md'),
        text: chunkText,
        vector,
        mtime,
        updatedAt: new Date().toISOString(),
      });
    }

    await this.table.add(records);
  }

  /**
   * Remove registros de um arquivo do índice.
   */
  async removeFile(file) {
    await this.init();
    try {
      await this.table.delete(`file = '${file.replace(/'/g, "''")}'`);
    } catch {
      // ignore
    }
  }

  async count() {
    await this.init();
    const total = await this.table.countRows();
    // Desconta o __init__ se presente
    return Math.max(0, total - 1);
  }
}

