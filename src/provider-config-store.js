/**
 * @fileoverview Gerenciamento seguro e No-Code de provedores de IA, Voz e Integracoes.
 *
 * Regras de seguranca:
 * - Whitelist fechada de provedores e variaveis (`PROVIDER_SPECS`).
 * - Nenhuma funcao de listagem ou resposta HTTP retorna o valor bruto de chaves/tokens
 *   (apenas `configured: boolean` e `masked`).
 * - Persistencia atomica (`tmp` + `rename`) em `data/providers.local.json` (fora do Git),
 *   sem sobrescrever ou corromper o `.env` manual do usuario.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { dataDir as resolveDataDir } from './data-paths.js';
import { readEnvValue } from './api-security.js';

export const PROVIDERS_FILE = 'providers.local.json';
const MAX_SECRET_LEN = 512;
const MAX_MODEL_LEN = 160;
const PROBE_TIMEOUT_MS = 8000;

export const PROVIDER_SPECS = Object.freeze([
  Object.freeze({
    id: 'nvidia',
    label: 'NVIDIA NIM (LLM Principal)',
    category: 'llm',
    envKey: 'NVIDIA_API_KEY',
    modelEnvKey: 'NVIDIA_BRAIN_MODEL',
    defaultModel: 'nvidia/nemotron-3-ultra-550b-a55b',
    probeUrl: 'https://integrate.api.nvidia.com/v1/models',
    probeAuth: 'bearer',
  }),
  Object.freeze({
    id: 'openrouter',
    label: 'OpenRouter (Fallback / Hedge)',
    category: 'llm',
    envKey: 'OPENROUTER_API_KEY',
    modelEnvKey: 'OPENROUTER_MODEL',
    defaultModel: 'google/gemini-2.5-flash',
    probeUrl: 'https://openrouter.ai/api/v1/models',
    probeAuth: 'bearer',
  }),
  Object.freeze({
    id: 'gemini_tts',
    label: 'Gemini TTS (Voz Oficial)',
    category: 'voice',
    envKey: 'GEMINI_API_KEY',
    modelEnvKey: 'GEMINI_TTS_VOICE',
    defaultModel: 'voice_ess199w2ioks',
    probeUrl: 'https://generativelanguage.googleapis.com/v1beta/models',
    probeAuth: 'x-goog-api-key',
  }),
  Object.freeze({
    id: 'discord',
    label: 'Discord Bot',
    category: 'integration',
    envKey: 'DISCORD_BOT_TOKEN',
    modelEnvKey: null,
    defaultModel: null,
    probeUrl: 'https://discord.com/api/v10/users/@me',
    probeAuth: 'bot',
  }),
  Object.freeze({
    id: 'tinyfish',
    label: 'TinyFish (Pesquisa Web)',
    category: 'research',
    envKey: 'TINYFISH_API_KEY',
    modelEnvKey: null,
    defaultModel: null,
    probeUrl: null,
    probeAuth: null,
  }),
  Object.freeze({
    id: 'firecrawl',
    label: 'Firecrawl (Scrape Web)',
    category: 'research',
    envKey: 'FIRECRAWL_API_KEY',
    modelEnvKey: null,
    defaultModel: null,
    probeUrl: null,
    probeAuth: null,
  }),
]);

const SPEC_BY_ID = new Map(PROVIDER_SPECS.map(spec => [spec.id, spec]));

export function getProviderSpec(providerId) {
  const key = String(providerId ?? '').trim().toLowerCase();
  return SPEC_BY_ID.get(key) || null;
}

/**
 * Mascara um segredo preservando no maximo 4 caracteres finais (nunca ecoa a chave).
 * @param {string|null|undefined} raw
 * @returns {string|null}
 */
export function maskSecret(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return null;
  if (value.length <= 8) return '****';
  if (value.length <= 14) return `****...${value.slice(-3)}`;
  const prefixMatch = /^[A-Za-z0-9]{2,6}[-_]/.exec(value);
  const prefix = prefixMatch ? prefixMatch[0] : '';
  return `${prefix}****...${value.slice(-4)}`;
}

