import { readEnvValue, signWebhook } from './api-security.js';

const ROUTINE_POLL_PATHS = new Set(['/api/n8n/commands', '/api/chat/activity']);
const OBSERVED_REQ_FLAG = Symbol('usamiObservedApiRequest');
const FORBIDDEN_TEXT_KEYS = new Set([
  'userMessage',
  'reply',
  'prompt',
  'output',
  'messages',
  'parameters',
  'result',
  'authorization',
  'cookie',
  'x-usami-token',
]);

/**
 * Mascara credenciais, chaves de API e tokens conhecidos antes de emitir logs.
 * Nunca retorna mais de 500 caracteres.
 */
export function redactSecrets(value) {
  if (value === null || value === undefined) return '';
  const text = String(value instanceof Error ? (value.message || value) : value);
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\b(nvapi|sk|ghp|gho|xoxb|xoxp|AIza)[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_KEY]')
    .replace(/((?:x-usami-token|authorization|api[-_]?key|secret|password|token)\s*[:=]\s*)(["']?)[^\s,"';&}]+\2/gi, '$1[REDACTED]')
    .replace(/([?&](?:token|key|secret|api_key|password|auth)=)[^&\s]+/gi, '$1[REDACTED]')
    .slice(0, 500);
}

/**
 * Resolve a URL do webhook de observabilidade no n8n.
 * Prioriza N8N_OBSERVABILITY_WEBHOOK_URL, depois deriva de N8N_WEBHOOK_URL.
 */
export function resolveObservabilityWebhookUrl(readEnvFn = readEnvValue) {
  const explicit = readEnvFn('N8N_OBSERVABILITY_WEBHOOK_URL');
  if (explicit) return explicit;

  const baseWebhook = readEnvFn('N8N_WEBHOOK_URL');
  if (baseWebhook) {
    if (baseWebhook.includes('/usami-events')) {
      return baseWebhook.replace('/usami-events', '/usami-observability');
    }
    try {
      return new URL('/webhook/usami-observability', baseWebhook).toString();
    } catch {
      // ignora URL inválida e usa default
    }
  }

  return 'http://localhost:5678/webhook/usami-observability';
}

function normalizePathname(rawUrl) {
  const raw = String(rawUrl || '/');
  const qIndex = raw.indexOf('?');
  return qIndex === -1 ? raw : raw.slice(0, qIndex);
}

/**
 * Evita inundar o banco com polls de rotina (1-2s) quando respondem < 400.
 * Erros (>= 400) em qualquer rota continuam sendo registrados.
 */
export function shouldSkipRoutinePoll(method, urlPath, statusCode, logPolls = false) {
  if (logPolls) return false;
  if (String(method || 'GET').toUpperCase() !== 'GET') return false;
  if (Number(statusCode) >= 400) return false;
  const pathname = normalizePathname(urlPath);
  return ROUTINE_POLL_PATHS.has(pathname);
}

function sanitizeMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {};
  const clean = {};
  for (const [key, val] of Object.entries(metadata)) {
    if (FORBIDDEN_TEXT_KEYS.has(key) || FORBIDDEN_TEXT_KEYS.has(key.toLowerCase())) continue;
    if (val === undefined) continue;
    if (typeof val === 'string') {
      clean[key] = redactSecrets(val);
    } else if (typeof val === 'number' || typeof val === 'boolean' || val === null) {
      clean[key] = val;
    } else if (typeof val === 'object') {
      clean[key] = sanitizeMetadata(val);
    }
  }
  return clean;
}

/**
 * Envia um evento estruturado de observabilidade para o n8n (fire-and-forget).
 * Nunca lança exceção nem inclui texto privado de conversa.
 */
export async function sendObservabilityEvent(event = {}, options = {}) {
  try {
    const readEnvFn = options.readEnvFn || readEnvValue;
    const isTestEnv = Boolean(process.env.NODE_TEST_CONTEXT);
    const hasExplicitTarget = Boolean(
      options.fetchImpl
      || options.webhookUrl
      || process.env.N8N_OBSERVABILITY_WEBHOOK_URL,
    );
    if (isTestEnv && !hasExplicitTarget) {
      return { skipped: true };
    }

    const webhookUrl = options.webhookUrl || resolveObservabilityWebhookUrl(readEnvFn);
    if (!webhookUrl) return { skipped: true };

    const fetchImpl = options.fetchImpl || fetch;
    const timestamp = event.timestamp || new Date().toISOString();
    const statusCode = Number.isFinite(Number(event.statusCode)) ? Number(event.statusCode) : null;
    const isError = Boolean(event.isError || (statusCode !== null && statusCode >= 400) || event.errorMessage);

    const payload = {
      event: 'usami.observability',
      timestamp,
      kind: String(event.kind || (isError ? 'error' : 'api_call')),
      source: String(event.source || 'usami-api'),
      method: event.method ? String(event.method).toUpperCase() : null,
      route: event.route ? normalizePathname(event.route) : null,
      statusCode,
      durationMs: Number.isFinite(Number(event.durationMs)) ? Math.round(Number(event.durationMs)) : null,
      provider: event.provider ? String(event.provider) : null,
      model: event.model ? String(event.model) : null,
      clientId: event.clientId ? redactSecrets(event.clientId).slice(0, 64) : null,
      isError,
      errorCode: event.errorCode ? redactSecrets(event.errorCode).slice(0, 64) : null,
      errorMessage: event.errorMessage ? redactSecrets(event.errorMessage) : null,
      metadata: sanitizeMetadata(event.metadata),
    };

    const body = JSON.stringify(payload);
    const headers = { 'Content-Type': 'application/json' };
    const secret = options.secret !== undefined ? options.secret : readEnvFn('N8N_WEBHOOK_SECRET');
    if (secret) {
      headers['X-Usami-Timestamp'] = timestamp;
      headers['X-Usami-Signature'] = signWebhook(secret, timestamp, body);
    }

    await fetchImpl(webhookUrl, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(options.timeoutMs ?? 3000),
    });
    return { sent: true };
  } catch {
    return { sent: false };
  }
}

/**
 * Instrumenta uma requisição HTTP /api/* da Usami ao término da resposta.
 */
export function observeApiRequest(req, res, options = {}) {
  if (!req || !res || typeof res.once !== 'function') return;
  if (req[OBSERVED_REQ_FLAG]) return;
  req[OBSERVED_REQ_FLAG] = true;

  const startedAt = Date.now();
  const method = String(req.method || 'GET').toUpperCase();
  const route = normalizePathname(req.url || '/');
  const readEnvFn = options.readEnvFn || readEnvValue;
  const logPolls = options.logPolls ?? (readEnvFn('N8N_OBS_LOG_POLLS') === 'true');
  const rawClient = req.headers?.['x-usami-client'];
  const clientId = typeof rawClient === 'string' && rawClient.trim() ? rawClient.trim() : null;

  res.once('finish', () => {
    const statusCode = Number(res.statusCode || 200);
    if (shouldSkipRoutinePoll(method, route, statusCode, logPolls)) return;
    const durationMs = Math.max(0, Date.now() - startedAt);
    const isError = statusCode >= 400;
    void sendObservabilityEvent({
      kind: statusCode >= 500 ? 'error' : 'api_call',
      source: 'usami-api',
      method,
      route,
      statusCode,
      durationMs,
      clientId,
      isError,
      errorMessage: statusCode >= 500 ? `HTTP ${statusCode} em ${method} ${route}` : null,
    }, options);
  });
}
