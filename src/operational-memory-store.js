/**
 * Memória operacional da Usami — um JSON por instalação em
 * `data/operational-memory.json` (via `data-paths.js`).
 *
 * Guarda projetos, tarefas e compromissos: a camada que o Memory Engine ainda
 * não tinha. É separada de `memory.json` (fatos semânticos) e não reescreve
 * curto prazo nem episódica. Toda mutação valida o contrato de
 * `agent-contracts.js` antes de gravar, e a trilha de alterações é append-only
 * (guarda ação, id e campos alterados — nunca o texto do registro).
 *
 * Escrita atômica (tmp + rename, o padrão do `bond-store.js`): crash no meio da
 * gravação não corrompe o arquivo anterior. O relógio é injetável.
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { dataDir as resolveDataDir } from './data-paths.js';
import { AGENT_SCHEMAS, validateOperationalRecord } from './agent-contracts.js';

const FILE_NAME = 'operational-memory.json';
const FILE_VERSION = 1;
const TRAIL_LIMIT = 1000;
const DAY_MS = 86_400_000;
export const OPERATIONAL_DEFAULT_LIMIT = 200;
export const OPERATIONAL_MAX_LIMIT = 500;

// Só estes campos podem mudar por PATCH; kind/id/origin/createdAt são
// identidade do registro e não se editam.
const EDITABLE_FIELDS = Object.freeze(['title', 'status', 'dueAt', 'projectId', 'relevance']);
const TRAIL_ACTIONS = Object.freeze(['create', 'update']);

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const recordTime = (dueAt) => (dueAt ? Date.parse(dueAt) : Number.POSITIVE_INFINITY);

function appendTrail(trail, entry) {
  trail.push(entry);
  if (trail.length > TRAIL_LIMIT) trail.splice(0, trail.length - TRAIL_LIMIT);
}

export function createOperationalMemoryStore({ dataDir = resolveDataDir(), filePath = join(dataDir, FILE_NAME), now = () => Date.now() } = {}) {
  if (!dataDir || typeof dataDir !== 'string') throw new Error('createOperationalMemoryStore: dataDir é obrigatório.');
  const isoNow = () => new Date(now()).toISOString();

  const defaultData = () => ({ version: FILE_VERSION, records: [], trail: [], updatedAt: isoNow() });

  let data = defaultData();
  // Se o arquivo existia e não pôde ser lido, o app não pode gravar por cima:
  // um JSON corrompido ainda é recuperável à mão. Toda escrita falha até o
  // operador resolver o arquivo.
  let loadFailed = false;

  function assertWritable() {
    if (loadFailed) throw new Error('memória operacional: arquivo inválido não foi carregado; escrita recusada');
  }

  function persist() {
    mkdirSync(dirname(filePath), { recursive: true });
    data.updatedAt = isoNow();
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

  // Registro inválido é erro, não descarte: o arquivo é a fonte da verdade, e
  // sumir com uma tarefa em silêncio é pior que recusar o load.
  function normalize(input) {
    if (!isPlainObject(input)) throw new Error('memória operacional: arquivo deve ser um objeto JSON');
    if (input.version !== FILE_VERSION) throw new Error(`memória operacional: versão ${JSON.stringify(input.version)} não suportada`);
    if (!Array.isArray(input.records)) throw new Error('memória operacional: campo records deve ser uma lista');
    const records = [];
    const ids = new Set();
    for (const [index, raw] of input.records.entries()) {
      const result = validateOperationalRecord(raw);
      if (!result.ok) {
        throw new Error(`memória operacional: registro ${index} inválido (${result.errors.join('; ')})`);
      }
      if (ids.has(result.value.id)) throw new Error(`memória operacional: id duplicado (${result.value.id})`);
      ids.add(result.value.id);
      records.push(result.value);
    }
    const trail = [];
    if (input.trail !== undefined && !Array.isArray(input.trail)) {
      throw new Error('memória operacional: campo trail deve ser uma lista');
    }
    for (const entry of (input.trail ?? []).slice(-TRAIL_LIMIT)) {
      if (!isPlainObject(entry) || !TRAIL_ACTIONS.includes(entry.action) || typeof entry.id !== 'string' || typeof entry.at !== 'string') continue;
      trail.push({
        at: entry.at,
        action: entry.action,
        id: entry.id,
        changed: Array.isArray(entry.changed) ? entry.changed.filter(field => typeof field === 'string').slice(0, 10) : [],
      });
    }
    return {
      version: FILE_VERSION,
      records,
      trail,
      updatedAt: typeof input.updatedAt === 'string' ? input.updatedAt : isoNow(),
    };
  }

  const snapshot = () => ({
    records: data.records.map(record => ({ ...record })),
    trail: data.trail.map(entry => ({ ...entry, changed: [...entry.changed] })),
    updatedAt: data.updatedAt,
  });

  const get = id => {
    const record = data.records.find(item => item.id === id);
    return record ? { ...record } : null;
  };

  return {
    /**
     * Carrega o arquivo; se não existe, começa vazio sem gravar — importar o
     * app não pode criar arquivo em `data/`, só a primeira mutação persiste.
     * Arquivo inválido lança.
     */
    load() {
      try {
        data = normalize(JSON.parse(readFileSync(filePath, 'utf8')));
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          loadFailed = true;
          throw error;
        }
        data = defaultData();
      }
      return snapshot();
    },

    getAll() {
      return snapshot();
    },

    get,

    create(input) {
      assertWritable();
      if (!isPlainObject(input)) return { ok: false, errors: ['record: deve ser um objeto'] };
      const createdAt = isoNow();
      const candidate = {
        schema: AGENT_SCHEMAS.operational,
        id: `op-${randomBytes(6).toString('hex')}`,
        kind: input.kind,
        title: input.title,
        status: input.status ?? 'open',
        origin: input.origin ?? 'user',
        relevance: input.relevance ?? 0.5,
        createdAt,
        updatedAt: createdAt,
      };
      if (input.dueAt !== undefined) candidate.dueAt = input.dueAt;
      if (input.projectId !== undefined) candidate.projectId = input.projectId;
      const result = validateOperationalRecord(candidate);
      if (!result.ok) return { ok: false, errors: result.errors };
      data.records.push(result.value);
      appendTrail(data.trail, { at: createdAt, action: 'create', id: result.value.id, changed: ['record'] });
      persist();
      return { ok: true, record: { ...result.value } };
    },

    update(id, patch) {
      assertWritable();
      if (!isPlainObject(patch)) return { ok: false, errors: ['patch: deve ser um objeto'] };
      const index = data.records.findIndex(item => item.id === id);
      if (index < 0) return { ok: false, notFound: true };
      const blocked = Object.keys(patch).filter(field => !EDITABLE_FIELDS.includes(field));
      if (blocked.length) return { ok: false, errors: blocked.map(field => `patch.${field}: campo não editável`) };

      const current = data.records[index];
      const next = { ...current };
      const changed = [];
      for (const field of EDITABLE_FIELDS) {
        if (!(field in patch)) continue;
        if (patch[field] === null) {
          if (field in next) {
            delete next[field];
            changed.push(field);
          }
          continue;
        }
        if (next[field] !== patch[field]) {
          next[field] = patch[field];
          changed.push(field);
        }
      }
      if (!changed.length) return { ok: true, record: { ...current }, changed: [] };

      next.updatedAt = isoNow();
      const result = validateOperationalRecord(next);
      if (!result.ok) return { ok: false, errors: result.errors };
      data.records[index] = result.value;
      appendTrail(data.trail, { at: next.updatedAt, action: 'update', id, changed });
      persist();
      return { ok: true, record: { ...result.value }, changed };
    },

    /**
     * Consulta por status, projeto, tipo e janela de `dueAt`. Registros sem
     * data ficam de fora quando há janela; a ordenação é por vencimento e, no
     * empate, por criação. `to` em data pura inclui o dia inteiro — um
     * `to=2026-11-13` não pode esconder o compromisso das 15h.
     */
    list({ status, kind, projectId, from, to, limit = OPERATIONAL_DEFAULT_LIMIT } = {}) {
      const endOfDay = /^\d{4}-\d{2}-\d{2}$/;
      const floor = from ? Date.parse(from) : null;
      const ceilingTime = to ? Date.parse(to) : null;
      const ceiling = ceilingTime !== null && endOfDay.test(to) ? ceilingTime + DAY_MS - 1 : ceilingTime;
      const filtered = data.records.filter(record => {
        if (status && record.status !== status) return false;
        if (kind && record.kind !== kind) return false;
        if (projectId && record.projectId !== projectId) return false;
        if (floor !== null) {
          const time = record.dueAt ? Date.parse(record.dueAt) : null;
          if (time === null || Number.isNaN(time) || time < floor) return false;
        }
        if (ceiling !== null) {
          const time = record.dueAt ? Date.parse(record.dueAt) : null;
          if (time === null || Number.isNaN(time) || time > ceiling) return false;
        }
        return true;
      });
      const ordered = [...filtered].sort((a, b) => {
        const timeA = recordTime(a.dueAt);
        const timeB = recordTime(b.dueAt);
        if (timeA !== timeB) return timeA - timeB;
        return a.createdAt.localeCompare(b.createdAt);
      });
      const max = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), OPERATIONAL_MAX_LIMIT) : OPERATIONAL_DEFAULT_LIMIT;
      return ordered.slice(0, max).map(record => ({ ...record }));
    },

    trail({ limit = 100 } = {}) {
      const max = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), TRAIL_LIMIT) : 100;
      return data.trail.slice(-max).map(entry => ({ ...entry, changed: [...entry.changed] }));
    },
  };
}
