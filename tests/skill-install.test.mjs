import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_SCHEMAS } from '../src/agent-contracts.js';
import { createToolRegistry } from '../src/tool-registry.js';
import { createPermissionGate } from '../src/permission-gate.js';
import { createSkillCatalog } from '../src/skill-catalog.js';
import { createSkillManager } from '../src/skill-manager.js';

// Troca o depósito antes de importar server.mjs para nenhum teste encostar em data/.
const scratchDir = mkdtempSync(join(tmpdir(), 'usami-skill-install-api-'));
process.env.USAMI_DATA_DIR = scratchDir;
process.env.USAMI_KEYS_FILE = process.env.USAMI_KEYS_FILE || join(scratchDir, 'no-keys.env');

const { createSkillsHandler, createToolHandler } = await import('../server.mjs');

const TEST_TOKEN = 'token-de-teste';

function makeManifest(id, patch = {}) {
  return {
    schema: AGENT_SCHEMAS.skill,
    id,
    name: `Skill ${id}`,
    version: '1.0.0',
    description: 'Skill de teste para S8',
    state: 'available',
    origin: 'dev',
    createdAt: '2026-11-11T00:00:00.000Z',
    tools: ['memory.search'],
    permissions: [1],
    dependencies: [],
    parameters: [],
    instructions: 'Execute a tarefa declarada.',
    tests: { files: ['test/skill.test.mjs'], timeoutMs: 5000 },
    ...patch,
  };
}

