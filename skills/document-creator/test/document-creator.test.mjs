import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DOCUMENT_SCHEMA,
  buildDocumentDraft,
  validateDocumentFilename,
  writeSafeDocument,
  createDocumentStore,
} from '../document-core.mjs';

test('buildDocumentDraft gera markdown válido e validateDocumentFilename bloqueia traversal', () => {
  const draft = buildDocumentDraft({
    title: 'Checklist de Lançamento',
    format: 'checklist',
    sections: [{ heading: 'Pré-voo', body: 'Rodar testes\nConferir build' }],
    tags: ['release'],
    nowMs: Date.parse('2026-11-11T12:00:00.000Z'),
  });

  assert.equal(draft.schema, DOCUMENT_SCHEMA);
  assert.equal(draft.filename, 'checklist-de-lancamento.md');
  assert.match(draft.content, /- \[ \] Rodar testes/);

  assert.equal(validateDocumentFilename('../fora.md').ok, false);
  assert.equal(validateDocumentFilename('.env').ok, false);
  assert.equal(validateDocumentFilename('sub/nota.md').ok, false);
  assert.equal(validateDocumentFilename('nota-ok.md').ok, true);
});

test('writeSafeDocument respeita pasta permitida e impede sobrescrita acidental', t => {
  const baseRoot = process.env.USAMI_DATA_DIR || tmpdir();
  const dir = mkdtempSync(join(baseRoot, 'doc-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const first = writeSafeDocument({
    allowedDir: dir,
    filename: 'resumo.md',
    content: '# Resumo\n\nConteúdo inicial.\n',
  });
  assert.equal(first.written, true);
  assert.equal(first.overwritten, false);
  assert.match(readFileSync(join(dir, 'resumo.md'), 'utf8'), /Conteúdo inicial/);

  assert.throws(() => writeSafeDocument({
    allowedDir: dir,
    filename: 'resumo.md',
    content: '# Novo\n',
    overwrite: false,
  }), /já existe/);

  const second = writeSafeDocument({
    allowedDir: dir,
    filename: 'resumo.md',
    content: '# Novo\n',
    overwrite: true,
  });
  assert.equal(second.overwritten, true);
});

// --- Store tests ---

test('createDocumentStore cria e persiste documentos', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'doc-store-'));
  const store = createDocumentStore({ dataDir: dir });

  const created = store.createDocument({
    title: 'Teste',
    format: 'note',
    filename: 'teste.md',
    content: '# Teste\n\nConteúdo.',
    tags: ['teste'],
  });
  assert.equal(created.ok, true);
  assert.ok(created.document.id.startsWith('doc-'));
  assert.equal(created.document.title, 'Teste');
  assert.equal(created.document.version, 1);

  // Nova instância deve carregar
  const store2 = createDocumentStore({ dataDir: dir });
  const doc = store2.getDocument(created.document.id);
  assert.ok(doc);
  assert.equal(doc.title, 'Teste');
  assert.equal(doc.tags[0], 'teste');
});

test('updateDocument versiona conteúdo', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'doc-store-'));
  const store = createDocumentStore({ dataDir: dir });

  const created = store.createDocument({
    title: 'Original',
    format: 'note',
    filename: 'original.md',
    content: 'v1',
  });

  const updated = store.updateDocument(created.document.id, {
    content: 'v2',
    title: 'Atualizado',
  });
  assert.equal(updated.ok, true);
  assert.equal(updated.document.version, 2);
  assert.equal(updated.document.content, 'v2');
  assert.equal(updated.document.title, 'Atualizado');

  const history = store.getDocumentHistory(created.document.id);
  assert.equal(history.length, 2);
  assert.equal(history[0].version, 1);
  assert.equal(history[1].version, 2);

  const v1 = store.getDocumentVersion(created.document.id, 1);
  assert.equal(v1.content, 'v1');
  const v2 = store.getDocumentVersion(created.document.id, 2);
  assert.equal(v2.content, 'v2');
});

