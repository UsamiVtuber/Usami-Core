/**
 * Skill operacional Document Creator (Fase 3 local).
 *
 * Publica o pacote `skills/document-creator` em `dataDir/skills` quando
 * ausente e registra:
 *  - `document.draft` (nível 1): gera rascunho Markdown verificado em memória;
 *  - `document.write` (nível 4): grava documento apenas em `allowedDir`
 *    (padrão `join(dataDir, 'documents')`) mediante confirmação humana S5.
 *  - `document.list` (nível 1): lista documentos com filtros;
 *  - `document.get` (nível 1): obtém documento por ID;
 *  - `document.search` (nível 1): busca full-text + filtros;
 *  - `document.history` (nível 1): histórico de versões;
 *  - `document.version` (nível 1): obtém versão específica;
 *  - `document.delete` (nível 3): remove documento;
 *  - `document.template.list` (nível 1): lista templates;
 *  - `document.template.get` (nível 1): obtém template;
 *  - `document.template.upsert` (nível 2): cria/atualiza template;
 *  - `document.template.delete` (nível 3): remove template;
 *  - `document.tags` (nível 1): lista todas as tags;
 *  - `document.stats` (nível 1): estatísticas.
 */
import { join } from 'node:path';
import { AGENT_SCHEMAS } from './agent-contracts.js';
import { dataDir as resolveDataDir } from './data-paths.js';
import { publishSkillPackage } from './skill-package.js';
import { createDocumentStore } from '../skills/document-creator/document-store.mjs';
import {
  DOCUMENT_FORMATS,
  DOCUMENT_SCHEMA,
  buildDocumentDraft,
  writeSafeDocument,
  slugifyFilename,
} from '../skills/document-creator/document-core.mjs';

export const DOCUMENT_CREATOR_SKILL_ID = 'document-creator';
export const DOCUMENT_CREATOR_TOOLS = Object.freeze([
  'document.draft',
  'document.write',
  'document.list',
  'document.get',
  'document.search',
  'document.history',
  'document.version',
  'document.delete',
  'document.template.list',
  'document.template.get',
  'document.template.upsert',
  'document.template.delete',
  'document.tags',
  'document.stats',
]);

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export function publishDocumentCreatorSkill({ dataDir, bundledDir } = {}) {
  return publishSkillPackage({ skillId: DOCUMENT_CREATOR_SKILL_ID, dataDir, bundledDir });
}

