/**
 * Skill operacional Document Creator (Fase 3 local).
 *
 * Publica o pacote `skills/document-creator` em `dataDir/skills` quando
 * ausente e registra:
 *  - `document.draft` (nível 1): gera rascunho Markdown verificado em memória;
 *  - `document.write` (nível 4): grava documento apenas em `allowedDir`
 *    (padrão `join(dataDir, 'documents')`) mediante confirmação humana S5.
 */
import { join } from 'node:path';
import { AGENT_SCHEMAS } from './agent-contracts.js';
import { dataDir as resolveDataDir } from './data-paths.js';
import { publishSkillPackage } from './skill-package.js';
import {
  DOCUMENT_FORMATS,
  DOCUMENT_SCHEMA,
  buildDocumentDraft,
  writeSafeDocument,
} from '../skills/document-creator/document-core.mjs';

export const DOCUMENT_CREATOR_SKILL_ID = 'document-creator';
export const DOCUMENT_CREATOR_TOOLS = Object.freeze(['document.draft', 'document.write']);

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
      return {
        ok: true,
        schema: DOCUMENT_SCHEMA,
        title: draft.title,
        format: draft.format,
        ...written,
      };
    },
  };

  return [draftTool, writeTool];
}

