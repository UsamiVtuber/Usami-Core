/**
 * Vínculo da Usami — um JSON por instalação em `data/bond.json`.
 *
 * Guarda os três medidores do VN e o histórico recente de momentos. O cálculo
 * do XP mora aqui (via `bond-core.js`), então web e desktop compartilham o
 * mesmo estado por dispositivo sem duplicar regra no cliente.
 *
 * Escrita atômica (tmp + rename, padrão do `memory-store.js`): um crash no
 * meio da gravação não corrompe o arquivo anterior. O relógio é injetável
 * (`now`) para os testes.
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
  BOND_LOG_LIMIT,
  METER_KEYS,
  clampMeters,
  sanitizeBondLog,
  applyGains,
  appendBondEvent,
  gainsFor,
  describeChatGains,
  levelUpEvent,
  bondSummary,
  levelFor,
  meterProgress,
} from './bond-core.js';

const BOND_FILE = 'bond.json';
const BOND_VERSION = 1;
const MAX_CONTENT_LENGTH = 4000;

const emptyIntimacy = () => ({ carinho: 0, humor: 0, companhia: 0 });

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export function createBondStore({ dataDir, now = () => Date.now() } = {}) {
  if (!dataDir || typeof dataDir !== 'string') throw new Error('createBondStore: dataDir é obrigatório.');
  const filePath = join(dataDir, BOND_FILE);

  const defaultData = () => ({
    version: BOND_VERSION,
    intimacy: emptyIntimacy(),
    log: [],
    updatedAt: new Date(now()).toISOString(),
  });

  function normalize(input) {
    const base = defaultData();
    if (!isPlainObject(input)) return base;
    return {
      version: BOND_VERSION,
      intimacy: clampMeters(input.intimacy),
      log: sanitizeBondLog(input.log, BOND_LOG_LIMIT),
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

  // `meters` existe para as UIs desenharem cada barra sem repetir os thresholds
  // do `bond-core` (o desktop é outro binário e não importa o JS).
  const meters = () => Object.fromEntries(METER_KEYS.map(key => {
    const xp = data.intimacy[key];
    return [key, { xp, level: levelFor(xp), progress: meterProgress(xp) }];
  }));

  const snapshot = () => ({
    intimacy: { ...data.intimacy },
    meters: meters(),
    log: data.log.map(item => ({ ...item, gains: { ...item.gains } })),
    updatedAt: data.updatedAt,
    summary: bondSummary(data.intimacy),
  });

  const isEmpty = () => data.log.length === 0 && Object.values(data.intimacy).every(value => !value);

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

    /** Verdadeiro quando ainda não há medidores nem histórico (migração). */
    isEmpty,

    /**
     * Decisão da frente D: o core calcula o ganho da resposta. Devolve o estado
     * novo, os deltas, o momento registrado e uma eventual subida de nível.
     */
    awardChat(content, { spoken = false } = {}) {
      const text = typeof content === 'string' ? content.slice(0, MAX_CONTENT_LENGTH) : '';
      if (!text.trim()) return { ...snapshot(), gains: {}, event: null, levelEvent: null, changed: false };

      const gains = gainsFor(text, { spoken });
      const previous = data.intimacy;
      const { intimacy, changed } = applyGains(previous, gains);
      if (!changed) return { ...snapshot(), gains, event: null, levelEvent: null, changed: false };

      data.intimacy = intimacy;
      const event = appendBondEvent(data.log, { ...describeChatGains(gains, { spoken }), at: now(), gains });
      // appendBondEvent devolve a lista nova; o evento registrado é o primeiro.
      const level = levelUpEvent(previous, intimacy, now());
      data.log = level ? appendBondEvent(event, level) : event;
      persist();
      return { ...snapshot(), gains, event: event[0] || null, levelEvent: level, changed: true };
    },

    /** Fim de chamada de voz rende companhia por minuto inteiro. */
    awardCall(minutes) {
      const amount = Math.min(MAX_BOND_XP, Math.max(0, Math.floor(Number(minutes) || 0)));
      if (!amount) return { ...snapshot(), gains: {}, event: null, levelEvent: null, changed: false };

      const gains = { companhia: amount };
      const previous = data.intimacy;
      const { intimacy, changed } = applyGains(previous, gains);
      if (!changed) return { ...snapshot(), gains, event: null, levelEvent: null, changed: false };

      data.intimacy = intimacy;
      const at = now();
      const event = appendBondEvent(data.log, { kind: 'call', text: `Chamada de voz · ${amount} min`, at, gains });
      const level = levelUpEvent(previous, intimacy, at);
      data.log = level ? appendBondEvent(event, level) : event;
      persist();
      return { ...snapshot(), gains, event: event[0] || null, levelEvent: level, changed: true };
    },

    /** Importa o estado antigo do localStorage uma única vez (core vazio). */
    importState({ intimacy, log } = {}) {
      if (!isEmpty()) return { ...snapshot(), imported: false };
      const next = clampMeters(intimacy);
      const nextLog = sanitizeBondLog(log, BOND_LOG_LIMIT);
      if (nextLog.length === 0 && Object.values(next).every(value => !value)) {
        return { ...snapshot(), imported: false };
      }
      data.intimacy = next;
      data.log = nextLog;
      persist();
      return { ...snapshot(), imported: true };
    },

    reset() {
      data = defaultData();
      persist();
      return snapshot();
    },
  };
}
