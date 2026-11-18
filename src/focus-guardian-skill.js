/**
 * Skill operacional Focus Guardian (Fase 1).
 *
 * Publica o manifesto `focus-guardian` em `dataDir/skills/focus-guardian`
 * quando ausente, registra as ferramentas de sessões, perfis, blocklists,
 * configurações e verificação de bloqueio (níveis 1–3) no Tool Registry.
 */
import { publishSkillPackage } from './skill-package.js';
import { createFocusGuardianCore } from '../skills/focus-guardian/focus-guardian-core.mjs';

export const FOCUS_GUARDIAN_SKILL_ID = 'focus-guardian';
export const FOCUS_GUARDIAN_TOOLS = Object.freeze([
  'focus.start',
  'focus.pause',
  'focus.resume',
  'focus.stop',
  'focus.cancel',
  'focus.break',
  'focus.distraction',
  'focus.status',
  'focus.sessions',
  'focus.stats',
  'focus.profile.upsert',
  'focus.profile.get',
  'focus.profile.list',
  'focus.profile.delete',
  'focus.blocklist.upsert',
  'focus.blocklist.get',
  'focus.blocklist.list',
  'focus.blocklist.delete',
  'focus.settings.get',
  'focus.settings.update',
  'focus.checkBlocked',
]);

/**
 * Publica o pacote versionado `skills/focus-guardian` dentro de `dataDir/skills`
 * apenas quando o destino ainda não existe (preservando `disabled`/`pending` do
 * operador entre reinícios e mantendo testes isolados via `dataDir` próprio).
 */
export function publishFocusGuardianSkill({
  dataDir,
  bundledDir,
} = {}) {
  return publishSkillPackage({ skillId: FOCUS_GUARDIAN_SKILL_ID, dataDir, bundledDir });
}

/**
 * Instancia as ToolSpecs da skill `focus-guardian` ligadas ao dataDir injetado.
 */
export function createFocusGuardianTools({
  dataDir,
} = {}) {
  if (!dataDir || typeof dataDir !== 'string') {
    throw new Error('createFocusGuardianTools: dataDir é obrigatório.');
  }

  const core = createFocusGuardianCore({ dataDir });

  // Wrappers que adaptam a API do core para o formato esperado pelo tool-registry
  const startTool = {
    ...core.toolSpecs.find(s => s.name === 'focus.start'),
    execute: async (args) => core.startFocusSession(args),
  };

  const pauseTool = {
    ...core.toolSpecs.find(s => s.name === 'focus.pause'),
    execute: async (args) => core.pauseFocusSession(args),
  };

  const resumeTool = {
    ...core.toolSpecs.find(s => s.name === 'focus.resume'),
    execute: async (args) => core.resumeFocusSession(args),
  };

  const stopTool = {
    ...core.toolSpecs.find(s => s.name === 'focus.stop'),
    execute: async (args) => core.stopFocusSession(args),
  };

  const cancelTool = {
    ...core.toolSpecs.find(s => s.name === 'focus.cancel'),
    execute: async (args) => core.cancelFocusSession(args),
  };

  const breakTool = {
    ...core.toolSpecs.find(s => s.name === 'focus.break'),
    execute: async (args) => core.takeBreak(args),
  };

  const distractionTool = {
    ...core.toolSpecs.find(s => s.name === 'focus.distraction'),
    execute: async (args) => core.recordDistractionBlocked(args),
  };

  const statusTool = {
    ...core.toolSpecs.find(s => s.name === 'focus.status'),
    execute: async (args) => core.getFocusStatus(args),
  };

  const sessionsTool = {
    ...core.toolSpecs.find(s => s.name === 'focus.sessions'),
    execute: async (args) => core.listFocusSessions(args),
  };

  const statsTool = {
    ...core.toolSpecs.find(s => s.name === 'focus.stats'),
    execute: async (args) => core.getFocusStats(args),
  };

  const profileUpsertTool = {
    ...core.toolSpecs.find(s => s.name === 'focus.profile.upsert'),
    execute: async (args) => core.upsertProfile(args),
  };

  const profileGetTool = {
    ...core.toolSpecs.find(s => s.name === 'focus.profile.get'),
    execute: async (args) => core.getProfile(args),
  };

  const profileListTool = {
    ...core.toolSpecs.find(s => s.name === 'focus.profile.list'),
    execute: async (args) => core.listProfiles(args),
  };

  const profileDeleteTool = {
    ...core.toolSpecs.find(s => s.name === 'focus.profile.delete'),
    execute: async (args) => core.deleteProfile(args),
  };

  const blocklistUpsertTool = {
    ...core.toolSpecs.find(s => s.name === 'focus.blocklist.upsert'),
    execute: async (args) => core.upsertBlocklist(args),
  };

  const blocklistGetTool = {
    ...core.toolSpecs.find(s => s.name === 'focus.blocklist.get'),
    execute: async (args) => core.getBlocklist(args),
  };

  const blocklistListTool = {
    ...core.toolSpecs.find(s => s.name === 'focus.blocklist.list'),
    execute: async (args) => core.listBlocklists(args),
  };

  const blocklistDeleteTool = {
    ...core.toolSpecs.find(s => s.name === 'focus.blocklist.delete'),
    execute: async (args) => core.deleteBlocklist(args),
  };

  const settingsGetTool = {
    ...core.toolSpecs.find(s => s.name === 'focus.settings.get'),
    execute: async (args) => core.getSettings(args),
  };

  const settingsUpdateTool = {
    ...core.toolSpecs.find(s => s.name === 'focus.settings.update'),
    execute: async (args) => core.updateSettings(args),
  };

  const checkBlockedTool = {
    ...core.toolSpecs.find(s => s.name === 'focus.checkBlocked'),
    execute: async (args) => core.checkBlocked(args),
  };

  return [
    startTool,
    pauseTool,
    resumeTool,
    stopTool,
    cancelTool,
    breakTool,
    distractionTool,
    statusTool,
    sessionsTool,
    statsTool,
    profileUpsertTool,
    profileGetTool,
    profileListTool,
    profileDeleteTool,
    blocklistUpsertTool,
    blocklistGetTool,
    blocklistListTool,
    blocklistDeleteTool,
    settingsGetTool,
    settingsUpdateTool,
    checkBlockedTool,
  ];
}