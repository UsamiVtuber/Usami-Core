/**
 * Skill operacional Study Companion (Fase 3 local).
 *
 * Publica o pacote `skills/study-companion` em `dataDir/skills` quando ausente,
 * registra `study.plan` (nível 2) e `study.review` (nível 1) no Tool Registry
 * e integra memória semântica, memória operacional e Task Planner via Tool
 * Executor.
 */
import { randomBytes } from 'node:crypto';
import { AGENT_SCHEMAS } from './agent-contracts.js';
import { publishSkillPackage } from './skill-package.js';
import {
  STUDY_LEVELS,
  STUDY_SCHEMA,
  buildStudyPlan,
  buildStudyReview,
} from '../skills/study-companion/study-core.mjs';

export const STUDY_COMPANION_SKILL_ID = 'study-companion';
export const STUDY_COMPANION_TOOLS = Object.freeze(['study.plan', 'study.review']);

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const stepId = () => `st-${randomBytes(6).toString('hex')}`;

export function publishStudyCompanionSkill({ dataDir, bundledDir } = {}) {
  return publishSkillPackage({ skillId: STUDY_COMPANION_SKILL_ID, dataDir, bundledDir });
}

function collectMemoryFacts(memoryStore) {
  if (!memoryStore) return [];
  const facts = [];
  if (typeof memoryStore.getSections === 'function') {
    for (const items of Object.values(memoryStore.getSections() || {})) {
      if (Array.isArray(items)) facts.push(...items);
    }
  }
  if (typeof memoryStore.getRecentFacts === 'function') {
    const recent = memoryStore.getRecentFacts();
    if (Array.isArray(recent)) facts.push(...recent);
  }
  return facts;
}

export function createStudyCompanionTools({
  memoryStore = null,
  operationalStore = null,
  taskPlanner = null,
  now = () => Date.now(),
} = {}) {
  const planTool = {
    schema: AGENT_SCHEMAS.tool,
    name: 'study.plan',
    version: '1.0.0',
    description: 'Cria uma trilha de estudos estruturada e persiste o plano de estudo no Task Planner e na memória operacional.',
    origin: 'skill',
    permissionLevel: 2,
    timeoutMs: 8000,
    parameters: [
      { name: 'topic', type: 'string', required: true, description: 'Tema ou assunto do estudo.' },
      { name: 'level', type: 'string', required: false, enum: [...STUDY_LEVELS], description: 'Nível inicial.' },
      { name: 'hoursPerWeek', type: 'number', required: false, description: 'Horas por semana (1 a 40).' },
      { name: 'deadline', type: 'string', required: false, description: 'Prazo opcional (YYYY-MM-DD ou ISO-8601).' },
      { name: 'persistPlan', type: 'boolean', required: false, description: 'Grava o plano no Task Planner (padrão true).' },
    ],
    verify(result) {
      return isPlainObject(result)
        && result.ok === true
        && result.schema === STUDY_SCHEMA
        && result.mode === 'plan'
        && Array.isArray(result.modules)
        && result.modules.length > 0
        && typeof result.summary === 'string';
    },
    async execute(args = {}) {
      const study = buildStudyPlan({
        topic: args.topic,
        level: args.level,
        hoursPerWeek: args.hoursPerWeek,
        deadline: args.deadline,
        memoryFacts: collectMemoryFacts(memoryStore),
        nowMs: now(),
      });

      let persistedTask = null;
      if (operationalStore && typeof operationalStore.create === 'function') {
        const created = operationalStore.create({
          kind: 'task',
          title: `Estudar: ${study.topic}`,
          status: 'open',
          ...(study.deadline ? { dueAt: study.deadline } : {}),
          origin: 'agent',
          relevance: 0.75,
        });
        if (created.ok) persistedTask = created.record;
      }

      let persistedPlan = null;
      if (args.persistPlan !== false && taskPlanner && typeof taskPlanner.create === 'function') {
        const steps = [];
        let prevId = null;
        for (const mod of study.modules) {
          const id = stepId();
          steps.push({
            id,
            title: `${mod.title} (~${mod.suggestedHours}h)`.slice(0, 120),
            status: 'pending',
            dependsOn: prevId ? [prevId] : [],
            effort: mod.effort,
            priority: mod.priority,
          });
          prevId = id;
        }
        const createdPlan = taskPlanner.create({
          goal: `Plano de estudos: ${study.topic}`.slice(0, 300),
          origin: 'planner',
          generated: {
            steps,
            missingInfo: study.deadline ? [] : ['prazo ou data-alvo do estudo'],
            risks: [],
          },
        });
        if (createdPlan.ok) persistedPlan = createdPlan.plan;
      }

      return {
        ok: true,
        ...study,
        ...(persistedTask ? { task: persistedTask } : {}),
        ...(persistedPlan ? { plan: persistedPlan } : {}),
      };
    },
  };

  const reviewTool = {
    schema: AGENT_SCHEMAS.tool,
    name: 'study.review',
    version: '1.0.0',
    description: 'Revisa estudos em andamento e gera perguntas de revisão espaçada a partir da base local.',
    origin: 'skill',
    permissionLevel: 1,
    timeoutMs: 5000,
    parameters: [
      { name: 'topic', type: 'string', required: false, description: 'Tema específico para filtrar a revisão.' },
    ],
    verify(result) {
      return isPlainObject(result)
        && result.ok === true
        && result.schema === STUDY_SCHEMA
        && result.mode === 'review'
        && Array.isArray(result.prompts)
        && typeof result.summary === 'string';
    },
    async execute(args = {}) {
      const operationalRecords = operationalStore && typeof operationalStore.list === 'function'
        ? operationalStore.list({ limit: 500 })
        : [];
      const plans = taskPlanner && typeof taskPlanner.list === 'function'
        ? taskPlanner.list({ limit: 200 })
        : [];
      const review = buildStudyReview({
        topic: args.topic ?? null,
        operationalRecords,
        plans,
        memoryFacts: collectMemoryFacts(memoryStore),
        nowMs: now(),
      });
      return { ok: true, ...review };
    },
  };

  return [planTool, reviewTool];
}

