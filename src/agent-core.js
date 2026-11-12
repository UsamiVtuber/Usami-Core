/**
 * Usami Core — roteamento de intenção e orquestração do domínio agêntico (S9).
 *
 * Classifica a mensagem de forma determinística primeiro (`conversation`,
 * `operational` ou `complex`) e aceita `classifyWithLlm` injetável apenas para
 * casos ambíguos. Encaminha pedidos operacionais ao Tool Executor (S4/S5) e
 * tarefas complexas ao Planner Engine (S6), sem nunca substituir o caminho ativo
 * de `createChatHandler` nem bloquear o balão da companion.
 */
import { randomBytes } from 'node:crypto';
import { AGENT_LIMITS, AGENT_SCHEMAS, INTENT_KINDS, validateIntent } from './agent-contracts.js';

export const DEFAULT_TURN_LIMIT = 50;
export const DEFAULT_TURN_DEADLINE_MS = 40_000;
const AMBIGUITY_CONFIDENCE_THRESHOLD = 0.7;

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const iso = ms => new Date(ms).toISOString();
const collapseText = value => String(value ?? '').trim().replace(/\s+/g, ' ');
const normalizeText = value => collapseText(value)
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase();

const COMPLEX_PATTERNS = [
  /\b(planej\w*|cronograma|roteiro|plano|etapas?|passo a passo|checklist|decompor|roadmap)\b/,
  /\b(organiz\w*|estrutur\w*|prepar\w*|mont\w*)\s+(?:a|o|minha|meu|as|os|uma|um)?\s*(?:semana|mes|dia|projeto|rotina|viagem|estudos?|sprint|entrega|tarefas?|agenda)\b/,
  /\b(primeiro|antes)\b.*\b(depois|em seguida|por fim)\b/,
];

const OPERATIONAL_PATTERNS = [
  /\b(bus(?:c|qu)\w*|procur\w*|pesquis\w*|consult\w*)\b.*\b(memoria|fatos|historico|resumos?)\b/,
  /\bo que (?:voce|vc|tu) (?:sabe|lembra)\b/,
  /\b(lembr\w*|record\w*)\b.*\b(te falei|eu disse|eu gosto|sobre mim|memoria)\b/,
  /\b(list\w*|mostr\w*|quais|adicion\w*|cri\w*|anot\w*|registr\w*|mar(?:c|qu)\w*|atualiz\w*|conclu\w*|prioriz\w*|orden\w*)\b.*\b(tarefas?|pendencias?|compromissos?|projetos?|prazos?|agenda)\b/,
  /\b(quais|lista\w*|mostr\w*|descrev\w*|resum\w*)\b.*\b(ferramentas?|skills?|habilidades?|modulos?|limitacoes?|integracoes?|erros?\s+recentes?)\b/,
  /\b(?:o que (?:voce|vc|tu) (?:tem|faz|consegue fazer)|suas? limitacoes?|seu status)\b/,
  /\bbriefing\b/,
  /\bresumo\s+(?:do\s+dia|diario)\b/,
  /\b(revis\w*|resum\w*)\b.*\b(estudos?|aprendizado|revisao espacada)\b/,
  /\b(?:criar|gerar|montar)\s+(?:uma?\s+)?(?:trilha\s+de\s+estudos?|rascunho|documento|nota|checklist|adr)\b/,
  /\b(?:inspecion\w*|ler|ver|mostr\w*|busc\w*|procur\w*)\b.*\b(?:arquivo|codigo|src\/|docs\/|skills\/)\b/,
  /\b(?:projet\w*|desenh\w*|blueprint)\b.*\bskill\b/,
  /\bexecuta\w*\s+(?:a\s+)?ferramenta\b/,
];

const CONVERSATION_PATTERNS = [
  /^(?:oi+|ola+|hey+|ei+|bom dia|boa tarde|boa noite|tudo bem|como vai|e ai)\b/,
  /\b(vamos conversar|conta uma piada|te amo|saudade|estou triste|estou feliz|estou cansad[oa])\b/,
];

