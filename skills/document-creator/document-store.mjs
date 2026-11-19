/**
 * Document Creator Store
 * Dedicated JSON store for documents with metadata, versioning, and templates.
 * Lazy-loads on first write; preserves data across instances.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir as resolveDataDir } from '../../src/data-paths.js';

const FILE_VERSION = 1;

function generateId(prefix = 'doc') {
  return `${prefix}-${Math.random().toString(36).slice(2, 14)}`;
}

function isoNow() {
  return new Date().toISOString();
}

function defaultData() {
  return {
    version: FILE_VERSION,
    documents: [],
    templates: [],
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
    documents: Array.isArray(input.documents) ? input.documents : [],
    templates: Array.isArray(input.templates) ? input.templates : [],
    updatedAt: typeof input.updatedAt === 'string' ? input.updatedAt : isoNow(),
  };
}

export function createDocumentStore({ dataDir = resolveDataDir() } = {}) {
  const filePath = join(dataDir, 'documents.json');
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
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  }

  function snapshot() {
    ensureLoaded();
    return {
      documents: data.documents.map(d => ({ ...d })),
      templates: data.templates.map(t => ({ ...t })),
      updatedAt: data.updatedAt,
    };
  }

  // --- Documents ---

  function createDocument(doc) {
    ensureLoaded();
    const now = isoNow();
    const newDoc = {
      id: doc.id || generateId(),
      title: doc.title,
      format: doc.format || 'note',
      filename: doc.filename,
      content: doc.content,
      tags: Array.isArray(doc.tags) ? doc.tags : [],
      version: 1,
      byteLength: Buffer.byteLength(doc.content || '', 'utf8'),
      createdAt: now,
      updatedAt: now,
      history: [{
        version: 1,
        content: doc.content,
        updatedAt: now,
        change: 'created',
      }],
    };
    data.documents.push(newDoc);
    persist();
    return { ok: true, document: { ...newDoc } };
  }

  function getDocument(id) {
    ensureLoaded();
    const doc = data.documents.find(d => d.id === id);
    return doc ? { ...doc } : null;
  }

  function getDocumentByFilename(filename) {
    ensureLoaded();
    const doc = data.documents.find(d => d.filename === filename);
    return doc ? { ...doc } : null;
  }

  function updateDocument(id, patch) {
    ensureLoaded();
    const index = data.documents.findIndex(d => d.id === id);
    if (index < 0) return { ok: false, notFound: true };

    const current = data.documents[index];
    const next = { ...current };
    const changed = [];

    const editableFields = ['title', 'format', 'content', 'tags'];
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

    if (!changed.length) return { ok: true, document: { ...current }, changed: [] };

    // Versioning
    if (changed.includes('content') || changed.includes('title')) {
      next.version = (current.version || 1) + 1;
      next.history = next.history || [];
      next.history.push({
        version: next.version,
        content: next.content,
        updatedAt: isoNow(),
        change: changed.join(', '),
      });
    }

    next.byteLength = Buffer.byteLength(next.content || '', 'utf8');
    next.updatedAt = isoNow();

    // Update filename if title changed
    if (changed.includes('title')) {
      next.filename = slugifyFilename(next.title, next.filename?.endsWith('.txt') ? '.txt' : '.md');
    }

    data.documents[index] = next;
    persist();
    return { ok: true, document: { ...next }, changed };
  }

  function deleteDocument(id) {
    ensureLoaded();
    const index = data.documents.findIndex(d => d.id === id);
    if (index < 0) return { ok: false, notFound: true };

    data.documents.splice(index, 1);
    persist();
    return { ok: true, removed: true };
  }

  function listDocuments({ limit = 100, tag, format, query, sortBy = 'updatedAt', sortOrder = 'desc' } = {}) {
    ensureLoaded();
    let docs = data.documents;

    if (tag) {
      docs = docs.filter(d => d.tags?.includes(tag));
    }
    if (format) {
      docs = docs.filter(d => d.format === format);
    }
    if (query) {
      const q = query.toLowerCase();
      docs = docs.filter(d =>
        d.title.toLowerCase().includes(q) ||
        d.content.toLowerCase().includes(q) ||
        d.tags?.some(t => t.toLowerCase().includes(q))
      );
    }

    // Sort
    const order = sortOrder === 'asc' ? 1 : -1;
    docs = [...docs].sort((a, b) => {
      const aVal = a[sortBy];
      const bVal = b[sortBy];
      if (aVal < bVal) return -1 * order;
      if (aVal > bVal) return 1 * order;
      return 0;
    });

    if (limit > 0) docs = docs.slice(0, limit);

    return docs.map(d => ({ ...d }));
  }

  function searchDocuments({ query, tag, format, limit = 50 } = {}) {
    return listDocuments({ query, tag, format, limit, sortBy: 'updatedAt', sortOrder: 'desc' });
  }

  function getDocumentHistory(id) {
    ensureLoaded();
    const doc = data.documents.find(d => d.id === id);
    if (!doc) return null;
    return (doc.history || []).map(h => ({ ...h }));
  }

  function getDocumentVersion(id, version) {
    ensureLoaded();
    const doc = data.documents.find(d => d.id === id);
    if (!doc) return null;
    const hist = (doc.history || []).find(h => h.version === version);
    if (!hist) return null;
    return {
      id: doc.id,
      title: doc.title,
      format: doc.format,
      filename: doc.filename,
      content: hist.content,
      tags: doc.tags,
      version: hist.version,
      byteLength: Buffer.byteLength(hist.content, 'utf8'),
      createdAt: doc.createdAt,
      updatedAt: hist.updatedAt,
    };
  }

  function getAllTags() {
    ensureLoaded();
    const tagSet = new Set();
    for (const doc of data.documents) {
      for (const tag of doc.tags || []) {
        tagSet.add(tag);
      }
    }
    return [...tagSet].sort();
  }

  function getStats() {
    ensureLoaded();
    const totalDocs = data.documents.length;
    const totalBytes = data.documents.reduce((sum, d) => sum + (d.byteLength || 0), 0);
    const byFormat = {};
    const byTag = {};
    for (const doc of data.documents) {
      byFormat[doc.format] = (byFormat[doc.format] || 0) + 1;
      for (const tag of doc.tags || []) {
        byTag[tag] = (byTag[tag] || 0) + 1;
      }
    }
    return {
      totalDocuments: totalDocs,
      totalBytes,
      byFormat,
      byTag: Object.entries(byTag).sort((a, b) => b[1] - a[1]),
      totalTags: Object.keys(byTag).length,
    };
  }

  // --- Templates ---

  function createTemplate(template) {
    ensureLoaded();
    const now = isoNow();
    const newTemplate = {
      id: template.id || generateId('template'),
      name: template.name,
      description: template.description || '',
      format: template.format || 'note',
      titleTemplate: template.titleTemplate || '',
      contentTemplate: template.contentTemplate || '',
      sectionsTemplate: Array.isArray(template.sectionsTemplate) ? template.sectionsTemplate : [],
      tagsTemplate: Array.isArray(template.tagsTemplate) ? template.tagsTemplate : [],
      createdAt: now,
      updatedAt: now,
    };
    data.templates.push(newTemplate);
    persist();
    return { ok: true, template: { ...newTemplate } };
  }

  function getTemplate(id) {
    ensureLoaded();
    const template = data.templates.find(t => t.id === id);
    return template ? { ...template } : null;
  }

  function getTemplateByName(name) {
    ensureLoaded();
    const template = data.templates.find(t => t.name.toLowerCase() === name.toLowerCase());
    return template ? { ...template } : null;
  }

  function updateTemplate(id, patch) {
    ensureLoaded();
    const index = data.templates.findIndex(t => t.id === id);
    if (index < 0) return { ok: false, notFound: true };

    const current = data.templates[index];
    const next = { ...current };
    const changed = [];

    const editableFields = ['name', 'description', 'format', 'titleTemplate', 'contentTemplate', 'sectionsTemplate', 'tagsTemplate'];
    for (const field of editableFields) {
      if (field in patch) {
        if (field.endsWith('Template') && field !== 'format') {
          next[field] = Array.isArray(patch[field]) ? patch[field] : (typeof patch[field] === 'string' ? patch[field] : current[field]);
        } else {
          next[field] = patch[field];
        }
        changed.push(field);
      }
    }

    if (!changed.length) return { ok: true, template: { ...current }, changed: [] };

    next.updatedAt = isoNow();
    data.templates[index] = next;
    persist();
    return { ok: true, template: { ...next }, changed };
  }

  function listTemplates() {
    ensureLoaded();
    return data.templates.map(t => ({ ...t }));
  }

  function deleteTemplate(id) {
    ensureLoaded();
    const index = data.templates.findIndex(t => t.id === id);
    if (index < 0) return { ok: false, notFound: true };

    data.templates.splice(index, 1);
    persist();
    return { ok: true, removed: true };
  }

  function initializeDefaults() {
    ensureLoaded();
    if (data.templates.length === 0) {
      // Default templates
      data.templates.push({
        id: generateId('template'),
        name: 'Reunião',
        description: 'Modelo para atas de reunião',
        format: 'note',
        titleTemplate: 'Reunião: {{date}} - {{topic}}',
        contentTemplate: '',
        sectionsTemplate: [
          { heading: 'Participantes', body: '' },
          { heading: 'Pauta', body: '' },
          { heading: 'Decisões', body: '' },
          { heading: 'Ações', body: '' },
          { heading: 'Próximos Passos', body: '' },
        ],
        tagsTemplate: ['reunião', 'ata'],
        createdAt: isoNow(),
        updatedAt: isoNow(),
      });

      data.templates.push({
        id: generateId('template'),
        name: 'ADR (Decisão de Arquitetura)',
        description: 'Architecture Decision Record',
        format: 'adr',
        titleTemplate: 'ADR: {{title}}',
        contentTemplate: '',
        sectionsTemplate: [
          { heading: 'Contexto', body: '' },
          { heading: 'Decisão', body: '' },
          { heading: 'Consequências', body: '' },
          { heading: 'Alternativas Consideradas', body: '' },
        ],
        tagsTemplate: ['adr', 'arquitetura', 'decisão'],
        createdAt: isoNow(),
        updatedAt: isoNow(),
      });

      data.templates.push({
        id: generateId('template'),
        name: 'Checklist',
        description: 'Lista de verificação genérica',
        format: 'checklist',
        titleTemplate: 'Checklist: {{title}}',
        contentTemplate: '',
        sectionsTemplate: [
          { heading: 'Itens', body: '' },
        ],
        tagsTemplate: ['checklist'],
        createdAt: isoNow(),
        updatedAt: isoNow(),
      });

      data.templates.push({
        id: generateId('template'),
        name: 'Resumo Diário',
        description: 'Resumo do dia para journaling',
        format: 'note',
        titleTemplate: 'Diário: {{date}}',
        contentTemplate: '',
        sectionsTemplate: [
          { heading: 'Conquistas', body: '' },
          { heading: 'Desafios', body: '' },
          { heading: 'Aprendizados', body: '' },
          { heading: 'Amanhã', body: '' },
        ],
        tagsTemplate: ['diário', 'resumo', 'jornal'],
        createdAt: isoNow(),
        updatedAt: isoNow(),
      });

      persist();
    }
  }

  return {
    // Documents
    createDocument,
    getDocument,
    getDocumentByFilename,
    updateDocument,
    deleteDocument,
    listDocuments,
    searchDocuments,
    getDocumentHistory,
    getDocumentVersion,
    getAllTags,
    getStats,
    // Templates
    createTemplate,
    getTemplate,
    getTemplateByName,
    updateTemplate,
    listTemplates,
    deleteTemplate,
    initializeDefaults,
    // For testing/debugging
    _ensureLoaded: ensureLoaded,
    _getRaw: () => snapshot(),
  };
}

// Helper function (shared with document-core)
function slugifyFilename(title, ext = '.md') {
  const base = String(title ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'documento';
  const safeExt = ext === '.txt' ? '.txt' : '.md';
  return `${base}${safeExt}`;
}