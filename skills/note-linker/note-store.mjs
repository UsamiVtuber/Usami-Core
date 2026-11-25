/**
 * Note Linker Store
 * Dedicated JSON store for notes with bidirectional links.
 * Lazy-loads on first write; preserves data across instances.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir as resolveDataDir } from '../../src/data-paths.js';

const FILE_VERSION = 1;
const NOTE_TAG = 'note';

function generateId() {
  return `note-${Math.random().toString(36).slice(2, 14)}`;
}

function isoNow() {
  return new Date().toISOString();
}

function defaultData() {
  return {
    version: FILE_VERSION,
    notes: [],
    updatedAt: isoNow(),
  };
}

function normalize(input) {
  if (!input || typeof input !== 'object') return defaultData();
  if (input.version !== FILE_VERSION) {
    // Future migration logic here
  }
  return {
    version: FILE_VERSION,
    notes: Array.isArray(input.notes) ? input.notes : [],
    updatedAt: typeof input.updatedAt === 'string' ? input.updatedAt : isoNow(),
  };
}

function extractLinks(content) {
  if (!content || typeof content !== 'string') return [];
  const linkRegex = /\[\[([^\]]+)\]\]/g;
  const links = [];
  let match;
  while ((match = linkRegex.exec(content)) !== null) {
    links.push(match[1].trim());
  }
  return [...new Set(links)]; // deduplicate
}

export function createNoteStore({ dataDir = resolveDataDir() } = {}) {
  const filePath = join(dataDir, 'notes.json');
  let data = defaultData();
  let loaded = false;

  function ensureLoaded() {
    if (loaded) return;
    if (existsSync(filePath)) {
      try {
        data = normalize(JSON.parse(readFileSync(filePath, 'utf8')));
      } catch {
        data = defaultData();
      }
    }
    loaded = true;
  }

  function persist() {
    ensureLoaded();
    data.updatedAt = isoNow();
    mkdirSync(join(dataDir), { recursive: true });
    writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  }

  function snapshot() {
    ensureLoaded();
    return {
      notes: data.notes.map(n => ({ ...n })),
      updatedAt: data.updatedAt,
    };
  }

  function get(id) {
    ensureLoaded();
    const note = data.notes.find(n => n.id === id);
    return note ? { ...note } : null;
  }

  function getByTitle(title) {
    ensureLoaded();
    const note = data.notes.find(n => n.title.toLowerCase() === title.toLowerCase());
    return note ? { ...note } : null;
  }

  function list({ limit = 500, tag, query } = {}) {
    ensureLoaded();
    let notes = data.notes;

    if (tag) {
      notes = notes.filter(n => n.tags?.includes(tag));
    }

    if (query) {
      const q = query.toLowerCase();
      notes = notes.filter(n =>
        n.title.toLowerCase().includes(q) ||
        n.content.toLowerCase().includes(q) ||
        n.tags?.some(t => t.toLowerCase().includes(q))
      );
    }

    // Sort by updatedAt desc
    notes = [...notes].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

    if (limit > 0) notes = notes.slice(0, limit);

    return notes.map(n => ({ ...n }));
  }

  function create(note) {
    ensureLoaded();
    const now = isoNow();
    const newNote = {
      schema: 'usami.note.v1',
      id: note.id || generateId(),
      title: note.title?.trim() || 'Sem título',
      content: note.content || '',
      tags: Array.isArray(note.tags) ? note.tags : [],
      links: Array.isArray(note.links) ? note.links : [],
      backlinks: [],
      createdAt: now,
      updatedAt: now,
    };

    // Auto-extract links from content if not provided
    if (!note.links || note.links.length === 0) {
      newNote.links = extractLinks(newNote.content);
    }

    data.notes.push(newNote);
    updateBacklinks(newNote.id, newNote.links, 'add');
    persist();
    return { ok: true, note: { ...newNote } };
  }

  function update(id, patch) {
    ensureLoaded();
    const index = data.notes.findIndex(n => n.id === id);
    if (index < 0) return { ok: false, notFound: true };

    const current = data.notes[index];
    const next = { ...current };
    const changed = [];

    const editableFields = ['title', 'content', 'tags'];
    for (const field of editableFields) {
      if (field in patch) {
        if (field === 'tags') {
          next.tags = Array.isArray(patch.tags) ? patch.tags : [];
        } else {
          next[field] = patch[field];
        }
        changed.push(field);
      }
    }

    // Handle link updates specially
    if ('links' in patch) {
      const newLinks = Array.isArray(patch.links) ? patch.links : [];
      const oldLinks = current.links || [];

      // Update backlinks: remove old, add new
      updateBacklinks(id, oldLinks, 'remove');
      updateBacklinks(id, newLinks, 'add');

      next.links = newLinks;
      changed.push('links');
    }

    if (!changed.length) return { ok: true, note: { ...current }, changed: [] };

    next.updatedAt = isoNow();

    // Re-extract links from content if content changed and links not explicitly provided
    if (changed.includes('content') && !changed.includes('links')) {
      next.links = extractLinks(next.content);
      updateBacklinks(id, current.links || [], 'remove');
      updateBacklinks(id, next.links, 'add');
      changed.push('links');
    }

    data.notes[index] = next;
    persist();
    return { ok: true, note: { ...next }, changed };
  }

  function updateBacklinks(noteId, linkTitles, action) {
    for (const linkTitle of linkTitles) {
      const target = data.notes.find(n => n.title.toLowerCase() === linkTitle.toLowerCase());
      if (target) {
        const backlinks = target.backlinks || [];
        if (action === 'add') {
          if (!backlinks.includes(noteId)) {
            target.backlinks = [...backlinks, noteId];
          }
        } else {
          target.backlinks = backlinks.filter(b => b !== noteId);
        }
      }
    }
  }

  function remove(id) {
    ensureLoaded();
    const index = data.notes.findIndex(n => n.id === id);
    if (index < 0) return { ok: false, notFound: true };

    const note = data.notes[index];
    // Remove backlinks from linked notes
    updateBacklinks(id, note.links || [], 'remove');

    data.notes.splice(index, 1);
    persist();
    return { ok: true, removed: true };
  }

  function getGraph() {
    ensureLoaded();
    const nodes = data.notes.map(n => ({
      id: n.id,
      title: n.title,
      tags: n.tags,
      linkCount: (n.links || []).length,
      backlinkCount: (n.backlinks || []).length,
    }));

    const edges = [];
    for (const note of data.notes) {
      for (const linkTitle of note.links || []) {
        const target = data.notes.find(n => n.title.toLowerCase() === linkTitle.toLowerCase());
        if (target) {
          edges.push({ source: note.id, target: target.id, label: linkTitle });
        }
      }
    }

    return { nodes, edges };
  }

  function getAllTags() {
    ensureLoaded();
    const tagSet = new Set();
    for (const note of data.notes) {
      for (const tag of note.tags || []) {
        tagSet.add(tag);
      }
    }
    return [...tagSet].sort();
  }

  return {
    get,
    getByTitle,
    list,
    create,
    update,
    remove,
    getGraph,
    getAllTags,
    // For testing/debugging
    _ensureLoaded: ensureLoaded,
    _getRaw: () => snapshot(),
  };
}