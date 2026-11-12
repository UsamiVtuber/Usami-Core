import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryStore } from '../src/memory-store.js';
import { createPersonalityStore } from '../src/personality-store.js';
import { createToolRegistry } from '../src/tool-registry.js';
import { createPermissionGate } from '../src/permission-gate.js';
import { createToolExecutor } from '../src/tool-executor.js';
import { createSkillCatalog } from '../src/skill-catalog.js';
import { defaultRunSkillTests } from '../src/skill-manager.js';
import { createCodeInspectorTools, publishCodeInspectorSkill } from '../src/code-inspector-skill.js';
import { createAgentCore } from '../src/agent-core.js';
import { createTaskPlanner } from '../src/task-planner.js';
import { AGENT_SCHEMAS } from '../src/agent-contracts.js';
import {
  createGitAssistantClient,
  createGitAssistantTools,
  GIT_ASSISTANT_SKILL_ID,
  publishGitAssistantSkill,
} from '../src/git-assistant-skill.js';
import { createSelfIntrospection, formatSelfAwarenessPrompt } from '../src/self-introspection.js';
import { buildPersona } from '../src/persona.js';

process.env.USE_NVIDIA = 'false';
const scratchServerDir = mkdtempSync(join(tmpdir(), 'usami-git-srv-'));
process.env.USAMI_DATA_DIR = scratchServerDir;
process.env.USAMI_KEYS_FILE = process.env.USAMI_KEYS_FILE || join(scratchServerDir, 'no-keys.env');
test.after(() => rmSync(scratchServerDir, { recursive: true, force: true }));

const {
  createAgentTurnHandler,
  createChatHandler,
  createSkillsHandler,
} = await import('../server.mjs');

const TEST_TOKEN = 'token-git-code-awareness';

