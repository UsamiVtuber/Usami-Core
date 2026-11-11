import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_BRIEFING_THRESHOLD,
  analyzeGoal,
  createTaskPlanner,
  parseBriefingThreshold,
} from '../src/task-planner.js';
import { AGENT_SCHEMAS } from '../src/agent-contracts.js';

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'usami-planner-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function strictGenerator(steps) {
  return () => ({ steps });
}

function twoCyclicSteps() {
  const a = 'st-000000000001';
  const b = 'st-000000000002';
  return [
    { id: a, title: 'Preparar a base', dependsOn: [b] },
    { id: b, title: 'Concluir a base', dependsOn: [a] },
  ];
}

test('load sem diretório não cria data/plans', t => {
  const dir = scratch(t);
  const planner = createTaskPlanner({ dataDir: dir });
  const snapshot = planner.load();
  assert.deepEqual(snapshot.plans, []);
  assert.deepEqual(snapshot.unavailable, []);
  assert.equal(existsSync(join(dir, 'plans')), false);
});

test('create gera plano válido com passos encadeados e briefing persistido', t => {
  const dir = scratch(t);
  const planner = createTaskPlanner({ dataDir: dir });
  planner.load();

  const created = planner.create({ goal: 'Organizar a viagem de fim de ano' });
  assert.equal(created.ok, true);
  assert.equal(created.version, 1);
  const { plan } = created;
  assert.equal(plan.schema, AGENT_SCHEMAS.plan);
  assert.equal(plan.status, 'draft');
  assert.equal(plan.steps.length, 5);
  assert.deepEqual(plan.steps[0].dependsOn, []);
  for (const [index, step] of plan.steps.entries()) {
    if (index > 0) assert.deepEqual(step.dependsOn, [plan.steps[index - 1].id]);
    assert.equal(step.status, 'pending');
  }
  assert.equal(Boolean(plan.briefing), plan.steps.length > DEFAULT_BRIEFING_THRESHOLD);

  const file = join(dir, 'plans', `${plan.id}.json`);
  assert.equal(existsSync(file), true);

  const reloaded = createTaskPlanner({ dataDir: dir });
  reloaded.load();
  const fetched = reloaded.get(plan.id);
  assert.equal(fetched.ok, true);
  assert.equal(fetched.plan.steps.length, 5);
  assert.equal(fetched.versions.length, 1);
});

test('briefing respeita o limiar configurável', t => {
  const dir = scratch(t);
  const above = createTaskPlanner({ dataDir: dir, briefingThreshold: 5 });
  above.load();
  assert.equal(above.create({ goal: 'Organizar a viagem de fim de ano' }).plan.briefing, undefined);

  const dirAlways = scratch(t);
  const always = createTaskPlanner({ dataDir: dirAlways, briefingThreshold: 0 });
  always.load();
  assert.ok(always.create({ goal: 'Organizar a viagem de fim de ano' }).plan.briefing);
});

test('plano vazio é recusado e não é persistido', t => {
  const dir = scratch(t);
  const planner = createTaskPlanner({ dataDir: dir, generatePlan: strictGenerator([]) });
  planner.load();

  const created = planner.create({ goal: 'Organizar a viagem de fim de ano' });
  assert.equal(created.ok, false);
  assert.ok(created.errors.some(error => error.startsWith('steps:')));
  assert.deepEqual(planner.list(), []);
  assert.equal(existsSync(join(dir, 'plans')), false);
});

test('dependência circular é recusada', t => {
  const dir = scratch(t);
  const planner = createTaskPlanner({ dataDir: dir, generatePlan: strictGenerator(twoCyclicSteps()) });
  planner.load();

  const created = planner.create({ goal: 'Organizar a viagem de fim de ano' });
  assert.equal(created.ok, false);
  assert.ok(created.errors.includes('steps: dependências formam ciclo'));
  assert.deepEqual(planner.list(), []);
});

test('progresso atualiza passo, valida dependência e persiste', t => {
  const dir = scratch(t);
  const planner = createTaskPlanner({ dataDir: dir });
  planner.load();
  const { plan } = planner.create({ goal: 'Organizar a viagem de fim de ano' });
  const [first, second] = plan.steps;

  const blocked = planner.updateProgress(plan.id, { steps: [{ id: second.id, status: 'done' }] });
  assert.equal(blocked.ok, false);
  assert.match(blocked.errors[0], /dependência/);

  const updated = planner.updateProgress(plan.id, { steps: [{ id: first.id, status: 'done' }] });
  assert.equal(updated.ok, true);
  assert.deepEqual(updated.changed, [`step:${first.id}`]);
  assert.equal(updated.plan.steps[0].status, 'done');
  assert.ok(updated.plan.updatedAt);

  const reloaded = createTaskPlanner({ dataDir: dir });
  reloaded.load();
  assert.equal(reloaded.get(plan.id).plan.steps[0].status, 'done');
});

