/**
 * Skill operacional Habit Garden (Fase 1).
 *
 * Publica o manifesto `habit-garden` em `dataDir/skills/habit-garden`
 * quando ausente, registra as ferramentas `habit.upsert`, `habit.log`,
 * `habit.streak`, `habit.heatmap`, `habit.suggest`, `habit.list`
 * (níveis 1–2) no Tool Registry usando a memória operacional (S3).
 */
import { publishSkillPackage } from './skill-package.js';
import { createHabitGardenCore } from '../skills/habit-garden/habit-garden-core.mjs';

export const HABIT_GARDEN_SKILL_ID = 'habit-garden';
export const HABIT_GARDEN_TOOLS = Object.freeze([
  'habit.upsert',
  'habit.log',
  'habit.streak',
  'habit.heatmap',
  'habit.suggest',
  'habit.list',
]);

/**
 * Publica o pacote versionado `skills/habit-garden` dentro de `dataDir/skills`
 * apenas quando o destino ainda não existe (preservando `disabled`/`pending` do
 * operador entre reinícios e mantendo testes isolados via `dataDir` próprio).
 */
export function publishHabitGardenSkill({
  dataDir,
  bundledDir,
} = {}) {
  return publishSkillPackage({ skillId: HABIT_GARDEN_SKILL_ID, dataDir, bundledDir });
}

/**
 * Instancia as ToolSpecs da skill `habit-garden` ligadas ao operationalStore injetado.
 */
export function createHabitGardenTools({
  operationalStore,
  dataDir,
  defaultFrequency = 'daily',
  microHabitThreshold = 5,
} = {}) {
  if (!operationalStore || typeof operationalStore.list !== 'function' || typeof operationalStore.create !== 'function') {
    throw new Error('createHabitGardenTools: operationalStore válido é obrigatório.');
  }
  if (!dataDir || typeof dataDir !== 'string') {
    throw new Error('createHabitGardenTools: dataDir é obrigatório.');
  }

  const core = createHabitGardenCore({
    dataDir,
    defaultFrequency,
    microHabitThreshold,
  });

  // Wrappers que adaptam a API do core para o formato esperado pelo tool-registry
  const upsertTool = {
    ...core.toolSpecs.find(s => s.name === 'habit.upsert'),
    execute: async (args) => core.upsertHabit(args),
  };

  const logTool = {
    ...core.toolSpecs.find(s => s.name === 'habit.log'),
    execute: async (args) => core.logHabit(args),
  };

  const streakTool = {
    ...core.toolSpecs.find(s => s.name === 'habit.streak'),
    execute: async (args) => core.getStreak(args),
  };

  const heatmapTool = {
    ...core.toolSpecs.find(s => s.name === 'habit.heatmap'),
    execute: async (args) => core.getHeatmap(args),
  };

  const suggestTool = {
    ...core.toolSpecs.find(s => s.name === 'habit.suggest'),
    execute: async (args) => core.suggestMicroHabitsTool(args),
  };

  const listTool = {
    ...core.toolSpecs.find(s => s.name === 'habit.list'),
    execute: async (args) => core.listHabits(args),
  };

  return [upsertTool, logTool, streakTool, heatmapTool, suggestTool, listTool];
}