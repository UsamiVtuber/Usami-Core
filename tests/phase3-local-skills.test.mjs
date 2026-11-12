import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryStore } from '../src/memory-store.js';
import { createOperationalMemoryStore } from '../src/operational-memory-store.js';
import { createTaskPlanner } from '../src/task-planner.js';
import { createToolRegistry } from '../src/tool-registry.js';
import { createPermissionGate } from '../src/permission-gate.js';
import { createToolExecutor } from '../src/tool-executor.js';
import { createSkillCatalog } from '../src/skill-catalog.js';
import { createSkillManager, defaultRunSkillTests } from '../src/skill-manager.js';
import { createAgentCore } from '../src/agent-core.js';
import {
  createStudyCompanionTools,
  publishStudyCompanionSkill,
  STUDY_COMPANION_SKILL_ID,
} from '../src/study-companion-skill.js';
import {
  createDocumentCreatorTools,
  DOCUMENT_CREATOR_SKILL_ID,
  publishDocumentCreatorSkill,
} from '../src/document-creator-skill.js';
import {
  CODE_INSPECTOR_SKILL_ID,
  createCodeInspectorTools,
  publishCodeInspectorSkill,
} from '../src/code-inspector-skill.js';
import {
  createSkillArchitectTools,
  publishSkillArchitectSkill,
  SKILL_ARCHITECT_SKILL_ID,
} from '../src/skill-architect-skill.js';

// Isolamento de módulo para server.mjs.
process.env.USE_NVIDIA = 'false';
const scratchServerDir = mkdtempSync(join(tmpdir(), 'usami-phase3-server-'));
process.env.USAMI_DATA_DIR = scratchServerDir;
process.env.USAMI_KEYS_FILE = process.env.USAMI_KEYS_FILE || join(scratchServerDir, 'no-keys.env');

const { createAgentTurnHandler, createSkillsHandler } = await import('../server.mjs');

const TEST_TOKEN = 'token-phase3-skills';

