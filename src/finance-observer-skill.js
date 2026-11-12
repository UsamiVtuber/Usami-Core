/**
 * Skill operacional Finance Observer (Open Finance Brasil — Pluggy / Belvo).
 *
 * Publica `skills/finance-observer` em `dataDir/skills` quando ausente e
 * registra ferramentas estritamente somente leitura (nível 3):
 *  - `finance.accounts`: lista contas e saldos;
 *  - `finance.transactions`: lista transações e resume fluxo por categoria.
 *
 * Credenciais via `readEnvValue`:
 *  - Pluggy: `PLUGGY_API_KEY` ou (`PLUGGY_CLIENT_ID` + `PLUGGY_CLIENT_SECRET`),
 *    e opcional `PLUGGY_ITEM_ID` / `PLUGGY_BASE_URL` (padrão `https://api.pluggy.ai`).
 *  - Belvo: `BELVO_SECRET_ID` + `BELVO_SECRET_PASSWORD`, opcional `BELVO_LINK_ID` /
 *    `BELVO_BASE_URL` (padrão `https://api.belvo.com`).
 */
import { AGENT_SCHEMAS } from './agent-contracts.js';
import { readEnvValue } from './api-security.js';
import { publishSkillPackage } from './skill-package.js';
import {
  FINANCE_SCHEMA,
  OPENFINANCE_PROVIDERS,
  normalizeAccount,
  normalizeTransaction,
  sanitizeOpenFinanceId,
  summarizeTransactions,
  validateDateRange,
} from '../skills/finance-observer/finance-core.mjs';

export const FINANCE_OBSERVER_SKILL_ID = 'finance-observer';
export const FINANCE_OBSERVER_TOOLS = Object.freeze(['finance.accounts', 'finance.transactions']);

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export function publishFinanceObserverSkill({ dataDir, bundledDir } = {}) {
  return publishSkillPackage({ skillId: FINANCE_OBSERVER_SKILL_ID, dataDir, bundledDir });
}