const MEMORY_QUERY_LEAD_IN_RE = /^(?:(?:por favor|usami|ei|oi)[,\s]+)*(?:(?:o que (?:voce|vc|tu) (?:sabe|lembra))|(?:(?:busca|buscar|busque|procure|procurar|pesquisa|pesquisar|pesquise|consulta|consultar|consulte|lembra|lembrar|lembre|mostra|mostrar|mostre|veja|ver)(?:\s+(?:na|nos|no)\s+(?:memoria|fatos|historico|resumos?))?))(?:\s+(?:sobre|por|de|a respeito de|do que))?\s*[:\-]?\s*/i;

export function extractMemoryQuery(message) {
  const clean = collapseText(message).replace(/[?!.]+$/, '').trim();
  const normalizedLead = normalizeText(clean);
  const match = MEMORY_QUERY_LEAD_IN_RE.exec(normalizedLead);
  if (!match) return clean;
  const sliced = clean.slice(match[0].length)
    .replace(/^(?:o que eu (?:disse|falei|gosto)\s*(?:sobre|de)?\s*)/i, '')
    .replace(/^(?:(?:o|a|os|as)\s+)?(?:meu|minha|meus|minhas)\s+|^(?:o|a|os|as)\s+/i, '')
    .trim();
  return sliced || clean;
}

function buildIntent({ kind, goal, confidence, origin, now }) {
  const trimmedGoal = collapseText(goal).slice(0, AGENT_LIMITS.maxGoalChars);
  const safeGoal = trimmedGoal.length >= 3 ? trimmedGoal : trimmedGoal.padEnd(3, '.');
  const candidate = {
    schema: AGENT_SCHEMAS.intent,
    id: `int-${randomBytes(6).toString('hex')}`,
    kind,
    goal: safeGoal,
    confidence,
    origin,
    createdAt: iso(now()),
  };
  const checked = validateIntent(candidate);
  if (!checked.ok) throw new Error(`intent inválida: ${checked.errors.join('; ')}`);
  return checked.value;
}

/**
 * Classificação determinística síncrona (primeiro estágio).
 * Devolve `{ kind, confidence, ambiguous, matchedToolName? }`.
 */
export function classifyDeterministic(message, { toolNames = [] } = {}) {
  const clean = collapseText(message);
  const normalized = normalizeText(clean);
  if (!normalized) return { kind: 'conversation', confidence: 0.9, ambiguous: false };

  for (const toolName of toolNames) {
    if (normalized.includes(toolName.toLowerCase())) {
      return { kind: 'operational', confidence: 0.95, ambiguous: false, matchedToolName: toolName };
    }
  }

  if (COMPLEX_PATTERNS.some(pattern => pattern.test(normalized))) {
    return { kind: 'complex', confidence: 0.9, ambiguous: false };
  }

  if (OPERATIONAL_PATTERNS.some(pattern => pattern.test(normalized))) {
    return { kind: 'operational', confidence: 0.88, ambiguous: false };
  }

  if (CONVERSATION_PATTERNS.some(pattern => pattern.test(normalized))) {
    return { kind: 'conversation', confidence: 0.92, ambiguous: false };
  }

  // Pedidos curtos ou vagos sem marcadores claros são sinalizados como
  // ambíguos para que um classificador LLM opcional possa desempatar; sem
  // LLM, caem em conversa com segurança.
  const words = normalized.split(/\s+/).filter(Boolean);
  const looksVagueQuestion = words.length <= 6 && /\b(faz|faca|resolve|ajuda|isso|aquilo|agora)\b/.test(normalized);
  return {
    kind: 'conversation',
    confidence: looksVagueQuestion ? 0.55 : 0.78,
    ambiguous: looksVagueQuestion,
  };
}

