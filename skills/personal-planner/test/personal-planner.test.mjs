import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildScheduleSummary,
  detectScheduleConflicts,
  prioritizeRecords,
  priorityToRelevance,
} from '../planner-core.mjs';

test('detecta sobreposição de horário e ignora itens adjacentes ou concluídos', () => {
  const conflicts = detectScheduleConflicts([
    {
      id: 'op-000000000001',
      kind: 'commitment',
      title: 'Reunião A',
      status: 'open',
      dueAt: '2026-11-12T14:00:00.000Z',
    },
    {
      id: 'op-000000000002',
      kind: 'task',
      title: 'Consulta',
      status: 'open',
      dueAt: '2026-11-12T14:30:00.000Z',
    },
    {
      id: 'op-000000000003',
      kind: 'task',
      title: 'Item adjacente sem conflito',
      status: 'open',
      dueAt: '2026-11-12T15:30:00.000Z',
    },
    {
      id: 'op-000000000004',
      kind: 'commitment',
      title: 'Cancelado mesmo horário',
      status: 'done',
      dueAt: '2026-11-12T14:10:00.000Z',
    },
  ]);

  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].overlapMinutes, 30);
  assert.equal(conflicts[0].a.id, 'op-000000000001');
  assert.equal(conflicts[0].b.id, 'op-000000000002');
});

test('prioriza atrasadas e alta relevância acima de tarefas sem prazo e gera resumo', () => {
  const nowMs = Date.parse('2026-11-11T12:00:00.000Z');
  const records = [
    {
      id: 'op-000000000010',
      kind: 'task',
      title: 'Organizar arquivos antigos',
      status: 'open',
      relevance: priorityToRelevance(4),
      createdAt: '2026-11-10T10:00:00.000Z',
    },
    {
      id: 'op-000000000011',
      kind: 'task',
      title: 'Entregar relatório crítico',
      status: 'open',
      relevance: priorityToRelevance(1),
      dueAt: '2026-11-11T09:00:00.000Z',
      createdAt: '2026-11-10T10:00:00.000Z',
    },
  ];

  const prioritized = prioritizeRecords(records, { nowMs });
  assert.equal(prioritized[0].id, 'op-000000000011');
  assert.equal(prioritized[0].priority, 1);
  assert.equal(prioritized[0].overdue, true);

  const schedule = buildScheduleSummary({ records, nowMs, goal: 'Organizar semana' });
  assert.equal(schedule.counts.total, 2);
  assert.equal(schedule.counts.overdue, 1);
  assert.equal(schedule.days.length, 1);
  assert.equal(schedule.unscheduled.length, 1);
  assert.match(schedule.summary, /Prioridade #1: Entregar relatório crítico/);
});
