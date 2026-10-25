import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readRagContext } from '../src/rag.js';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

test('rag: retorna null quando o diretório não existe', async () => {
  const result = await readRagContext({ vaultRelative: './nao_existe_qualquer_coisa' });
  assert.equal(result, null);
});

test('rag: lê arquivos recentes do vault', async () => {
  const tmpDir = join(process.cwd(), 'tests', '_tmp_rag_vault');
  await mkdir(tmpDir, { recursive: true });

  await writeFile(join(tmpDir, '2026-10-25-teste1.md'), '---\nsource: usami-response\n---\n\nEsta é a primeira resposta da Usami.\n');
  await writeFile(join(tmpDir, '2026-10-25-teste2.md'), '---\nsource: usami-response\n---\n\nEsta é a segunda resposta da Usami.\n');

  const result = await readRagContext({
    vaultRelative: join('tests', '_tmp_rag_vault'),
    maxFiles: 5,
    maxCharsPerFile: 2000,
    maxTotalChars: 6000,
  });

  assert.ok(result, 'deve retornar contexto');
  assert.ok(result.includes('primeira resposta'), 'deve conter conteúdo do arquivo 1');
  assert.ok(result.includes('segunda resposta'), 'deve conter conteúdo do arquivo 2');

  // Limpeza
  await rm(tmpDir, { recursive: true, force: true });
});

test('rag: remove frontmatter do conteúdo', async () => {
  const tmpDir = join(process.cwd(), 'tests', '_tmp_rag_vault2');
  await mkdir(tmpDir, { recursive: true });

  await writeFile(join(tmpDir, '2026-10-25-fm.md'), '---\nsource: test\nkind: event\n---\n\nConteúdo sem frontmatter.\n');

  const result = await readRagContext({
    vaultRelative: join('tests', '_tmp_rag_vault2'),
    maxFiles: 5,
  });

  assert.ok(result, 'deve retornar contexto');
  assert.ok(!result.includes('---\nsource'), 'não deve conter frontmatter');
  assert.ok(result.includes('Conteúdo sem frontmatter'), 'deve conter o corpo');

  await rm(tmpDir, { recursive: true, force: true });
});

test('rag: respeita o limite máximo de caracteres', async () => {
  const tmpDir = join(process.cwd(), 'tests', '_tmp_rag_vault3');
  await mkdir(tmpDir, { recursive: true });

  const longContent = 'X'.repeat(5000);
  await writeFile(join(tmpDir, '2026-10-25-long.md'), longContent);

  const result = await readRagContext({
    vaultRelative: join('tests', '_tmp_rag_vault3'),
    maxFiles: 5,
    maxCharsPerFile: 100,
    maxTotalChars: 200,
  });

  assert.ok(result, 'deve retornar contexto');
  assert.ok(result.length <= 300, 'deve respeitar o limite total (com margem para headers)');

  await rm(tmpDir, { recursive: true, force: true });
});
