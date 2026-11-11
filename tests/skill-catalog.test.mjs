import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSkillCatalog } from '../src/skill-catalog.js';
import { AGENT_SCHEMAS } from '../src/agent-contracts.js';

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'usami-skills-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function manifest(id, patch = {}) {
  return {
    schema: AGENT_SCHEMAS.skill,
    id,
    name: `Skill ${id}`,
    version: '1.0.0',
    description: 'Skill de teste',
    state: 'installed',
    origin: 'dev',
    createdAt: '2026-11-11T00:00:00.000Z',
    tools: ['memory.search'],
    permissions: [],
    dependencies: [],
    parameters: [],
    instructions: 'Execute a tarefa declarada.',
    tests: { files: ['test/skill.test.mjs'] },
    ...patch,
  };
}

function writeSkill(root, id, patch = {}) {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'skill.json'), JSON.stringify(manifest(id, patch)));
  return dir;
}

function registryWith(...tools) {
  const available = new Set(tools);
  return { has: tool => available.has(tool) };
}

function loadCatalog(root, registry = registryWith('memory.search')) {
  const warnings = [];
  const catalog = createSkillCatalog({
    dataDir: join(root, 'unused'),
    skillsDir: root,
    registry,
    onLoadError: message => warnings.push(message),
  });
  return { catalog, warnings, snapshot: catalog.load() };
}

test('load sem diretório não cria nada', t => {
  const root = scratch(t);
  const { catalog, snapshot } = loadCatalog(join(root, 'skills'));
  assert.deepEqual(snapshot.skills, []);
  assert.deepEqual(catalog.list(), []);
  assert.equal(existsSync(join(root, 'skills')), false);
});

test('skill instalada com ferramentas e dependências presentes pode ativar', t => {
  const root = scratch(t);
  writeSkill(root, 'base-skill');
  writeSkill(root, 'full-skill', { dependencies: ['base-skill'] });
  const { catalog, snapshot, warnings } = loadCatalog(root);

  assert.deepEqual(snapshot.skills.map(skill => skill.id), ['base-skill', 'full-skill']);
  assert.deepEqual(warnings, []);
  const full = catalog.get('full-skill');
  assert.equal(full.ok, true);
  assert.equal(full.skill.valid, true);
  assert.equal(full.skill.activation.canActivate, true);
  assert.deepEqual(full.skill.activation.reasons, []);
  assert.deepEqual(full.skill.missing, { tools: [], dependencies: [] });
  assert.equal(full.skill.manifest.dependencies[0], 'base-skill');
  assert.equal(full.skill.maxPermissionLevel, null);
});

test('ferramenta ausente do registry bloqueia a ativação', t => {
  const root = scratch(t);
  writeSkill(root, 'tool-skill', { tools: ['memory.search', 'web.fetch'] });
  const { catalog } = loadCatalog(root);

  const skill = catalog.get('tool-skill').skill;
  assert.equal(skill.valid, true);
  assert.equal(skill.activation.canActivate, false);
  assert.deepEqual(skill.activation.reasons, ['ferramenta ausente: web.fetch']);
  assert.deepEqual(skill.missing.tools, ['web.fetch']);
});

test('dependência ausente, inválida ou não instalada bloqueia a ativação', t => {
  const root = scratch(t);
  writeSkill(root, 'missing-dep', { dependencies: ['ghost-skill'] });
  writeSkill(root, 'broken-dep');
  writeFileSync(join(root, 'broken-dep', 'skill.json'), '{ nope');
  writeSkill(root, 'avail-dep', { state: 'available' });
  writeSkill(root, 'needs-avail', { dependencies: ['avail-dep'] });
  writeSkill(root, 'needs-broken', { dependencies: ['broken-dep'] });
  const { catalog } = loadCatalog(root);

  const missing = catalog.get('missing-dep').skill;
  assert.equal(missing.activation.canActivate, false);
  assert.deepEqual(missing.activation.reasons, ['dependência ausente: ghost-skill']);
  assert.deepEqual(missing.missing.dependencies, ['ghost-skill']);

  const invalid = catalog.get('needs-broken').skill;
  assert.equal(invalid.activation.canActivate, false);
  assert.deepEqual(invalid.activation.reasons, ['dependência inválida: broken-dep']);
  assert.deepEqual(invalid.missing.dependencies, ['broken-dep']);

  const notInstalled = catalog.get('needs-avail').skill;
  assert.equal(notInstalled.activation.canActivate, false);
  assert.deepEqual(notInstalled.activation.reasons, ['dependência não instalada: avail-dep (estado available)']);
  assert.deepEqual(notInstalled.missing.dependencies, ['avail-dep']);
});

