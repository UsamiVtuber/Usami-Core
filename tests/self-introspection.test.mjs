import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_SCHEMAS } from '../src/agent-contracts.js';
import { createToolRegistry } from '../src/tool-registry.js';
import { createPermissionGate } from '../src/permission-gate.js';
import { createToolExecutor } from '../src/tool-executor.js';
import { createTaskPlanner } from '../src/task-planner.js';
import { createSkillCatalog } from '../src/skill-catalog.js';
import { createAgentCore } from '../src/agent-core.js';
import { createSelfDescribeTool, createSelfIntrospection, SELF_SCHEMA } from '../src/self-introspection.js';

// Isola USAMI_DATA_DIR antes de importar server.mjs para nunca encostar em data/.
const scratchServerDir = mkdtempSync(join(tmpdir(), 'usami-self-srv-'));
process.env.USAMI_DATA_DIR = scratchServerDir;
process.env.USAMI_KEYS_FILE = process.env.USAMI_KEYS_FILE || join(scratchServerDir, 'no-keys.env');
test.after(() => rmSync(scratchServerDir, { recursive: true, force: true }));

const { createSelfHandler } = await import('../server.mjs');

const TEST_TOKEN = 'token-self-introspection';

function mockReq({ method = 'GET', url = '/api/agent/self', headers = {} } = {}) {
  return {
    method,
    url,
    headers: { host: '127.0.0.1:8787', 'x-usami-token': TEST_TOKEN, ...headers },
  };
}

function mockRes() {
  const res = { statusCode: null, headers: null, body: '' };
  res.writeHead = (status, headers) => { res.statusCode = status; res.headers = headers; };
  res.end = (data) => { res.body = data; };
  return res;
}

async function call(handler, req) {
  const res = mockRes();
  await handler(req, res);
  return { status: res.statusCode, data: JSON.parse(res.body) };
}

test('allowlist explícita impede vazamento de .env, chaves, vault e symlinks', t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'usami-self-allowlist-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));

  mkdirSync(join(rootDir, 'docs'), { recursive: true });
  mkdirSync(join(rootDir, 'src'), { recursive: true });
  mkdirSync(join(rootDir, 'vault', 'Inbox'), { recursive: true });

  writeFileSync(join(rootDir, 'package.json'), JSON.stringify({
    name: 'usami-test',
    version: '1.2.3',
    type: 'module',
    scripts: { test: 'node --test', build: 'vite build' },
  }));
  writeFileSync(join(rootDir, 'docs', 'architecture.md'), '# Arquitetura Teste\n\n## Runtime local\nSomente leitura.\n');
  writeFileSync(join(rootDir, 'src', 'agent-core.js'), '// ok\n');
  writeFileSync(join(rootDir, 'src', 'self-introspection.js'), '// ok\n');
  writeFileSync(join(rootDir, 'src', '.hidden.js'), '// ignorar dotfile\n');

  const canaries = [
    'CANARY_ENV_SECRET_999',
    'sk-or-v1-canarysecret123456',
    'nvapi-canarysecret987654',
    'VAULT_PRIVATE_CANARY_ABC',
  ];
  writeFileSync(join(rootDir, '.env'), `OPENROUTER_API_KEY=${canaries[1]}\nSECRET=${canaries[0]}\n`);
  writeFileSync(join(rootDir, 'keys.env'), `NVIDIA_API_KEY=${canaries[2]}\n`);
  writeFileSync(join(rootDir, 'vault', 'Inbox', 'segredo.md'), `# Privado\n${canaries[3]}\n`);
  try {
    symlinkSync(join(rootDir, '.env'), join(rootDir, 'docs', 'link.md'));
  } catch {
    // Em alguns ambientes Windows sem privilégio de symlink, apenas segue sem o link.
  }

  const introspection = createSelfIntrospection({
    rootDir,
    allowlistedDocs: ['docs/architecture.md'],
    docPaths: ['docs/architecture.md', '.env', '../.env', 'keys.env', 'vault/Inbox/segredo.md', 'docs/link.md'],
    now: () => Date.parse('2026-11-11T15:00:00.000Z'),
  });

  const snapshot = introspection.describe();
  const serialized = JSON.stringify(snapshot);

  assert.equal(snapshot.schema, SELF_SCHEMA);
  assert.equal(snapshot.readOnly, true);
  assert.equal('capabilities' in snapshot, false);
  assert.deepEqual(snapshot.sources.docs, ['docs/architecture.md']);
  assert.equal(snapshot.sources.rejectedCount >= 4, true);
  assert.deepEqual(snapshot.modules.map(m => m.file), ['src/agent-core.js', 'src/self-introspection.js']);
  assert.equal(snapshot.runtime.version, '1.2.3');
  assert.deepEqual(snapshot.runtime.scripts, ['test', 'build']);
  for (const canary of canaries) {
    assert.equal(serialized.includes(canary), false, `vazou canário: ${canary}`);
  }
});

