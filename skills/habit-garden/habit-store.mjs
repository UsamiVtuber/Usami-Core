/**
 * Store de hábitos — JSON em `data/habits.json`.
 * Separação intencional do operational-memory para permitir
 * campos ricos (frequency, logHistory, streak, category, etc.).
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dataDir as resolveDataDir } from '../../src/data-paths.js';
import { randomBytes } from 'node:crypto';

const FILE_NAME = 'habits.json';

export function createHabitStore({ dataDir = resolveDataDir(), filePath = join(dataDir, FILE_NAME), now = () => Date.now() } = {}) {
  if (!dataDir || typeof dataDir !== 'string') throw new Error('createHabitStore: dataDir é obrigatório.');

  let data = { version: 1, habits: [], updatedAt: new Date(now()).toISOString() };
  let loadFailed = false;
  let loaded = false;

  function persist() {
    mkdirSync(dirname(filePath), { recursive: true });
    data.updatedAt = new Date(now()).toISOString();
    const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temporary, JSON.stringify(data, null, 2), 'utf8');
    try {
      renameSync(temporary, filePath);
    } catch (error) {
      try { unlinkSync(temporary); } catch {}
      if (error?.code !== 'EEXIST' && error?.code !== 'EPERM') throw error;
    }
    return data;
  }

  function ensureLoaded() {
    if (!loaded) {
      load();
      loaded = true;
    }
  }

  function load() {
    try {
      const raw = JSON.parse(readFileSync(filePath, 'utf8'));
      if (raw.version !== 1 || !Array.isArray(raw.habits)) throw new Error('formato inválido');
      data = { version: 1, habits: raw.habits, updatedAt: raw.updatedAt ?? new Date(now()).toISOString() };
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        loadFailed = true;
        throw error;
      }
      data = { version: 1, habits: [], updatedAt: new Date(now()).toISOString() };
    }
    return data;
  }

  function getAll() {
    ensureLoaded();
    return { habits: [...data.habits], updatedAt: data.updatedAt };
  }

  function create(habit) {
    ensureLoaded();
    if (loadFailed) throw new Error('habits: arquivo inválido não foi carregado; escrita recusada');
    const record = {
      ...habit,
      id: habit.id ?? `hab-${randomBytes(6).toString('hex')}`,
      createdAt: habit.createdAt ?? new Date(now()).toISOString(),
      updatedAt: new Date(now()).toISOString(),
    };
    data.habits.push(record);
    persist();
    return { ok: true, habit: record };
  }

  function update(id, patch) {
    ensureLoaded();
    if (loadFailed) throw new Error('habits: arquivo inválido não foi carregado; escrita recusada');
    const index = data.habits.findIndex(h => h.id === id);
    if (index < 0) return { ok: false, notFound: true };
    const updated = { ...data.habits[index], ...patch, updatedAt: new Date(now()).toISOString() };
    data.habits[index] = updated;
    persist();
    return { ok: true, habit: updated };
  }

  function get(id) {
    ensureLoaded();
    const habit = data.habits.find(h => h.id === id);
    return habit ? { ...habit } : null;
  }

  function list({ category, status, limit = 500 } = {}) {
    ensureLoaded();
    let habits = data.habits;
    if (category) habits = habits.filter(h => h.category === category);
    if (status) habits = habits.filter(h => h.status === status);
    return habits
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, limit)
      .map(h => ({ ...h }));
  }

  return { load, getAll, create, update, get, list, filePath };
}