function writeSkillPackage(skillsDir, id, { manifestPatch = {}, testSource, extraFiles = {} } = {}) {
  const dir = join(skillsDir, id);
  mkdirSync(join(dir, 'test'), { recursive: true });
  writeFileSync(join(dir, 'skill.json'), JSON.stringify(makeManifest(id, manifestPatch), null, 2));
  writeFileSync(
    join(dir, 'index.mjs'),
    'export function greet(name) { return `oi ${name}`; }\n',
  );
  writeFileSync(
    join(dir, 'test', 'skill.test.mjs'),
    testSource ?? [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'import { greet } from "../index.mjs";',
      'test("saudação básica", () => { assert.equal(greet("Usami"), "oi Usami"); });',
      '',
    ].join('\n'),
  );
  for (const [relPath, content] of Object.entries(extraFiles)) {
    const full = join(dir, relPath);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

function setup(t, { runTests, ttlMs } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'usami-skill-install-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const skillsDir = join(root, 'skills');
  mkdirSync(skillsDir, { recursive: true });

  const registry = createToolRegistry();
  registry.register({
    schema: AGENT_SCHEMAS.tool,
    name: 'memory.search',
    version: '1.0.0',
    description: 'Busca na memória.',
    origin: 'runtime',
    permissionLevel: 1,
    timeoutMs: 500,
    parameters: [],
    verify: result => result?.ok === true,
    execute: () => ({ ok: true }),
  });

  let clock = Date.parse('2026-11-11T12:00:00.000Z');
  const gate = createPermissionGate({
    registry,
    dataDir: root,
    now: () => clock,
    ...(ttlMs ? { ttlMs } : {}),
    onLoadError: () => {},
  });
  gate.load();

  const catalog = createSkillCatalog({
    dataDir: root,
    skillsDir,
    registry,
    onLoadError: () => {},
  });
  const manager = createSkillManager({
    catalog,
    gate,
    dataDir: root,
    skillsDir,
    now: () => clock,
    ...(runTests ? { runTests } : {}),
    onLoadError: () => {},
  });
  manager.load();

  const toolHandler = createToolHandler({ registry, gate, skillCatalog: catalog, apiToken: TEST_TOKEN });
  const skillsHandler = createSkillsHandler({ catalog, manager, apiToken: TEST_TOKEN });

  return {
    root,
    skillsDir,
    registry,
    gate,
    catalog,
    manager,
    toolHandler,
    skillsHandler,
    advance: ms => { clock += ms; },
  };
}

function mockReq({ method = 'GET', url = '/api/agent/skills', headers = {}, body = '' } = {}) {
  const chunks = body ? [Buffer.from(body)] : [];
  return {
    method,
    url,
    headers: { host: '127.0.0.1:8787', 'x-usami-token': TEST_TOKEN, ...headers },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

function jsonReq(url, payload, { method = 'POST', headers = {} } = {}) {
  return mockReq({
    method,
    url,
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
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

test('fluxo HTTP completo: proposta -> confirmação (S5) -> teste isolado -> instalada -> desativar/ativar', async t => {
  const { skillsDir, toolHandler, skillsHandler } = setup(t);
  const pkgDir = writeSkillPackage(skillsDir, 'daily-helper');

  const initial = await call(skillsHandler, mockReq({ url: '/api/agent/skills/daily-helper' }));
  assert.equal(initial.status, 200);
  assert.equal(initial.data.skill.state, 'available');
  assert.equal(initial.data.skill.activation.canActivate, false);

  const proposed = await call(skillsHandler, jsonReq('/api/agent/skills/proposals', {
    skillId: 'daily-helper',
    benefit: 'Resume compromissos do dia sem leitura externa.',
    risks: ['Lê apenas memória local'],
    dependencies: [],
    permissions: [1],
  }));
  assert.equal(proposed.status, 201);
  assert.equal(proposed.data.ok, true);
  assert.equal(proposed.data.proposal.status, 'pending');
  assert.equal(proposed.data.skill.state, 'pending');
  assert.match(proposed.data.proposal.id, /^sp-[0-9a-f]{12}$/);

  const listProposals = await call(skillsHandler, mockReq({ url: '/api/agent/skills/proposals' }));
  assert.equal(listProposals.status, 200);
  assert.equal(listProposals.data.count, 1);

  const fetchedProposal = await call(
    skillsHandler,
    mockReq({ url: `/api/agent/skills/proposals/${proposed.data.proposal.id}` }),
  );
  assert.equal(fetchedProposal.status, 200);
  assert.equal(fetchedProposal.data.proposal.skillId, 'daily-helper');

  // Sem confirmação S5 a instalação é recusada e a skill segue pending.
  const denied = await call(skillsHandler, jsonReq('/api/agent/skills/daily-helper/install', {}));
  assert.equal(denied.status, 403);
  assert.equal(denied.data.ok, false);
  const stillPending = await call(skillsHandler, mockReq({ url: '/api/agent/skills/daily-helper' }));
  assert.equal(stillPending.data.skill.state, 'pending');

  // Confirmação exige palavra escrita CONFIRMAR.
  const badWord = await call(toolHandler, jsonReq('/api/agent/confirmations', { skill: 'daily-helper', confirm: 'sim' }));
  assert.equal(badWord.status, 403);

  const confirmed = await call(toolHandler, jsonReq('/api/agent/confirmations', { skill: 'daily-helper', confirm: 'confirmar' }));
  assert.equal(confirmed.status, 201);
  const token = confirmed.data.confirmation.token;
  assert.match(token, /^[0-9a-f]{32}$/);

  const installed = await call(skillsHandler, jsonReq('/api/agent/skills/daily-helper/install', { confirmation: token }));
  assert.equal(installed.status, 200);
  assert.equal(installed.data.ok, true);
  assert.equal(installed.data.installed, true);
  assert.equal(installed.data.skill.state, 'installed');
  assert.equal(installed.data.skill.activation.canActivate, true);
  assert.equal(installed.data.testResult.ok, true);
  assert.equal(installed.data.proposal.status, 'installed');

  // Desativar não apaga arquivos e impede ativação derivada.
  const disabled = await call(skillsHandler, jsonReq('/api/agent/skills/daily-helper/disable', {}));
  assert.equal(disabled.status, 200);
  assert.equal(disabled.data.skill.state, 'disabled');
  assert.equal(disabled.data.skill.activation.canActivate, false);
  assert.equal(existsSync(join(pkgDir, 'index.mjs')), true);
  assert.equal(existsSync(join(pkgDir, 'test', 'skill.test.mjs')), true);

  // Reativar executa os testes isolados e restaura installed.
  const enabled = await call(skillsHandler, jsonReq('/api/agent/skills/daily-helper/enable', {}));
  assert.equal(enabled.status, 200);
  assert.equal(enabled.data.skill.state, 'installed');
  assert.equal(enabled.data.skill.activation.canActivate, true);
});

test('teste falhando ou em timeout nunca promove a skill e mantém desativada', async t => {
  const { skillsDir, toolHandler, skillsHandler } = setup(t);
  const pkgDir = writeSkillPackage(skillsDir, 'flaky-skill', {
    testSource: [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'test("quebrado", () => { assert.equal(1, 2); });',
      '',
    ].join('\n'),
  });

  await call(skillsHandler, jsonReq('/api/agent/skills/proposals', {
    skillId: 'flaky-skill',
    benefit: 'Testa reprovação de instalação.',
    risks: ['Teste falha de propósito'],
  }));
  const conf1 = await call(toolHandler, jsonReq('/api/agent/confirmations', { skill: 'flaky-skill', confirm: 'CONFIRMAR' }));
  const failedInstall = await call(
    skillsHandler,
    jsonReq('/api/agent/skills/flaky-skill/install', { confirmation: conf1.data.confirmation.token }),
  );
  assert.equal(failedInstall.status, 422);
  assert.equal(failedInstall.data.ok, false);
  assert.equal(failedInstall.data.installed, false);
  assert.equal(failedInstall.data.skill.state, 'disabled');
  assert.equal(failedInstall.data.skill.activation.canActivate, false);
  assert.equal(failedInstall.data.proposal.status, 'failed');

  // Tentar ativar com o teste ainda quebrado mantém a skill desativada.
  const enableFailed = await call(skillsHandler, jsonReq('/api/agent/skills/flaky-skill/enable', {}));
  assert.equal(enableFailed.status, 422);
  assert.equal(enableFailed.data.skill.state, 'disabled');

  // Timeout também não promove a skill.
  writeFileSync(
    join(pkgDir, 'skill.json'),
    JSON.stringify(makeManifest('flaky-skill', { state: 'disabled', tests: { files: ['test/skill.test.mjs'], timeoutMs: 250 } })),
  );
  writeFileSync(
    join(pkgDir, 'test', 'skill.test.mjs'),
    'import test from "node:test"; test("pendura", async () => { await new Promise(() => {}); });\n',
  );
  const enableTimeout = await call(skillsHandler, jsonReq('/api/agent/skills/flaky-skill/enable', {}));
  assert.equal(enableTimeout.status, 422);
  assert.equal(enableTimeout.data.testResult.timedOut, true);
  assert.equal(enableTimeout.data.skill.state, 'disabled');

  // Corrige o teste: enable agora promove para installed.
  writeFileSync(
    join(pkgDir, 'skill.json'),
    JSON.stringify(makeManifest('flaky-skill', { state: 'disabled', tests: { files: ['test/skill.test.mjs'], timeoutMs: 5000 } })),
  );
  writeFileSync(
    join(pkgDir, 'test', 'skill.test.mjs'),
    'import test from "node:test"; import assert from "node:assert/strict"; test("ok", () => assert.equal(1, 1));\n',
  );
  const enableFixed = await call(skillsHandler, jsonReq('/api/agent/skills/flaky-skill/enable', {}));
  assert.equal(enableFixed.status, 200);
  assert.equal(enableFixed.data.skill.state, 'installed');
});

test('sandbox roda em diretório temporário, sem rede e sem acesso a segredos ou data/ real', async t => {
  const { root, skillsDir, gate, manager } = setup(t);
  const secretPath = join(root, 'segredo-externo.txt');
  writeFileSync(secretPath, 'segredo-nao-leia');

  const pkgDir = writeSkillPackage(skillsDir, 'sandbox-check', {
    testSource: [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'import { readFileSync } from "node:fs";',
      'import { resolve } from "node:path";',
      'test("isolamento de cwd, env, rede e fs", async () => {',
      `  assert.notEqual(resolve(process.cwd()), ${JSON.stringify(join(skillsDir, 'sandbox-check'))});`,
      '  assert.equal(process.env.USAMI_API_TOKEN, undefined);',
      '  assert.equal(process.env.PLANE_API_KEY, undefined);',
      '  await assert.rejects(() => fetch("http://127.0.0.1:8787/api/memory"), /rede desabilitada/);',
      `  assert.throws(() => readFileSync(${JSON.stringify(secretPath)}, "utf8"));`,
      '});',
      '',
    ].join('\n'),
  });

  process.env.USAMI_API_TOKEN = 'segredo-de-ambiente-teste';
  t.after(() => { delete process.env.USAMI_API_TOKEN; });

  assert.equal(manager.propose({ skillId: 'sandbox-check', benefit: 'Verifica sandbox isolado.', risks: [] }).ok, true);
  const conf = gate.createSkillConfirmation('sandbox-check');
  const installed = await manager.install('sandbox-check', { confirmation: conf.confirmation.token });
  assert.equal(installed.ok, true, installed.error);
  assert.equal(installed.skill.state, 'installed');
  assert.equal(existsSync(pkgDir), true);

  // Skill que tenta usar rede no teste falha e não instala.
  writeSkillPackage(skillsDir, 'net-escape', {
    testSource: [
      'import test from "node:test";',
      'test("tenta fetch", async () => { await fetch("http://127.0.0.1:8787"); });',
      '',
    ].join('\n'),
  });
  assert.equal(manager.propose({ skillId: 'net-escape', benefit: 'Tenta acessar rede.', risks: ['Rede bloqueada'] }).ok, true);
  const netConf = gate.createSkillConfirmation('net-escape');
  const netInstall = await manager.install('net-escape', { confirmation: netConf.confirmation.token });
  assert.equal(netInstall.ok, false);
  assert.equal(netInstall.testFailed, true);
  assert.equal(netInstall.skill.state, 'disabled');
});

test('recusa sem autorização, token expirado/reutilizado/trocado e revogação S5', async t => {
  let testRuns = 0;
  const { skillsDir, gate, manager, advance } = setup(t, {
    ttlMs: 5000,
    runTests: async () => {
      testRuns += 1;
      return { ok: true, timedOut: false, durationMs: 1, files: ['test/skill.test.mjs'] };
    },
  });
  writeSkillPackage(skillsDir, 'auth-one');
  writeSkillPackage(skillsDir, 'auth-two');
  manager.propose({ skillId: 'auth-one', benefit: 'Skill 1 para testes de autorização.', risks: [] });
  manager.propose({ skillId: 'auth-two', benefit: 'Skill 2 para testes de autorização.', risks: [] });

  // Token emitido para outra skill é recusado e consumido.
  const confTwo = gate.createSkillConfirmation('auth-two');
  const wrongSkill = await manager.install('auth-one', { confirmation: confTwo.confirmation.token });
  assert.equal(wrongSkill.ok, false);
  assert.equal(wrongSkill.denied, true);
  assert.match(wrongSkill.error, /outra skill/);

  const replay = await manager.install('auth-two', { confirmation: confTwo.confirmation.token });
  assert.equal(replay.ok, false);
  assert.equal(replay.denied, true);
  assert.match(replay.error, /já usada/);

  // Token de ferramenta não autoriza skill.
  const toolConf = gate.createSkillConfirmation('auth-one');
  assert.equal(toolConf.ok, true);
  advance(5001);
  const expired = await manager.install('auth-one', { confirmation: toolConf.confirmation.token });
  assert.equal(expired.ok, false);
  assert.equal(expired.denied, true);
  assert.match(expired.error, /expirada/);

  // Revogação bloqueia confirmação e instalação até restaurar.
  assert.equal(gate.revoke('skill.*', 'instalações pausadas').ok, true);
  assert.equal(gate.createSkillConfirmation('auth-one').denied, true);
  const blocked = await manager.install('auth-one', { confirmation: 'qualquer' });
  assert.equal(blocked.denied, true);
  assert.match(blocked.error, /revogada/);
  assert.equal(testRuns, 0, 'nenhum teste deve rodar quando autorização falha');

  // Não é possível pular proposta/autorização via enable().
  assert.equal(gate.restore('skill.*').removed, true);
  writeSkillPackage(skillsDir, 'bypass-skill', { manifestPatch: { state: 'disabled' } });
  const bypass = await manager.enable('bypass-skill');
  assert.equal(bypass.ok, false);
  assert.equal(bypass.wrongState, true);
});

test('proposta valida origem, manifesto, divergência e rejeita symlinks', async t => {
  const { skillsDir, gate, manager, skillsHandler } = setup(t);
  writeSkillPackage(skillsDir, 'model-skill', { manifestPatch: { origin: 'model' } });
  writeSkillPackage(skillsDir, 'dep-skill', { manifestPatch: { dependencies: ['other-skill'], permissions: [1, 2] } });

  const fromModel = await call(skillsHandler, jsonReq('/api/agent/skills/proposals', {
    skillId: 'model-skill',
    benefit: 'Origin model não pode propor código.',
    risks: ['Origem não confiável'],
  }));
  assert.equal(fromModel.status, 403);

  const mismatch = await call(skillsHandler, jsonReq('/api/agent/skills/proposals', {
    skillId: 'dep-skill',
    benefit: 'Oculta permissão 2.',
    risks: [],
    permissions: [1],
  }));
  assert.equal(mismatch.status, 400);

  // Arquivo de teste ausente impede proposta.
  writeSkillPackage(skillsDir, 'missing-test');
  rmSync(join(skillsDir, 'missing-test', 'test', 'skill.test.mjs'));
  const missingTest = manager.propose({ skillId: 'missing-test', benefit: 'Falta teste.', risks: [] });
  assert.equal(missingTest.ok, false);
  assert.equal(missingTest.invalidManifest, true);

  // Symlink no pacote é recusado pelo sandbox.
  const symDir = writeSkillPackage(skillsDir, 'sym-skill');
  try {
    symlinkSync(join(skillsDir, 'model-skill', 'skill.json'), join(symDir, 'leak.json'));
  } catch {
    // Em alguns ambientes Windows sem privilégio de symlink, pula só esta asserção.
    return;
  }
  assert.equal(manager.propose({ skillId: 'sym-skill', benefit: 'Contém symlink.', risks: [] }).ok, true);
  const symConf = gate.createSkillConfirmation('sym-skill');
  const symInstall = await manager.install('sym-skill', { confirmation: symConf.confirmation.token });
  assert.equal(symInstall.ok, false);
  assert.equal(symInstall.testFailed, true);
  assert.match(symInstall.error, /symlink/i);
  assert.equal(symInstall.skill.state, 'disabled');
});

test('rotas novas respeitam borda de token, Host/Origin e validação de corpo', async t => {
  const { skillsDir, catalog, manager, skillsHandler } = setup(t);
  writeSkillPackage(skillsDir, 'edge-skill');

  const unauth = createSkillsHandler({ catalog, manager, apiToken: TEST_TOKEN });
  assert.equal((await call(unauth, jsonReq('/api/agent/skills/proposals', {}, { headers: { 'x-usami-token': '' } }))).status, 401);
  assert.equal((await call(skillsHandler, jsonReq('/api/agent/skills/proposals', {}, { headers: { host: 'evil.example' } }))).status, 403);
  assert.equal((await call(skillsHandler, mockReq({ method: 'POST', url: '/api/agent/skills/proposals', body: '{}' }))).status, 403);
  assert.equal((await call(skillsHandler, jsonReq('/api/agent/skills/proposals', '{ quebrado'))).status, 400);
  assert.equal((await call(skillsHandler, jsonReq('/api/agent/skills/edge-skill/enable', { extra: 1 }))).status, 400);
  assert.equal((await call(skillsHandler, jsonReq('/api/agent/skills/edge-skill/install', { confirmation: 123 }))).status, 400);
  assert.equal((await call(skillsHandler, jsonReq('/api/agent/skills/edge-skill/unknown', {}))).status, 404);
  assert.equal(readFileSync(join(skillsDir, 'edge-skill', 'skill.json'), 'utf8').includes('"available"'), true);
});