test('progresso recusa passo inexistente e status inválido', t => {
  const dir = scratch(t);
  const planner = createTaskPlanner({ dataDir: dir });
  planner.load();
  const { plan } = planner.create({ goal: 'Organizar a viagem de fim de ano' });

  const missing = planner.updateProgress(plan.id, { steps: [{ id: 'st-ffffffffffff', status: 'done' }] });
  assert.equal(missing.ok, false);
  assert.match(missing.errors[0], /passo inexistente/);

  const invalid = planner.updateProgress(plan.id, { status: 'brincando' });
  assert.equal(invalid.ok, false);
  assert.match(invalid.errors[0], /status: inválido/);
});

test('plano done ou cancelled é imutável', t => {
  const dir = scratch(t);
  const planner = createTaskPlanner({ dataDir: dir });
  planner.load();
  const { plan } = planner.create({ goal: 'Organizar a viagem de fim de ano' });

  assert.equal(planner.updateProgress(plan.id, { status: 'done' }).ok, true);
  const locked = planner.updateProgress(plan.id, { steps: [{ id: plan.steps[0].id, status: 'pending' }] });
  assert.equal(locked.ok, false);
  assert.equal(locked.locked, true);
});

test('replanejamento incrementa a versão e preserva o histórico', t => {
  const dir = scratch(t);
  const planner = createTaskPlanner({ dataDir: dir });
  planner.load();
  const { plan } = planner.create({ goal: 'Organizar a viagem de fim de ano' });
  planner.updateProgress(plan.id, { status: 'running' });

  const replanned = planner.create({ goal: 'Organizar a viagem de fim de ano', replanOf: plan.id });
  assert.equal(replanned.ok, true);
  assert.equal(replanned.replanned, true);
  assert.equal(replanned.plan.id, plan.id);
  assert.equal(replanned.plan.version, 2);
  assert.equal(replanned.plan.status, 'draft');

  const reloaded = createTaskPlanner({ dataDir: dir });
  reloaded.load();
  const fetched = reloaded.get(plan.id);
  assert.equal(fetched.plan.version, 2);
  assert.deepEqual(fetched.versions.map(version => version.version), [1, 2]);
  assert.equal(fetched.versions[0].status, 'running');

  const missing = reloaded.create({ goal: 'Organizar a viagem de fim de ano', replanOf: 'pl-ffffffffffff' });
  assert.equal(missing.ok, false);
  assert.equal(missing.notFound, true);
});

test('arquivo corrompido fica indisponível sem derrubar os outros planos', t => {
  const dir = scratch(t);
  const planner = createTaskPlanner({ dataDir: dir });
  planner.load();
  const keep = planner.create({ goal: 'Organizar a viagem de fim de ano' }).plan;
  const broken = planner.create({ goal: 'Revisar as anotações do projeto' }).plan;
  writeFileSync(join(dir, 'plans', `${broken.id}.json`), '{ isto não é json', 'utf8');

  const messages = [];
  const reloaded = createTaskPlanner({ dataDir: dir, onLoadError: message => messages.push(message) });
  reloaded.load();

  assert.deepEqual(reloaded.list().map(plan => plan.id), [keep.id]);
  assert.deepEqual(reloaded.unavailable(), [broken.id]);
  assert.equal(reloaded.get(broken.id).unavailable, true);
  assert.equal(reloaded.updateProgress(broken.id, { status: 'running' }).unavailable, true);
  assert.equal(reloaded.create({ goal: 'Revisar as anotações do projeto', replanOf: broken.id }).unavailable, true);
  assert.equal(messages.length, 1);

  const created = reloaded.create({ goal: 'Fazer a lista de compras da semana' });
  assert.equal(created.ok, true);
  assert.equal(readdirSync(join(dir, 'plans')).length, 3);
});

test('informações ausentes seguem regras explícitas', () => {
  const external = analyzeGoal('Enviar o relatório amanhã');
  assert.ok(external.includes('autorização, canal e destinatário da ação externa'));
  assert.ok(external.includes('data ou prazo explícito'));

  const short = analyzeGoal('Estudar');
  assert.ok(short.includes('escopo e critério de conclusão do objetivo'));
});

test('parseBriefingThreshold aceita valor válido e cai no padrão', () => {
  assert.equal(parseBriefingThreshold('6'), 6);
  assert.equal(parseBriefingThreshold(0), 0);
  assert.equal(parseBriefingThreshold('abc'), DEFAULT_BRIEFING_THRESHOLD);
  assert.equal(parseBriefingThreshold('-1'), DEFAULT_BRIEFING_THRESHOLD);
  assert.equal(parseBriefingThreshold(31), DEFAULT_BRIEFING_THRESHOLD);
  assert.equal(parseBriefingThreshold(undefined), DEFAULT_BRIEFING_THRESHOLD);
});