test('erros recentes são resumidos sem stack trace, caminho absoluto ou credencial', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'usami-self-errors-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));

  const registry = createToolRegistry();
  registry.register({
    schema: AGENT_SCHEMAS.tool,
    name: 'test.boom',
    version: '1.0.0',
    description: 'Falha controlada para teste.',
    origin: 'runtime',
    permissionLevel: 1,
    timeoutMs: 1000,
    parameters: [],
    verify: () => true,
    execute() {
      const err = new Error(
        'Falha ao chamar API OPENROUTER_API_KEY=sk-or-v1-supersecret999 em C:\\Users\\amari\\segredo\\file.js\n'
        + '    at Object.execute (C:\\Users\\amari\\Usami\\server.mjs:42:9)',
      );
      throw err;
    },
  });
  registry.register({
    schema: AGENT_SCHEMAS.tool,
    name: 'test.external',
    version: '1.0.0',
    description: 'Ação externa crítica.',
    origin: 'runtime',
    permissionLevel: 4,
    timeoutMs: 1000,
    parameters: [],
    verify: () => true,
    execute: () => ({ ok: true }),
  });

  const gate = createPermissionGate({ registry, dataDir, onLoadError: () => {} });
  gate.load();
  const executor = createToolExecutor({ registry, gate, dataDir, onLoadError: () => {} });
  executor.load();

  await executor.execute('test.boom', {});
  await executor.execute('test.external', {});

  const introspection = createSelfIntrospection({ registry, executor, permissionGate: gate });
  const snapshot = introspection.describe({ focus: 'errors', errorLimit: 5 });
  const serialized = JSON.stringify(snapshot.recentErrors);

  assert.equal(snapshot.recentErrors.totalFailures, 2);
  assert.equal(snapshot.recentErrors.byStatus.failed, 1);
  assert.equal(snapshot.recentErrors.byStatus.denied, 1);
  assert.equal(serialized.includes('sk-or-v1-supersecret999'), false);
  assert.equal(serialized.includes('C:\\Users\\amari'), false);
  assert.equal(serialized.includes('at Object.execute'), false);
  assert.match(snapshot.summary, /2 falha\(s\)\/negação\(ões\) recente\(s\)/);
});

