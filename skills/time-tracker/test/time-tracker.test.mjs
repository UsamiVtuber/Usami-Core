/**
 * Testes da skill Time Tracker
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTimeTrackerCore } from '../time-tracker-core.mjs';

describe('time-tracker skill', () => {
  let tempDir;
  let tracker;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'usami-time-tracker-'));
    tracker = createTimeTrackerCore({ dataDir: tempDir, defaultPomodoroMinutes: 25, defaultBreakMinutes: 5 });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // --- Timer básico ---

  test('startTimer cria sessão de foco e retorna timer ativo', async () => {
    const result = await tracker.startTimer({ title: 'Teste foco', kind: 'focus' });
    assert.strictEqual(result.ok, true);
    assert.ok(result.timer.id.startsWith('op-'));
    assert.strictEqual(result.timer.title, '[Timer] Teste foco');
    assert.strictEqual(result.timer.metadata.timerKind, 'focus');

    const status = tracker.getTimerStatus();
    assert.strictEqual(status.active, true);
    assert.strictEqual(status.timer.title, '[Timer] Teste foco');
  });

  test('startTimer falha se já houver timer ativo', async () => {
    await tracker.startTimer({ title: 'Primeiro' });
    await assert.rejects(
      tracker.startTimer({ title: 'Segundo' }),
      /Já existe um timer ativo/
    );
  });

  test('stopTimer finaliza sessão e registra duração', async () => {
    await tracker.startTimer({ title: 'Sessão teste', kind: 'focus' });
    // Pequeno delay para garantir duração > 0
    await new Promise(r => setTimeout(r, 10));
    const result = await tracker.stopTimer();

    assert.strictEqual(result.ok, true);
    assert.ok(result.durationMs > 0);
    assert.ok(result.durationHuman.includes('min') || result.durationHuman.includes('ms'));
    assert.strictEqual(result.timer.metadata.completed, true);

    const status = tracker.getTimerStatus();
    assert.strictEqual(status.active, false);
  });

  test('stopTimer falha se não houver timer ativo', async () => {
    await assert.rejects(
      tracker.stopTimer(),
      /Nenhum timer ativo/
    );
  });

  test('getTimerStatus retorna inactive quando sem timer', () => {
    const status = tracker.getTimerStatus();
    assert.strictEqual(status.active, false);
  });

  // --- Pomodoro ---

  test('startPomodoro cria sessão de trabalho e agenda pausa', async () => {
    const result = await tracker.startPomodoro({ title: 'Pomodoro teste', workMinutes: 1, breakMinutes: 1 });
    assert.strictEqual(result.ok, true);
    assert.ok(result.workSession.id.startsWith('op-'));
    assert.ok(result.workSession.title.includes('🍅'));
    assert.ok(result.breakScheduled.id.startsWith('op-'));
    assert.ok(result.breakScheduled.title.includes('☕'));
    assert.strictEqual(result.breakScheduled.metadata.pomodoroBreak, true);
    assert.strictEqual(result.breakScheduled.metadata.breakMinutes, 1);
  });

  test('startPomodoro usa defaults quando não informado', async () => {
    const result = await tracker.startPomodoro({ title: 'Defaults' });
    assert.strictEqual(result.workSession.metadata.plannedDurationMinutes, 25);
    assert.strictEqual(result.breakScheduled.metadata.breakMinutes, 5);
  });

  // --- Time Block ---

  test('createTimeBlock cria bloco agendado válido', async () => {
    const startAt = new Date(Date.now() + 3600000).toISOString(); // +1h
    const endAt = new Date(Date.now() + 7200000).toISOString();   // +2h

    const result = await tracker.createTimeBlock({
      title: 'Bloco teste',
      startAt,
      endAt,
      tags: ['reunião'],
    });

    assert.strictEqual(result.ok, true);
    assert.ok(result.block.id.startsWith('op-'));
    assert.strictEqual(result.block.title, '📅 Bloco teste');
    assert.strictEqual(result.block.metadata.timeBlock, true);
    assert.strictEqual(result.block.metadata.durationMinutes, 60);
    assert.ok(result.block.tags.includes('time-block'));
    assert.ok(result.block.tags.includes('reunião'));
  });

  test('createTimeBlock falha com datas inválidas', async () => {
    await assert.rejects(
      tracker.createTimeBlock({ title: 'Inválido', startAt: 'não-data', endAt: 'também-não' }),
      /datas ISO-8601 válidas/
    );
  });

  test('createTimeBlock falha se endAt <= startAt', async () => {
    const now = new Date().toISOString();
    await assert.rejects(
      tracker.createTimeBlock({ title: 'Invertido', startAt: now, endAt: now }),
      /endAt deve ser posterior/
    );
  });

  // --- Relatórios ---

  test('getReport vazio retorna zeros', async () => {
    const report = await tracker.getReport({ period: 'day' });
    assert.strictEqual(report.ok, true);
    assert.strictEqual(report.summary.totalTrackedMs, 0);
    assert.strictEqual(report.summary.completedSessions, 0);
    assert.strictEqual(report.sessions.length, 0);
  });

  test('getReport agrega sessões concluídas por tipo', async () => {
    // Cria sessões de diferentes tipos
    await tracker.startTimer({ title: 'Foco 1', kind: 'focus', durationMinutes: 30 });
    await new Promise(r => setTimeout(r, 5));
    await tracker.stopTimer();

    await tracker.startTimer({ title: 'Foco 2', kind: 'focus', durationMinutes: 20 });
    await new Promise(r => setTimeout(r, 5));
    await tracker.stopTimer();

    await tracker.startPomodoro({ title: 'Pomo 1', workMinutes: 1, breakMinutes: 1 });
    await new Promise(r => setTimeout(r, 5));
    await tracker.stopTimer(); // para o work session

    const report = await tracker.getReport({ period: 'day' });
    assert.strictEqual(report.summary.totalSessions, 3);
    assert.strictEqual(report.summary.completedSessions, 3);
    assert.ok(report.summary.byKind.focus.ms > 0);
    assert.ok(report.summary.byKind.pomodoro.ms > 0);
  });

  test('getReport filtra por projectId', async () => {
    const projA = 'proj-a';
    const projB = 'proj-b';

    await tracker.startTimer({ title: 'Tarefa A', projectId: projA, kind: 'focus' });
    await new Promise(r => setTimeout(r, 5));
    await tracker.stopTimer();

    await tracker.startTimer({ title: 'Tarefa B', projectId: projB, kind: 'focus' });
    await new Promise(r => setTimeout(r, 5));
    await tracker.stopTimer();

    const reportA = await tracker.getReport({ period: 'day', projectId: projA });
    assert.strictEqual(reportA.sessions.length, 1);
    assert.strictEqual(reportA.sessions[0].projectId, projA);

    const reportAll = await tracker.getReport({ period: 'day' });
    assert.strictEqual(reportAll.sessions.length, 2);
  });

  test('getReport período week usa weekStartDay configurado', async () => {
    const trackerMon = createTimeTrackerCore({ dataDir: tempDir, weekStartDay: 1 }); // Segunda
    const trackerSun = createTimeTrackerCore({ dataDir: tempDir, weekStartDay: 0 }); // Domingo

    const wednesday = new Date('2026-11-18T10:00:00.000Z'); // Uma quarta-feira

    await trackerMon.startTimer({ title: 'Semana Mon', kind: 'focus' });
    await new Promise(r => setTimeout(r, 5));
    await trackerMon.stopTimer();

    const reportMon = await trackerMon.getReport({ period: 'week', date: wednesday.toISOString() });
    const reportSun = await trackerSun.getReport({ period: 'week', date: wednesday.toISOString() });

    // Ambos devem incluir a sessão (mesma semana civil)
    assert.strictEqual(reportMon.sessions.length, 1);
    assert.strictEqual(reportSun.sessions.length, 1);
  });

  // --- Tool Specs ---

  test('toolSpecs expõe 6 ferramentas com verify functions', () => {
    const specs = tracker.toolSpecs;
    assert.strictEqual(specs.length, 6);
    const names = specs.map(s => s.name).sort();
    assert.deepStrictEqual(names, [
      'timer.block',
      'timer.pomodoro',
      'timer.report',
      'timer.start',
      'timer.status',
      'timer.stop',
    ]);
    for (const spec of specs) {
      assert.strictEqual(typeof spec.verify, 'function');
      assert.ok(spec.permissionLevel >= 1 && spec.permissionLevel <= 2);
    }
  });

  // --- Persistência ---

  test('dados persistem entre instâncias (mesmo dataDir)', async () => {
    await tracker.startTimer({ title: 'Persistente', kind: 'focus', projectId: 'proj-x' });
    await new Promise(r => setTimeout(r, 5));
    await tracker.stopTimer();

    // Nova instância com mesmo dataDir
    const tracker2 = createTimeTrackerCore({ dataDir: tempDir });
    const report = await tracker2.getReport({ period: 'all' });
    assert.strictEqual(report.sessions.length, 1);
    assert.strictEqual(report.sessions[0].projectId, 'proj-x');
  });
});