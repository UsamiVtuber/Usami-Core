/**
 * Skill operacional Daily Briefing (S13).
 *
 * Publica o manifesto `daily-briefing` (nível 1) em `dataDir/skills/daily-briefing`
 * quando ausente, expõe a ferramenta `briefing.build` no Tool Registry e monta
 * o briefing do dia a partir da memória operacional (S3), Planner (S6) e
 * execuções (S4) com template determinístico e redação LLM opcional/injetável.
 */
import { AGENT_SCHEMAS } from './agent-contracts.js';
import { publishSkillPackage } from './skill-package.js';
import {
  BRIEFING_SCHEMA,
  buildDailyBriefing,
  isValidCalendarDate,
} from '../skills/daily-briefing/briefing-core.mjs';

export { BRIEFING_SCHEMA, isValidCalendarDate };

export const DAILY_BRIEFING_SKILL_ID = 'daily-briefing';
export const DAILY_BRIEFING_TOOLS = Object.freeze(['briefing.build']);

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * Publica o pacote `skills/daily-briefing` em `dataDir/skills` apenas quando o
 * manifesto ainda não existe (preservando estado alterado pelo operador).
 */
export function publishDailyBriefingSkill({
  dataDir,
  bundledDir,
} = {}) {
  return publishSkillPackage({ skillId: DAILY_BRIEFING_SKILL_ID, dataDir, bundledDir });
}

function readRecordsSafely(fn, fallback = []) {
  try {
    const res = typeof fn === 'function' ? fn() : fallback;
    return Array.isArray(res) ? res : fallback;
  } catch {
    return fallback;
  }
}

export function createDailyBriefingService({
  operationalStore = null,
  taskPlanner = null,
  toolExecutor = null,
  executionProvider = null,
  rewriteWithLlm = null,
  now = () => Date.now(),
} = {}) {
  return {
    async build({ date = null, useLlm = false } = {}) {
      if (date !== null && date !== undefined && !isValidCalendarDate(date)) {
        throw new Error('date inválido: use YYYY-MM-DD válido');
      }

      const operationalRecords = readRecordsSafely(() => operationalStore?.list({ limit: 500 }));
      const plans = readRecordsSafely(() => taskPlanner?.list({ limit: 200 }));
      const executions = executionProvider
        ? readRecordsSafely(executionProvider)
        : readRecordsSafely(() => toolExecutor?.list({ limit: 200 }));

      const base = buildDailyBriefing({
        nowMs: now(),
        date: date ?? null,
        operationalRecords,
        plans,
        executions,
      });

      if (useLlm === true && typeof rewriteWithLlm === 'function') {
        try {
          const rewritten = await rewriteWithLlm({
            date: base.date,
            briefing: base,
            deterministicText: base.deterministicText,
          });
          if (typeof rewritten === 'string' && rewritten.trim()) {
            return {
              ok: true,
              ...base,
              text: rewritten.trim(),
              narrativeSource: 'llm',
            };
          }
        } catch {
          return {
            ok: true,
            ...base,
            llmFallback: true,
          };
        }
      }

      return {
        ok: true,
        ...base,
      };
    },
  };
}

export function createDailyBriefingTool({
  operationalStore = null,
  taskPlanner = null,
  toolExecutor = null,
  executionProvider = null,
  rewriteWithLlm = null,
  now = () => Date.now(),
} = {}) {
  const service = createDailyBriefingService({
    operationalStore,
    taskPlanner,
    toolExecutor,
    executionProvider,
    rewriteWithLlm,
    now,
  });

  return {
    schema: AGENT_SCHEMAS.tool,
    name: 'briefing.build',
    version: '1.0.0',
    description: 'Monta o briefing diário com compromissos, tarefas prioritárias, pendências e projetos em andamento a partir da base local.',
    origin: 'skill',
    permissionLevel: 1,
    timeoutMs: 5000,
    parameters: [
      {
        name: 'date',
        type: 'string',
        required: false,
        description: 'Data do briefing (YYYY-MM-DD; padrão hoje).',
      },
      {
        name: 'useLlm',
        type: 'boolean',
        required: false,
        description: 'Se verdadeiro e houver redator LLM injetado, formata a narrativa mantendo os dados determinísticos.',
      },
    ],
    verify(result) {
      if (!isPlainObject(result) || result.ok !== true) return false;
      if (result.schema !== BRIEFING_SCHEMA) return false;
      if (!isValidCalendarDate(result.date)) return false;
      if (typeof result.text !== 'string' || !result.text.trim()) return false;
      if (typeof result.deterministicText !== 'string' || !result.deterministicText.trim()) return false;
      if (!Array.isArray(result.commitments) || !Array.isArray(result.priorityTasks) || !Array.isArray(result.projects)) {
        return false;
      }
      if (!isPlainObject(result.pending) || !isPlainObject(result.counts)) return false;
      return true;
    },
    async execute(args = {}) {
      return service.build({
        date: args.date ?? null,
        useLlm: args.useLlm === true,
      });
    },
  };
}