export const DEFAULT_TOOL_MATCHERS = Object.freeze([
  {
    toolName: 'memory.search',
    matches: normalized => (
      /\b(busca\w*|procur\w*|pesquis\w*|consult\w*|lembra\w*)\b.*\b(memoria|fatos|historico|resumos?|sobre|eu)\b/.test(normalized)
      || /\bo que (?:voce|vc|tu) (?:sabe|lembra)\b/.test(normalized)
    ),
    buildArgs: message => ({ query: extractMemoryQuery(message) }),
  },
  {
    toolName: 'planner.prioritize',
    matches: normalized => /\b(prioriz\w*|orden\w*)\b.*\b(tarefas?|pendencias?|compromissos?|agenda)\b/.test(normalized),
    buildArgs: () => ({}),
  },
  {
    toolName: 'self.describe',
    matches: normalized => (
      /\b(quais|lista\w*|mostr\w*|descrev\w*|resum\w*)\b.*\b(ferramentas?|skills?|habilidades?|modulos?|limitacoes?|integracoes?|erros?\s+recentes?)\b/.test(normalized)
      || /\b(?:o que (?:voce|vc|tu) (?:tem|faz|consegue fazer)|suas? limitacoes?|seu status)\b/.test(normalized)
    ),
    buildArgs: message => {
      const normalized = normalizeText(message);
      if (/\berros?\b/.test(normalized)) return { focus: 'errors' };
      if (/\blimitacoes?\b/.test(normalized)) return { focus: 'limitations' };
      if (/\bskills?\b/.test(normalized)) return { focus: 'skills' };
      if (/\bmodulos?\b/.test(normalized)) return { focus: 'modules' };
      if (/\bferramentas?\b/.test(normalized)) return { focus: 'tools' };
      return { focus: 'all' };
    },
  },
  {
    toolName: 'briefing.build',
    matches: normalized => (
      /\bbriefing\b/.test(normalized)
      || /\bresumo\s+(?:do\s+dia|diario)\b/.test(normalized)
    ),
    buildArgs: message => {
      const dateMatch = String(message ?? '').match(/\b(\d{4}-\d{2}-\d{2})\b/);
      return dateMatch ? { date: dateMatch[1] } : {};
    },
  },
  {
    toolName: 'study.review',
    matches: normalized => /\b(revis\w*|resum\w*)\b.*\b(estudos?|aprendizado|revisao espacada)\b/.test(normalized),
    buildArgs: message => {
      const clean = collapseText(message);
      const match = /(?:sobre|de)\s+([a-zA-Z0-9À-ÿ _-]{2,80})[?!.]*$/i.exec(clean);
      const topic = match?.[1]?.trim();
      return topic && !/^estudos?$/i.test(topic) ? { topic } : {};
    },
  },
  {
    toolName: 'study.plan',
    matches: normalized => /\b(?:criar|gerar|montar)\s+(?:uma?\s+)?trilha\s+de\s+estudos?\b/.test(normalized),
    buildArgs: message => {
      const clean = collapseText(message).replace(/[?!.]+$/, '').trim();
      const match = /trilha\s+de\s+estudos?\s*(?:sobre|de|para)?\s*(.+)$/i.exec(clean);
      return { topic: (match?.[1]?.trim() || clean).slice(0, 160) };
    },
  },
  {
    toolName: 'document.draft',
    matches: normalized => /\b(?:criar|gerar|montar)\s+(?:uma?\s+)?(?:rascunho|documento|nota|checklist|adr)\b/.test(normalized),
    buildArgs: message => {
      const clean = collapseText(message).replace(/[?!.]+$/, '').trim();
      const norm = normalizeText(clean);
      const format = /\bchecklist\b/.test(norm)
        ? 'checklist'
        : (/\badr\b/.test(norm) ? 'adr' : (/\bresumo\b/.test(norm) ? 'summary' : 'note'));
      const match = /(?:rascunho|documento|nota|checklist|adr)\s*(?:sobre|de|para|com titulo)?\s*(.+)$/i.exec(clean);
      return {
        title: (match?.[1]?.trim() || clean).slice(0, 180),
        format,
      };
    },
  },
  {
    toolName: 'code.inspect',
    matches: normalized => /\b(?:inspecion\w*|ler|ver|mostr\w*)\b.*\b(?:src\/|docs\/|skills\/|package\.json|server\.mjs)\b/.test(normalized),
    buildArgs: message => {
      const pathMatch = String(message ?? '').match(/\b((?:src|docs|skills|tests)\/[a-zA-Z0-9._/-]+|package\.json|server\.mjs)\b/);
      return { path: pathMatch ? pathMatch[1] : 'package.json' };
    },
  },
  {
    toolName: 'code.search',
    matches: normalized => /\b(?:busc\w*|procur\w*|pesquis\w*)\b.*\b(?:codigo|src\/|docs\/|skills\/)\b/.test(normalized),
    buildArgs: message => {
      const clean = collapseText(message).replace(/[?!.]+$/, '').trim();
      const match = /(?:por|sobre|termo|simbolo)\s+([a-zA-Z0-9_.-]{2,80})$/i.exec(clean);
      return { query: (match?.[1] || clean).slice(0, 80) };
    },
  },
  {
    toolName: 'architect.blueprint',
    matches: normalized => /\b(?:projet\w*|desenh\w*|blueprint)\b.*\bskill\b/.test(normalized),
    buildArgs: message => {
      const clean = collapseText(message).replace(/[?!.]+$/, '').trim();
      const match = /skill\s*(?:de|para|chamada)?\s*(.+)$/i.exec(clean);
      const name = (match?.[1]?.trim() || 'Nova Skill').slice(0, 60);
      return {
        name,
        description: `Skill projetada para ${name}.`,
      };
    },
  },
]);