test('skill desativada e estados não instalados não ativam', t => {
  const root = scratch(t);
  writeSkill(root, 'off-skill', { state: 'disabled' });
  writeSkill(root, 'pending-skill', { state: 'pending' });
  const { catalog } = loadCatalog(root);

  const off = catalog.get('off-skill').skill;
  assert.equal(off.activation.canActivate, false);
  assert.deepEqual(off.activation.reasons, ['skill desativada']);

  const pending = catalog.get('pending-skill').skill;
  assert.equal(pending.activation.canActivate, false);
  assert.deepEqual(pending.activation.reasons, ['estado pending: skill não instalada']);
});

test('manifesto inválido, id divergente e manifesto ausente ficam isolados', t => {
  const root = scratch(t);
  writeSkill(root, 'good-skill');
  writeSkill(root, 'bad-schema', { schema: 'usami.agent.nope.v1' });
  writeSkill(root, 'wrong-id');
  writeFileSync(join(root, 'wrong-id', 'skill.json'), JSON.stringify(manifest('another-id')));
  mkdirSync(join(root, 'no-manifest'));
  const { catalog, snapshot, warnings } = loadCatalog(root);

  assert.deepEqual(snapshot.skills.map(skill => skill.id), ['bad-schema', 'good-skill', 'no-manifest', 'wrong-id']);
  assert.equal(snapshot.skills.find(skill => skill.id === 'good-skill').valid, true);
  for (const id of ['bad-schema', 'wrong-id', 'no-manifest']) {
    const skill = catalog.get(id).skill;
    assert.equal(skill.valid, false, id);
    assert.equal(skill.activation.canActivate, false, id);
    assert.equal(skill.errors.length > 0, true, id);
    assert.equal('name' in skill, false, id);
  }
  assert.match(catalog.get('bad-schema').skill.errors[0], /schema/);
  assert.match(catalog.get('wrong-id').skill.errors[0], /não corresponde/);
  assert.match(catalog.get('no-manifest').skill.errors[0], /ausente/);
  assert.equal(warnings.length, 3);
});

test('loader nunca importa código da skill', t => {
  const root = scratch(t);
  const dir = writeSkill(root, 'code-skill');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  writeFileSync(join(dir, 'index.mjs'), 'throw new Error("código da skill executou");\n');
  writeFileSync(join(dir, 'skill.json'), JSON.stringify(manifest('code-skill')));
  const { catalog } = loadCatalog(root);

  assert.equal(catalog.get('code-skill').skill.activation.canActivate, true);
});

test('diretório fora do padrão de slug é ignorado com aviso', t => {
  const root = scratch(t);
  writeSkill(root, 'valid-skill');
  writeSkill(root, 'Bad_ID');
  writeFileSync(join(root, 'readme.txt'), 'ignorado');
  const { snapshot, warnings } = loadCatalog(root);

  assert.deepEqual(snapshot.skills.map(skill => skill.id), ['valid-skill']);
  assert.equal(warnings.some(message => message.includes('Bad_ID')), true);
});

test('get de skill desconhecida responde notFound sem quebrar o load', t => {
  const root = scratch(t);
  writeSkill(root, 'valid-skill');
  const { catalog } = loadCatalog(root);

  assert.deepEqual(catalog.get('ghost'), { ok: false, notFound: true });
  assert.equal(catalog.get('valid-skill').ok, true);
});

test('load recarrega o diretório a cada chamada', t => {
  const root = scratch(t);
  writeSkill(root, 'first-skill');
  const { catalog } = loadCatalog(root);
  assert.deepEqual(catalog.list().map(skill => skill.id), ['first-skill']);

  writeSkill(root, 'second-skill');
  assert.deepEqual(catalog.list().map(skill => skill.id), ['first-skill']);
  catalog.load();
  assert.deepEqual(catalog.list().map(skill => skill.id), ['first-skill', 'second-skill']);
});