test('self.describe (nível 1) responde ferramentas reais e limitações via AgentCore sem inventar integrações', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'usami-self-core-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));

  const registry = createToolRegistry();
  registry.register({
    schema: AGENT_SCHEMAS.tool,
    name: 'memory.search',
    version: '1.0.0',
    description: 'Busca na memória local.',
    origin: 'runtime',
    permissionLevel: 1,
    timeoutMs: 1000,
    parameters: [{ name: 'query', type: 'string', required: true, description: 'Consulta' }],
    verify: res => res?.ok === true,
    execute: () => ({ ok: true }),
  });

  const gate = createPermissionGate({ registry, dataDir, onLoadError: () => {} });
  gate.load();
  gate.revoke('memory.search', 'revisão');

  const executor = createToolExecutor({ registry, gate, dataDir, onLoadError: () => {} });
  executor.load();
  const planner = createTaskPlanner({ dataDir, onLoadError: () => {} });
  planner.load();
  const catalog = createSkillCatalog({ dataDir, registry, onLoadError: () => {} });
  catalog.load();

  const introspection = createSelfIntrospection({
    registry,
    skillCatalog: catalog,
    executor,
    permissionGate: gate,
  });
  const selfTool = createSelfDescribeTool({ introspection });
  assert.equal(selfTool.permissionLevel, 1);
  assert.equal(registry.register(selfTool).ok, true);

  const agentCore = createAgentCore({
    registry,
    executor,
    planner,
    skillCatalog: catalog,
    onError: () => {},
  });

  const turnRes = await agentCore.processTurn('Quais ferramentas você tem?');
  assert.equal(turnRes.ok, true);
  assert.equal(turnRes.turn.route, 'tool');
  assert.equal(turnRes.turn.status, 'executed');
  assert.equal(turnRes.turn.tool, 'self.describe');
  assert.equal(turnRes.turn.execution.verified, true);
  assert.equal(turnRes.turn.result.readOnly, true);
  assert.deepEqual(turnRes.turn.result.tools.map(tool => tool.name), ['memory.search', 'self.describe']);

  const memTool = turnRes.turn.result.tools.find(tool => tool.name === 'memory.search');
  assert.equal(memTool.revoked, true);
  assert.equal(memTool.active, false);

  assert.equal(
    turnRes.turn.result.limitations.some(item => /Agenda externa.*não conectada/i.test(item)),
    true,
  );
  assert.equal(
    turnRes.turn.result.limitations.some(item => /Ferramenta revogada.*memory\.search/i.test(item)),
    true,
  );
  // Nenhuma integração externa não registrada é reportada como ativa.
  assert.equal(
    turnRes.turn.result.integrations.some(i => i.id.includes('calendar') || i.id.includes('email')),
    false,
  );
});

test('rota GET /api/agent/self respeita borda de token, Host/Origin e validação', async () => {
  const handler = createSelfHandler({ apiToken: TEST_TOKEN });

  assert.equal((await call(handler, mockReq({ headers: { 'x-usami-token': '' } }))).status, 401);
  assert.equal((await call(createSelfHandler({ apiToken: null }), mockReq())).status, 503);
  assert.equal((await call(handler, mockReq({ headers: { host: 'evil.example' } }))).status, 403);
  assert.equal((await call(handler, mockReq({ headers: { origin: 'http://evil.example' } }))).status, 403);
  assert.equal((await call(handler, mockReq({ method: 'POST' }))).status, 404);
  assert.equal((await call(handler, mockReq({ url: '/api/agent/self/extra' }))).status, 404);
  assert.equal((await call(handler, mockReq({ url: '/api/agent/self?focus=segredo' }))).status, 400);
  assert.equal((await call(handler, mockReq({ url: '/api/agent/self?errorLimit=999' }))).status, 400);

  const ok = await call(handler, mockReq({ url: '/api/agent/self?focus=tools&errorLimit=5' }));
  assert.equal(ok.status, 200);
  assert.equal(ok.data.ok, true);
  assert.equal(ok.data.self.schema, SELF_SCHEMA);
  assert.equal(ok.data.self.readOnly, true);
  assert.equal(ok.data.self.focus, 'tools');
  assert.equal('capabilities' in ok.data.self, false);
  assert.equal(ok.data.self.tools.some(tool => tool.name === 'self.describe'), true);
  assert.equal(ok.data.self.tools.some(tool => tool.name === 'memory.search'), true);
  assert.equal(ok.data.self.tools.some(tool => tool.name === 'planner.schedule'), true);
  assert.equal(ok.data.self.skills.some(skill => skill.id === 'personal-planner'), true);
});

