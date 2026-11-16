import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LanceMemoryStore } from '../src/lancedb-store.js';
import {
  EMBEDDING_DIMENSION,
  clearSharedEmbedderCache,
  embedText,
  getSharedEmbedderCacheStats,
} from '../src/local-embedder.js';

// Embedder determinístico leve por palavra-chave para testar isolamento vetorial sem rede
function mockKeywordEmbedder(text) {
  const vec = new Array(EMBEDDING_DIMENSION).fill(0);
  const lower = String(text).toLowerCase();
  if (lower.includes('astronomia') || lower.includes('estrela')) {
    vec[0] = 1;
  } else if (lower.includes('culinaria') || lower.includes('bolo')) {
    vec[1] = 1;
  } else {
    vec[2] = 1;
  }
  return Promise.resolve(vec);
}

test('lancedb-multitenant: isola diretórios, tabelas e buscas entre char-alpha e char-beta', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'usami-lance-mt-'));
  const storeAlpha = new LanceMemoryStore({
    dataDir: dir,
    characterId: 'char-alpha',
    embedder: mockKeywordEmbedder,
  });
  const storeBeta = new LanceMemoryStore({
    dataDir: dir,
    characterId: 'char-beta',
    embedder: mockKeywordEmbedder,
  });

  try {
    assert.equal(storeAlpha.tableName, 'memories_char_alpha');
    assert.equal(storeBeta.tableName, 'memories_char_beta');
    assert.notEqual(storeAlpha.dbDir, storeBeta.dbDir);

    await storeAlpha.upsertFileChunks({
      file: 'alpha-notes.md',
      title: 'Notas Alpha',
      chunks: ['Segredo exclusivo de astronomia sobre estrelas distantes'],
    });
    await storeBeta.upsertFileChunks({
      file: 'beta-notes.md',
      title: 'Notas Beta',
      chunks: ['Receita secreta de culinaria para fazer bolo de morango'],
    });

    assert.equal(existsSync(join(dir, 'characters', 'char-alpha', 'memory', 'lancedb')), true);
    assert.equal(existsSync(join(dir, 'characters', 'char-beta', 'memory', 'lancedb')), true);

    assert.equal(await storeAlpha.count(), 1);
    assert.equal(await storeBeta.count(), 1);

    const alphaOnAlpha = await storeAlpha.search({ query: 'astronomia estrela', limit: 3, minScore: 0.4 });
    assert.equal(alphaOnAlpha.length, 1);
    assert.match(alphaOnAlpha[0].text, /astronomia/);

    // Buscar conteúdo do beta no store do alpha não pode retornar o segredo do beta
    const betaQueryOnAlpha = await storeAlpha.search({ query: 'culinaria bolo', limit: 3, minScore: 0.7 });
    assert.equal(betaQueryOnAlpha.length, 0);

    const alphaQueryOnBeta = await storeBeta.search({ query: 'astronomia estrela', limit: 3, minScore: 0.7 });
    assert.equal(alphaQueryOnBeta.length, 0);

    const betaOnBeta = await storeBeta.search({ query: 'culinaria bolo', limit: 3, minScore: 0.4 });
    assert.equal(betaOnBeta.length, 1);
    assert.match(betaOnBeta[0].text, /bolo de morango/);
  } finally {
    await storeAlpha.close();
    await storeBeta.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch { }
  }
});

test('lancedb-store: rejeita characterId com path traversal e expõe stats de cache ONNX global', async () => {
  assert.throws(
    () => new LanceMemoryStore({ dataDir: tmpdir(), characterId: '../evil' }),
    /characterId inválido/,
  );

  clearSharedEmbedderCache();
  const initialStats = getSharedEmbedderCacheStats();
  assert.equal(initialStats.size, 0);

  // Texto vazio retorna vetor zero imediato sem alocar pipeline
  const emptyVec = await embedText('   ');
  assert.equal(emptyVec.length, EMBEDDING_DIMENSION);
  assert.equal(emptyVec[0], 0);
});