const isScheduleGoal = normalized => /\b(semana|agenda|cronograma|tarefas?|compromissos?|prioriz\w*|conflit\w*|rotina)\b/.test(normalized);

function resolveToolCall(message, registry, toolMatchers, hintedToolName, isToolActive = () => true) {
  const normalized = normalizeText(message);

  if (hintedToolName && registry.has(hintedToolName) && isToolActive(hintedToolName)) {
    const matcher = toolMatchers.find(item => item.toolName === hintedToolName);
    if (matcher) return { toolName: hintedToolName, args: matcher.buildArgs(message) };
    const clean = collapseText(message).replace(new RegExp(hintedToolName.replace('.', '\\.'), 'ig'), '').trim() || collapseText(message);
    const spec = registry.get(hintedToolName);
    const firstStringParam = spec?.parameters?.find(param => param.type === 'string' && param.required);
    return {
      toolName: hintedToolName,
      args: firstStringParam ? { [firstStringParam.name]: clean } : {},
    };
  }

  for (const matcher of toolMatchers) {
    if (!registry.has(matcher.toolName) || !isToolActive(matcher.toolName)) continue;
    if (matcher.matches(normalized)) {
      return { toolName: matcher.toolName, args: matcher.buildArgs(message) };
    }
  }
  return null;
}

