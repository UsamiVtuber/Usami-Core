import test from 'node:test';
import assert from 'node:assert/strict';
import { STUDY_SCHEMA, buildStudyPlan, buildStudyReview } from '../study-core.mjs';

test('buildStudyPlan cria trilha estruturada sem inventar fatos', () => {
  const plan = buildStudyPlan({
    topic: 'Rust assíncrono',
    level: 'beginner',
    hoursPerWeek: 6,
    memoryFacts: ['Já programa em TypeScript', 'Gosta de café gelado'],
    nowMs: Date.parse('2026-11-11T12:00:00.000Z'),
  });

  assert.equal(plan.schema, STUDY_SCHEMA);
  assert.equal(plan.mode, 'plan');
  assert.equal(plan.level, 'beginner');
  assert.equal(plan.modules.length, 4);
  assert.match(plan.summary, /Rust assíncrono/);
  assert.deepEqual(plan.relevantFacts, []);
});

test('buildStudyReview lista tarefas/planos de estudo e gera perguntas determinísticas', () => {
  const review = buildStudyReview({
    topic: 'TypeScript',
    operationalRecords: [
      { id: 'op-111111111111', title: 'Estudar TypeScript generics', status: 'open' },
      { id: 'op-222222222222', title: 'Comprar leite', status: 'open' },
    ],
    plans: [
      { id: 'pl-aaaaaaaaaaaa', goal: 'Aprender TypeScript avançado', status: 'approved', steps: [{ status: 'pending' }] },
    ],
    memoryFacts: ['Usa TypeScript no trabalho'],
  });

  assert.equal(review.schema, STUDY_SCHEMA);
  assert.equal(review.mode, 'review');
  assert.equal(review.activeItems.length, 1);
  assert.equal(review.activePlans.length, 1);
  assert.deepEqual(review.relevantFacts, ['Usa TypeScript no trabalho']);
  assert.equal(review.prompts.length, 3);
});

