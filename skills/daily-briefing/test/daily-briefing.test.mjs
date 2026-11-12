import test from 'node:test';
import assert from 'node:assert/strict';
import { BRIEFING_SCHEMA, buildDailyBriefing } from '../briefing-core.mjs';

test('base vazia devolve briefing vazio sem inventar compromissos ou tarefas', () => {
  const nowMs = Date.parse('2026-11-11T12:00:00.000Z');
  const briefing = buildDailyBriefing({
    nowMs,
    operationalRecords: [],
    plans: [],
    executions: [],
  });

  assert.equal(briefing.schema, BRIEFING_SCHEMA);
  assert.equal(briefing.date, '2026-11-11');
  assert.equal(briefing.empty, true);
  assert.deepEqual(briefing.commitments, []);
  assert.deepEqual(briefing.priorityTasks, []);
  assert.deepEqual(briefing.projects, []);
  assert.equal(briefing.pending.totalCount, 0);
  assert.equal(briefing.narrativeSource, 'deterministic');
  assert.match(briefing.text, /Base operacional vazia/);
});

test('base populada organiza compromissos, tarefas prioritárias, projetos e pendências reais', () => {
  const nowMs = Date.parse('2026-11-11T12:00:00.000Z');
  const briefing = buildDailyBriefing({
    nowMs,
    operationalRecords: [
      {
        id: 'op-111111111111',
        kind: 'commitment',
        title: 'Reunião de alinhamento',
        status: 'open',
        dueAt: '2026-11-11T15:00:00.000Z',
        relevance: 0.7,
      },
      {
        id: 'op-222222222222',
        kind: 'task',
        title: 'Enviar nota fiscal',
        status: 'open',
        dueAt: '2026-11-10T18:00:00.000Z',
        relevance: 0.8,
      },
      {
        id: 'op-333333333333',
        kind: 'project',
        title: 'Usami 2.0',
        status: 'in_progress',
        relevance: 0.9,
        updatedAt: '2026-11-11T10:00:00.000Z',
      },
    ],
    plans: [
      {
        id: 'pl-aaaaaaaaaaaa',
        goal: 'Entregar S13',
        status: 'approved',
        steps: [{ id: 'st-111111111111', status: 'pending' }],
      },
    ],
    executions: [
      {
        id: 'ex-bbbbbbbbbbbb',
        tool: 'mail.send',
        status: 'denied',
        verified: false,
        reason: 'confirmação recusada',
        startedAt: '2026-11-11T11:30:00.000Z',
      },
    ],
  });

  assert.equal(briefing.empty, false);
  assert.equal(briefing.commitments.length, 1);
  assert.equal(briefing.commitments[0].onTargetDate, true);
  assert.equal(briefing.priorityTasks.length, 1);
  assert.equal(briefing.priorityTasks[0].overdue, true);
  assert.equal(briefing.projects.length, 1);
  assert.equal(briefing.pending.overdueRecords.length, 1);
  assert.equal(briefing.pending.plans.length, 1);
  assert.equal(briefing.pending.executionAlerts.length, 1);
  assert.match(briefing.text, /Reunião de alinhamento/);
  assert.match(briefing.text, /ATRASAD/);
  assert.match(briefing.text, /Usami 2\.0/);
});

