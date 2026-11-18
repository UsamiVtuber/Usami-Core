/**
 * Skill operacional Note Linker (Fase 1).
 *
 * Publica o manifesto `note-linker` em `dataDir/skills/note-linker`
 * quando ausente, registra as ferramentas `note.upsert`, `note.get`,
 * `note.search`, `note.link`, `note.backlinks`, `note.graph`,
 * `note.tags`, `note.list`, `note.delete` (níveis 1–3) no Tool Registry.
 */
import { publishSkillPackage } from './skill-package.js';
import { createNoteLinkerCore } from '../skills/note-linker/note-linker-core.mjs';

export const NOTE_LINKER_SKILL_ID = 'note-linker';
export const NOTE_LINKER_TOOLS = Object.freeze([
  'note.upsert',
  'note.get',
  'note.search',
  'note.link',
  'note.backlinks',
  'note.graph',
  'note.tags',
  'note.list',
  'note.delete',
]);

/**
 * Publica o pacote versionado `skills/note-linker` dentro de `dataDir/skills`
 * apenas quando o destino ainda não existe (preservando `disabled`/`pending` do
 * operador entre reinícios e mantendo testes isolados via `dataDir` próprio).
 */
export function publishNoteLinkerSkill({
  dataDir,
  bundledDir,
} = {}) {
  return publishSkillPackage({ skillId: NOTE_LINKER_SKILL_ID, dataDir, bundledDir });
}

/**
 * Instancia as ToolSpecs da skill `note-linker` ligadas ao dataDir injetado.
 */
export function createNoteLinkerTools({
  dataDir,
} = {}) {
  if (!dataDir || typeof dataDir !== 'string') {
    throw new Error('createNoteLinkerTools: dataDir é obrigatório.');
  }

  const core = createNoteLinkerCore({ dataDir });

  // Wrappers que adaptam a API do core para o formato esperado pelo tool-registry
  const upsertTool = {
    ...core.toolSpecs.find(s => s.name === 'note.upsert'),
    execute: async (args) => core.upsertNote(args),
  };

  const getTool = {
    ...core.toolSpecs.find(s => s.name === 'note.get'),
    execute: async (args) => core.getNote(args),
  };

  const searchTool = {
    ...core.toolSpecs.find(s => s.name === 'note.search'),
    execute: async (args) => core.searchNotes(args),
  };

  const linkTool = {
    ...core.toolSpecs.find(s => s.name === 'note.link'),
    execute: async (args) => core.linkNote(args),
  };

  const backlinksTool = {
    ...core.toolSpecs.find(s => s.name === 'note.backlinks'),
    execute: async (args) => core.getBacklinks(args),
  };

  const graphTool = {
    ...core.toolSpecs.find(s => s.name === 'note.graph'),
    execute: async (args) => core.getGraph(args),
  };

  const tagsTool = {
    ...core.toolSpecs.find(s => s.name === 'note.tags'),
    execute: async (args) => core.listTags(args),
  };

  const listTool = {
    ...core.toolSpecs.find(s => s.name === 'note.list'),
    execute: async (args) => core.listNotes(args),
  };

  const deleteTool = {
    ...core.toolSpecs.find(s => s.name === 'note.delete'),
    execute: async (args) => core.deleteNote(args),
  };

  return [upsertTool, getTool, searchTool, linkTool, backlinksTool, graphTool, tagsTool, listTool, deleteTool];
}