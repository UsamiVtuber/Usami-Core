import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createToolRegistry } from '../src/tool-registry.js';
import { createPermissionGate } from '../src/permission-gate.js';
import { createToolExecutor } from '../src/tool-executor.js';
import { createSkillCatalog } from '../src/skill-catalog.js';
import { createSkillManager, defaultRunSkillTests } from '../src/skill-manager.js';
import { createGoogleAuthClient } from '../src/google-auth.js';
import {
  CALENDAR_MANAGER_SKILL_ID,
  createCalendarManagerTools,
  publishCalendarManagerSkill,
} from '../src/calendar-manager-skill.js';
import {
  EMAIL_ASSISTANT_SKILL_ID,
  createEmailAssistantTools,
  publishEmailAssistantSkill,
} from '../src/email-assistant-skill.js';
import {
  FINANCE_OBSERVER_SKILL_ID,
  createFinanceObserverTools,
  createOpenFinanceClient,
  publishFinanceObserverSkill,
} from '../src/finance-observer-skill.js';
import {
  RESEARCH_AGENT_SKILL_ID,
  createResearchAgentTools,
  createResearchClient,
  publishResearchAgentSkill,
} from '../src/research-agent-skill.js';

// Isolamento de módulo para server.mjs.
process.env.USE_NVIDIA = 'false';
const scratchServerDir = mkdtempSync(join(tmpdir(), 'usami-phase3-ext-srv-'));
process.env.USAMI_DATA_DIR = scratchServerDir;
process.env.USAMI_KEYS_FILE = process.env.USAMI_KEYS_FILE || join(scratchServerDir, 'no-keys.env');

const {
  createAgentTurnHandler,
  createSelfHandler,
  createSkillsHandler,
} = await import('../server.mjs');

const TEST_TOKEN = 'token-phase3-external-skills';
const EXTERNAL_IDS = [
  CALENDAR_MANAGER_SKILL_ID,
  EMAIL_ASSISTANT_SKILL_ID,
  FINANCE_OBSERVER_SKILL_ID,
  RESEARCH_AGENT_SKILL_ID,
];

function createEmptyEnv() {
  return () => '';
}

function createMapEnv(map) {
  return name => map[name] ?? '';
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body);
    },
  };
}

function setupRuntime(t, { googleAuth, openFinanceClient, researchClient, vaultSearch } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'usami-phase3-ext-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const clockMs = Date.parse('2026-11-11T15:00:00.000Z');
  const registry = createToolRegistry();
  const gate = createPermissionGate({ registry, dataDir: dir, now: () => clockMs, onLoadError: () => {} });
  gate.load();
  const executor = createToolExecutor({ registry, gate, dataDir: dir, now: () => clockMs, onLoadError: () => {} });
  executor.load();

  publishCalendarManagerSkill({ dataDir: dir });
  publishEmailAssistantSkill({ dataDir: dir });
  publishFinanceObserverSkill({ dataDir: dir });
  publishResearchAgentSkill({ dataDir: dir });

  for (const tool of [
    ...createCalendarManagerTools({ googleAuth, now: () => clockMs }),
    ...createEmailAssistantTools({ googleAuth }),
    ...createFinanceObserverTools({ openFinanceClient }),
    ...createResearchAgentTools({ researchClient, vaultSearch }),
  ]) {
    assert.equal(registry.register(tool).ok, true, `falha ao registrar ${tool.name}`);
  }

  const catalog = createSkillCatalog({ dataDir: dir, registry, onLoadError: () => {} });
  catalog.load();
  const manager = createSkillManager({ catalog, gate, dataDir: dir, now: () => clockMs });
  manager.load();

  return { dir, registry, gate, executor, catalog, manager };
}

