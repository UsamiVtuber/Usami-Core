/**
 * Testes da skill Habit Garden
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHabitGardenCore } from '../habit-garden-core.mjs';

describe('habit-garden skill', () => {
  let tempDir;
  let garden;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'usami-habit-garden-'));
    garden = createHabitGardenCore({ dataDir: tempDir, defaultFrequency: 'daily', microHabitThreshold: 5 });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // --- upsertHabit ---

  test('upsertHabit cria hábito com defaults', async () => {
    const result = await garden.upsertHabit({ title: 'Beber água' });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.action, 'created');
    assert.ok(result.habit.id.startsWith('hab-'));
    assert.strictEqual(result.habit.title, 'Beber água');
    assert.strictEqual(result.habit.frequency, 'daily');
    assert.strictEqual(result.habit.category, 'geral');
    assert.strictEqual(result.habit.color, '#FF5E7E');
    assert.deepStrictEqual(result.habit.logHistory, []);
  });

  test('upsertHabit cria hábito com parâmetros customizados', async () => {
    const result = await garden.upsertHabit({
      title: 'Meditar',
      frequency: 'weekly',
      category: 'bem-estar',
      targetMinutes: 10,
      color: '#00FF00',
    });
    assert.strictEqual(result.habit.frequency, 'weekly');
    assert.strictEqual(result.habit.category, 'bem-estar');
    assert.strictEqual(result.habit.targetMinutes, 10);
    assert.strictEqual(result.habit.color, '#00FF00');
  });

  test('upsertHabit atualiza hábito existente', async () => {
    const created = await garden.upsertHabit({ title: 'Ler' });
    const habitId = created.habit.id;

    const updated = await garden.upsertHabit({ id: habitId, title: 'Ler 20 min', category: 'estudos' });
    assert.strictEqual(updated.action, 'updated');
    assert.strictEqual(updated.habit.title, 'Ler 20 min');
    assert.strictEqual(updated.habit.category, 'estudos');
  });

  test('upsertHabit falha sem title', async () => {
    await assert.rejects(
      garden.upsertHabit({ title: '' }),
      /title: obrigatório/
    );
  });

  test('upsertHabit falha ao atualizar ID inexistente', async () => {
    await assert.rejects(
      garden.upsertHabit({ id: 'op-abcdef123456', title: 'Teste' }),
      /hábito não encontrado/
    );
  });

  // --- logHabit ---

  test('logHabit registra log para hoje', async () => {
    const created = await garden.upsertHabit({ title: 'Exercício' });
    const habitId = created.habit.id;

    const result = await garden.logHabit({ habitId });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.logged, true);
    assert.strictEqual(result.streak, 1);
    assert.strictEqual(result.habit.logHistory.length, 1);
    assert.ok(result.habit.lastLoggedAt);
  });

  test('logHabit registra log para data específica', async () => {
    const created = await garden.upsertHabit({ title: 'Alongar' });
    const habitId = created.habit.id;
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

    const result = await garden.logHabit({ habitId, date: yesterday });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.habit.logHistory.length, 1);
  });

  test('logHabit não duplica log no mesmo dia', async () => {
    const created = await garden.upsertHabit({ title: 'Vitaminas' });
    const habitId = created.habit.id;

    await garden.logHabit({ habitId });
    const result = await garden.logHabit({ habitId });

    assert.strictEqual(result.habit.logHistory.length, 1);
    assert.strictEqual(result.isNewLog, false);
  });

  test('logHabit calcula streak corretamente (daily)', async () => {
    const created = await garden.upsertHabit({ title: 'Daily habit', frequency: 'daily' });
    const habitId = created.habit.id;

    // Log 3 dias consecutivos terminando ontem (para streak funcionar com referência today)
    const base = new Date();
    base.setDate(base.getDate() - 1); // ontem
    for (let i = 0; i < 3; i++) {
      const date = new Date(base);
      date.setDate(date.getDate() - i);
      await garden.logHabit({ habitId, date: date.toISOString() });
    }

    const streakResult = garden.getStreak({ habitId });
    assert.strictEqual(streakResult.streak, 3);
  });

  test('logHabit quebra streak se pular dia (daily)', async () => {
    const created = await garden.upsertHabit({ title: 'Daily streak test', frequency: 'daily' });
    const habitId = created.habit.id;

    // Log ontem e anteontem (consecutivo = streak 2)
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const dayBefore = new Date();
    dayBefore.setDate(dayBefore.getDate() - 2);

    await garden.logHabit({ habitId, date: dayBefore.toISOString() });
    await garden.logHabit({ habitId, date: yesterday.toISOString() });

    let streakResult = garden.getStreak({ habitId });
    assert.strictEqual(streakResult.streak, 2);

    // Agora loga hoje (continua streak = 3)
    await garden.logHabit({ habitId });
    streakResult = garden.getStreak({ habitId });
    assert.strictEqual(streakResult.streak, 3);
  });

  test('logHabit falha com habitId inválido', async () => {
    await assert.rejects(
      garden.logHabit({ habitId: 'op-abcdef123456' }),
      /hábito não encontrado/
    );
  });

  // --- getStreak ---

  test('getStreak retorna streak, heatmap e isDueToday', async () => {
    const created = await garden.upsertHabit({ title: 'Test streak' });
    const habitId = created.habit.id;

    await garden.logHabit({ habitId });

    const result = garden.getStreak({ habitId });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.streak, 1);
    assert.strictEqual(result.longestStreak, 1);
    assert.ok(typeof result.heatmap === 'object');
    assert.strictEqual(typeof result.isDueToday, 'boolean');
  });

  // --- getHeatmap ---

  test('getHeatmap retorna heatmap consolidado', async () => {
    await garden.upsertHabit({ title: 'Habit 1' });
    await garden.upsertHabit({ title: 'Habit 2' });

    const result = garden.getHeatmap({ weeks: 2 });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.weeks, 2);
    assert.ok(typeof result.heatmap === 'object');
    assert.strictEqual(result.summary.totalHabits, 2);
  });

  // --- suggestMicroHabitsTool ---

  test('suggestMicroHabitsTool retorna sugestões baseadas em hábitos existentes', async () => {
    await garden.upsertHabit({ title: 'Beber água de manhã', category: 'saúde' });
    await garden.upsertHabit({ title: 'Ler antes de dormir', category: 'aprendizado' });

    const result = garden.suggestMicroHabitsTool({ thresholdMinutes: 5 });
    assert.strictEqual(result.ok, true);
    assert.ok(Array.isArray(result.suggestions));
    assert.ok(result.suggestions.length > 0);
    assert.ok(result.suggestions.every(s => s.estimatedMinutes <= 5));
  });

  test('suggestMicroHabitsTool sugere genéricos se poucos hábitos', async () => {
    const result = garden.suggestMicroHabitsTool({ thresholdMinutes: 5 });
    assert.strictEqual(result.ok, true);
    assert.ok(result.suggestions.length >= 3);
  });

  // --- listHabits ---

  test('listHabits lista todos os hábitos abertos', async () => {
    await garden.upsertHabit({ title: 'Hábito 1', category: 'cat1' });
    await garden.upsertHabit({ title: 'Hábito 2', category: 'cat2' });

    const result = garden.listHabits({ status: 'open' });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.count, 2);
    assert.ok(result.habits.every(h => h.status === 'open'));
  });

  test('listHabits filtra por categoria', async () => {
    await garden.upsertHabit({ title: 'Saúde 1', category: 'saúde' });
    await garden.upsertHabit({ title: 'Trabalho 1', category: 'trabalho' });

    const result = garden.listHabits({ category: 'saúde' });
    assert.strictEqual(result.count, 1);
    assert.strictEqual(result.habits[0].category, 'saúde');
  });

  test('listHabits inclui streak e isDueToday em cada hábito', async () => {
    const created = await garden.upsertHabit({ title: 'Com streak' });
    await garden.logHabit({ habitId: created.habit.id });

    const result = garden.listHabits();
    const habit = result.habits.find(h => h.id === created.habit.id);
    assert.ok(typeof habit.streak === 'number');
    assert.ok(typeof habit.isDueToday === 'boolean');
  });

  // --- Tool Specs ---

  test('toolSpecs expõe 6 ferramentas com verify functions', () => {
    const specs = garden.toolSpecs;
    assert.strictEqual(specs.length, 6);
    const names = specs.map(s => s.name).sort();
    assert.deepStrictEqual(names, [
      'habit.heatmap',
      'habit.list',
      'habit.log',
      'habit.streak',
      'habit.suggest',
      'habit.upsert',
    ]);
    for (const spec of specs) {
      assert.strictEqual(typeof spec.verify, 'function');
      assert.ok(spec.permissionLevel >= 1 && spec.permissionLevel <= 2);
    }
  });

  // --- Persistência ---

  test('dados persistem entre instâncias (mesmo dataDir)', async () => {
    const created = await garden.upsertHabit({ title: 'Persistente', category: 'teste' });
    await garden.logHabit({ habitId: created.habit.id });

    // Nova instância com mesmo dataDir
    const garden2 = createHabitGardenCore({ dataDir: tempDir });
    const list = garden2.listHabits();

    assert.strictEqual(list.count, 1);
    assert.strictEqual(list.habits[0].title, 'Persistente');
    assert.strictEqual(list.habits[0].category, 'teste');
    assert.strictEqual(list.habits[0].streak, 1);
  });

  // --- Frequência weekly ---

  test('streak semanal conta semanas consecutivas', async () => {
    const created = await garden.upsertHabit({ title: 'Semanal', frequency: 'weekly' });
    const habitId = created.habit.id;

    // Log 3 semanas consecutivas
    await garden.logHabit({ habitId, date: '2026-11-01' });
    await garden.logHabit({ habitId, date: '2026-11-08' });
    await garden.logHabit({ habitId, date: '2026-11-15' });

    const streakResult = garden.getStreak({ habitId });
    assert.strictEqual(streakResult.streak, 3);
  });
});