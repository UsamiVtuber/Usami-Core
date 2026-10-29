// Cliente NVIDIA API (build.nvidia.com / integrate.api.nvidia.com) com
// rate limiter global: 40 requisições por minuto, compartilhado entre
// todas as funções (classificação, geração de texto, animação).
//
// Resiliência: fila FIFO com teto de espera, retry com backoff + jitter que
// respeita Retry-After (429/5xx/timeout), circuit breaker e cancelamento pelo
// chamador (`signal`) — o deadline do turno e a desconexão do cliente chegam
// aqui como abort.
//
// Lê NVIDIA_API_KEY de process.env.NVIDIA_API_KEY ou do arquivo .env
// indicado por NVIDIA_ENV_FILE (padrão: o .env do projeto, ver keysFilePath).
//
// A API é compatível com OpenAI (POST /v1/chat/completions), então o
// corpo da requisição segue o mesmo esquema do OpenRouter.

import { readFileSync } from 'node:fs';
import { keysFilePath } from './api-security.js';

const DEFAULT_BASE_URL = 'https://integrate.api.nvidia.com/v1';
const DEFAULT_RATE_LIMIT = 40;    // requisições por minuto
const DEFAULT_RATE_WINDOW_MS = 60 * 1000;
const DEFAULT_MAX_QUEUE = 100;
const DEFAULT_MAX_WAIT_MS = 30 * 1000;
const MAX_BACKOFF_MS = 4000;

let apiKeyCache = null;
let envFileCache = null;

function resolveApiKeySync() {
  if (apiKeyCache) return apiKeyCache;
  // 1) variável de ambiente
  if (process.env.NVIDIA_API_KEY) {
    apiKeyCache = process.env.NVIDIA_API_KEY;
    return apiKeyCache;
  }
  // 2) arquivo .env
  const envFile = process.env.NVIDIA_ENV_FILE || keysFilePath();
  if (envFile === envFileCache && apiKeyCache) return apiKeyCache;
  try {
    const text = readFileSync(envFile, 'utf8');
    const parsed = parseEnvText(text);
    apiKeyCache = parsed.NVIDIA_API_KEY || null;
    envFileCache = envFile;
    return apiKeyCache;
  } catch (error) {
    console.warn('[nvidia-client] não foi possível ler', envFile, ':', error.message);
    apiKeyCache = null;
    return null;
  }
}

async function resolveApiKey() {
  return resolveApiKeySync();
}

function parseEnvText(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    out[key] = value;
  }
  return out;
}