test('4 skills externas da Fase 3 publicam, ativam no catálogo e passam no sandbox S8', async t => {
  const { dir, catalog } = setupRuntime(t, {
    googleAuth: createGoogleAuthClient({ envProvider: createEmptyEnv() }),
    openFinanceClient: createOpenFinanceClient({ envProvider: createEmptyEnv() }),
    researchClient: createResearchClient({ envProvider: createEmptyEnv() }),
  });

  for (const id of EXTERNAL_IDS) {
    const found = catalog.get(id);
    assert.equal(found.ok, true, `skill ${id} ausente do catálogo`);
    assert.equal(found.skill.valid, true, `skill ${id} inválida`);
    assert.equal(found.skill.state, 'installed');
    assert.equal(
      found.skill.activation.canActivate,
      true,
      `skill ${id} não pronta para ativação: ${found.skill.activation.reasons.join(', ')}`,
    );

    const skillDir = join(dir, 'skills', id);
    const rawManifest = JSON.parse(readFileSync(join(skillDir, 'skill.json'), 'utf8'));
    const sandbox = await defaultRunSkillTests({ skillId: id, skillDir, manifest: rawManifest });
    assert.equal(sandbox.ok, true, `sandbox S8 falhou para ${id}: ${sandbox.summary}`);
  }
});

test('skills externas falham fechado quando credenciais estão ausentes e sem vazar segredos', async t => {
  const { executor } = setupRuntime(t, {
    googleAuth: createGoogleAuthClient({ envProvider: createEmptyEnv() }),
    openFinanceClient: createOpenFinanceClient({ envProvider: createEmptyEnv() }),
    researchClient: createResearchClient({ envProvider: createEmptyEnv() }),
  });

  const cal = await executor.execute('calendar.list', {});
  assert.equal(cal.ok, false);
  assert.match(cal.record.reason, /GOOGLE_/);

  const mail = await executor.execute('email.list', {});
  assert.equal(mail.ok, false);
  assert.match(mail.record.reason, /GOOGLE_/);

  const fin = await executor.execute('finance.accounts', {});
  assert.equal(fin.ok, false);
  assert.match(fin.record.reason, /Open Finance não configurado/i);

  const res = await executor.execute('research.search', { query: 'usami companion' });
  assert.equal(res.ok, false);
  assert.match(res.record.reason, /TINYFISH_API_KEY|FIRECRAWL_API_KEY/);
});