function gitSync(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function setupTempGitWorkspace(t) {
  const base = mkdtempSync(join(tmpdir(), 'usami-git-ws-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const bareDir = join(base, 'remote.git');
  const usamiDir = join(base, 'usami');
  const desktopDir = join(base, 'usami-desktop');

  mkdirSync(bareDir, { recursive: true });
  mkdirSync(join(usamiDir, 'src'), { recursive: true });
  mkdirSync(join(desktopDir, 'src'), { recursive: true });

  gitSync(bareDir, ['init', '--bare', '-b', 'main']);
  gitSync(usamiDir, ['init', '-b', 'main']);
  gitSync(usamiDir, ['config', 'user.email', 'test@usami.local']);
  gitSync(usamiDir, ['config', 'user.name', 'Usami Test']);
  gitSync(usamiDir, ['remote', 'add', 'origin', bareDir]);

  writeFileSync(join(usamiDir, 'package.json'), JSON.stringify({ name: 'usami-tmp', version: '0.1.0' }));
  writeFileSync(join(usamiDir, 'src', 'app.js'), 'export const appVersion = "1.0";\n');
  writeFileSync(join(usamiDir, '.env'), 'GITHUB_TOKEN=ghp_supersecrettoken123456\n');
  writeFileSync(join(desktopDir, 'src', 'main.rs'), 'pub fn desktop_boot() -> i32 { 1 }\n');

  gitSync(usamiDir, ['add', 'package.json', 'src/app.js']);
  gitSync(usamiDir, ['commit', '-m', 'chore: initial commit']);
  gitSync(usamiDir, ['push', '-u', 'origin', 'main']);

  return { base, bareDir, usamiDir, desktopDir };
}

test('git-assistant publica, ativa e passa no sandbox isolado S8', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'usami-git-s8-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));

  const registry = createToolRegistry();
  publishGitAssistantSkill({ dataDir });
  for (const tool of createGitAssistantTools({
    gitClient: createGitAssistantClient({ envProvider: () => '' }),
  })) {
    assert.equal(registry.register(tool).ok, true, `falha ao registrar ${tool.name}`);
  }

  const catalog = createSkillCatalog({ dataDir, registry, onLoadError: () => {} });
  catalog.load();
  const found = catalog.get(GIT_ASSISTANT_SKILL_ID);
  assert.equal(found.ok, true);
  assert.equal(found.skill.valid, true);
  assert.equal(found.skill.state, 'installed');
  assert.equal(found.skill.activation.canActivate, true, found.skill.activation.reasons.join(', '));

  const skillDir = join(dataDir, 'skills', GIT_ASSISTANT_SKILL_ID);
  const rawManifest = JSON.parse(readFileSync(join(skillDir, 'skill.json'), 'utf8'));
  const sandbox = await defaultRunSkillTests({ skillId: GIT_ASSISTANT_SKILL_ID, skillDir, manifest: rawManifest });
  assert.equal(sandbox.ok, true, `sandbox S8 falhou: ${sandbox.summary}`);
});

test('code-inspector lê usami-desktop/*.rs, extrai pub fn e redige tokens GitHub', async t => {
  const { usamiDir, desktopDir } = setupTempGitWorkspace(t);
  const dataDir = mkdtempSync(join(tmpdir(), 'usami-code-desk-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));

  const registry = createToolRegistry();
  const gate = createPermissionGate({ registry, dataDir, onLoadError: () => {} });
  gate.load();
  const executor = createToolExecutor({ registry, gate, dataDir, onLoadError: () => {} });
  executor.load();

  publishCodeInspectorSkill({ dataDir });
  for (const tool of createCodeInspectorTools({ rootDir: usamiDir, desktopRoot: desktopDir })) {
    assert.equal(registry.register(tool).ok, true);
  }

  const desk = await executor.execute('code.inspect', { path: 'usami-desktop/src/main.rs' });
  assert.equal(desk.ok, true);
  assert.equal(desk.result.path, 'desktop/src/main.rs');
  assert.deepEqual(desk.result.exports, ['desktop_boot']);

  const searchDesk = await executor.execute('code.search', { query: 'desktop_boot', scope: 'desktop' });
  assert.equal(searchDesk.ok, true);
  assert.equal(searchDesk.result.totalMatches, 1);

  const blocked = await executor.execute('code.inspect', { path: 'desktop/target/debug/usami.exe' });
  assert.equal(blocked.ok, false);
});

test('git.status, git.log, git.diff e escrita S5 nível 4 (git.commit e git.push) protegem .env', async t => {
  const { bareDir, usamiDir, desktopDir } = setupTempGitWorkspace(t);
  const dataDir = mkdtempSync(join(tmpdir(), 'usami-git-rw-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));

  writeFileSync(join(usamiDir, 'src', 'app.js'), 'export const appVersion = "2.0";\n// GITHUB_TOKEN=ghp_leak9876543210\n');

  const registry = createToolRegistry();
  const gate = createPermissionGate({ registry, dataDir, onLoadError: () => {} });
  gate.load();
  const executor = createToolExecutor({ registry, gate, dataDir, onLoadError: () => {} });
  executor.load();

  const gitClient = createGitAssistantClient({
    repoDirs: { usami: usamiDir, desktop: desktopDir, workspace: join(usamiDir, '..') },
    envProvider: () => '',
  });
  for (const tool of createGitAssistantTools({ gitClient })) {
    assert.equal(registry.register(tool).ok, true);
  }

  const status = await executor.execute('git.status', { target: 'usami' });
  assert.equal(status.ok, true);
  assert.equal(status.result.branch, 'main');
  assert.equal(status.result.modified.includes('M src/app.js'), true);
  assert.equal(status.result.untracked.includes('[arquivo-protegido]'), true);

  const log = await executor.execute('git.log', { target: 'usami', limit: 5 });
  assert.equal(log.ok, true);
  assert.equal(log.result.commits[0].subject, 'chore: initial commit');

  const diff = await executor.execute('git.diff', { target: 'usami' });
  assert.equal(diff.ok, true);
  assert.equal(diff.result.diff.includes('ghp_leak9876543210'), false);

  // Nível 4: commit sem confirmação deve negar.
  const deniedCommit = await executor.execute('git.commit', {
    target: 'usami',
    message: 'feat: bump version',
    files: ['src/app.js'],
  });
  assert.equal(deniedCommit.ok, false);
  assert.equal(deniedCommit.denied, true);

  // Mesmo com confirmação, .env é bloqueado.
  const confEnv = gate.createConfirmation('git.commit');
  const blockedEnv = await executor.execute('git.commit', {
    target: 'usami',
    message: 'chore: bad env',
    files: ['.env'],
  }, { confirmation: confEnv.confirmation.token });
  assert.equal(blockedEnv.ok, false);
  assert.match(blockedEnv.record.reason, /bloqueado/);

  // Commit + push reais no bare repo local com confirmações S5 válidas.
  const confCommit = gate.createConfirmation('git.commit');
  const committed = await executor.execute('git.commit', {
    target: 'usami',
    message: 'feat: bump app version',
    files: ['src/app.js'],
  }, { confirmation: confCommit.confirmation.token });
  assert.equal(committed.ok, true);
  assert.equal(committed.result.commit.subject, 'feat: bump app version');

  const deniedPush = await executor.execute('git.push', { target: 'usami' });
  assert.equal(deniedPush.ok, false);
  assert.equal(deniedPush.denied, true);

  const confPush = gate.createConfirmation('git.push');
  const pushed = await executor.execute('git.push', { target: 'usami', remote: 'origin', branch: 'main' }, {
    confirmation: confPush.confirmation.token,
  });
  assert.equal(pushed.ok, true);
  assert.equal(pushed.result.pushed, true);
  assert.match(gitSync(bareDir, ['log', '-n', '1', '--oneline']), /feat: bump app version/);
});

test('GitHub API falha fechado sem GITHUB_TOKEN e executa listagem + PR nível 4 com mock', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'usami-gh-api-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));

  const emptyReg = createToolRegistry();
  const emptyGate = createPermissionGate({ registry: emptyReg, dataDir, onLoadError: () => {} });
  emptyGate.load();
  const emptyExec = createToolExecutor({ registry: emptyReg, gate: emptyGate, dataDir, onLoadError: () => {} });
  emptyExec.load();
  for (const tool of createGitAssistantTools({
    gitClient: createGitAssistantClient({ envProvider: () => '' }),
  })) {
    emptyReg.register(tool);
  }
  const missingTok = await emptyExec.execute('github.repos', {});
  assert.equal(missingTok.ok, false);
  assert.match(missingTok.record.reason, /GITHUB_TOKEN/);

  // Agora com mock autenticado.
  const reg = createToolRegistry();
  const gate = createPermissionGate({ registry: reg, dataDir, onLoadError: () => {} });
  gate.load();
  const exec = createToolExecutor({ registry: reg, gate, dataDir, onLoadError: () => {} });
  exec.load();

  const fakeFetch = async (url, init = {}) => {
    assert.equal(init.headers?.authorization, 'Bearer ghp_mocktoken123456');
    const json = (status, body) => ({
      ok: status >= 200 && status < 300,
      status,
      async json() { return body; },
    });
    if (url.startsWith('https://api.github.com/user/repos')) {
      return json(200, [
        { full_name: 'UsamiVtuber/Usami-Core', private: false, default_branch: 'main', language: 'JavaScript' },
      ]);
    }
    if (url === 'https://api.github.com/repos/UsamiVtuber/Usami-Core') {
      return json(200, { full_name: 'UsamiVtuber/Usami-Core', private: false, default_branch: 'main' });
    }
    if (url.includes('/branches')) return json(200, [{ name: 'main' }, { name: 'feat/git' }]);
    if (url.includes('/commits')) return json(200, [{ sha: 'abc123456789', commit: { author: { name: 'Luke', date: '2026-11-11' }, message: 'feat: test' } }]);
    if (url.includes('/pulls') && (init.method || 'GET') === 'GET') return json(200, []);
    if (url === 'https://api.github.com/repos/UsamiVtuber/Usami-Core/pulls' && init.method === 'POST') {
      return json(201, { number: 7, title: 'PR de teste', html_url: 'https://github.com/UsamiVtuber/Usami-Core/pull/7' });
    }
    throw new Error(`URL GitHub inesperada: ${url}`);
  };

  for (const tool of createGitAssistantTools({
    gitClient: createGitAssistantClient({
      envProvider: k => (k === 'GITHUB_TOKEN' ? 'ghp_mocktoken123456' : ''),
      fetchImpl: fakeFetch,
    }),
  })) {
    reg.register(tool);
  }

  const repos = await exec.execute('github.repos', {});
  assert.equal(repos.ok, true);
  assert.equal(repos.result.repositories[0].fullName, 'UsamiVtuber/Usami-Core');

  const details = await exec.execute('github.repos', { repo: 'UsamiVtuber/Usami-Core' });
  assert.equal(details.ok, true);
  assert.deepEqual(details.result.branches, ['main', 'feat/git']);

  const blockedPr = await exec.execute('github.pr', {
    repo: 'UsamiVtuber/Usami-Core',
    title: 'PR bloqueado',
    head: 'feat/git',
  });
  assert.equal(blockedPr.ok, false);
  assert.equal(blockedPr.denied, true);

  const confPr = gate.createConfirmation('github.pr');
  const createdPr = await exec.execute('github.pr', {
    repo: 'UsamiVtuber/Usami-Core',
    title: 'PR de teste',
    head: 'feat/git',
  }, { confirmation: confPr.confirmation.token });
  assert.equal(createdPr.ok, true);
  assert.equal(createdPr.result.number, 7);
});

test('buildPersona e /api/chat injetam consciência real de código, skills e Git sem vazar segredos', async t => {
  assert.equal(buildPersona({ affinity: 50, date: '2026-11-11' }).includes('CONSCIÊNCIA DO PRÓPRIO CÓDIGO'), false);

  const introspection = createSelfIntrospection();
  const awareness = formatSelfAwarenessPrompt({
    snapshot: introspection.describe(),
    gitStatus: { target: 'usami', branch: 'main', head: { hash: 'cd5d2ea', subject: 'feat: external skills' }, staged: [], modified: [], untracked: [] },
    githubConfigured: false,
  });
  const prompt = buildPersona({ affinity: 50, date: '2026-11-11', selfAwareness: awareness });
  assert.match(prompt, /CONSCIÊNCIA DO PRÓPRIO CÓDIGO E AMBIENTE/);
  assert.match(prompt, /branch main/);

  const chatDataDir = mkdtempSync(join(tmpdir(), 'usami-chat-aware-'));
  t.after(() => rmSync(chatDataDir, { recursive: true, force: true }));
  const memoryStore = createMemoryStore({ dataDir: chatDataDir, now: () => '2026-11-11T23:00:00.000Z', today: () => '2026-11-11' });
  memoryStore.load();
  const personalityStore = createPersonalityStore({ dataDir: chatDataDir });
  personalityStore.load();

  let capturedSystem = '';
  const chatHandler = createChatHandler({
    memoryStore,
    personalityStore,
    moodStore: null,
    vaultSearch: async () => null,
    getKey: async () => 'mock-openrouter-key',
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      capturedSystem = body.messages?.[0]?.content || '';
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    reply: 'Hmph, sei tudo sobre meu código.',
                    gesture: 'tilt',
                    actions: [],
                    remember: null,
                  }),
                },
              },
            ],
          };
        },
      };
    },
  });

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
  const call = async (handler, req) => {
    const res = { statusCode: null, body: '' };
    res.writeHead = (s) => { res.statusCode = s; };
    res.end = (b) => { res.body = b; };
    await handler(req, res);
    return { status: res.statusCode, data: JSON.parse(res.body) };
  };

  const chatRes = await call(chatHandler, makeReq('POST', '/api/chat', JSON.stringify({ message: 'Em qual branch voce roda?' })));
  assert.equal(chatRes.status, 200);
  assert.match(capturedSystem, /CONSCIÊNCIA DO PRÓPRIO CÓDIGO E AMBIENTE/);
  assert.match(capturedSystem, /git-assistant/);
  assert.match(capturedSystem, /Git local \(usami\): branch/);

  // Confirma skill registrada e roteamento no /api/agent/turn.
  const skillsRes = await call(createSkillsHandler({ apiToken: TEST_TOKEN }), makeReq('GET', '/api/agent/skills'));
  assert.equal(skillsRes.status, 200);
  const gitEntry = skillsRes.data.skills.find(s => s.id === 'git-assistant');
  assert.ok(gitEntry);
  assert.equal(gitEntry.activation.canActivate, true);

  const turnHandler = createAgentTurnHandler({ apiToken: TEST_TOKEN });
  for (const [msg, expectedTool] of [
    ['Qual o status do git?', 'git.status'],
    ['Mostrar ultimos commits do git', 'git.log'],
    ['Ver diff do git', 'git.diff'],
    ['Listar meus repositorios no github', 'github.repos'],
    ['Inspecionar arquivo usami-desktop/src/main.rs', 'code.inspect'],
  ]) {
    const turn = await call(turnHandler, makeReq('POST', '/api/agent/turn', JSON.stringify({ message: msg })));
    assert.equal(turn.status, 200);
    assert.equal(turn.data.turn.tool, expectedTool, `${msg} -> ${expectedTool}`);
    assert.equal(turn.data.turn.route, 'tool');
  }
});

