import test from 'node:test';
import assert from 'node:assert/strict';
import { ARCHITECT_SCHEMA, buildSkillBlueprint, slugifySkillId } from '../architect-core.mjs';

test('slugifySkillId normaliza nomes em slugs válidos', () => {
  assert.equal(slugifySkillId('Leitor de Notas!'), 'leitor-de-notas');
  assert.equal(slugifySkillId('ab'), '');
});

test('buildSkillBlueprint gera manifesto válido e sinaliza dependências/riscos', () => {
  const blueprint = buildSkillBlueprint({
    name: 'Reading Tracker',
    description: 'Acompanha leituras e capítulos concluídos localmente.',
    tools: ['reading.track', 'reading.summary'],
    permissions: [1, 2],
    dependencies: ['personal-planner', 'missing-dep'],
    knownSkills: [{ id: 'personal-planner' }],
    nowMs: Date.parse('2026-11-11T12:00:00.000Z'),
  });

  assert.equal(blueprint.schema, ARCHITECT_SCHEMA);
  assert.equal(blueprint.manifest.id, 'reading-tracker');
  assert.equal(blueprint.manifest.state, 'available');
  assert.deepEqual(blueprint.manifest.tools, ['reading.track', 'reading.summary']);
  assert.deepEqual(blueprint.missingDependencies, ['missing-dep']);
  assert.ok(blueprint.risks.some(r => r.includes('missing-dep')));
});