test('Google Calendar e Gmail: refresh 401 no OAuth2, operações normais e confirmação S5 para nível 4', async t => {
  const requests = [];
  let accessTokenExpiredOnce = false;

  const fakeFetch = async (url, init = {}) => {
    requests.push({ url, method: init.method || 'GET', headers: init.headers || {}, body: init.body });

    if (url === 'https://oauth2.googleapis.com/token') {
      return jsonResponse(200, { access_token: 'fresh-access-tok', expires_in: 3600 });
    }
    if (url.includes('/calendar/v3/calendars/primary/events?')) {
      if (!accessTokenExpiredOnce && init.headers?.authorization === 'Bearer stale-access-tok') {
        accessTokenExpiredOnce = true;
        return jsonResponse(401, { error: 'invalid_token' });
      }
      assert.equal(init.headers?.authorization, 'Bearer fresh-access-tok');
      return jsonResponse(200, {
        items: [
          {
            id: 'evt-1',
            summary: 'Revisão Usami',
            start: { dateTime: '2026-11-11T17:00:00-03:00' },
            end: { dateTime: '2026-11-11T18:00:00-03:00' },
            status: 'confirmed',
          },
        ],
      });
    }
    if (url === 'https://www.googleapis.com/calendar/v3/calendars/primary/events' && init.method === 'POST') {
      const parsed = JSON.parse(init.body);
      return jsonResponse(200, {
        id: 'evt-new-99',
        summary: parsed.summary,
        start: parsed.start,
        end: parsed.end,
        status: 'confirmed',
      });
    }
    if (url === 'https://www.googleapis.com/calendar/v3/calendars/primary/events/evt-new-99' && init.method === 'DELETE') {
      return jsonResponse(204, '');
    }
    if (url.startsWith('https://gmail.googleapis.com/gmail/v1/users/me/messages?')) {
      return jsonResponse(200, { messages: [{ id: 'msg-1' }] });
    }
    if (url.includes('gmail/v1/users/me/messages/msg-1?')) {
      return jsonResponse(200, {
        id: 'msg-1',
        threadId: 'thr-1',
        snippet: 'Contrato pronto',
        payload: {
          headers: [
            { name: 'From', value: 'alice@example.com' },
            { name: 'Subject', value: 'Assinatura' },
          ],
        },
      });
    }
    if (url === 'https://gmail.googleapis.com/gmail/v1/users/me/drafts' && init.method === 'POST') {
      return jsonResponse(200, { id: 'draft-42' });
    }
    if (url === 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send' && init.method === 'POST') {
      return jsonResponse(200, { id: 'sent-88' });
    }
    throw new Error(`URL inesperada no mock Google: ${init.method || 'GET'} ${url}`);
  };

  const googleAuth = createGoogleAuthClient({
    envProvider: createMapEnv({
      GOOGLE_ACCESS_TOKEN: 'stale-access-tok',
      GOOGLE_CLIENT_ID: 'gid',
      GOOGLE_CLIENT_SECRET: 'gsec-supersecret',
      GOOGLE_REFRESH_TOKEN: 'gref-supersecret',
    }),
    fetchImpl: fakeFetch,
  });

  const { gate, executor } = setupRuntime(t, { googleAuth });

  // calendar.list faz retry automático após 401 renovando token via refresh_token.
  const listed = await executor.execute('calendar.list', { maxResults: 5 });
  assert.equal(listed.ok, true);
  assert.equal(listed.result.count, 1);
  assert.equal(listed.result.events[0].summary, 'Revisão Usami');
  assert.equal(requests.some(r => r.url === 'https://oauth2.googleapis.com/token'), true);

  const created = await executor.execute('calendar.create', {
    summary: 'Sync Arquitetura',
    start: '2026-11-12T10:00:00-03:00',
  });
  assert.equal(created.ok, true);
  assert.equal(created.result.event.id, 'evt-new-99');

  // Nível 4 bloqueia até confirmação humana S5.
  const blockedDelete = await executor.execute('calendar.delete', { eventId: 'evt-new-99' });
  assert.equal(blockedDelete.ok, false);
  assert.equal(blockedDelete.denied, true);
  const confCal = gate.createConfirmation('calendar.delete');
  assert.equal(confCal.ok, true);
  const deleted = await executor.execute(
    'calendar.delete',
    { eventId: 'evt-new-99' },
    { confirmation: confCal.confirmation.token },
  );
  assert.equal(deleted.ok, true);
  assert.equal(deleted.result.deleted, true);

  // Gmail list, draft e send nível 4.
  const inbox = await executor.execute('email.list', { query: 'is:unread', maxResults: 5 });
  assert.equal(inbox.ok, true);
  assert.equal(inbox.result.messages[0].subject, 'Assinatura');

  const draft = await executor.execute('email.draft', {
    to: 'bob@example.com',
    subject: 'Rascunho',
    body: 'Segue resumo.',
  });
  assert.equal(draft.ok, true);
  assert.equal(draft.result.draftId, 'draft-42');

  const blockedSend = await executor.execute('email.send', {
    to: 'bob@example.com',
    subject: 'Final',
    body: 'Enviando.',
  });
  assert.equal(blockedSend.ok, false);
  assert.equal(blockedSend.denied, true);
  const confMail = gate.createConfirmation('email.send');
  assert.equal(confMail.ok, true);
  const sent = await executor.execute(
    'email.send',
    { to: 'bob@example.com', subject: 'Final', body: 'Enviando.' },
    { confirmation: confMail.confirmation.token },
  );
  assert.equal(sent.ok, true);
  assert.equal(sent.result.sent, true);
  assert.equal(sent.result.messageId, 'sent-88');
});

