// Vínculo no frontend: persistência local (fallback offline) e utilidades de
// exibição. Desde a frente D as regras moram em `bond-core.js`, compartilhadas
// com o core local — é ele quem decide o XP de cada resposta.

import { BOND_LOG_LIMIT, sanitizeBondLog } from './bond-core.js';
import { safeGetItem, safeSetItem } from './storage-safe.js';

export {
  METER_KEYS, LEVELS, LEVEL_NAMES, LEVEL_LINES, MAX_BOND_XP, LAUGHTER_PATTERN,
  levelFor, meterProgress, bondSummary, topXp, gainsFor, describeChatGains,
  appendBondEvent, sanitizeBondLog, clampMeters, applyGains, levelUpEvent,
} from './bond-core.js';

export const BOND_LOG_KEY = 'usami.intimidade.historico.v1';
export const MAX_BOND_LOG = BOND_LOG_LIMIT;

const sameLocalDay = (a, b) => {
  const x = new Date(a), y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
};

export function loadBondLog(storage) {
  try { return sanitizeBondLog(JSON.parse(safeGetItem(BOND_LOG_KEY, storage) || 'null')); } catch { return []; }
}

export function saveBondLog(log, storage) {
  safeSetItem(BOND_LOG_KEY, JSON.stringify(sanitizeBondLog(log)), storage);
}

export function relativeDay(at, now = Date.now()) {
  if (sameLocalDay(at, now)) return 'Hoje';
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (sameLocalDay(at, yesterday.getTime())) return 'Ontem';
  const date = new Date(at);
  return `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}`;
}
