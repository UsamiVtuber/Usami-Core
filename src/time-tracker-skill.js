/**
 * Skill operacional Time Tracker (Fase 1).
 *
 * Publica o manifesto `time-tracker` em `dataDir/skills/time-tracker`
 * quando ausente, registra as ferramentas `timer.start`, `timer.stop`,
 * `timer.status`, `timer.report`, `timer.pomodoro`, `timer.block`
 * (níveis 1–2) no Tool Registry usando a memória operacional (S3) + timer-session-store.
 */
import { publishSkillPackage } from './skill-package.js';
import { createTimeTrackerCore } from '../skills/time-tracker/time-tracker-core.mjs';

export const TIME_TRACKER_SKILL_ID = 'time-tracker';
export const TIME_TRACKER_TOOLS = Object.freeze([
  'timer.start',
  'timer.stop',
  'timer.status',
  'timer.report',
  'timer.pomodoro',
  'timer.block',
]);

/**
 * Publica o pacote versionado `skills/time-tracker` dentro de `dataDir/skills`
 * apenas quando o destino ainda não existe (preservando `disabled`/`pending` do
 * operador entre reinícios e mantendo testes isolados via `dataDir` próprio).
 */
export function publishTimeTrackerSkill({
  dataDir,
  bundledDir,
} = {}) {
  return publishSkillPackage({ skillId: TIME_TRACKER_SKILL_ID, dataDir, bundledDir });
}

/**
 * Instancia as ToolSpecs da skill `time-tracker` ligadas ao operationalStore injetado.
 * O core cria seu próprio timer-session-store internamente usando o dataDir passado.
 */
export function createTimeTrackerTools({
  operationalStore,
  dataDir,
  defaultPomodoroMinutes = 25,
  defaultBreakMinutes = 5,
  weekStartDay = 1,
} = {}) {
  if (!operationalStore || typeof operationalStore.list !== 'function' || typeof operationalStore.create !== 'function') {
    throw new Error('createTimeTrackerTools: operationalStore válido é obrigatório.');
  }
  if (!dataDir || typeof dataDir !== 'string') {
    throw new Error('createTimeTrackerTools: dataDir é obrigatório.');
  }

  const core = createTimeTrackerCore({
    dataDir,
    defaultPomodoroMinutes,
    defaultBreakMinutes,
    weekStartDay,
  });

  // Wrappers que adaptam a API do core para o formato esperado pelo tool-registry
  const startTool = {
    ...core.toolSpecs.find(s => s.name === 'timer.start'),
    execute: async (args) => core.startTimer(args),
  };

  const stopTool = {
    ...core.toolSpecs.find(s => s.name === 'timer.stop'),
    execute: async () => core.stopTimer(),
  };

  const statusTool = {
    ...core.toolSpecs.find(s => s.name === 'timer.status'),
    execute: async () => core.getTimerStatus(),
  };

  const reportTool = {
    ...core.toolSpecs.find(s => s.name === 'timer.report'),
    execute: async (args) => core.getReport(args),
  };

  const pomodoroTool = {
    ...core.toolSpecs.find(s => s.name === 'timer.pomodoro'),
    execute: async (args) => core.startPomodoro(args),
  };

  const blockTool = {
    ...core.toolSpecs.find(s => s.name === 'timer.block'),
    execute: async (args) => core.createTimeBlock(args),
  };

  return [startTool, stopTool, statusTool, reportTool, pomodoroTool, blockTool];
}