test('Finance Observer funciona com Pluggy e Belvo em modo somente leitura', async t => {
  const pluggyFetch = async (url, init = {}) => {
    if (url === 'https://api.pluggy.ai/auth' && init.method === 'POST') {
      return jsonResponse(200, { apiKey: 'pluggy-jwt-temp' });
    }
    if (url.startsWith('https://api.pluggy.ai/accounts?')) {
      assert.equal(init.headers?.['X-API-KEY'], 'pluggy-jwt-temp');
      return jsonResponse(200, {
        results: [
          { id: 'acc-1', name: 'Conta Corrente', type: 'BANK', subtype: 'CHECKING_ACCOUNT', balance: 2500.5, currencyCode: 'BRL' },
        ],
      });
    }
    if (url.startsWith('https://api.pluggy.ai/transactions?')) {
      return jsonResponse(200, {
        results: [
          { id: 'tx-1', date: '2026-11-10', description: 'Salário', amount: 5000, type: 'CREDIT', category: 'Income' },
          { id: 'tx-2', date: '2026-11-11', description: 'Mercado', amount: -250.5, type: 'DEBIT', category: 'Groceries' },
        ],
      });
    }
    throw new Error(`URL Pluggy inesperada: ${url}`);
  };

  const pluggyClient = createOpenFinanceClient({
    envProvider: createMapEnv({
      PLUGGY_CLIENT_ID: 'pid',
      PLUGGY_CLIENT_SECRET: 'psec',
      PLUGGY_ITEM_ID: 'item-1',
    }),
    fetchImpl: pluggyFetch,
  });

  const pluggyRuntime = setupRuntime(t, { openFinanceClient: pluggyClient });
  const pluggyAcc = await pluggyRuntime.executor.execute('finance.accounts', { provider: 'pluggy' });
  assert.equal(pluggyAcc.ok, true);
  assert.equal(pluggyAcc.result.provider, 'pluggy');
  assert.equal(pluggyAcc.result.readOnly, true);
  assert.equal(pluggyAcc.result.accounts[0].balance, 2500.5);

  const pluggyTx = await pluggyRuntime.executor.execute('finance.transactions', {
    provider: 'pluggy',
    accountId: 'acc-1',
    from: '2026-11-01',
    to: '2026-11-11',
  });
  assert.equal(pluggyTx.ok, true);
  assert.equal(pluggyTx.result.summary.totalInflow, 5000);
  assert.equal(pluggyTx.result.summary.totalOutflow, 250.5);
  assert.equal(pluggyTx.result.summary.netFlow, 4749.5);

  const belvoFetch = async (url, init = {}) => {
    assert.ok(String(init.headers?.authorization || '').startsWith('Basic '));
    if (url.startsWith('https://api.belvo.com/api/accounts/')) {
      return jsonResponse(200, {
        results: [
          { id: 'bel-acc-1', name: 'Poupança', category: 'CHECKING_ACCOUNT', balance: { current: 1200 }, currency: 'BRL' },
        ],
      });
    }
    if (url.startsWith('https://api.belvo.com/api/transactions/')) {
      return jsonResponse(200, {
        results: [
          { id: 'btx-1', value_date: '2026-11-11', description: 'Café', amount: 18, type: 'OUTFLOW', category: 'Food' },
        ],
      });
    }
    throw new Error(`URL Belvo inesperada: ${url}`);
  };

  const belvoClient = createOpenFinanceClient({
    envProvider: createMapEnv({
      OPENFINANCE_PROVIDER: 'belvo',
      BELVO_SECRET_ID: 'bid',
      BELVO_SECRET_PASSWORD: 'bsec',
      BELVO_LINK_ID: 'link-9',
    }),
    fetchImpl: belvoFetch,
  });

  const belvoRuntime = setupRuntime(t, { openFinanceClient: belvoClient });
  const belvoAcc = await belvoRuntime.executor.execute('finance.accounts', {});
  assert.equal(belvoAcc.ok, true);
  assert.equal(belvoAcc.result.provider, 'belvo');
  assert.equal(belvoAcc.result.accounts[0].name, 'Poupança');

  const belvoTx = await belvoRuntime.executor.execute('finance.transactions', {
    from: '2026-11-01',
    to: '2026-11-11',
  });
  assert.equal(belvoTx.ok, true);
  assert.equal(belvoTx.result.summary.totalOutflow, 18);
});