export function createAgentCore({
  registry,
  executor,
  planner,
  skillCatalog = null,
  classifyWithLlm = null,
  toolMatchers = DEFAULT_TOOL_MATCHERS,
  turnDeadlineMs = DEFAULT_TURN_DEADLINE_MS,
  turnLimit = DEFAULT_TURN_LIMIT,
  now = () => Date.now(),
  onError = message => console.error(message),
} = {}) {
  if (!registry || typeof registry.has !== 'function' || typeof registry.names !== 'function') {
    throw new Error('createAgentCore: registry é obrigatório.');
  }
  if (!executor || typeof executor.execute !== 'function') {
    throw new Error('createAgentCore: executor é obrigatório.');
  }
  if (!planner || typeof planner.create !== 'function') {
    throw new Error('createAgentCore: planner é obrigatório.');
  }

  function isToolActive(toolName) {
    if (!registry.has(toolName)) return false;
    if (!skillCatalog || typeof skillCatalog.list !== 'function' || typeof skillCatalog.get !== 'function') {
      return true;
    }
    const items = skillCatalog.list();
    for (const item of items) {
      if (!item.valid) continue;
      const detailed = skillCatalog.get(item.id);
      const tools = detailed?.ok ? detailed.skill?.manifest?.tools : null;
      if (Array.isArray(tools) && tools.includes(toolName)) {
        return detailed.skill.activation?.canActivate === true;
      }
    }
    return true;
  }

  const turns = [];
  const turnsById = new Map();

  function recordTurn(entry) {
    turns.push(entry);
    turnsById.set(entry.id, entry);
    if (turns.length > turnLimit) {
      const removed = turns.shift();
      if (removed) turnsById.delete(removed.id);
    }
    return entry;
  }

  function cloneTurn(entry) {
    return JSON.parse(JSON.stringify(entry));
  }

  async function classifyIntent(message, { signal } = {}) {
    const clean = collapseText(message);
    const deterministic = classifyDeterministic(clean, { toolNames: registry.names() });

    if (!deterministic.ambiguous || typeof classifyWithLlm !== 'function') {
      return {
        intent: buildIntent({
          kind: deterministic.kind,
          goal: clean,
          confidence: deterministic.confidence,
          origin: 'classifier',
          now,
        }),
        matchedToolName: deterministic.matchedToolName || null,
      };
    }

    const llmAbort = new AbortController();
    const llmTimer = setTimeout(() => llmAbort.abort(), turnDeadlineMs);
    try {
      const llmSignal = signal ? AbortSignal.any([signal, llmAbort.signal]) : llmAbort.signal;
      const llmDecision = await classifyWithLlm({
        message: clean,
        tools: registry.list(),
        signal: llmSignal,
      });
      if (isPlainObject(llmDecision) && INTENT_KINDS.includes(llmDecision.kind)) {
        const confidence = typeof llmDecision.confidence === 'number' && Number.isFinite(llmDecision.confidence)
          ? Math.min(Math.max(llmDecision.confidence, 0), 1)
          : AMBIGUITY_CONFIDENCE_THRESHOLD;
        return {
          intent: buildIntent({
            kind: llmDecision.kind,
            goal: typeof llmDecision.goal === 'string' && llmDecision.goal.trim() ? llmDecision.goal : clean,
            confidence,
            origin: 'llm',
            now,
          }),
          matchedToolName: typeof llmDecision.tool === 'string' ? llmDecision.tool : null,
        };
      }
    } catch (error) {
      onError(`Aviso: classificador LLM falhou no turno (${error?.message || error}); usando fallback determinístico.`);
    } finally {
      clearTimeout(llmTimer);
    }

    return {
      intent: buildIntent({
        kind: deterministic.kind,
        goal: clean,
        confidence: deterministic.confidence,
        origin: 'classifier',
        now,
      }),
      matchedToolName: null,
    };
  }

  async function executeClassified({ turnId, intent, matchedToolName, message, confirmation, origin, startedMs }) {
    if (intent.kind === 'conversation') {
      return {
        id: turnId,
        intent,
        route: 'conversation',
        status: 'idle',
        createdAt: intent.createdAt,
        durationMs: Math.max(0, now() - startedMs),
      };
    }

    if (intent.kind === 'operational') {
      const resolved = resolveToolCall(message, registry, toolMatchers, matchedToolName, isToolActive);
      if (!resolved) {
        return {
          id: turnId,
          intent,
          route: 'unmatched',
          status: 'no_matching_tool',
          missingCapability: true,
          reason: 'nenhuma ferramenta registrada atende esta solicitação operacional',
          createdAt: intent.createdAt,
          durationMs: Math.max(0, now() - startedMs),
        };
      }

      const execution = await executor.execute(resolved.toolName, resolved.args, { origin, confirmation });
      const status = execution.ok
        ? 'executed'
        : (execution.denied ? 'awaiting_confirmation' : 'failed');
      return {
        id: turnId,
        intent,
        route: 'tool',
        status,
        tool: resolved.toolName,
        ...(execution.record ? { execution: execution.record } : {}),
        ...(execution.ok ? { result: execution.result } : {}),
        ...(!execution.ok && execution.errors ? { errors: execution.errors } : {}),
        createdAt: intent.createdAt,
        durationMs: Math.max(0, now() - startedMs),
      };
    }

    if (isToolActive('planner.schedule') && isScheduleGoal(normalizeText(intent.goal || message))) {
      const execution = await executor.execute(
        'planner.schedule',
        { goal: intent.goal },
        { origin, confirmation },
      );
      if (execution.ok) {
        return {
          id: turnId,
          intent,
          route: 'plan',
          status: 'planned',
          tool: 'planner.schedule',
          ...(execution.record ? { execution: execution.record } : {}),
          ...(execution.result.plan ? { plan: execution.result.plan } : {}),
          ...(execution.result.plan?.briefing ? { briefing: execution.result.plan.briefing } : {}),
          schedule: execution.result.schedule,
          conflicts: execution.result.conflicts,
          tasks: execution.result.tasks,
          summary: execution.result.summary,
          createdAt: intent.createdAt,
          durationMs: Math.max(0, now() - startedMs),
        };
      }
      return {
        id: turnId,
        intent,
        route: 'plan',
        status: execution.denied ? 'denied' : 'failed',
        tool: 'planner.schedule',
        ...(execution.record ? { execution: execution.record } : {}),
        ...(!execution.ok && execution.errors ? { errors: execution.errors } : {}),
        createdAt: intent.createdAt,
        durationMs: Math.max(0, now() - startedMs),
      };
    }

    const created = planner.create({ goal: intent.goal, origin: 'planner' });
    return {
      id: turnId,
      intent,
      route: 'plan',
      status: created.ok ? 'planned' : 'failed',
      ...(created.ok ? { plan: created.plan, ...(created.plan.briefing ? { briefing: created.plan.briefing } : {}) } : { errors: created.errors }),
      createdAt: intent.createdAt,
      durationMs: Math.max(0, now() - startedMs),
    };
  }

  /** Processa um turno completo (usado por `POST /api/agent/turn`). */
  async function processTurn(message, { confirmation, origin = 'agent', signal } = {}) {
    const clean = collapseText(message);
    if (clean.length < 1 || clean.length > 2000) {
      return { ok: false, invalidInput: true, error: 'Mensagem inválida (1 a 2000 caracteres).' };
    }
    const startedMs = now();
    const turnId = `trn-${randomBytes(6).toString('hex')}`;
    const { intent, matchedToolName } = await classifyIntent(clean, { signal });
    const turn = await executeClassified({
      turnId,
      intent,
      matchedToolName,
      message: clean,
      confirmation,
      origin,
      startedMs,
    });
    recordTurn(turn);
    return { ok: true, turn: cloneTurn(turn) };
  }

  /**
   * Integração não-bloqueante para o `/api/chat`: classificação determinística
   * síncrona (<1 ms). Conversas normais devolvem `null` (contrato do chat
   * intacto); pedidos operacionais ou complexos disparam em background e
   * devolvem um resumo compacto para o campo opcional `agentTurn`.
   */
  function dispatchAsync(message, { origin = 'agent' } = {}) {
    const clean = collapseText(message);
    if (!clean) return null;
    const deterministic = classifyDeterministic(clean, { toolNames: registry.names() });
    if (deterministic.kind === 'conversation' && !(deterministic.ambiguous && typeof classifyWithLlm === 'function')) {
      return null;
    }

    const startedMs = now();
    const turnId = `trn-${randomBytes(6).toString('hex')}`;
    const provisionalIntent = buildIntent({
      kind: deterministic.kind,
      goal: clean,
      confidence: deterministic.confidence,
      origin: 'classifier',
      now,
    });
    const initialRoute = deterministic.kind === 'complex' ? 'plan' : (deterministic.kind === 'operational' ? 'tool' : 'conversation');
    recordTurn({
      id: turnId,
      intent: provisionalIntent,
      route: initialRoute,
      status: 'queued',
      createdAt: provisionalIntent.createdAt,
    });

    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), turnDeadlineMs);
    void (async () => {
      try {
        const classified = deterministic.ambiguous && typeof classifyWithLlm === 'function'
          ? await classifyIntent(clean, { signal: controller.signal })
          : { intent: provisionalIntent, matchedToolName: deterministic.matchedToolName || null };
        const finished = await executeClassified({
          turnId,
          intent: classified.intent,
          matchedToolName: classified.matchedToolName,
          message: clean,
          origin,
          startedMs,
        });
        const existing = turnsById.get(turnId);
        if (existing) Object.assign(existing, finished);
      } catch (error) {
        onError(`Aviso: orquestração assíncrona do turno ${turnId} falhou (${error?.message || error}).`);
        const existing = turnsById.get(turnId);
        if (existing) {
          existing.status = 'failed';
          existing.error = String(error?.message || error);
          existing.durationMs = Math.max(0, now() - startedMs);
        }
      } finally {
        clearTimeout(deadline);
      }
    })();

    return {
      id: turnId,
      kind: provisionalIntent.kind,
      route: initialRoute,
      status: 'queued',
    };
  }

  function listTurns({ limit = 20 } = {}) {
    const max = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), turnLimit) : 20;
    return turns.slice(-max).reverse().map(cloneTurn);
  }

  function getTurn(id) {
    if (typeof id !== 'string' || !/^trn-[0-9a-f]{12}$/.test(id)) return { ok: false, notFound: true };
    const found = turnsById.get(id);
    if (!found) return { ok: false, notFound: true };
    return { ok: true, turn: cloneTurn(found) };
  }

  return {
    classifyIntent,
    processTurn,
    dispatchAsync,
    listTurns,
    getTurn,
  };
}