export function createDocumentCreatorTools({
  dataDir = null,
  allowedDir = null,
  now = () => Date.now(),
} = {}) {
  const resolveAllowedDir = () => allowedDir || join(dataDir || resolveDataDir(), 'documents');
  const store = createDocumentStore({ dataDir: dataDir || resolveDataDir() });
  store.initializeDefaults();

  const draftTool = {
    schema: AGENT_SCHEMAS.tool,
    name: 'document.draft',
    version: '1.0.0',
    description: 'Gera um rascunho estruturado em Markdown (nota, checklist, ADR ou resumo) sem gravar em disco.',
    origin: 'skill',
    permissionLevel: 1,
    timeoutMs: 5000,
    parameters: [
      { name: 'title', type: 'string', required: true, description: 'Título do documento.' },
      { name: 'format', type: 'string', required: false, enum: [...DOCUMENT_FORMATS], description: 'Formato do documento.' },
      { name: 'body', type: 'string', required: false, description: 'Texto principal curto (até 500 chars; para texto longo use sections).' },
      { name: 'sections', type: 'array', required: false, description: 'Lista de seções { heading, body } ou parágrafos.' },
      { name: 'tags', type: 'array', required: false, description: 'Lista de tags curtas.' },
      { name: 'filename', type: 'string', required: false, description: 'Nome sugerido (.md ou .txt).' },
    ],
    verify(result) {
      return isPlainObject(result)
        && result.ok === true
        && result.schema === DOCUMENT_SCHEMA
        && typeof result.filename === 'string'
        && typeof result.content === 'string'
        && result.content.trim().length > 0;
    },
    async execute(args = {}) {
      const draft = buildDocumentDraft({
        title: args.title,
        format: args.format,
        body: args.body,
        sections: args.sections,
        tags: args.tags,
        filename: args.filename ?? null,
        nowMs: now(),
      });
      return { ok: true, ...draft };
    },
  };

  const writeTool = {
    schema: AGENT_SCHEMAS.tool,
    name: 'document.write',
    version: '1.0.0',
    description: 'Grava um documento Markdown/TXT dentro da pasta autorizada de documentos (exige confirmação humana nível 4).',
    origin: 'skill',
    permissionLevel: 4,
    timeoutMs: 5000,
    parameters: [
      { name: 'title', type: 'string', required: true, description: 'Título do documento.' },
      { name: 'format', type: 'string', required: false, enum: [...DOCUMENT_FORMATS], description: 'Formato do documento.' },
      { name: 'body', type: 'string', required: false, description: 'Corpo curto do documento.' },
      { name: 'sections', type: 'array', required: false, description: 'Seções { heading, body } ou parágrafos.' },
      { name: 'tags', type: 'array', required: false, description: 'Tags opcionais.' },
      { name: 'filename', type: 'string', required: false, description: 'Nome do arquivo (.md ou .txt) dentro da pasta permitida.' },
      { name: 'overwrite', type: 'boolean', required: false, description: 'Permite substituir arquivo existente (padrão false).' },
    ],
    verify(result) {
      return isPlainObject(result)
        && result.ok === true
        && result.schema === DOCUMENT_SCHEMA
        && result.written === true
        && typeof result.filename === 'string'
        && Number.isFinite(result.bytes)
        && result.bytes > 0;
    },
    async execute(args = {}) {
      const draft = buildDocumentDraft({
        title: args.title,
        format: args.format,
        body: args.body,
        sections: args.sections,
        tags: args.tags,
        filename: args.filename ?? null,
        nowMs: now(),
      });
      const written = writeSafeDocument({
        allowedDir: resolveAllowedDir(),
        filename: draft.filename,
        content: draft.content,
        overwrite: args.overwrite === true,
      });
      // Also persist to store
      const stored = store.createDocument({
        ...draft,
        content: draft.content,
      });
      return {
        ok: true,
        schema: DOCUMENT_SCHEMA,
        title: draft.title,
        format: draft.format,
        ...written,
        document: stored.document,
      };
    },
  };

  const listTool = {
    schema: AGENT_SCHEMAS.tool,
    name: 'document.list',
    version: '1.0.0',
    description: 'Lista documentos com filtros opcionais (tag, formato, query, ordenação).',
    origin: 'skill',
    permissionLevel: 1,
    timeoutMs: 3000,
    parameters: [
      { name: 'tag', type: 'string', required: false, description: 'Filtrar por tag.' },
      { name: 'format', type: 'string', required: false, enum: [...DOCUMENT_FORMATS], description: 'Filtrar por formato.' },
      { name: 'query', type: 'string', required: false, description: 'Busca em título, conteúdo e tags.' },
      { name: 'limit', type: 'number', required: false, description: 'Limite de resultados (padrão: 100).' },
      { name: 'sortBy', type: 'string', required: false, enum: ['title', 'format', 'createdAt', 'updatedAt', 'byteLength'], description: 'Campo para ordenar (padrão: updatedAt).' },
      { name: 'sortOrder', type: 'string', required: false, enum: ['asc', 'desc'], description: 'Ordem (padrão: desc).' },
    ],
    verify(result) {
      return isPlainObject(result) && result.ok === true && Array.isArray(result.documents) && typeof result.count === 'number';
    },
    async execute(args = {}) {
      const documents = store.listDocuments({
        tag: args.tag,
        format: args.format,
        query: args.query,
        limit: args.limit ?? 100,
        sortBy: args.sortBy ?? 'updatedAt',
        sortOrder: args.sortOrder ?? 'desc',
      });
      return { ok: true, documents, count: documents.length };
    },
  };

  const getTool = {
    schema: AGENT_SCHEMAS.tool,
    name: 'document.get',
    version: '1.0.0',
    description: 'Obtém um documento por ID.',
    origin: 'skill',
    permissionLevel: 1,
    timeoutMs: 2000,
    parameters: [
      { name: 'id', type: 'string', required: true, description: 'ID do documento (doc-...).' },
    ],
    verify(result) {
      return isPlainObject(result) && result.ok === true && result.document && typeof result.document.id === 'string';
    },
    async execute(args = {}) {
      const document = store.getDocument(args.id);
      if (!document) throw new Error(`documento não encontrado (${args.id})`);
      return { ok: true, document };
    },
  };

  const searchTool = {
    schema: AGENT_SCHEMAS.tool,
    name: 'document.search',
    version: '1.0.0',
    description: 'Busca full-text em documentos com filtros opcionais.',
    origin: 'skill',
    permissionLevel: 1,
    timeoutMs: 3000,
    parameters: [
      { name: 'query', type: 'string', required: true, description: 'Texto para buscar.' },
      { name: 'tag', type: 'string', required: false, description: 'Filtrar por tag.' },
      { name: 'format', type: 'string', required: false, enum: [...DOCUMENT_FORMATS], description: 'Filtrar por formato.' },
      { name: 'limit', type: 'number', required: false, description: 'Limite de resultados (padrão: 50).' },
    ],
    verify(result) {
      return isPlainObject(result) && result.ok === true && Array.isArray(result.documents) && typeof result.count === 'number';
    },
    async execute(args = {}) {
      const documents = store.searchDocuments({
        query: args.query,
        tag: args.tag,
        format: args.format,
        limit: args.limit ?? 50,
      });
      return { ok: true, documents, count: documents.length };
    },
  };

  const historyTool = {
    schema: AGENT_SCHEMAS.tool,
    name: 'document.history',
    version: '1.0.0',
    description: 'Retorna histórico de versões de um documento.',
    origin: 'skill',
    permissionLevel: 1,
    timeoutMs: 2000,
    parameters: [
      { name: 'id', type: 'string', required: true, description: 'ID do documento (doc-...).' },
    ],
    verify(result) {
      return isPlainObject(result) && result.ok === true && Array.isArray(result.history);
    },
    async execute(args = {}) {
      const history = store.getDocumentHistory(args.id);
      if (history === null) throw new Error(`documento não encontrado (${args.id})`);
      return { ok: true, id: args.id, history, count: history.length };
    },
  };

  const versionTool = {
    schema: AGENT_SCHEMAS.tool,
    name: 'document.version',
    version: '1.0.0',
    description: 'Obtém uma versão específica de um documento.',
    origin: 'skill',
    permissionLevel: 1,
    timeoutMs: 2000,
    parameters: [
      { name: 'id', type: 'string', required: true, description: 'ID do documento (doc-...).' },
      { name: 'version', type: 'number', required: true, description: 'Número da versão.' },
    ],
    verify(result) {
      return isPlainObject(result) && result.ok === true && result.document && typeof result.document.version === 'number';
    },
    async execute(args = {}) {
      const document = store.getDocumentVersion(args.id, args.version);
      if (!document) throw new Error(`documento ou versão não encontrada (${args.id} v${args.version})`);
      return { ok: true, document };
    },
  };

  const deleteTool = {
    schema: AGENT_SCHEMAS.tool,
    name: 'document.delete',
    version: '1.0.0',
    description: 'Remove um documento do store.',
    origin: 'skill',
    permissionLevel: 3,
    timeoutMs: 2000,
    parameters: [
      { name: 'id', type: 'string', required: true, description: 'ID do documento (doc-...).' },
    ],
    verify(result) {
      return isPlainObject(result) && result.ok === true && result.removed === true;
    },
    async execute(args = {}) {
      const result = store.deleteDocument(args.id);
      if (!result.ok) throw new Error(result.notFound ? `documento não encontrado (${args.id})` : 'falha ao remover');
      return { ok: true, removed: true };
    },
  };

  const templateListTool = {
    schema: AGENT_SCHEMAS.tool,
    name: 'document.template.list',
    version: '1.0.0',
    description: 'Lista todos os templates de documento.',
    origin: 'skill',
    permissionLevel: 1,
    timeoutMs: 2000,
    parameters: [],
    verify(result) {
      return isPlainObject(result) && result.ok === true && Array.isArray(result.templates) && typeof result.count === 'number';
    },
    async execute() {
      const templates = store.listTemplates();
      return { ok: true, templates, count: templates.length };
    },
  };

  const templateGetTool = {
    schema: AGENT_SCHEMAS.tool,
    name: 'document.template.get',
    version: '1.0.0',
    description: 'Obtém um template por ID ou nome.',
    origin: 'skill',
    permissionLevel: 1,
    timeoutMs: 2000,
    parameters: [
      { name: 'id', type: 'string', required: false, description: 'ID do template (template-...).' },
      { name: 'name', type: 'string', required: false, description: 'Nome do template.' },
    ],
    verify(result) {
      return isPlainObject(result) && result.ok === true && result.template && typeof result.template.id === 'string';
    },
    async execute(args = {}) {
      if (!args.id && !args.name) throw new Error('id ou name: obrigatório');
      const template = args.id ? store.getTemplate(args.id) : store.getTemplateByName(args.name);
      if (!template) throw new Error(args.id ? `template não encontrado (${args.id})` : `template não encontrado com nome "${args.name}"`);
      return { ok: true, template };
    },
  };

  const templateUpsertTool = {
    schema: AGENT_SCHEMAS.tool,
    name: 'document.template.upsert',
    version: '1.0.0',
    description: 'Cria ou atualiza um template de documento.',
    origin: 'skill',
    permissionLevel: 2,
    timeoutMs: 3000,
    parameters: [
      { name: 'id', type: 'string', required: false, description: 'ID do template para atualização.' },
      { name: 'name', type: 'string', required: true, description: 'Nome do template.' },
      { name: 'description', type: 'string', required: false, description: 'Descrição.' },
      { name: 'format', type: 'string', required: false, enum: [...DOCUMENT_FORMATS], description: 'Formato base.' },
      { name: 'titleTemplate', type: 'string', required: false, description: 'Template do título (use {{date}}, {{title}}).' },
      { name: 'contentTemplate', type: 'string', required: false, description: 'Template do conteúdo.' },
      { name: 'sectionsTemplate', type: 'array', required: false, description: 'Array de { heading, body }.' },
      { name: 'tagsTemplate', type: 'array', required: false, description: 'Tags padrão.' },
    ],
    verify(result) {
      return isPlainObject(result) && result.ok === true && result.template && typeof result.template.id === 'string';
    },
    async execute(args = {}) {
      if (args.id) {
        const patch = {};
        if (args.name) patch.name = args.name;
        if (args.description !== undefined) patch.description = args.description;
        if (args.format) patch.format = args.format;
        if (args.titleTemplate !== undefined) patch.titleTemplate = args.titleTemplate;
        if (args.contentTemplate !== undefined) patch.contentTemplate = args.contentTemplate;
        if (args.sectionsTemplate !== undefined) patch.sectionsTemplate = args.sectionsTemplate;
        if (args.tagsTemplate !== undefined) patch.tagsTemplate = args.tagsTemplate;

        const updated = store.updateTemplate(args.id, patch);
        if (!updated.ok) throw new Error(updated.notFound ? `template não encontrado (${args.id})` : 'falha ao atualizar');
        return { ok: true, action: 'updated', template: updated.template };
      }

      if (!args.name?.trim()) throw new Error('name: obrigatório');
      const created = store.createTemplate({
        name: args.name.trim(),
        description: args.description,
        format: args.format,
        titleTemplate: args.titleTemplate,
        contentTemplate: args.contentTemplate,
        sectionsTemplate: args.sectionsTemplate,
        tagsTemplate: args.tagsTemplate,
      });
      if (!created.ok) throw new Error('falha ao criar template');
      return { ok: true, action: 'created', template: created.template };
    },
  };

  const templateDeleteTool = {
    schema: AGENT_SCHEMAS.tool,
    name: 'document.template.delete',
    version: '1.0.0',
    description: 'Remove um template.',
    origin: 'skill',
    permissionLevel: 3,
    timeoutMs: 2000,
    parameters: [
      { name: 'id', type: 'string', required: true, description: 'ID do template (template-...).' },
    ],
    verify(result) {
      return isPlainObject(result) && result.ok === true && result.removed === true;
    },
    async execute(args = {}) {
      const result = store.deleteTemplate(args.id);
      if (!result.ok) throw new Error(result.notFound ? `template não encontrado (${args.id})` : 'falha ao remover');
      return { ok: true, removed: true };
    },
  };

  const tagsTool = {
    schema: AGENT_SCHEMAS.tool,
    name: 'document.tags',
    version: '1.0.0',
    description: 'Lista todas as tags usadas nos documentos.',
    origin: 'skill',
    permissionLevel: 1,
    timeoutMs: 2000,
    parameters: [],
    verify(result) {
      return isPlainObject(result) && result.ok === true && Array.isArray(result.tags) && typeof result.count === 'number';
    },
    async execute() {
      const tags = store.getAllTags();
      return { ok: true, tags, count: tags.length };
    },
  };

  const statsTool = {
    schema: AGENT_SCHEMAS.tool,
    name: 'document.stats',
    version: '1.0.0',
    description: 'Retorna estatísticas dos documentos (total, por formato, por tag).',
    origin: 'skill',
    permissionLevel: 1,
    timeoutMs: 2000,
    parameters: [],
    verify(result) {
      return isPlainObject(result) && result.ok === true && typeof result.totalDocuments === 'number' && typeof result.totalBytes === 'number';
    },
    async execute() {
      return { ok: true, ...store.getStats() };
    },
  };

  return [
    draftTool,
    writeTool,
    listTool,
    getTool,
    searchTool,
    historyTool,
    versionTool,
    deleteTool,
    templateListTool,
    templateGetTool,
    templateUpsertTool,
    templateDeleteTool,
    tagsTool,
    statsTool,
  ];
}