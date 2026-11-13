/**
 * @fileoverview Rotas do Domínio Agêntico da Usami (Turnos, Introspecção, Sugestões, Briefing).
 * @module routes/agent-routes
 */

import { EXECUTION_ORIGINS } from '../agent-contracts.js';
import { DEFAULT_ERROR_LIMIT, MAX_ERROR_LIMIT } from '../self-introspection.js';
import {
  SUGGESTION_STATUSES,
  SUGGESTIONS_DEFAULT_LIMIT,
  SUGGESTIONS_MAX_LIMIT,
} from '../proactive-suggestions.js';
import { isValidCalendarDate, createDailyBriefingService } from '../daily-briefing-skill.js';
import {
  DEFAULT_ALLOWED_ORIGINS,
  isAllowedOrigin,
  denyWithoutToken,
  readRequestBody,
  sendJsonResponse,
} from './http-helpers.js';

export { createCodeAgentBridge, createAgentBridgeHandler } from '../code-agent-bridge.js';

const AGENT_TURN_ID_RE = /^\/api\/agent\/turns\/(trn-[0-9a-f]{12})$/;
const SELF_FOCUS_VALUES = Object.freeze(['all', 'tools', 'skills', 'modules', 'errors', 'limitations']);
const AGENT_SUGGESTION_PATH_RE = /^\/api\/agent\/suggestions\/(sg-[0-9a-f]{12})$/;
const AGENT_SUGGESTION_ACTION_RE = /^\/api\/agent\/suggestions\/(sg-[0-9a-f]{12})\/(accept|dismiss)$/;

