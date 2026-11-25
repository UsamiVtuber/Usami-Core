/**
 * Testes da skill Note Linker
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createNoteLinkerCore } from '../note-linker-core.mjs';

describe('note-linker skill', () => {
  let tempDir;
  let linker;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'usami-note-linker-'));
    linker = createNoteLinkerCore({ dataDir: tempDir });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // --- upsertNote ---

  test('upsertNote cria nota com defaults', async () => {
    const result = await linker.upsertNote({ title: 'Minha nota' });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.action, 'created');
    assert.ok(result.note.id.startsWith('note-'));
    assert.strictEqual(result.note.title, 'Minha nota');
    assert.strictEqual(result.note.content, '');
    assert.deepStrictEqual(result.note.tags, []);
    assert.deepStrictEqual(result.note.links, []);
    assert.deepStrictEqual(result.note.backlinks, []);
  });

  test('upsertNote cria nota com conteúdo, tags e links', async () => {
    const result = await linker.upsertNote({
      title: 'Projeto',
      content: 'Ver [[Tarefas]] e [[Reuniões]]',
      tags: ['trabalho', 'urgente'],
      links: ['Tarefas', 'Reuniões'],
    });
    assert.strictEqual(result.note.content, 'Ver [[Tarefas]] e [[Reuniões]]');
    assert.deepStrictEqual(result.note.tags, ['trabalho', 'urgente']);
    assert.deepStrictEqual(result.note.links, ['Tarefas', 'Reuniões']);
  });

  test('upsertNote auto-extrai links do conteúdo', async () => {
    const result = await linker.upsertNote({
      title: 'Auto links',
      content: 'Veja [[Nota A]] e também [[Nota B]] e [[Nota A]] de novo',
    });
    assert.deepStrictEqual(result.note.links.sort(), ['Nota A', 'Nota B']);
  });

  test('upsertNote atualiza nota existente', async () => {
    const created = await linker.upsertNote({ title: 'Original' });
    const noteId = created.note.id;

    const updated = await linker.upsertNote({ id: noteId, title: 'Atualizada', tags: ['nova'] });
    assert.strictEqual(updated.action, 'updated');
    assert.strictEqual(updated.note.title, 'Atualizada');
    assert.deepStrictEqual(updated.note.tags, ['nova']);
  });

  test('upsertNote falha sem title', async () => {
    await assert.rejects(
      linker.upsertNote({ title: '' }),
      /title: obrigatório/
    );
  });

  test('upsertNote falha ao atualizar ID inexistente', async () => {
    await assert.rejects(
      linker.upsertNote({ id: 'note-abcdef123456', title: 'Teste' }),
      /nota não encontrada/
    );
  });

  // --- getNote ---

  test('getNote obtém nota por ID', async () => {
    const created = await linker.upsertNote({ title: 'Buscar por ID', content: 'Conteúdo' });
    const result = linker.getNote({ id: created.note.id });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.note.title, 'Buscar por ID');
    assert.strictEqual(result.note.content, 'Conteúdo');
  });

  test('getNote obtém nota por título', async () => {
    await linker.upsertNote({ title: 'Título Único', content: 'Conteúdo' });
    const result = linker.getNote({ title: 'Título Único' });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.note.title, 'Título Único');
  });

  test('getNote falha sem id nem title', () => {
    assert.throws(
      () => linker.getNote({}),
      /id ou title: obrigatório/
    );
  });

  test('getNote falha com ID inexistente', () => {
    assert.throws(
      () => linker.getNote({ id: 'note-abcdef123456' }),
      /nota não encontrada/
    );
  });

  // --- searchNotes ---

  test('searchNotes busca por query no título', async () => {
    await linker.upsertNote({ title: 'Projeto Alpha', content: '...' });
    await linker.upsertNote({ title: 'Projeto Beta', content: '...' });
    await linker.upsertNote({ title: 'Outro', content: '...' });

    const result = linker.searchNotes({ query: 'alpha' });
    assert.strictEqual(result.count, 1);
    assert.strictEqual(result.notes[0].title, 'Projeto Alpha');
  });

  test('searchNotes busca por query no conteúdo', async () => {
    await linker.upsertNote({ title: 'A', content: 'palavra secreta' });
    await linker.upsertNote({ title: 'B', content: 'outra coisa' });

    const result = linker.searchNotes({ query: 'secreta' });
    assert.strictEqual(result.count, 1);
    assert.strictEqual(result.notes[0].title, 'A');
  });

  test('searchNotes filtra por tag', async () => {
    await linker.upsertNote({ title: 'T1', tags: ['trabalho'] });
    await linker.upsertNote({ title: 'T2', tags: ['pessoal'] });
    await linker.upsertNote({ title: 'T3', tags: ['trabalho', 'urgente'] });

    const result = linker.searchNotes({ tag: 'trabalho' });
    assert.strictEqual(result.count, 2);
    assert.ok(result.notes.every(n => n.tags.includes('trabalho')));
  });

  test('searchNotes combina query e tag', async () => {
    await linker.upsertNote({ title: 'Projeto X', tags: ['trabalho'], content: 'importante' });
    await linker.upsertNote({ title: 'Projeto Y', tags: ['trabalho'], content: 'normal' });
    await linker.upsertNote({ title: 'Projeto Z', tags: ['pessoal'], content: 'importante' });

    const result = linker.searchNotes({ query: 'importante', tag: 'trabalho' });
    assert.strictEqual(result.count, 1);
    assert.strictEqual(result.notes[0].title, 'Projeto X');
  });

  test('searchNotes respeita limit', async () => {
    await linker.upsertNote({ title: 'N1' });
    await linker.upsertNote({ title: 'N2' });
    await linker.upsertNote({ title: 'N3' });

    const result = linker.searchNotes({ limit: 2 });
    assert.strictEqual(result.count, 2);
  });

  // --- linkNote ---

  test('linkNote adiciona link para outra nota', async () => {
    const noteA = await linker.upsertNote({ title: 'Nota A' });
    const noteB = await linker.upsertNote({ title: 'Nota B' });

    const result = await linker.linkNote({ noteId: noteA.note.id, linkTitle: 'Nota B' });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.action, 'add');
    assert.ok(result.note.links.includes('Nota B'));

    // Verifica backlink na nota B
    const noteBUpdated = linker.getNote({ id: noteB.note.id });
    assert.ok(noteBUpdated.note.backlinks.includes(noteA.note.id));
  });

  test('linkNote não duplica link existente', async () => {
    const noteA = await linker.upsertNote({ title: 'Nota A', links: ['Nota B'] });
    await linker.upsertNote({ title: 'Nota B' });

    const result = await linker.linkNote({ noteId: noteA.note.id, linkTitle: 'Nota B' });
    assert.strictEqual(result.action, 'noop');
  });

  test('linkNote remove link', async () => {
    const noteA = await linker.upsertNote({ title: 'Nota A', links: ['Nota B'] });
    await linker.upsertNote({ title: 'Nota B' });

    const result = await linker.linkNote({ noteId: noteA.note.id, linkTitle: 'Nota B', action: 'remove' });
    assert.strictEqual(result.action, 'remove');
    assert.ok(!result.note.links.includes('Nota B'));

    // Verifica backlink removido
    const noteBUpdated = linker.getNote({ title: 'Nota B' });
    assert.ok(!noteBUpdated.note.backlinks.includes(noteA.note.id));
  });

  test('linkNote falha com noteId inválido', async () => {
    await assert.rejects(
      linker.linkNote({ noteId: 'note-abcdef123456', linkTitle: 'X' }),
      /nota não encontrada/
    );
  });

  // --- getBacklinks ---

  test('getBacklinks retorna notas que linkam para a nota', async () => {
    const noteA = await linker.upsertNote({ title: 'Nota A' });
    const noteB = await linker.upsertNote({ title: 'Nota B', links: ['Nota A'] });
    const noteC = await linker.upsertNote({ title: 'Nota C', links: ['Nota A'] });

    const result = linker.getBacklinks({ noteId: noteA.note.id });
    assert.strictEqual(result.count, 2);
    const backlinkTitles = result.backlinks.map(b => b.title).sort();
    assert.deepStrictEqual(backlinkTitles, ['Nota B', 'Nota C']);
  });

  test('getBacklinks retorna vazio se ninguém linka', async () => {
    const note = await linker.upsertNote({ title: 'Isolada' });
    const result = linker.getBacklinks({ noteId: note.note.id });
    assert.strictEqual(result.count, 0);
    assert.deepStrictEqual(result.backlinks, []);
  });

  // --- getGraph ---

  test('getGraph retorna nodes e edges', async () => {
    const noteA = await linker.upsertNote({ title: 'A', links: ['B'] });
    const noteB = await linker.upsertNote({ title: 'B', links: ['C'] });
    await linker.upsertNote({ title: 'C' });

    const result = linker.getGraph();
    assert.strictEqual(result.nodes.length, 3);
    assert.strictEqual(result.edges.length, 2);

    const edgeAB = result.edges.find(e => e.source === noteA.note.id && e.target === noteB.note.id);
    assert.ok(edgeAB);
  });

  // --- listTags ---

  test('listTags retorna todas as tags únicas ordenadas', async () => {
    await linker.upsertNote({ title: 'T1', tags: ['b', 'a'] });
    await linker.upsertNote({ title: 'T2', tags: ['a', 'c'] });

    const result = linker.listTags();
    assert.deepStrictEqual(result.tags, ['a', 'b', 'c']);
    assert.strictEqual(result.count, 3);
  });

  // --- listNotes ---

  test('listNotes lista todas as notas', async () => {
    await linker.upsertNote({ title: 'Nota 1' });
    await linker.upsertNote({ title: 'Nota 2' });

    const result = linker.listNotes();
    assert.strictEqual(result.count, 2);
  });

  test('listNotes filtra por tag', async () => {
    await linker.upsertNote({ title: 'T1', tags: ['trabalho'] });
    await linker.upsertNote({ title: 'T2', tags: ['pessoal'] });

    const result = linker.listNotes({ tag: 'trabalho' });
    assert.strictEqual(result.count, 1);
    assert.strictEqual(result.notes[0].title, 'T1');
  });

  // --- deleteNote ---

  test('deleteNote remove nota e seus backlinks', async () => {
    const noteA = await linker.upsertNote({ title: 'Nota A' });
    const noteB = await linker.upsertNote({ title: 'Nota B', links: ['Nota A'] });

    const result = await linker.deleteNote({ id: noteA.note.id });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.removed, true);

    // Nota A não existe mais
    assert.throws(
      () => linker.getNote({ id: noteA.note.id }),
      /nota não encontrada/
    );

    // Backlink removido da Nota B
    const noteBUpdated = linker.getNote({ id: noteB.note.id });
    assert.ok(!noteBUpdated.note.backlinks.includes(noteA.note.id));
  });

  test('deleteNote falha com ID inexistente', async () => {
    await assert.rejects(
      linker.deleteNote({ id: 'note-abcdef123456' }),
      /nota não encontrada/
    );
  });

  // --- Tool Specs ---

  test('toolSpecs expõe 9 ferramentas com verify functions', () => {
    const specs = linker.toolSpecs;
    assert.strictEqual(specs.length, 9);
    const names = specs.map(s => s.name).sort();
    assert.deepStrictEqual(names, [
      'note.backlinks',
      'note.delete',
      'note.get',
      'note.graph',
      'note.link',
      'note.list',
      'note.search',
      'note.tags',
      'note.upsert',
    ]);
    for (const spec of specs) {
      assert.strictEqual(typeof spec.verify, 'function');
      assert.ok(spec.permissionLevel >= 1 && spec.permissionLevel <= 3);
    }
  });

  // --- Persistência ---

  test('dados persistem entre instâncias (mesmo dataDir)', async () => {
    const created = await linker.upsertNote({ title: 'Persistente', tags: ['teste'], content: 'conteúdo' });
    await linker.linkNote({ noteId: created.note.id, linkTitle: 'Outra' });

    // Nova instância com mesmo dataDir
    const linker2 = createNoteLinkerCore({ dataDir: tempDir });
    const note = linker2.getNote({ id: created.note.id });

    assert.strictEqual(note.note.title, 'Persistente');
    assert.deepStrictEqual(note.note.tags, ['teste']);
    assert.strictEqual(note.note.content, 'conteúdo');
  });

  // --- Atualização de links via upsertNote ---

  test('upsertNote atualiza links e mantém backlinks sincronizados', async () => {
    const noteA = await linker.upsertNote({ title: 'Nota A' });
    const noteB = await linker.upsertNote({ title: 'Nota B' });
    const noteC = await linker.upsertNote({ title: 'Nota C' });

    // A linka para B
    await linker.upsertNote({ id: noteA.note.id, links: ['Nota B'] });
    let noteBUpdated = linker.getNote({ id: noteB.note.id });
    assert.ok(noteBUpdated.note.backlinks.includes(noteA.note.id));

    // Atualiza A para linkar para C em vez de B
    await linker.upsertNote({ id: noteA.note.id, links: ['Nota C'] });
    noteBUpdated = linker.getNote({ id: noteB.note.id });
    assert.ok(!noteBUpdated.note.backlinks.includes(noteA.note.id));

    const noteCUpdated = linker.getNote({ id: noteC.note.id });
    assert.ok(noteCUpdated.note.backlinks.includes(noteA.note.id));
  });

  // --- Extração de links do conteúdo na atualização ---

  test('atualização de content re-extrai links automaticamente', async () => {
    const noteA = await linker.upsertNote({ title: 'Nota A' });
    const noteB = await linker.upsertNote({ title: 'Nota B' });

    await linker.upsertNote({ id: noteA.note.id, content: 'Veja [[Nota B]]' });
    const noteAUpdated = linker.getNote({ id: noteA.note.id });
    assert.ok(noteAUpdated.note.links.includes('Nota B'));

    const noteBUpdated = linker.getNote({ id: noteB.note.id });
    assert.ok(noteBUpdated.note.backlinks.includes(noteA.note.id));
  });
});