export function createOpenFinanceClient({
  envProvider = name => readEnvValue(name),
  fetchImpl = (...args) => fetch(...args),
} = {}) {
  let cachedPluggyKey = null;

  function resolveProvider(preferred = 'auto') {
    const forced = preferred && preferred !== 'auto'
      ? preferred
      : String(envProvider('OPENFINANCE_PROVIDER') || '').trim().toLowerCase();

    const pluggyKey = String(envProvider('PLUGGY_API_KEY') || '').trim();
    const pluggyId = String(envProvider('PLUGGY_CLIENT_ID') || '').trim();
    const pluggySecret = String(envProvider('PLUGGY_CLIENT_SECRET') || '').trim();
    const pluggyOk = Boolean(pluggyKey || (pluggyId && pluggySecret));

    const belvoId = String(envProvider('BELVO_SECRET_ID') || '').trim();
    const belvoSecret = String(envProvider('BELVO_SECRET_PASSWORD') || '').trim();
    const belvoOk = Boolean(belvoId && belvoSecret);

    if (forced === 'pluggy') {
      if (!pluggyOk) throw new Error('Pluggy não configurado (defina PLUGGY_CLIENT_ID + PLUGGY_CLIENT_SECRET ou PLUGGY_API_KEY).');
      return 'pluggy';
    }
    if (forced === 'belvo') {
      if (!belvoOk) throw new Error('Belvo não configurado (defina BELVO_SECRET_ID + BELVO_SECRET_PASSWORD).');
      return 'belvo';
    }
    if (pluggyOk) return 'pluggy';
    if (belvoOk) return 'belvo';
    throw new Error('Open Finance não configurado: defina credenciais Pluggy ou Belvo no .env.');
  }

  async function pluggyApiKey({ ignoreDirectKey = false } = {}) {
    if (cachedPluggyKey) return cachedPluggyKey;
    const direct = String(envProvider('PLUGGY_API_KEY') || '').trim();
    if (!ignoreDirectKey && direct) return direct;

    const baseUrl = String(envProvider('PLUGGY_BASE_URL') || 'https://api.pluggy.ai').replace(/\/+$/, '');
    const clientId = String(envProvider('PLUGGY_CLIENT_ID') || '').trim();
    const clientSecret = String(envProvider('PLUGGY_CLIENT_SECRET') || '').trim();
    const res = await fetchImpl(`${baseUrl}/auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId, clientSecret }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || typeof data?.apiKey !== 'string' || !data.apiKey) {
      throw new Error(`Pluggy auth falhou (HTTP ${res.status}).`);
    }
    cachedPluggyKey = data.apiKey;
    return cachedPluggyKey;
  }

  async function requestProvider(provider, path) {
    if (provider === 'pluggy') {
      const baseUrl = String(envProvider('PLUGGY_BASE_URL') || 'https://api.pluggy.ai').replace(/\/+$/, '');
      let apiKey = await pluggyApiKey();
      let res = await fetchImpl(`${baseUrl}${path}`, { headers: { 'X-API-KEY': apiKey } });
      const hasClientCreds = Boolean(
        String(envProvider('PLUGGY_CLIENT_ID') || '').trim()
        && String(envProvider('PLUGGY_CLIENT_SECRET') || '').trim(),
      );
      if ((res.status === 401 || res.status === 403) && hasClientCreds) {
        cachedPluggyKey = null;
        apiKey = await pluggyApiKey({ ignoreDirectKey: true });
        res = await fetchImpl(`${baseUrl}${path}`, { headers: { 'X-API-KEY': apiKey } });
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`Pluggy erro (HTTP ${res.status}).`);
      return data;
    }

    const baseUrl = String(envProvider('BELVO_BASE_URL') || 'https://api.belvo.com').replace(/\/+$/, '');
    const secretId = String(envProvider('BELVO_SECRET_ID') || '').trim();
    const secretPassword = String(envProvider('BELVO_SECRET_PASSWORD') || '').trim();
    const basic = Buffer.from(`${secretId}:${secretPassword}`, 'utf8').toString('base64');
    const res = await fetchImpl(`${baseUrl}${path}`, {
      headers: { authorization: `Basic ${basic}` },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Belvo erro (HTTP ${res.status}).`);
    return data;
  }

  async function resolvePluggyAccounts(connectionId = null) {
    const itemIds = connectionId
      ? [sanitizeOpenFinanceId(connectionId, 'connectionId')]
      : String(envProvider('PLUGGY_ITEM_ID') || '')
        .split(',')
        .map(part => part.trim())
        .filter(Boolean)
        .map(id => sanitizeOpenFinanceId(id, 'PLUGGY_ITEM_ID'));
    if (itemIds.length === 0) {
      throw new Error('Pluggy requer connectionId (itemId) ou PLUGGY_ITEM_ID configurado.');
    }
    const lists = await Promise.all(itemIds.map(async (itemId) => {
      const data = await requestProvider('pluggy', `/accounts?itemId=${encodeURIComponent(itemId)}`);
      const rawList = Array.isArray(data?.results) ? data.results : (Array.isArray(data) ? data : []);
      return rawList.map(item => normalizeAccount(item, 'pluggy')).filter(Boolean);
    }));
    return lists.flat();
  }

  return {
    async listAccounts({ provider = 'auto', connectionId = null } = {}) {
      const chosen = resolveProvider(provider);
      if (chosen === 'pluggy') {
        const accounts = await resolvePluggyAccounts(connectionId);
        return {
          provider: 'pluggy',
          accounts,
        };
      }

      const linkId = connectionId
        ? sanitizeOpenFinanceId(connectionId, 'connectionId')
        : String(envProvider('BELVO_LINK_ID') || '').trim();
      const qs = linkId ? `?link=${encodeURIComponent(linkId)}` : '';
      const data = await requestProvider('belvo', `/api/accounts/${qs}`);
      const rawList = Array.isArray(data?.results) ? data.results : (Array.isArray(data) ? data : []);
      return {
        provider: 'belvo',
        accounts: rawList.map(item => normalizeAccount(item, 'belvo')).filter(Boolean),
      };
    },

    async listTransactions({ provider = 'auto', accountId = null, connectionId = null, from = null, to = null, limit = 50 } = {}) {
      const chosen = resolveProvider(provider);
      const range = validateDateRange({ from, to });
      const safeLimit = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 100) : 50;

      if (chosen === 'pluggy') {
        let safeAccountId = null;
        if (accountId && String(accountId).trim()) {
          safeAccountId = sanitizeOpenFinanceId(accountId, 'accountId');
        } else {
          const accounts = await resolvePluggyAccounts(connectionId);
          if (!accounts[0]?.id) {
            throw new Error('Pluggy não encontrou nenhuma conta para consultar transações.');
          }
          safeAccountId = sanitizeOpenFinanceId(accounts[0].id, 'accountId');
        }
        const params = new URLSearchParams({ accountId: safeAccountId, pageSize: String(safeLimit) });
        if (range.from) params.set('from', range.from);
        if (range.to) params.set('to', range.to);
        const data = await requestProvider('pluggy', `/transactions?${params.toString()}`);
        const rawList = Array.isArray(data?.results) ? data.results : (Array.isArray(data) ? data : []);
        const transactions = rawList.slice(0, safeLimit).map(item => normalizeTransaction(item, 'pluggy')).filter(Boolean);
        return { provider: 'pluggy', transactions, summary: summarizeTransactions(transactions) };
      }

      const params = new URLSearchParams({ page_size: String(safeLimit) });
      if (accountId) params.set('account', sanitizeOpenFinanceId(accountId, 'accountId'));
      const linkId = connectionId
        ? sanitizeOpenFinanceId(connectionId, 'connectionId')
        : String(envProvider('BELVO_LINK_ID') || '').trim();
      if (linkId) params.set('link', linkId);
      if (range.from) params.set('value_date__gte', range.from);
      if (range.to) params.set('value_date__lte', range.to);
      const data = await requestProvider('belvo', `/api/transactions/?${params.toString()}`);
      const rawList = Array.isArray(data?.results) ? data.results : (Array.isArray(data) ? data : []);
      const transactions = rawList.slice(0, safeLimit).map(item => normalizeTransaction(item, 'belvo')).filter(Boolean);
      return { provider: 'belvo', transactions, summary: summarizeTransactions(transactions) };
    },
  };
}

