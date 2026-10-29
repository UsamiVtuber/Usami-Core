// Cliente NVIDIA API (build.nvidia.com / integrate.api.nvidia.com) com
// rate limiter global: 40 requisições por minuto, compartilhado entre
// todas as funções (classificação, geração de texto, animação).
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

// Rate limiter: janela deslizante de `rateLimit` requisições por `windowMs`.
export function createRateLimiter({ rateLimit = DEFAULT_RATE_LIMIT, windowMs = DEFAULT_RATE_WINDOW_MS } = {}) {
  const stamps = [];

  async function waitForSlot() {
    const now = Date.now();
    // Remove timestamps fora da janela
    while (stamps.length && now - stamps[0] > windowMs) stamps.shift();

    if (stamps.length < rateLimit) {
      stamps.push(now);
      return;
    }

    // Aguarda o mais antigo sair da janela
    const waitMs = windowMs - (now - stamps[0]) + 1;
    await new Promise(resolve => setTimeout(resolve, Math.max(0, waitMs)));
    return waitForSlot();
  }

  return { waitForSlot };
}

export class NvidiaClient {
  constructor({
    baseUrl = DEFAULT_BASE_URL,
    rateLimiter = createRateLimiter(),
    timeoutMs = 45000,
  } = {}) {
    this.baseUrl = baseUrl;
    this.rateLimiter = rateLimiter;
    this.timeoutMs = timeoutMs;
  }

  async chatCompletions({ model, messages, temperature = 0.7, max_tokens = 320, response_format = null, extra = null }) {
    const key = await resolveApiKey();
    if (!key) throw new Error('NVIDIA_API_KEY não configurada (defina NVIDIA_API_KEY ou o .env do projeto)');

    const requestedAt = Date.now();
    await this.rateLimiter.waitForSlot();

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

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

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
        signal: controller.signal,
      });
      status = response.status;

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`NVIDIA API HTTP ${response.status}: ${text.slice(0, 200)}`);
      }

      const data = await response.json();
      usage = data?.usage ?? null;
      finishReason = data?.choices?.[0]?.finish_reason ?? '-';
      return data;
    } finally {
      clearTimeout(timeoutId);
      const httpMs = Date.now() - startedAt;
      console.log('[llm] ' + model
        + ' inicio=' + requestedAt + ' fim=' + Date.now()
        + ' espera-fila=' + waitedSlotMs + 'ms http=' + httpMs + 'ms'
        + ' status=' + status + ' finish=' + finishReason
        + ' entrada=' + (usage?.prompt_tokens ?? '-')
        + ' saida=' + (usage?.completion_tokens ?? '-')
        + ' raciocinio=' + (usage?.completion_tokens_details?.reasoning_tokens ?? '-')
        + ' max_tokens=' + max_tokens + ' json=' + (response_format ? 'sim' : 'nao'));
    }
  }

  async chatText({ model, messages, temperature = 0.7, max_tokens = 320 }) {
    const data = await this.chatCompletions({ model, messages, temperature, max_tokens });
    return data?.choices?.[0]?.message?.content || '';
  }

  // Chamada que espera JSON. NEMOTRON escreve o raciocínio em
  // `reasoning_content`, mas quando o raciocínio estoura o orçamento de
  // tokens ele transborda para `content` e o JSON nunca nasce — com
  // response_format o modelo vai direto ao JSON (11.7s vs 19.4s medidos).
  // Retorna os três campos para o chamador poder resgatar o JSON do raciocínio.
  async chatJson({ model, messages, temperature = 0.7, max_tokens = 320, extra = null }) {
    const data = await this.chatCompletions({
      model, messages, temperature, max_tokens,
      response_format: { type: 'json_object' },
      extra,
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
