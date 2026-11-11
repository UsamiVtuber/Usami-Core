/**
 * Conquistas da Usami — um JSON por instalação em `data/achievements.json`.
 *
 * Guarda só o mapa de desbloqueios (`{ id: unlockedAt ISO }`); o catálogo mora
 * no módulo puro `achievements.js`, como as regras do vínculo moram no
 * `bond-core.js`. Escrita atômica (tmp + rename, padrão do `bond-store.js`) e
 * relógio injetável (`now`) para os testes. Desbloqueio é idempotente: uma vez
 * gravado, `unlockedAt` nunca é reescrito por reavaliações posteriores.
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { ACHIEVEMENTS } from './achievements.js';

const ACHIEVEMENTS_FILE = 'achievements.json';
const ACHIEVEMENTS_VERSION = 1;

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export function createAchievementsStore({ dataDir, now = () => Date.now() } = {}) {
  if (!dataDir || typeof dataDir !== 'string') throw new Error('createAchievementsStore: dataDir é obrigatório.');
  const filePath = join(dataDir, ACHIEVEMENTS_FILE);

  const defaultData = () => ({
    version: ACHIEVEMENTS_VERSION,
    unlocked: {},
    updatedAt: new Date(now()).toISOString(),
  });

  const knownIds = new Set(ACHIEVEMENTS.map(achievement => achievement.id));

  function normalize(input) {
    const base = defaultData();
    if (!isPlainObject(input)) return base;
    const unlocked = {};
    for (const [id, at] of Object.entries(isPlainObject(input.unlocked) ? input.unlocked : {})) {
      if (knownIds.has(id) && typeof at === 'string') unlocked[id] = at;
    }
    return {
      version: ACHIEVEMENTS_VERSION,
      unlocked,
      updatedAt: typeof input.updatedAt === 'string' ? input.updatedAt : base.updatedAt,
    };
  }

  let data = defaultData();

  function persist() {
    mkdirSync(dataDir, { recursive: true });
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

  const snapshot = () => ({ version: data.version, unlocked: { ...data.unlocked }, updatedAt: data.updatedAt });

  return {
    /** Carrega o arquivo; se não existe, cria o padrão. */
    load() {
      mkdirSync(dataDir, { recursive: true });
      try {
        data = normalize(JSON.parse(readFileSync(filePath, 'utf8')));
      } catch (error) {
        // corrompido/ilegível: segue com o padrão em memória, SEM sobrescrever
        // o disco (o JSON antigo ainda pode ser recuperado à mão)
        data = defaultData();
        if (error?.code === 'ENOENT') persist();
      }
      return snapshot();
    },

    getAll() {
      return snapshot();
    },

    /**
     * Reavalia o catálogo inteiro contra o estado atual do vínculo. Condição
     * satisfeita destrava com a data do evento que a causou; reavaliações
     * seguintes não tocam em `unlockedAt` já gravado.
     */
    reevaluate(bond) {
      const newlyUnlocked = [];
      let changed = false;
      for (const achievement of ACHIEVEMENTS) {
        if (data.unlocked[achievement.id]) continue;
        const at = achievement.condition(bond);
        if (at === null || at === undefined) continue;
        const ms = Number.isFinite(Number(at)) ? Number(at) : now();
        data.unlocked[achievement.id] = new Date(ms).toISOString();
        newlyUnlocked.push(achievement.id);
        changed = true;
      }
      if (changed) persist();
      return { ...snapshot(), newlyUnlocked };
    },

    /** Catálogo completo no formato do endpoint: um item por conquista. */
    list() {
      return ACHIEVEMENTS.map(({ id, name, description, icon }) => ({
        id,
        name,
        description,
        icon,
        unlocked: Boolean(data.unlocked[id]),
        unlockedAt: data.unlocked[id] ?? null,
      }));
    },
  };
}
