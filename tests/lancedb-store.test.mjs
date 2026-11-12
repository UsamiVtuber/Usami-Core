import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LanceMemoryStore } from '../src/lancedb-store.js';

test('lancedb-store: inicializa tabela, insere chunks e busca semântica', async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'usami-lance-test-'));

  try {
    const store = new LanceMemoryStore({ dataDir: tempDir });

    await store.init();
    const initialCount = await store.count();
    assert.equal(initialCount, 0);

    // Inserção de chunks de exemplo
    await store.upsertFileChunks({
      file: 'Inbox/Responses/cafe_da_manha.md',
      title: 'Café da Manhã Preferido',
      chunks: [
        'O usuário toma café coado sem açúcar toda manhã antes de começar a programar.',
      ],
      mtime: 1700000000000,
    });

    await store.upsertFileChunks({
      file: 'Inbox/Responses/musica.md',
      title: 'Gostos Musicais',
      chunks: [
        'Adora ouvir City Pop japonês e lo-fi enquanto trabalha.',
      ],
      mtime: 1700000001000,
    });

    const countAfter = await store.count();
    assert.equal(countAfter, 2);

    // Busca por café
    const results = await store.search({ query: 'café sem açúcar', limit: 3 });
    assert.ok(results.length >= 1);
    assert.ok(results[0].text.includes('café'));
    assert.ok(results[0].score > 0);

    // Limpeza
    await store.removeFile('Inbox/Responses/cafe_da_manha.md');
  } finally {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