test('Research Agent combina TinyFish + Firecrawl, aplica fallback e bloqueia SSRF', async t => {
  const researchFetchMock = async (url, init = {}) => {
    if (url.startsWith('https://api.search.tinyfish.ai?')) {
      assert.equal(init.headers?.['X-API-Key'], 'tf-key');
      return jsonResponse(200, {
        results: [
          { title: 'Docs Node.js', url: 'https://nodejs.org/docs', snippet: 'TinyFish snippet' },
          { title: 'Guia exclusivo TF', url: 'https://tinyfish.ai/guide', snippet: 'TF only' },
        ],
      });
    }
    if (url === 'https://api.firecrawl.dev/v1/search') {
      assert.equal(init.headers?.authorization, 'Bearer fc-key');
      return jsonResponse(200, {
        data: [
          { title: 'Node Docs FC', url: 'https://nodejs.org/docs/', description: 'Duplicado normalizado' },
          { title: 'Firecrawl Blog', url: 'https://firecrawl.dev/blog', description: 'FC only' },
        ],
      });
    }
    if (url === 'https://api.fetch.tinyfish.ai') {
      return jsonResponse(502, { error: 'upstream down' });
    }
    if (url === 'https://api.firecrawl.dev/v1/scrape') {
      return jsonResponse(200, {
        data: {
          markdown: '# Artigo Extraído\nConteúdo limpo.',
          metadata: { title: 'Artigo', sourceURL: 'https://example.org/post' },
        },
      });
    }
    throw new Error(`URL Research inesperada: ${url}`);
  };

  const client = createResearchClient({
    envProvider: createMapEnv({
      TINYFISH_API_KEY: 'tf-key',
      FIRECRAWL_API_KEY: 'fc-key',
    }),
    fetchImpl: researchFetchMock,
  });

  const { executor } = setupRuntime(t, {
    researchClient: client,
    vaultSearch: async q => [`Nota local sobre ${q}`],
  });

  // provider='both' deduplica https://nodejs.org/docs e consulta vault local quando solicitado.
  const combined = await executor.execute('research.search', {
    query: 'nodejs sandbox',
    provider: 'both',
    limit: 10,
    includeLocalVault: true,
  });
  assert.equal(combined.ok, true);
  assert.deepEqual(combined.result.providersUsed.sort(), ['firecrawl', 'tinyfish']);
  assert.equal(combined.result.count, 3);
  assert.deepEqual(combined.result.localNotes, ['Nota local sobre nodejs sandbox']);

  // provider='auto' faz fallback de TinyFish 502 para Firecrawl Scrape.
  const fetched = await executor.execute('research.fetch', {
    url: 'https://example.org/post',
    provider: 'auto',
  });
  assert.equal(fetched.ok, true);
  assert.equal(fetched.result.providerUsed, 'firecrawl');
  assert.match(fetched.result.pages[0].markdown, /Artigo Extraído/);

  // Bloqueio SSRF contra localhost / IP privado.
  const ssrf = await executor.execute('research.fetch', {
    url: 'http://127.0.0.1:8787/api/health',
  });
  assert.equal(ssrf.ok, false);
  assert.match(ssrf.record.reason, /bloquead|privad|pública|local/i);
});