export function createFinanceObserverTools({
  openFinanceClient = createOpenFinanceClient(),
} = {}) {
  const accountsTool = {
    schema: AGENT_SCHEMAS.tool,
    name: 'finance.accounts',
    version: '1.0.0',
    description: 'Lista contas e saldos conectados via Open Finance (Pluggy ou Belvo) em modo somente leitura.',
    origin: 'skill',
    permissionLevel: 3,
    timeoutMs: 15000,
    parameters: [
      { name: 'provider', type: 'string', required: false, enum: [...OPENFINANCE_PROVIDERS], description: 'Agregador: auto, pluggy ou belvo.' },
      { name: 'connectionId', type: 'string', required: false, description: 'itemId (Pluggy) ou linkId (Belvo) opcional.' },
    ],
    verify(result) {
      return isPlainObject(result)
        && result.ok === true
        && result.schema === FINANCE_SCHEMA
        && Array.isArray(result.accounts);
    },
    async execute(args = {}) {
      const data = await openFinanceClient.listAccounts({
        provider: args.provider || 'auto',
        connectionId: args.connectionId ?? null,
      });
      return {
        ok: true,
        schema: FINANCE_SCHEMA,
        readOnly: true,
        provider: data.provider,
        count: data.accounts.length,
        accounts: data.accounts,
      };
    },
  };

  const transactionsTool = {
    schema: AGENT_SCHEMAS.tool,
    name: 'finance.transactions',
    version: '1.0.0',
    description: 'Consulta transações no Open Finance e calcula entradas, saídas, saldo líquido e top categorias.',
    origin: 'skill',
    permissionLevel: 3,
    timeoutMs: 15000,
    parameters: [
      { name: 'accountId', type: 'string', required: false, description: 'ID da conta (obrigatório para Pluggy).' },
      { name: 'connectionId', type: 'string', required: false, description: 'linkId (Belvo) opcional.' },
      { name: 'provider', type: 'string', required: false, enum: [...OPENFINANCE_PROVIDERS], description: 'Agregador: auto, pluggy ou belvo.' },
      { name: 'from', type: 'string', required: false, description: 'Data inicial YYYY-MM-DD.' },
      { name: 'to', type: 'string', required: false, description: 'Data final YYYY-MM-DD.' },
      { name: 'limit', type: 'number', required: false, description: 'Máximo de transações (1 a 100, padrão 50).' },
    ],
    verify(result) {
      return isPlainObject(result)
        && result.ok === true
        && result.schema === FINANCE_SCHEMA
        && Array.isArray(result.transactions)
        && isPlainObject(result.summary);
    },
    async execute(args = {}) {
      const data = await openFinanceClient.listTransactions({
        provider: args.provider || 'auto',
        accountId: args.accountId ?? null,
        connectionId: args.connectionId ?? null,
        from: args.from ?? null,
        to: args.to ?? null,
        limit: args.limit ?? 50,
      });
      return {
        ok: true,
        schema: FINANCE_SCHEMA,
        readOnly: true,
        provider: data.provider,
        transactions: data.transactions,
        summary: data.summary,
      };
    },
  };

  return [accountsTool, transactionsTool];
}