function sanitizeSecretInput(raw) {
  if (typeof raw !== 'string') return { ok: false, value: null, error: 'Chave deve ser texto.' };
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, value: null, error: 'Chave não pode ser vazia.' };
  if (trimmed.length > MAX_SECRET_LEN) {
    return { ok: false, value: null, error: `Chave excede o limite de ${MAX_SECRET_LEN} caracteres.` };
  }
  if (/[\r\n\u0000-\u001f\u007f]/.test(trimmed)) {
    return { ok: false, value: null, error: 'Chave contém caracteres de controle inválidos.' };
  }
  return { ok: true, value: trimmed, error: null };
}

function sanitizeModelInput(raw) {
  if (typeof raw !== 'string') return { ok: false, value: null, error: 'Modelo/voz deve ser texto.' };
  const trimmed = raw.trim();
  if (trimmed.length > MAX_MODEL_LEN) {
    return { ok: false, value: null, error: `Modelo excede ${MAX_MODEL_LEN} caracteres.` };
  }
  if (/[\r\n\u0000-\u001f\u007f]/.test(trimmed)) {
    return { ok: false, value: null, error: 'Modelo contém caracteres inválidos.' };
  }
  return { ok: true, value: trimmed, error: null };
}

export function createProviderConfigStore({
  dataDir = resolveDataDir(),
  filePath = join(dataDir, PROVIDERS_FILE),
  envReader = name => readEnvValue(name),
  syncProcessEnv = false,
} = {}) {
  // syncProcessEnv: true grava/remove chaves em process.env globalmente.
  // Efeito colateral: altera variaveis de ambiente do processo inteiro.
  // Usar apenas em inicializacao unica; isolar por wrapper se necessario.
  let overrides = {}; // { [providerId]: { apiKey?: string, model?: string, updatedAt?: string } }

  function load() {
    try {
      if (!existsSync(filePath)) {
        overrides = {};
        return;
      }
      const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
      const rawMap = parsed && typeof parsed === 'object' && parsed.providers && typeof parsed.providers === 'object' && !Array.isArray(parsed.providers)
        ? parsed.providers
        : {};
      const next = {};
      for (const spec of PROVIDER_SPECS) {
        const entry = rawMap?.[spec.id];
        if (!entry || typeof entry !== 'object') continue;
        next[spec.id] = {
          ...(typeof entry.apiKey === 'string' && entry.apiKey.trim() ? { apiKey: entry.apiKey.trim() } : {}),
          ...(typeof entry.model === 'string' && entry.model.trim() ? { model: entry.model.trim() } : {}),
          ...(typeof entry.updatedAt === 'string' ? { updatedAt: entry.updatedAt } : {}),
        };
        if (syncProcessEnv) {
          if (next[spec.id].apiKey) process.env[spec.envKey] = next[spec.id].apiKey;
          if (spec.modelEnvKey && next[spec.id].model) process.env[spec.modelEnvKey] = next[spec.id].model;
        }
      }
      overrides = next;
    } catch {
      overrides = {};
    }
  }

  function persist() {
    mkdirSync(dirname(filePath), { recursive: true });
    const payload = JSON.stringify({ version: 1, providers: overrides }, null, 2);
    const tmpPath = `${filePath}.${randomBytes(8).toString('hex')}.tmp`;
    writeFileSync(tmpPath, `${payload}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(tmpPath, filePath);
    try {
      chmodSync(filePath, 0o600);
    } catch {
      // Windows ignora chmod POSIX
    }
  }

  load();

  function resolveEffectiveSecret(spec) {
    const localVal = overrides[spec.id]?.apiKey;
    if (localVal) return { value: localVal, source: 'local_override' };
    const envVal = envReader(spec.envKey);
    if (typeof envVal === 'string' && envVal.trim()) {
      return { value: envVal.trim(), source: 'env' };
    }
    return { value: null, source: 'none' };
  }

  function resolveEffectiveModel(spec) {
    if (!spec.modelEnvKey) return null;
    const localModel = overrides[spec.id]?.model;
    if (localModel) return localModel;
    const envModel = envReader(spec.modelEnvKey);
    if (typeof envModel === 'string' && envModel.trim()) return envModel.trim();
    return spec.defaultModel;
  }

  function describeProvider(spec) {
    const eff = resolveEffectiveSecret(spec);
    return {
      id: spec.id,
      label: spec.label,
      category: spec.category,
      envKey: spec.envKey,
      configured: Boolean(eff.value),
      source: eff.source,
      masked: maskSecret(eff.value),
      modelEnvKey: spec.modelEnvKey,
      model: resolveEffectiveModel(spec),
      supportsProbe: Boolean(spec.probeUrl),
      updatedAt: overrides[spec.id]?.updatedAt || null,
    };
  }

  function listStatus() {
    return PROVIDER_SPECS.map(describeProvider);
  }

  function updateProvider({ providerId, apiKey = undefined, clearKey = false, model = undefined } = {}) {
    const spec = getProviderSpec(providerId);
    if (!spec) {
      return { ok: false, status: 400, error: `Provedor não permitido: "${String(providerId ?? '')}".` };
    }

    const current = { ...(overrides[spec.id] || {}) };

    if (clearKey === true) {
      delete current.apiKey;
      if (syncProcessEnv) delete process.env[spec.envKey];
    } else if (apiKey !== undefined) {
      const checked = sanitizeSecretInput(apiKey);
      if (!checked.ok) return { ok: false, status: 400, error: checked.error };
      current.apiKey = checked.value;
      if (syncProcessEnv) process.env[spec.envKey] = checked.value;
    }

    if (model !== undefined) {
      if (!spec.modelEnvKey) {
        return { ok: false, status: 400, error: `Provedor "${spec.id}" não suporta configuração de modelo/voz.` };
      }
      const checkedModel = sanitizeModelInput(model);
      if (!checkedModel.ok) return { ok: false, status: 400, error: checkedModel.error };
      if (checkedModel.value) {
        current.model = checkedModel.value;
        if (syncProcessEnv) process.env[spec.modelEnvKey] = checkedModel.value;
      } else {
        delete current.model;
        if (syncProcessEnv) delete process.env[spec.modelEnvKey];
      }
    }

    current.updatedAt = new Date().toISOString();
    if (!current.apiKey && !current.model) {
      delete overrides[spec.id];
    } else {
      overrides[spec.id] = current;
    }

    persist();
    return { ok: true, status: 200, provider: describeProvider(spec), providers: listStatus() };
  }

  async function testProvider(providerId, { fetchImpl = globalThis.fetch } = {}) {
    const spec = getProviderSpec(providerId);
    if (!spec) {
      return { ok: false, status: 400, providerId: String(providerId ?? ''), message: 'Provedor não permitido.' };
    }

    const eff = resolveEffectiveSecret(spec);
    if (!eff.value) {
      return {
        ok: false,
        status: 400,
        providerId: spec.id,
        latencyMs: 0,
        message: `${spec.envKey} não está configurada.`,
      };
    }

    if (!spec.probeUrl) {
      return {
        ok: true,
        status: 200,
        providerId: spec.id,
        latencyMs: 0,
        message: `${spec.label} configurada (${eff.source}). Teste remoto não aplicável.`,
      };
    }

    const headers = {};
    if (spec.probeAuth === 'bearer') headers.Authorization = `Bearer ${eff.value}`;
    else if (spec.probeAuth === 'bot') headers.Authorization = `Bot ${eff.value}`;
    else if (spec.probeAuth === 'x-goog-api-key') headers['x-goog-api-key'] = eff.value;

    const startedAt = Date.now();
    try {
      const res = await fetchImpl(spec.probeUrl, {
        method: 'GET',
        headers,
        signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(PROBE_TIMEOUT_MS) : undefined,
      });
      const latencyMs = Date.now() - startedAt;
      if (res.ok) {
        return {
          ok: true,
          status: res.status,
          providerId: spec.id,
          latencyMs,
          message: `Conexão validada com ${spec.label} (HTTP ${res.status}).`,
        };
      }
      return {
        ok: false,
        status: res.status,
        providerId: spec.id,
        latencyMs,
        message: `${spec.label} recusou a credencial (HTTP ${res.status}).`,
      };
    } catch {
      const latencyMs = Date.now() - startedAt;
      return {
        ok: false,
        status: 502,
        providerId: spec.id,
        latencyMs,
        message: `Falha de rede ao testar ${spec.label}.`,
      };
    }
  }

  return {
    load,
    listStatus,
    updateProvider,
    testProvider,
  };
}