// Erro do provedor com o que o retry precisa saber: status HTTP e Retry-After.
export class UpstreamError extends Error {
  constructor(message, { status = 0, retryAfterMs = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'UpstreamError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

// Fila cheia, espera estourada ou circuito aberto: o chamador cai no fallback
// em vez de ficar parado (503 + retryAfterMs).
export class UpstreamUnavailable extends UpstreamError {
  constructor(message, { retryAfterMs = null } = {}) {
    super(message, { status: 503, retryAfterMs });
    this.name = 'UpstreamUnavailable';
  }
}

function abortError(signal) {
  return signal?.reason instanceof Error ? signal.reason : new DOMException('Abortado', 'AbortError');
}

// Rate limiter: janela deslizante de `rateLimit` requisições por `windowMs`,
// com fila FIFO. Quem chega depois nunca passa na frente, a espera tem teto
// (`maxWaitMs`), a fila tem teto (`maxQueue`) e `signal` tira o chamador da fila.
export function createRateLimiter({
  rateLimit = DEFAULT_RATE_LIMIT,
  windowMs = DEFAULT_RATE_WINDOW_MS,
  maxQueue = DEFAULT_MAX_QUEUE,
  maxWaitMs = DEFAULT_MAX_WAIT_MS,
  now = Date.now,
} = {}) {
  const stamps = [];
  const queue = [];
  let timer = null;

  function prune(at) {
    while (stamps.length && at - stamps[0] > windowMs) stamps.shift();
  }

  function schedule(at) {
    clearTimeout(timer);
    timer = null;
    if (!queue.length || !stamps.length) return;
    const waitMs = Math.max(0, windowMs - (at - stamps[0]) + 1);
    timer = setTimeout(drain, waitMs);
    timer.unref?.();
  }

  function drain() {
    const at = now();
    prune(at);
    while (queue.length && stamps.length < rateLimit) {
      const waiter = queue.shift();
      waiter.settle();
      stamps.push(at);
      waiter.resolve();
    }
    schedule(at);
  }

  function waitForSlot({ signal, maxWaitMs: waitCap = maxWaitMs } = {}) {
    if (signal?.aborted) return Promise.reject(abortError(signal));
    const at = now();
    prune(at);
    if (!queue.length && stamps.length < rateLimit) {
      stamps.push(at);
      return Promise.resolve();
    }
    if (queue.length >= maxQueue) {
      return Promise.reject(new UpstreamUnavailable('Fila de requisições cheia.', { retryAfterMs: windowMs }));
    }
    return new Promise((resolve, reject) => {
      let waitTimer = null;
      const waiter = {
        resolve,
        settle() {
          clearTimeout(waitTimer);
          signal?.removeEventListener('abort', onAbort);
        },
      };
      const leave = error => {
        const index = queue.indexOf(waiter);
        if (index >= 0) queue.splice(index, 1);
        waiter.settle();
        reject(error);
      };
      const onAbort = () => leave(abortError(signal));
      signal?.addEventListener('abort', onAbort, { once: true });
      if (Number.isFinite(waitCap)) {
        waitTimer = setTimeout(
          () => leave(new UpstreamUnavailable('Espera pelo limite de requisições estourou.', { retryAfterMs: windowMs })),
          waitCap,
        );
        waitTimer.unref?.();
      }
      queue.push(waiter);
      schedule(at);
    });
  }

  return { waitForSlot };
}

// Circuit breaker: depois de `failureThreshold` falhas seguidas do provedor o
// circuito abre por `cooldownMs` e as chamadas falham na hora (o chat cai no
// fallback em vez de pagar o timeout inteiro); passado o cooldown, uma única
// chamada de prova decide se ele fecha.
export function createCircuitBreaker({ failureThreshold = 5, cooldownMs = 30 * 1000, now = Date.now } = {}) {
  let failures = 0;
  let openedAt = null;
  let probing = false;

  return {
    // Devolve null quando pode passar, ou o tempo restante do cooldown.
    check() {
      if (openedAt === null) return null;
      const remaining = cooldownMs - (now() - openedAt);
      if (remaining > 0) return remaining;
      if (probing) return cooldownMs;
      probing = true;
      return null;
    },
    success() {
      failures = 0;
      openedAt = null;
      probing = false;
    },
    failure() {
      failures += 1;
      if (probing || failures >= failureThreshold) {
        openedAt = now();
        probing = false;
      }
    },
    // A chamada de prova terminou sem veredito (cancelada, 4xx): libera a próxima.
    release() {
      probing = false;
    },
    get state() {
      if (openedAt === null) return 'closed';
      return now() - openedAt >= cooldownMs ? 'half-open' : 'open';
    },
  };
}

// Retry-After: segundos ou data HTTP. Valores absurdos ou ilegíveis viram null.
export function parseRetryAfter(value, now = Date.now()) {
  if (value == null || value === '') return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds >= 0 ? Math.round(seconds * 1000) : null;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

function isRetryable(error) {
  if (error instanceof UpstreamUnavailable) return false;
  if (error?.name === 'TimeoutError') return true;
  if (error instanceof UpstreamError) return error.status === 429 || error.status === 408 || error.status >= 500;
  // falha de rede do fetch (ECONNRESET, UND_ERR_CONNECT_TIMEOUT...)
  return error instanceof TypeError;
}

function sleep(ms, signal) {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class NvidiaClient {
  constructor({
    baseUrl = DEFAULT_BASE_URL,
    rateLimiter = createRateLimiter(),
    timeoutMs = 45000,
    retries = 1,
    breaker = createCircuitBreaker(),
    random = Math.random,
  } = {}) {
    this.baseUrl = baseUrl;
    this.rateLimiter = rateLimiter;
    this.timeoutMs = timeoutMs;
    this.retries = retries;
    this.breaker = breaker;
    this.random = random;
  }

  // `signal` (opcional) é o cancelamento do chamador: deadline do turno ou
  // cliente que desconectou. Aborto do chamador nunca é repetido nem conta
  // como falha do provedor.
  async chatCompletions({ model, messages, temperature = 0.7, max_tokens = 320, response_format = null, extra = null, signal = null }) {
    const key = await resolveApiKey();
    if (!key) throw new Error('NVIDIA_API_KEY não configurada (defina NVIDIA_API_KEY ou o .env do projeto)');

    const body = {
      model,
      messages,
      temperature,
      max_tokens,
    };
    if (response_format) body.response_format = response_format;
    // Pass-through para controles do próprio provedor (orçamento de raciocínio,
    // chat_template_kwargs). Só para medição por enquanto; o motivo é o decode
    // dominar llmMs (~11,5s de 17,9s medidos em 335 tokens de saída).
    if (extra) Object.assign(body, extra);

    for (let attempt = 0; ; attempt++) {
      const cooldownMs = this.breaker.check();
      if (cooldownMs !== null) {
        throw new UpstreamUnavailable('Circuito da NVIDIA aberto: provedor instável.', { retryAfterMs: cooldownMs });
      }
      try {
        const requestedAt = Date.now();
        await this.rateLimiter.waitForSlot({ signal });
        const data = await this.#attempt({ key, body, model, max_tokens, response_format, signal, requestedAt, attempt });
        this.breaker.success();
        return data;
      } catch (error) {
        if (signal?.aborted) {
          this.breaker.release();
          throw error;
        }
        const retryable = isRetryable(error);
        if (retryable) this.breaker.failure();
        else this.breaker.release();
        if (!retryable || attempt >= this.retries) throw error;
        const backoff = error.retryAfterMs ?? Math.min(MAX_BACKOFF_MS, 400 * 2 ** attempt) * (0.5 + this.random());
        console.warn('[llm] ' + model + ' tentativa ' + (attempt + 1) + ' falhou (' + (error.status || error.name)
          + '), nova tentativa em ' + Math.round(backoff) + 'ms');
        await sleep(Math.min(backoff, MAX_BACKOFF_MS), signal);
      }
    }
  }

  async #attempt({ key, body, model, max_tokens, response_format, signal, requestedAt, attempt }) {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

    // [llm] por chamada: separa "espera do provedor" de "custo de geração".
    // Sem o usage não há como dizer se um 16s é fila até o primeiro token ou
    // tokens de raciocínio — são alavancas diferentes.
    const startedAt = Date.now();
    const waitedSlotMs = startedAt - requestedAt;
    let status = 0;
    let finishReason = '-';
    let usage = null;
    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + key,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify(body),
        signal: combined,
      });
      status = response.status;

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new UpstreamError(`NVIDIA API HTTP ${response.status}: ${text.slice(0, 200)}`, {
          status: response.status,
          retryAfterMs: parseRetryAfter(response.headers?.get?.('retry-after')),
        });
      }

      const data = await response.json();
      usage = data?.usage ?? null;
      finishReason = data?.choices?.[0]?.finish_reason ?? '-';
      return data;
    } finally {
      const httpMs = Date.now() - startedAt;
      console.log('[llm] ' + model
        + ' inicio=' + requestedAt + ' fim=' + Date.now()
        + ' espera-fila=' + waitedSlotMs + 'ms http=' + httpMs + 'ms'
        + ' status=' + status + ' finish=' + finishReason
        + ' entrada=' + (usage?.prompt_tokens ?? '-')
        + ' saida=' + (usage?.completion_tokens ?? '-')
        + ' raciocinio=' + (usage?.completion_tokens_details?.reasoning_tokens ?? '-')
        + ' max_tokens=' + max_tokens + ' json=' + (response_format ? 'sim' : 'nao')
        + (attempt ? ' tentativa=' + (attempt + 1) : ''));
    }
  }