test('listDocuments filtra por tag, formato e query', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'doc-store-'));
  const store = createDocumentStore({ dataDir: dir });

  store.createDocument({ title: 'Nota A', format: 'note', filename: 'a.md', content: 'conteúdo A', tags: ['trabalho'] });
  store.createDocument({ title: 'Nota B', format: 'note', filename: 'b.md', content: 'conteúdo B', tags: ['pessoal'] });
  store.createDocument({ title: 'Checklist C', format: 'checklist', filename: 'c.md', content: 'itens', tags: ['trabalho'] });

  const byTag = store.listDocuments({ tag: 'trabalho' });
  assert.equal(byTag.length, 2);
  assert.ok(byTag.every(d => d.tags.includes('trabalho')));

  const byFormat = store.listDocuments({ format: 'checklist' });
  assert.equal(byFormat.length, 1);
  assert.equal(byFormat[0].format, 'checklist');

  const byQuery = store.listDocuments({ query: 'conteúdo' });
  assert.equal(byQuery.length, 2);
});

test('searchDocuments busca full-text', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'doc-store-'));
  const store = createDocumentStore({ dataDir: dir });

  store.createDocument({ title: 'Projeto Alpha', format: 'note', filename: 'a.md', content: 'importante', tags: [] });
  store.createDocument({ title: 'Projeto Beta', format: 'note', filename: 'b.md', content: 'normal', tags: [] });

  const results = store.searchDocuments({ query: 'importante' });
  assert.equal(results.length, 1);
  assert.equal(results[0].title, 'Projeto Alpha');
});

test('deleteDocument remove documento', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'doc-store-'));
  const store = createDocumentStore({ dataDir: dir });

  const created = store.createDocument({ title: 'Para Apagar', format: 'note', filename: 'del.md', content: 'x' });
  const deleted = store.deleteDocument(created.document.id);
  assert.equal(deleted.ok, true);
  assert.equal(deleted.removed, true);

  assert.equal(store.getDocument(created.document.id), null);
});

test('getAllTags retorna tags únicas ordenadas', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'doc-store-'));
  const store = createDocumentStore({ dataDir: dir });

  store.createDocument({ title: 'A', format: 'note', filename: 'a.md', content: '', tags: ['b', 'a'] });
  store.createDocument({ title: 'B', format: 'note', filename: 'b.md', content: '', tags: ['a', 'c'] });

  const tags = store.getAllTags();
  assert.deepEqual(tags, ['a', 'b', 'c']);
});

test('getStats retorna estatísticas', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'doc-store-'));
  const store = createDocumentStore({ dataDir: dir });

  store.createDocument({ title: 'A', format: 'note', filename: 'a.md', content: 'hello', tags: ['t1'] });
  store.createDocument({ title: 'B', format: 'checklist', filename: 'b.md', content: 'world', tags: ['t1', 't2'] });

  const stats = store.getStats();
  assert.equal(stats.totalDocuments, 2);
  assert.ok(stats.totalBytes > 0);
  assert.equal(stats.byFormat.note, 1);
  assert.equal(stats.byFormat.checklist, 1);
  assert.equal(stats.byTag[0][0], 't1');
  assert.equal(stats.byTag[0][1], 2);
});

// --- Templates ---

test('createTemplate cria template padrão', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'doc-store-'));
  const store = createDocumentStore({ dataDir: dir });

  const created = store.createTemplate({
    name: 'Meu Template',
    format: 'note',
    titleTemplate: '{{date}} - {{title}}',
    sectionsTemplate: [{ heading: 'Secao', body: '' }],
    tagsTemplate: ['tag1'],
  });
  assert.equal(created.ok, true);
  assert.equal(created.template.name, 'Meu Template');
  assert.equal(created.template.format, 'note');
});

test('initializeDefaults cria templates padrão', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'doc-store-'));
  const store = createDocumentStore({ dataDir: dir });
  store.initializeDefaults();

  const templates = store.listTemplates();
  assert.ok(templates.length >= 4);
  const names = templates.map(t => t.name);
  assert.ok(names.includes('Reunião'));
  assert.ok(names.includes('ADR (Decisão de Arquitetura)'));
  assert.ok(names.includes('Checklist'));
  assert.ok(names.includes('Resumo Diário'));
});

test('template upsert e delete', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'doc-store-'));
  const store = createDocumentStore({ dataDir: dir });

  const created = store.createTemplate({ name: 'Temp', format: 'note' });
  const updated = store.updateTemplate(created.template.id, { name: 'Atualizado' });
  assert.equal(updated.template.name, 'Atualizado');

  const deleted = store.deleteTemplate(created.template.id);
  assert.equal(deleted.ok, true);
  assert.equal(deleted.removed, true);
  assert.equal(store.getTemplate(created.template.id), null);
});