function setupRuntime(t) {
  const dir = mkdtempSync(join(tmpdir(), 'usami-phase3-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const clockIso = '2026-11-11T14:00:00.000Z';
  const clockMs = Date.parse(clockIso);

  const memoryStore = createMemoryStore({ dataDir: dir, now: () => clockIso, today: () => '2026-11-11' });
  memoryStore.load();
  memoryStore.addCoreFact('Usa TypeScript no trabalho', 'user');

  const operationalStore = createOperationalMemoryStore({ dataDir: dir, now: () => clockMs, onLoadError: () => {} });
  operationalStore.load();

  const taskPlanner = createTaskPlanner({ dataDir: dir, now: () => clockMs, onLoadError: () => {} });
  taskPlanner.load();

  const registry = createToolRegistry();
  const gate = createPermissionGate({ registry, dataDir: dir, now: () => clockMs, onLoadError: () => {} });
  gate.load();
  const executor = createToolExecutor({ registry, gate, dataDir: dir, now: () => clockMs, onLoadError: () => {} });
  executor.load();

  publishStudyCompanionSkill({ dataDir: dir });
  publishDocumentCreatorSkill({ dataDir: dir });
  publishCodeInspectorSkill({ dataDir: dir });
  publishSkillArchitectSkill({ dataDir: dir });

  for (const tool of [
    ...createStudyCompanionTools({ memoryStore, operationalStore, taskPlanner, now: () => clockMs }),
    ...createDocumentCreatorTools({ dataDir: dir, now: () => clockMs }),
    ...createCodeInspectorTools({ rootDir: dir }),
  ]) {
    assert.equal(registry.register(tool).ok, true, `falha ao registrar ${tool.name}`);
  }

  const catalog = createSkillCatalog({ dataDir: dir, registry, onLoadError: () => {} });
  const manager = createSkillManager({ catalog, gate, dataDir: dir, now: () => clockMs });
  manager.load();

  for (const tool of createSkillArchitectTools({ skillCatalog: catalog, skillManager: manager, now: () => clockMs })) {
    assert.equal(registry.register(tool).ok, true, `falha ao registrar ${tool.name}`);
  }

  catalog.load();

  const agentCore = createAgentCore({
    registry,
    executor,
    planner: taskPlanner,
    skillCatalog: catalog,
    now: () => clockMs,
    onError: () => {},
  });

  return { dir, memoryStore, operationalStore, taskPlanner, registry, gate, executor, catalog, manager, agentCore };
}

test('as 4 skills locais da Fase 3 publicam, ativam no catálogo e passam no teste isolado S8', async t => {
  const { dir, catalog } = setupRuntime(t);

  for (const id of [
    STUDY_COMPANION_SKILL_ID,
    DOCUMENT_CREATOR_SKILL_ID,
    CODE_INSPECTOR_SKILL_ID,
    SKILL_ARCHITECT_SKILL_ID,
  ]) {
    const found = catalog.get(id);
    assert.equal(found.ok, true, `${id} deve existir no catálogo`);
    assert.equal(found.skill.valid, true, `${id} deve ter manifesto válido`);
    assert.equal(found.skill.state, 'installed');
    assert.equal(found.skill.activation.canActivate, true, `${id} deve estar ativa: ${found.skill.activation.reasons.join(', ')}`);

    const skillDir = join(dir, 'skills', id);
    const rawManifest = JSON.parse(readFileSync(join(skillDir, 'skill.json'), 'utf8'));
    const sandbox = await defaultRunSkillTests({ skillId: id, skillDir, manifest: rawManifest });
    assert.equal(sandbox.ok, true, `teste isolado S8 de ${id} falhou: ${sandbox.summary}`);
  }
});

test('Study Companion cria trilha persistida e gera revisão a partir da base local', async t => {
  const { executor, operationalStore, taskPlanner } = setupRuntime(t);

  const planned = await executor.execute('study.plan', {
    topic: 'TypeScript avançado',
    level: 'intermediate',
    hoursPerWeek: 6,
  });
  assert.equal(planned.ok, true);
  assert.equal(planned.result.modules.length, 4);
  assert.deepEqual(planned.result.relevantFacts, ['Usa TypeScript no trabalho']);
  assert.equal(operationalStore.list().length, 1);
  assert.equal(taskPlanner.list().length, 1);

  const reviewed = await executor.execute('study.review', { topic: 'TypeScript' });
  assert.equal(reviewed.ok, true);
  assert.equal(reviewed.result.activeItems.length, 1);
  assert.equal(reviewed.result.activePlans.length, 1);
  assert.equal(reviewed.result.prompts.length, 3);
});

test('Document Creator exige confirmação nível 4 para gravar e bloqueia traversal', async t => {
  const { dir, executor, gate } = setupRuntime(t);

  const drafted = await executor.execute('document.draft', {
    title: 'Plano de Estudos',
    format: 'checklist',
    sections: [{ heading: 'Semana 1', body: 'Revisar módulos\nFazer exercícios' }],
  });
  assert.equal(drafted.ok, true);
  assert.match(drafted.result.content, /- \[ \] Revisar módulos/);

  // Sem confirmação nível 4 deve negar.
  const denied = await executor.execute('document.write', {
    title: 'Nota Privada',
    body: 'Conteúdo importante',
    filename: 'nota-privada.md',
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.denied, true);

  // Com confirmação de uso único grava dentro de dataDir/documents.
  const conf = gate.createConfirmation('document.write');
  assert.equal(conf.ok, true);
  const written = await executor.execute('document.write', {
    title: 'Nota Privada',
    body: 'Conteúdo importante',
    filename: 'nota-privada.md',
  }, { confirmation: conf.confirmation.token });
  assert.equal(written.ok, true);
  assert.equal(existsSync(join(dir, 'documents', 'nota-privada.md')), true);
  assert.match(readFileSync(join(dir, 'documents', 'nota-privada.md'), 'utf8'), /Conteúdo importante/);

  // Traversal é recusado mesmo com confirmação.
  const conf2 = gate.createConfirmation('document.write');
  const traversal = await executor.execute('document.write', {
    title: 'Fora',
    body: 'x',
    filename: '../fora.md',
  }, { confirmation: conf2.confirmation.token });
  assert.equal(traversal.ok, false);
});

test('Code Inspector respeita allowlist, redige segredos e recusa .env', async t => {
  const { dir, executor } = setupRuntime(t);

  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, '.env'), 'NVIDIA_API_KEY=nvapi-secret1234567890\n');
  writeFileSync(
    join(dir, 'src', 'demo.js'),
    'export function helloWorld() {\n  return "ok";\n}\n// USAMI_API_TOKEN=tokensecreto12345\n',
  );

  const inspected = await executor.execute('code.inspect', { path: 'src/demo.js' });
  assert.equal(inspected.ok, true);
  assert.deepEqual(inspected.result.exports, ['helloWorld']);
  assert.equal(inspected.result.snippet.lines.some(l => l.text.includes('tokensecreto12345')), false);

  const searched = await executor.execute('code.search', { query: 'helloWorld', scope: 'src' });
  assert.equal(searched.ok, true);
  assert.equal(searched.result.totalMatches, 1);

  const blocked = await executor.execute('code.inspect', { path: '.env' });
  assert.equal(blocked.ok, false);
});

test('Skill Architect gera blueprint válido e registra proposta no Skill Manager', async t => {
  const { dir, executor, catalog } = setupRuntime(t);

  const blueprint = await executor.execute('architect.blueprint', {
    name: 'Habit Loop',
    description: 'Acompanha hábitos diários localmente sem acesso externo.',
    tools: ['habit.log'],
    permissions: [1, 2],
  });
  assert.equal(blueprint.ok, true);
  assert.equal(blueprint.result.manifest.id, 'habit-loop');
  assert.equal(blueprint.result.manifest.state, 'available');

  // Cria um pacote válido em disk para testar architect.propose.
  const pkgDir = join(dir, 'skills', 'habit-loop');
  mkdirSync(join(pkgDir, 'test'), { recursive: true });
  writeFileSync(join(pkgDir, 'skill.json'), JSON.stringify(blueprint.result.manifest, null, 2));
  writeFileSync(join(pkgDir, 'test', 'habit-loop.test.mjs'), 'import test from "node:test"; test("ok", () => {});\n');
  catalog.load();

  const proposed = await executor.execute('architect.propose', {
    skillId: 'habit-loop',
    benefit: 'Ajudar a acompanhar hábitos diários.',
    risks: ['Escrita apenas local'],
  });
  assert.equal(proposed.ok, true);
  assert.equal(proposed.result.skill.state, 'pending');
});

test('server.mjs publica as 4 novas skills no startup e roteia pelo AgentCore', async () => {
  const skillsHandler = createSkillsHandler({ apiToken: TEST_TOKEN });
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
  const ids = listed.data.skills.map(s => s.id);
  for (const expected of ['study-companion', 'document-creator', 'code-inspector', 'skill-architect']) {
    assert.ok(ids.includes(expected), `${expected} deveria estar em /api/agent/skills`);
  }

  const turnRes = await call(turnHandler, makeReq('POST', '/api/agent/turn', JSON.stringify({
    message: 'Inspecionar arquivo src/agent-core.js',
  })));
  assert.equal(turnRes.status, 200);
  assert.equal(turnRes.data.turn.tool, 'code.inspect');
  assert.equal(turnRes.data.turn.status, 'executed');
  assert.ok(turnRes.data.turn.result.exports.includes('createAgentCore'));
});
