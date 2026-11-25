/**
 * Store de sessões de timer — JSON simples em `data/timer-sessions.json`.
 * Separação intencional do operational-memory (schema fixo) para permitir
 * campos ricos (metadata, tags, duração real, etc.).
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dataDir as resolveDataDir } from '../../src/data-paths.js';
import { randomBytes } from 'node:crypto';

const FILE_NAME = 'timer-sessions.json';

export function createTimerSessionStore({ dataDir = resolveDataDir(), filePath = join(dataDir, FILE_NAME), now = () => Date.now() } = {}) {
  if (!dataDir || typeof dataDir !== 'string') throw new Error('createTimerSessionStore: dataDir é obrigatório.');

  let data = { version: 1, sessions: [], updatedAt: new Date(now()).toISOString() };
  let loadFailed = false;
  let loaded = false;

  function ensureLoaded() {
    if (!loaded) {
      load();
      loaded = true;
    }
  }

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

  function load() {
    try {
      const raw = JSON.parse(readFileSync(filePath, 'utf8'));
      if (raw.version !== 1 || !Array.isArray(raw.sessions)) throw new Error('formato inválido');
      data = { version: 1, sessions: raw.sessions, updatedAt: raw.updatedAt ?? new Date(now()).toISOString() };
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        loadFailed = true;
        throw error;
      }
      data = { version: 1, sessions: [], updatedAt: new Date(now()).toISOString() };
    }
    return data;
  }

  function getAll() {
    return { sessions: [...data.sessions], updatedAt: data.updatedAt };
  }

  function create(session) {
    ensureLoaded();
    if (loadFailed) throw new Error('timer sessions: arquivo inválido não foi carregado; escrita recusada');
    const record = {
      ...session,
      id: session.id ?? `ts-${randomBytes(6).toString('hex')}`,
      createdAt: session.createdAt ?? new Date(now()).toISOString(),
      updatedAt: new Date(now()).toISOString(),
    };
    data.sessions.push(record);
    persist();
    return { ok: true, session: record };
  }

  function update(id, patch) {
    ensureLoaded();
    if (loadFailed) throw new Error('timer sessions: arquivo inválido não foi carregado; escrita recusada');
    const index = data.sessions.findIndex(s => s.id === id);
    if (index < 0) return { ok: false, notFound: true };
    const updated = { ...data.sessions[index], ...patch, updatedAt: new Date(now()).toISOString() };
    data.sessions[index] = updated;
    persist();
    return { ok: true, session: updated };
  }

  function get(id) {
    ensureLoaded();
    const session = data.sessions.find(s => s.id === id);
    return session ? { ...session } : null;
  }

  function list({ projectId, kind, status, limit = 500 } = {}) {
    ensureLoaded();
    let sessions = data.sessions;
    if (projectId) sessions = sessions.filter(s => s.projectId === projectId);
    if (kind) sessions = sessions.filter(s => s.kind === kind);
    if (status) sessions = sessions.filter(s => s.status === status);
    return sessions
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, limit)
      .map(s => ({ ...s }));
  }

  return { load, getAll, create, update, get, list, filePath };
}