  async chatText({ model, messages, temperature = 0.7, max_tokens = 320, signal = null }) {
    const data = await this.chatCompletions({ model, messages, temperature, max_tokens, signal });
    return data?.choices?.[0]?.message?.content || '';
  }

  // Chamada que espera JSON. NEMOTRON escreve o raciocínio em
  // `reasoning_content`, mas quando o raciocínio estoura o orçamento de
  // tokens ele transborda para `content` e o JSON nunca nasce — com
  // response_format o modelo vai direto ao JSON (11.7s vs 19.4s medidos).
  // Retorna os três campos para o chamador poder resgatar o JSON do raciocínio.
  async chatJson({ model, messages, temperature = 0.7, max_tokens = 320, extra = null, signal = null }) {
    const data = await this.chatCompletions({
      model, messages, temperature, max_tokens,
      response_format: { type: 'json_object' },
      extra,
      signal,
    });
    const choice = data?.choices?.[0];
    const message = choice?.message || {};
    return {
      content: message.content || '',
      reasoning: message.reasoning_content || message.reasoning || '',
      finishReason: choice?.finish_reason || null,
    };
  }
}

// Instância compartilhada (rate limiter global entre as 3 funções).
export const sharedRateLimiter = createRateLimiter();
export const sharedClient = new NvidiaClient({ rateLimiter: sharedRateLimiter });