/**
 * Cria o handler para turnos agênticos: POST /api/agent/turn, GET /api/agent/turns e GET /api/agent/turns/:id.
 * @param {Object} [options]
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createAgentTurnHandler(options = {}) {
  const allowedOrigins = options.allowedOrigins || DEFAULT_ALLOWED_ORIGINS;
  const agentCore = options.agentCore;

  return async function handleAgentTurn(req, res) {
    const send = (status, data) => sendJsonResponse(res, status, data);

    if (!isAllowedOrigin(req.headers.origin, req.headers.host, allowedOrigins)) {
      return send(403, { error: 'Origem não autorizada.' });
    }
    if (denyWithoutToken(req, options, send)) return;

    const url = new URL(req.url || '/api/agent/turn', 'http://127.0.0.1:8787');
    const path = url.pathname;

    if (!agentCore) {
      return send(500, { error: 'AgentCore não inicializado.' });
    }

    if (req.method === 'GET') {
      if (path === '/api/agent/turns') {
        const rawLimit = url.searchParams.get('limit');
        let limit = 20;
        if (rawLimit !== null) {
          const parsed = Number(rawLimit);
          if (!Number.isInteger(parsed) || parsed < 1 || parsed > 50) {
            return send(400, { error: 'limit inválido (inteiro entre 1 e 50).' });
          }
          limit = parsed;
        }
        const turns = agentCore.listTurns({ limit });
        return send(200, { ok: true, turns, count: turns.length });
      }
      const match = path.match(AGENT_TURN_ID_RE);
      if (!match) return send(404, { error: 'Não encontrado.' });
      const found = agentCore.getTurn(match[1]);
      if (!found.ok) return send(404, { error: 'Turno não encontrado.' });
      return send(200, { ok: true, turn: found.turn });
    }

    if (req.method !== 'POST' || path !== '/api/agent/turn') {
      return send(404, { error: 'Não encontrado.' });
    }

    const contentType = (req.headers['content-type'] || '').split(';')[0].trim();
    if (contentType !== 'application/json') return send(403, { error: 'Content-Type inválido.' });
    const read = await readRequestBody(req, { limit: 16384 });
    if (!read.ok) return send(413, { error: 'Pedido muito longo.' });

    let payload;
    try {
      payload = JSON.parse(read.body);
    } catch {
      return send(400, { error: 'Corpo da requisição inválido (JSON esperado).' });
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return send(400, { error: 'Corpo inválido.' });
    }
    const unknown = Object.keys(payload).filter(key => !['message', 'confirmation', 'origin'].includes(key));
    if (unknown.length) {
      return send(400, { error: 'Corpo inválido.', details: unknown.map(key => `payload.${key}: campo desconhecido`) });
    }
    if (typeof payload.message !== 'string') {
      return send(400, { error: 'message: deve ser texto.' });
    }
    const origin = payload.origin ?? 'agent';
    if (!EXECUTION_ORIGINS.includes(origin)) {
      return send(400, { error: `origin inválido (use ${EXECUTION_ORIGINS.join('|')}).` });
    }
    if (payload.confirmation !== undefined && (typeof payload.confirmation !== 'string' || payload.confirmation.length > 128)) {
      return send(400, { error: 'confirmation: deve ser texto de até 128 caracteres.' });
    }

    let result;
    try {
      result = await agentCore.processTurn(payload.message, {
        confirmation: payload.confirmation,
        origin,
      });
    } catch (error) {
      console.error('Aviso: falha ao processar turno agêntico:', error?.message || error);
      return send(500, { error: 'Não foi possível processar o turno.' });
    }
    if (result.invalidInput) return send(400, { error: result.error });
    return send(200, { ok: true, turn: result.turn });
  };
}

/**
 * Cria o handler para introspecção do sistema: GET /api/agent/self.
 * @param {Object} [options]
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createSelfHandler(options = {}) {
  const allowedOrigins = options.allowedOrigins || DEFAULT_ALLOWED_ORIGINS;
  const introspection = options.introspection;

  return async function handleSelf(req, res) {
    const send = (status, data) => sendJsonResponse(res, status, data);

    if (!isAllowedOrigin(req.headers.origin, req.headers.host, allowedOrigins)) {
      return send(403, { error: 'Origem não autorizada.' });
    }
    if (denyWithoutToken(req, options, send)) return;

    const url = new URL(req.url || '/api/agent/self', 'http://127.0.0.1:8787');
    if (req.method !== 'GET' || url.pathname !== '/api/agent/self') {
      return send(404, { error: 'Não encontrado.' });
    }

    if (!introspection) {
      return send(500, { error: 'SelfIntrospection não inicializado.' });
    }

    const focusParam = url.searchParams.get('focus');
    const focus = focusParam === null ? 'all' : focusParam;
    if (!SELF_FOCUS_VALUES.includes(focus)) {
      return send(400, { error: `focus inválido (use ${SELF_FOCUS_VALUES.join('|')}).` });
    }

    const rawErrorLimit = url.searchParams.get('errorLimit');
    let errorLimit = DEFAULT_ERROR_LIMIT;
    if (rawErrorLimit !== null) {
      const parsed = Number(rawErrorLimit);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_ERROR_LIMIT) {
        return send(400, { error: `errorLimit inválido (inteiro entre 1 e ${MAX_ERROR_LIMIT}).` });
      }
      errorLimit = parsed;
    }

    try {
      const self = introspection.describe({ focus, errorLimit });
      return send(200, { ok: true, self });
    } catch (error) {
      console.error('Aviso: self-introspection falhou:', error?.message || error);
      return send(500, { error: 'Não foi possível montar o retrato do sistema.' });
    }
  };
}

/**
 * Cria o handler para sugestões proativas contextuais: /api/agent/suggestions.
 * @param {Object} [options]
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createSuggestionsHandler(options = {}) {
  const allowedOrigins = options.allowedOrigins || DEFAULT_ALLOWED_ORIGINS;
  const store = options.suggestionsStore;
  const planner = options.taskPlanner;
  const engine = options.proactiveEngine;

  return async function handleSuggestions(req, res) {
    const send = (status, data) => sendJsonResponse(res, status, data);

    if (!isAllowedOrigin(req.headers.origin, req.headers.host, allowedOrigins)) {
      return send(403, { error: 'Origem não autorizada.' });
    }
    if (denyWithoutToken(req, options, send)) return;

    const url = new URL(req.url || '/api/agent/suggestions', 'http://127.0.0.1:8787');
    const path = url.pathname;

    if (!store) {
      return send(500, { error: 'SuggestionsStore não inicializado.' });
    }

    if (req.method === 'GET') {
      if (path === '/api/agent/suggestions') {
        const statusParam = url.searchParams.get('status');
        if (statusParam !== null && !SUGGESTION_STATUSES.includes(statusParam)) {
          return send(400, { error: `status inválido (use ${SUGGESTION_STATUSES.join('|')}).` });
        }
        const rawLimit = url.searchParams.get('limit');
        let limit = SUGGESTIONS_DEFAULT_LIMIT;
        if (rawLimit !== null) {
          const parsed = Number(rawLimit);
          if (!Number.isInteger(parsed) || parsed < 1 || parsed > SUGGESTIONS_MAX_LIMIT) {
            return send(400, { error: `limit inválido (inteiro entre 1 e ${SUGGESTIONS_MAX_LIMIT}).` });
          }
          limit = parsed;
        }
        const evaluateParam = url.searchParams.get('evaluate');
        if ((evaluateParam === '1' || evaluateParam === 'true') && typeof engine?.checkSuggestions === 'function') {
          engine.checkSuggestions({ store });
        }
        const suggestions = store.list({ ...(statusParam ? { status: statusParam } : {}), limit });
        return send(200, {
          ok: true,
          suggestions,
          count: suggestions.length,
          unansweredCount: store.countUnanswered(),
          pending: store.getPending(),
          unavailable: store.unavailable(),
        });
      }

      const idMatch = path.match(AGENT_SUGGESTION_PATH_RE);
      if (!idMatch) return send(404, { error: 'Não encontrado.' });
      const found = store.get(idMatch[1]);
      if (found.unavailable) return send(500, { error: 'Sugestões indisponíveis (arquivo inválido).' });
      if (found.notFound) return send(404, { error: 'Sugestão não encontrada.' });
      return send(200, { ok: true, suggestion: found.suggestion });
    }

    if (req.method !== 'POST') return send(404, { error: 'Não encontrado.' });
    const actionMatch = path.match(AGENT_SUGGESTION_ACTION_RE);
    if (!actionMatch) return send(404, { error: 'Não encontrado.' });

    const contentType = (req.headers['content-type'] || '').split(';')[0].trim();
    if (contentType !== 'application/json') return send(403, { error: 'Content-Type inválido.' });
    const read = await readRequestBody(req, { limit: 4096 });
    if (!read.ok) return send(413, { error: 'Pedido muito longo.' });

    let payload;
    try {
      payload = JSON.parse(read.body);
    } catch {
      return send(400, { error: 'Corpo da requisição inválido (JSON esperado).' });
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return send(400, { error: 'Corpo inválido.' });
    }

    const [, suggestionId, action] = actionMatch;
    const allowedKeys = action === 'accept' ? ['goal', 'note'] : ['reason'];
    const unknown = Object.keys(payload).filter(key => !allowedKeys.includes(key));
    if (unknown.length) {
      return send(400, { error: 'Corpo inválido.', details: unknown.map(key => `payload.${key}: campo desconhecido`) });
    }

    if (store.unavailable()) return send(500, { error: 'Sugestões indisponíveis (arquivo inválido).' });

    let result;
    try {
      result = action === 'accept'
        ? store.accept(suggestionId, { taskPlanner: planner, goal: payload.goal, note: payload.note })
        : store.dismiss(suggestionId, { reason: payload.reason });
    } catch (error) {
      console.error('Aviso: falha ao responder sugestão:', error?.message || error);
      return send(500, { error: 'Não foi possível atualizar a sugestão.' });
    }

    if (result.notFound) return send(404, { error: 'Sugestão não encontrada.' });
    if (result.wrongState) return send(409, { error: result.error });
    if (result.plannerUnavailable) return send(500, { error: result.error });
    if (!result.ok) return send(400, { error: 'Pedido inválido.', details: result.errors });

    return send(200, {
      ok: true,
      suggestion: result.suggestion,
      ...(result.plan ? { plan: result.plan } : {}),
    });
  };
}

/**
 * Cria o handler para Daily Briefing: GET /api/agent/briefing.
 * @param {Object} [options]
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createBriefingHandler(options = {}) {
  const allowedOrigins = options.allowedOrigins || DEFAULT_ALLOWED_ORIGINS;
  const toolExecutor = options.toolExecutor;
  const catalog = 'skillCatalog' in options ? options.skillCatalog : null;
  const useCustomService = Boolean(
    options.briefingService
    || ((options.operationalStore || options.taskPlanner || options.rewriteWithLlm || options.executionProvider || options.now)
      && !options.toolExecutor),
  );
  const service = options.briefingService || createDailyBriefingService({
    operationalStore: options.operationalStore,
    taskPlanner: options.taskPlanner,
    toolExecutor,
    executionProvider: options.executionProvider || null,
    rewriteWithLlm: options.rewriteWithLlm || null,
    now: options.now || (() => Date.now()),
  });

  return async function handleBriefing(req, res) {
    const send = (status, data) => sendJsonResponse(res, status, data);

    if (!isAllowedOrigin(req.headers.origin, req.headers.host, allowedOrigins)) {
      return send(403, { error: 'Origem não autorizada.' });
    }
    if (denyWithoutToken(req, options, send)) return;

    const url = new URL(req.url || '/api/agent/briefing', 'http://127.0.0.1:8787');
    if (req.method !== 'GET' || url.pathname !== '/api/agent/briefing') {
      return send(404, { error: 'Não encontrado.' });
    }

    const rawDate = url.searchParams.get('date');
    if (rawDate !== null && !isValidCalendarDate(rawDate)) {
      return send(400, { error: 'date inválido (use YYYY-MM-DD).' });
    }

    const rawUseLlm = url.searchParams.get('useLlm');
    let useLlm = false;
    if (rawUseLlm !== null) {
      const lowered = rawUseLlm.trim().toLowerCase();
      if (lowered === 'true' || lowered === '1') useLlm = true;
      else if (lowered === 'false' || lowered === '0') useLlm = false;
      else return send(400, { error: 'useLlm inválido (use true|false).' });
    }

    if (catalog && typeof catalog.get === 'function') {
      const skillEntry = catalog.get('daily-briefing');
      if (skillEntry?.ok && !skillEntry.skill?.activation?.canActivate) {
        return send(409, {
          ok: false,
          error: 'Skill daily-briefing não está ativa.',
          reasons: skillEntry.skill?.activation?.reasons || [],
        });
      }
    }

    if (useCustomService) {
      try {
        const briefing = await service.build({ date: rawDate, useLlm });
        return send(200, { ok: true, briefing });
      } catch (error) {
        console.error('Aviso: falha ao montar daily briefing:', error?.message || error);
        return send(500, { error: 'Não foi possível montar o briefing diário.' });
      }
    }

    if (!toolExecutor) {
      return send(500, { error: 'ToolExecutor não inicializado.' });
    }

    let outcome;
    try {
      outcome = await toolExecutor.execute(
        'briefing.build',
        { ...(rawDate !== null ? { date: rawDate } : {}), ...(useLlm ? { useLlm: true } : {}) },
        { origin: 'user' },
      );
    } catch (error) {
      console.error('Aviso: execução de briefing.build falhou:', error?.message || error);
      return send(500, { error: 'Não foi possível montar o briefing diário.' });
    }

    if (outcome.notFound) return send(500, { error: 'Ferramenta briefing.build indisponível.' });
    if (outcome.denied) return send(403, { ok: false, error: outcome.record?.reason || 'Permissão negada.', execution: outcome.record });
    if (!outcome.ok) return send(500, { ok: false, error: outcome.record?.reason || 'Falha ao montar briefing.', execution: outcome.record });
    return send(200, { ok: true, briefing: outcome.result, execution: outcome.record });
  };
}