test('formatSelfAwarenessPrompt lista todas as skills/ferramentas sem corte e status booleano de integrações sem vazar segredos', () => {
  const tools = Array.from({ length: 35 }, (_, i) => ({
    name: `skill.tool_${String(i + 1).padStart(2, '0')}`,
    active: true,
  }));
  const prompt = formatSelfAwarenessPrompt({
    snapshot: {
      runtime: { name: 'usami', version: '2.0.0' },
      modules: ['server.mjs'],
      tools,
      skills: [
        { id: 'finance-observer', description: 'Open Finance Pluggy e Belvo sk-tinyfish-shouldnotleak123', activation: { canActivate: true } },
        { id: 'calendar-manager', description: 'Agenda no Google Calendar', activation: { canActivate: true } },
      ],
    },
    gitStatus: { target: 'usami', branch: 'main', staged: [], modified: [], untracked: [] },
    integrationsStatus: { google: true, openFinance: true, research: true, github: false },
  });

  assert.match(prompt, /- finance-observer: Open Finance Pluggy e Belvo/);
  assert.match(prompt, /- calendar-manager: Agenda no Google Calendar/);
  assert.equal(prompt.includes('shouldnotleak123'), false);
  assert.match(prompt, /skill\.tool_35/);
  assert.match(prompt, /Google \(Calendar\/Gmail\)=pronta/);
  assert.match(prompt, /Open Finance \(Pluggy\/Belvo\)=pronta/);
  assert.match(prompt, /Pesquisa Web \(TinyFish\/Firecrawl\)=pronta/);
  assert.match(prompt, /GitHub API=não configurada/);
});

