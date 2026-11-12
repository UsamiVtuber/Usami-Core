#!/usr/bin/env node
// Script de indexação em lote do Vault Obsidian para o LanceDB.
// Execução: npm run index:vault

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { LanceMemoryStore } from '../src/lancedb-store.js';
import { resolveVaultDir, stripFrontmatter } from '../src/rag.js';

const CHUNK_SIZE = 400; // Caracteres por chunk semântico
const CHUNK_OVERLAP = 50;

function splitIntoChunks(text) {
  const clean = text.trim();
  if (!clean) return [];
  if (clean.length <= CHUNK_SIZE) return [clean];

  const chunks = [];
  let start = 0;
  while (start < clean.length) {
    const end = Math.min(start + CHUNK_SIZE, clean.length);
    chunks.push(clean.slice(start, end));
    if (end >= clean.length) break;
    start += CHUNK_SIZE - CHUNK_OVERLAP;
  }
  return chunks;
}

async function runIndex() {
  console.log('🚀 Iniciando indexação semântica do Obsidian no LanceDB...');
  const responsesDir = resolveVaultDir();
  const automationsDir = path.resolve(responsesDir, '../Automations');
  const targetDirs = [responsesDir, automationsDir];

  let files = [];
  for (const dir of targetDirs) {
    try {
      const dirEntries = readdirSync(dir, { withFileTypes: true });
      const dirFiles = dirEntries
        .filter((e) => e.isFile() && e.name.endsWith('.md'))
        .map((e) => path.join(dir, e.name));
      files.push(...dirFiles);
      console.log(`📁 Diretório verificado: ${dir} (${dirFiles.length} notas)`);
    } catch (err) {
      console.warn(`[index-vault] Diretório não acessível: ${dir} (${err.message})`);
    }
  }

  if (!files.length) {
    console.log('ℹ️ Nenhuma nota .md encontrada no diretório do Vault.');
    process.exit(0);
  }

  const store = new LanceMemoryStore();
  await store.init();

  let totalChunks = 0;
  for (const filePath of files) {
    const stat = statSync(filePath);
    const content = readFileSync(filePath, 'utf-8');
    const stripped = stripFrontmatter(content);
    const chunks = splitIntoChunks(stripped);
    const relative = path.relative(path.resolve(responsesDir, '../..'), filePath);

    if (chunks.length > 0) {
      await store.upsertFileChunks({
        file: relative,
        title: path.basename(filePath, '.md'),
        chunks,
        mtime: stat.mtimeMs,
      });
      totalChunks += chunks.length;
      console.log(`  ✓ Indexado: ${path.basename(filePath)} (${chunks.length} chunks)`);
    }
  }

  const finalCount = await store.count();
  console.log(`✨ Concluído! Total de chunks armazenados no LanceDB: ${finalCount}`);
}

runIndex().catch((err) => {
  console.error('❌ Erro na indexação:', err);
  process.exit(1);
});

