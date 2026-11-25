/**
 * Note Linker Skill Core
 * Gerencia notas com links bidirecionais, backlinks, grafo, busca e tags.
 */
import { createNoteStore } from './note-store.mjs';
import { dataDir as resolveDataDir } from '../../src/data-paths.js';

function nowIso() {
  return new Date().toISOString();
}

export function createNoteLinkerCore({
  dataDir = resolveDataDir(),
} = {}) {
  const noteStore = createNoteStore({ dataDir });

  // --- Tools ---

  /**
   * Cria ou atualiza uma nota.
   * @param {{id?:string, title?:string, content?:string, tags?:string[], links?:string[]}} params
   */
  async function upsertNote({ id, title, content = '', tags = [], links }) {
    if (id) {
      const existing = noteStore.get(id);
      if (!existing) throw new Error(`nota não encontrada (${id})`);

      const patch = { updatedAt: nowIso() };
      if (title !== undefined) {
        if (!title?.trim()) throw new Error('title: não pode ser vazio');
        patch.title = title.trim();
      }
      if (content !== undefined) patch.content = content;
      if (tags.length > 0) patch.tags = tags;
      if (links !== undefined) patch.links = links;

      const updated = noteStore.update(id, patch);
      if (!updated.ok) throw new Error(updated.notFound ? `nota não encontrada (${id})` : 'falha ao atualizar');
      return { ok: true, action: 'updated', note: updated.note };
    }

    if (!title?.trim()) throw new Error('title: obrigatório');
    const created = noteStore.create({ title: title.trim(), content, tags, links });
    if (!created.ok) throw new Error('falha ao criar');
    return { ok: true, action: 'created', note: created.note };
  }

  /**
   * Obtém uma nota por ID ou título.
   * @param {{id?:string, title?:string}} params
   */
  function getNote({ id, title }) {
    if (!id && !title) throw new Error('id ou title: obrigatório');

    const note = id ? noteStore.get(id) : noteStore.getByTitle(title);
    if (!note) throw new Error(id ? `nota não encontrada (${id})` : `nota não encontrada com título "${title}"`);

    return { ok: true, note };
  }

  /**
   * Busca notas por query, tag ou lista todas.
   * @param {{query?:string, tag?:string, limit?:number}} params
   */
  function searchNotes({ query, tag, limit = 50 } = {}) {
    const notes = noteStore.list({ query, tag, limit });
    return { ok: true, notes, count: notes.length };
  }

  /**
   * Adiciona/remove link entre notas (formato [[Título]]).
   * @param {{noteId:string, linkTitle:string, action:'add'|'remove'}} params
   */
  async function linkNote({ noteId, linkTitle, action = 'add' }) {
    const note = noteStore.get(noteId);
    if (!note) throw new Error(`nota não encontrada (${noteId})`);

    const currentLinks = note.links || [];
    let newLinks;

    if (action === 'add') {
      if (currentLinks.includes(linkTitle)) {
        return { ok: true, action: 'noop', note, message: 'link já existe' };
      }
      newLinks = [...currentLinks, linkTitle];
    } else {
      newLinks = currentLinks.filter(l => l !== linkTitle);
    }

    const updated = noteStore.update(noteId, { links: newLinks });
    if (!updated.ok) throw new Error('falha ao atualizar links');
    return { ok: true, action, note: updated.note };
  }

  /**
   * Retorna backlinks de uma nota (quem linka para ela).
   * @param {{noteId:string}} params
   */
  function getBacklinks({ noteId }) {
    const note = noteStore.get(noteId);
    if (!note) throw new Error(`nota não encontrada (${noteId})`);

    const backlinkNotes = (note.backlinks || []).map(id => noteStore.get(id)).filter(Boolean);
    return {
      ok: true,
      noteId,
      title: note.title,
      backlinks: backlinkNotes.map(n => ({ id: n.id, title: n.title, tags: n.tags })),
      count: backlinkNotes.length,
    };
  }

  /**
   * Retorna grafo de notas (nodes + edges).
   * @param {{}} params
   */
  function getGraph() {
    const graph = noteStore.getGraph();
    return { ok: true, ...graph };
  }

  /**
   * Lista todas as tags usadas.
   * @param {{}} params
   */
  function listTags() {
    const tags = noteStore.getAllTags();
    return { ok: true, tags, count: tags.length };
  }

  /**
   * Lista notas com filtros.
   * @param {{status?:string, tag?:string, limit?:number}} params
   */
  function listNotes({ tag, limit = 100 } = {}) {
    const notes = noteStore.list({ tag, limit });
    return { ok: true, notes, count: notes.length };
  }

  /**
   * Remove uma nota.
   * @param {{id:string}} params
   */
  async function deleteNote({ id }) {
    const result = noteStore.remove(id);
    if (!result.ok) throw new Error(result.notFound ? `nota não encontrada (${id})` : 'falha ao remover');
    return { ok: true, removed: true };
  }

  // --- Tool Specs ---
  const toolSpecs = [
    {
      schema: 'usami.agent.tool.v1',
      name: 'note.upsert',
      version: '1.0.0',
      description: 'Cria ou atualiza uma nota com título, conteúdo, tags e links [[wiki]].',
      origin: 'skill',
      permissionLevel: 2,
      timeoutMs: 3000,
      parameters: [
        { name: 'id', type: 'string', required: false, description: 'ID note-... para atualização' },
        { name: 'title', type: 'string', required: true, description: 'Título da nota' },
        { name: 'content', type: 'string', required: false, description: 'Conteúdo (suporta [[links wiki]])' },
        { name: 'tags', type: 'array', required: false, description: 'Array de tags', items: { type: 'string' } },
        { name: 'links', type: 'array', required: false, description: 'Links explícitos (opcional, auto-extraído do conteúdo)', items: { type: 'string' } },
      ],
      verify: (result) => result && result.ok === true && result.note && typeof result.note.id === 'string',
    },
    {
      schema: 'usami.agent.tool.v1',
      name: 'note.get',
      version: '1.0.0',
      description: 'Obtém uma nota por ID ou título exato.',
      origin: 'skill',
      permissionLevel: 1,
      timeoutMs: 2000,
      parameters: [
        { name: 'id', type: 'string', required: false, description: 'ID da nota (note-...)' },
        { name: 'title', type: 'string', required: false, description: 'Título exato da nota' },
      ],
      verify: (result) => result && result.ok === true && result.note && typeof result.note.id === 'string',
    },
    {
      schema: 'usami.agent.tool.v1',
      name: 'note.search',
      version: '1.0.0',
      description: 'Busca notas por query de texto e/ou tag.',
      origin: 'skill',
      permissionLevel: 1,
      timeoutMs: 3000,
      parameters: [
        { name: 'query', type: 'string', required: false, description: 'Texto para buscar em título, conteúdo e tags' },
        { name: 'tag', type: 'string', required: false, description: 'Filtrar por tag específica' },
        { name: 'limit', type: 'number', required: false, description: 'Limite de resultados (padrão: 50)' },
      ],
      verify: (result) => result && result.ok === true && Array.isArray(result.notes) && typeof result.count === 'number',
    },
    {
      schema: 'usami.agent.tool.v1',
      name: 'note.link',
      version: '1.0.0',
      description: 'Adiciona ou remove link [[wiki]] para outra nota.',
      origin: 'skill',
      permissionLevel: 2,
      timeoutMs: 2000,
      parameters: [
        { name: 'noteId', type: 'string', required: true, description: 'ID da nota origem (note-...)' },
        { name: 'linkTitle', type: 'string', required: true, description: 'Título da nota alvo' },
        { name: 'action', type: 'string', required: false, description: 'add ou remove', enum: ['add', 'remove'] },
      ],
      verify: (result) => result && result.ok === true && result.note && Array.isArray(result.note.links),
    },
    {
      schema: 'usami.agent.tool.v1',
      name: 'note.backlinks',
      version: '1.0.0',
      description: 'Retorna backlinks (notas que linkam para esta).',
      origin: 'skill',
      permissionLevel: 1,
      timeoutMs: 2000,
      parameters: [
        { name: 'noteId', type: 'string', required: true, description: 'ID da nota (note-...)' },
      ],
      verify: (result) => result && result.ok === true && Array.isArray(result.backlinks) && typeof result.count === 'number',
    },
    {
      schema: 'usami.agent.tool.v1',
      name: 'note.graph',
      version: '1.0.0',
      description: 'Retorna grafo completo de notas (nodes + edges).',
      origin: 'skill',
      permissionLevel: 1,
      timeoutMs: 3000,
      parameters: [],
      verify: (result) => result && result.ok === true && Array.isArray(result.nodes) && Array.isArray(result.edges),
    },
    {
      schema: 'usami.agent.tool.v1',
      name: 'note.tags',
      version: '1.0.0',
      description: 'Lista todas as tags usadas nas notas.',
      origin: 'skill',
      permissionLevel: 1,
      timeoutMs: 2000,
      parameters: [],
      verify: (result) => result && result.ok === true && Array.isArray(result.tags) && typeof result.count === 'number',
    },
    {
      schema: 'usami.agent.tool.v1',
      name: 'note.list',
      version: '1.0.0',
      description: 'Lista notas com filtro opcional por tag.',
      origin: 'skill',
      permissionLevel: 1,
      timeoutMs: 2000,
      parameters: [
        { name: 'tag', type: 'string', required: false, description: 'Filtrar por tag' },
        { name: 'limit', type: 'number', required: false, description: 'Limite (padrão: 100)' },
      ],
      verify: (result) => result && result.ok === true && Array.isArray(result.notes) && typeof result.count === 'number',
    },
    {
      schema: 'usami.agent.tool.v1',
      name: 'note.delete',
      version: '1.0.0',
      description: 'Remove uma nota e seus backlinks.',
      origin: 'skill',
      permissionLevel: 3,
      timeoutMs: 2000,
      parameters: [
        { name: 'id', type: 'string', required: true, description: 'ID da nota (note-...)' },
      ],
      verify: (result) => result && result.ok === true && result.removed === true,
    },
  ];

  return {
    // API interna
    upsertNote,
    getNote,
    searchNotes,
    linkNote,
    getBacklinks,
    getGraph,
    listTags,
    listNotes,
    deleteNote,
    // Store
    noteStore,
    // Para registro no tool-registry
    toolSpecs,
  };
}