test('server.mjs registra as 4 skills externas, limpa limitações no /api/agent/self e roteia via AgentCore', async () => {
  const skillsHandler = createSkillsHandler({ apiToken: TEST_TOKEN });
  const selfHandler = createSelfHandler({ apiToken: TEST_TOKEN });
  const turnHandler = createAgentTurnHandler({ apiToken: TEST_TOKEN });

  const call = async (handler, req) => {
    const res = { statusCode: null, body: '' };
    res.writeHead = (s) => { res.statusCode = s; };
    res.end = (b) => { res.body = b; };
    await handler(req, res);
    return { status: res.statusCode, data: JSON.parse(res.body) };
  };
  const makeReq = (method, url, body = '') => ({
    method,
    url,
    headers: {
      host: '127.0.0.1:8787',
      'x-usami-token': TEST_TOKEN,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    async *[Symbol.asyncIterator]() {
      if (body) yield Buffer.from(body);
    },
  });

  const listed = await call(skillsHandler, makeReq('GET', '/api/agent/skills'));
  assert.equal(listed.status, 200);
  for (const id of EXTERNAL_IDS) {
    const entry = listed.data.skills.find(s => s.id === id);
    assert.ok(entry, `${id} deveria estar em /api/agent/skills`);
    assert.equal(entry.state, 'installed', `${id} deveria estar publicada em server.mjs`);
    assert.equal(entry.activation.canActivate, true, `${id} deveria poder ativar em server.mjs`);
  }

  const self = await call(selfHandler, makeReq('GET', '/api/agent/self'));
  assert.equal(self.status, 200);
  const limText = (self.data.limitations || []).join(' | ');
  assert.equal(/Agenda externa.*não conectada/i.test(limText), false);
  assert.equal(/E-mail externo.*não conectado/i.test(limText), false);
  assert.equal(/Finanças externas.*não conectadas/i.test(limText), false);
  assert.equal(/Busca web agêntica não integrada/i.test(limText), false);

  const routingCases = [
    ['Listar eventos do google calendar', 'calendar.list'],
    ['O que tenho na minha agenda hoje?', 'calendar.list'],
    ['Listar emails recentes do gmail', 'email.list'],
    ['Chegou algum email novo?', 'email.list'],
    ['Consultar contas do open finance', 'finance.accounts'],
    ['Quanto tenho no banco no pluggy?', 'finance.accounts'],
    ['Ver meus gastos do mes', 'finance.transactions'],
    ['Pesquisar na web via tinyfish sobre AgentCore', 'research.search'],
    ['Pesquise sobre Rust na internet', 'research.search'],
    ['Extrair conteudo de https://example.org/docs via firecrawl', 'research.fetch'],
  ];

  for (const [message, expectedTool] of routingCases) {
    const res = await call(turnHandler, makeReq('POST', '/api/agent/turn', JSON.stringify({ message })));
    assert.equal(res.status, 200);
    assert.equal(res.data.turn.tool, expectedTool, `mensagem "${message}" deveria rotear para ${expectedTool}`);
    assert.equal(res.data.turn.route, 'tool');
  }
});

test('Pluggy aceita múltiplos itemIds em PLUGGY_ITEM_ID e resolve accountId automaticamente em finance.transactions', async t => {
  const seenUrls = [];
  const pluggyFetch = async (url, init = {}) => {
    seenUrls.push(url);
    if (url === 'https://api.pluggy.ai/auth') {
      assert.equal(init.method, 'POST');
      return jsonResponse(200, { apiKey: 'pluggy-api-key' });
    }
    if (url === 'https://api.pluggy.ai/accounts?itemId=item-a') {
      return jsonResponse(200, { results: [{ id: 'acc-a1', name: 'NuConta', subtype: 'CHECKING_ACCOUNT', balance: 1500.25, currencyCode: 'BRL', institution: { name: 'Nubank' } }] });
    }
    if (url === 'https://api.pluggy.ai/accounts?itemId=item-b') {
      return jsonResponse(200, { results: [{ id: 'acc-b1', name: 'Inter', subtype: 'CHECKING_ACCOUNT', balance: 320, currencyCode: 'BRL', institution: { name: 'Banco Inter' } }] });
    }
    if (url.startsWith('https://api.pluggy.ai/transactions?accountId=acc-a1')) {
      return jsonResponse(200, {
        results: [
          { id: 'tx-10', date: '2026-11-11', description: 'Mercado', amount: 120.5, type: 'DEBIT', currencyCode: 'BRL', category: 'Supermarket' },
        ],
      });
    }
    throw new Error(`URL inesperada: ${url}`);
  };

  const client = createOpenFinanceClient({
    envProvider: createMapEnv({
      OPENFINANCE_PROVIDER: 'pluggy',
      PLUGGY_CLIENT_ID: 'pid',
      PLUGGY_CLIENT_SECRET: 'psec',
      PLUGGY_ITEM_ID: 'item-a, item-b',
    }),
    fetchImpl: pluggyFetch,
  });

  const runtime = setupRuntime(t, { openFinanceClient: client });
  const accRes = await runtime.executor.execute('finance.accounts', {});
  assert.equal(accRes.ok, true);
  assert.equal(accRes.result.count, 2);
  assert.deepEqual(accRes.result.accounts.map(a => a.id), ['acc-a1', 'acc-b1']);

  const txRes = await runtime.executor.execute('finance.transactions', { limit: 10 });
  assert.equal(txRes.ok, true);
  assert.equal(txRes.result.transactions[0].description, 'Mercado');
  assert.equal(txRes.result.summary.totalOutflow, 120.5);
  assert.ok(seenUrls.some(u => u.includes('accountId=acc-a1')));
});