test('/api/chat executa ferramenta operacional segura (nível <= 3) antes do LLM e preserva bloqueio S5 para nível 4', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'usami-chat-agent-bridge-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const memoryStore = createMemoryStore({ dataDir: dir, now: () => '2026-11-12T00:00:00.000Z', today: () => '2026-11-12' });
  memoryStore.load();
  const personalityStore = createPersonalityStore({ dataDir: dir });
  personalityStore.load();

  const registry = createToolRegistry();
  let accountsCalls = 0;
  let commitCalls = 0;
  registry.register({
    schema: AGENT_SCHEMAS.tool,
    name: 'finance.accounts',
    version: '1.0.0',
    description: 'Lista contas e saldos.',
    origin: 'skill',
    permissionLevel: 3,
    timeoutMs: 2000,
    parameters: [],
    verify: r => r?.ok === true,
    execute: () => {
      accountsCalls += 1;
      return {
        ok: true,
        provider: 'pluggy',
        readOnly: true,
        accounts: [{ id: 'acc-real-1', name: 'Conta Real', balance: 4321.5, currency: 'BRL', institution: 'Nubank' }],
      };
    },
  });
  registry.register({
    schema: AGENT_SCHEMAS.tool,
    name: 'git.commit',
    version: '1.0.0',
    description: 'Cria commit local.',
    origin: 'skill',
    permissionLevel: 4,
    timeoutMs: 2000,
    parameters: [{ name: 'message', type: 'string', required: false }],
    verify: r => r?.ok === true,
    execute: () => {
      commitCalls += 1;
      return { ok: true };
    },
  });

  const gate = createPermissionGate({ registry, dataDir: dir, onLoadError: () => {} });
  gate.load();
  const executor = createToolExecutor({ registry, gate, dataDir: dir, onLoadError: () => {} });
  executor.load();
  const planner = createTaskPlanner({ dataDir: dir, onLoadError: () => {} });
  planner.load();

  const agentCore = createAgentCore({ registry, executor, planner, onError: () => {} });

  let capturedSystem = '';
  const chatHandler = createChatHandler({
    agentCore,
    memoryStore,
    personalityStore,
    moodStore: null,
    vaultSearch: async () => null,
    integrationsStatus: { google: true, openFinance: true, research: true, github: true },
    getKey: async () => 'mock-openrouter-key',
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      capturedSystem = body.messages?.[0]?.content || '';
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            choices: [{
              message: {
                content: JSON.stringify({
                  reply: 'Você tem 4321,50 reais na Conta Real do Nubank!',
                  gesture: 'nod',
                  actions: [],
                  remember: null,
                }),
              },
            }],
          };
        },
      };
    },
  });

  const turnHandler = createAgentTurnHandler({ agentCore, apiToken: TEST_TOKEN });
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
  const call = async (handler, req) => {
    const res = { statusCode: null, body: '' };
    res.writeHead = (s) => { res.statusCode = s; };
    res.end = (b) => { res.body = b; };
    await handler(req, res);
    return { status: res.statusCode, data: JSON.parse(res.body) };
  };

  // 1) Ferramenta nível 3 executa antes do LLM e alimenta o prompt.
  const financeRes = await call(chatHandler, makeReq('POST', '/api/chat', JSON.stringify({ message: 'Quanto tenho no banco no Pluggy?' })));
  assert.equal(financeRes.status, 200);
  assert.equal(accountsCalls, 1);
  assert.equal(financeRes.data.agentTurn.status, 'executed');
  assert.equal(financeRes.data.agentTurn.tool, 'finance.accounts');
  assert.match(capturedSystem, /RESULTADO DA SKILL EXECUTADA AGORA \(finance\.accounts\)/);
  assert.match(capturedSystem, /4321\.5/);
  assert.match(capturedSystem, /Open Finance \(Pluggy\/Belvo\)=pronta/);

  const stored = await call(turnHandler, makeReq('GET', `/api/agent/turns/${financeRes.data.agentTurn.id}`));
  assert.equal(stored.status, 200);
  assert.equal(stored.data.turn.result.accounts[0].name, 'Conta Real');

  // 2) Ferramenta nível 4 nunca auto-executa no chat.
  const lvl4Res = await call(chatHandler, makeReq('POST', '/api/chat', JSON.stringify({ message: 'Executa a ferramenta git.commit agora' })));
  assert.equal(lvl4Res.status, 200);
  assert.equal(commitCalls, 0);
  await new Promise(resolve => setTimeout(resolve, 30));
  const lvl4Turn = await call(turnHandler, makeReq('GET', `/api/agent/turns/${lvl4Res.data.agentTurn.id}`));
  assert.equal(lvl4Turn.status, 200);
  assert.equal(lvl4Turn.data.turn.status, 'awaiting_confirmation');
});

