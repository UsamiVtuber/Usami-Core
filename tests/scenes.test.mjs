import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getTimeSlot,
  getLogicalDate,
  formatDateIso,
  hashString,
  pickDeterministic,
  getDailyScene,
  SESSION_BOUNDARY_HOUR,
} from '../src/scenes.js';

test('getTimeSlot particiona as 24 horas nos 8 slots do OpenAmika', () => {
  assert.equal(getTimeSlot(0), 'tarde_da_noite');
  assert.equal(getTimeSlot(4), 'madrugada');
  assert.equal(getTimeSlot(5), 'alvorada');
  assert.equal(getTimeSlot(7), 'alvorada');
  assert.equal(getTimeSlot(8), 'manha');
  assert.equal(getTimeSlot(11), 'manha');
  assert.equal(getTimeSlot(12), 'almoco');
  assert.equal(getTimeSlot(13), 'almoco');
  assert.equal(getTimeSlot(14), 'tarde');
  assert.equal(getTimeSlot(16), 'tarde');
  assert.equal(getTimeSlot(17), 'entardecer');
  assert.equal(getTimeSlot(18), 'entardecer');
  assert.equal(getTimeSlot(19), 'noite');
  assert.equal(getTimeSlot(21), 'noite');
  assert.equal(getTimeSlot(22), 'tarde_da_noite');
  assert.equal(getTimeSlot(23), 'tarde_da_noite');
});

test('getLogicalDate recua 1 dia para horários antes da fronteira de 5h', () => {
  const at3am = new Date('2026-11-06T03:30:00');
  const logical3am = getLogicalDate(at3am);
  assert.equal(formatDateIso(logical3am), '2026-11-05');

  const at6am = new Date('2026-11-06T06:30:00');
  const logical6am = getLogicalDate(at6am);
  assert.equal(formatDateIso(logical6am), '2026-11-06');
});

test('pickDeterministic é 100% determinístico e distribui entre as opções', () => {
  const options = ['opt0', 'opt1', 'opt2', 'opt3', 'opt4'];
  const seed1 = '2026-11-06|weekday/tarde';
  const pick1 = pickDeterministic(options, seed1);
  const pick2 = pickDeterministic(options, seed1);
  assert.equal(pick1, pick2);
  assert.ok(options.includes(pick1));

  // Seeds diferentes produzem escolhas válidas
  const picks = new Set();
  for (let i = 0; i < 20; i++) {
    picks.add(pickDeterministic(options, `seed-${i}`));
  }
  assert.ok(picks.size > 1);
});

test('getDailyScene monta o contexto com placeholders preenchidos', () => {
  const date = new Date('2026-11-06T15:00:00'); // sexta-feira às 15h -> weekday/tarde
  const scene = getDailyScene({ date, username: 'Amari' });

  assert.equal(scene.slotKey, 'weekday/tarde');
  assert.equal(scene.period, 'tarde');
  assert.equal(scene.dayType, 'weekday');
  assert.equal(scene.logicalDateStr, '2026-11-06');
  assert.ok(scene.dailyContext.length > 20);
  assert.ok(scene.currentScene.length > 20);
  assert.ok(scene.fallbackProactive.length > 10);

  // Sem placeholders vazios não resolvidos
  assert.ok(!scene.dailyContext.includes('{weekday}'));
  assert.ok(!scene.dailyContext.includes('{username}'));
  assert.ok(!scene.currentScene.includes('{username}'));
});

test('getDailyScene diferencia dia de semana e fim de semana', () => {
  const friday = new Date('2026-11-06T10:00:00');
  const sunday = new Date('2026-11-08T10:00:00');

  const sceneFri = getDailyScene({ date: friday });
  const sceneSun = getDailyScene({ date: sunday });

  assert.equal(sceneFri.dayType, 'weekday');
  assert.equal(sceneSun.dayType, 'weekend');
  assert.equal(sceneFri.slotKey, 'weekday/manha');
  assert.equal(sceneSun.slotKey, 'weekend/manha');
  assert.notEqual(sceneFri.dailyContext, sceneSun.dailyContext);
});
