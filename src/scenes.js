/**
 * Motor determinístico de cenas e rotinas diárias da Usami (padrão OpenAmika).
 *
 * Seleciona 1 das 5 variações de daily_context e o current_scene baseado
 * estritamente na chave determinística `YYYY-MM-DD|slotKey` via PRNG seeded.
 *
 * A troca de dia lógico ocorre na fronteira das 05:00 da manhã (SESSION_BOUNDARY_HOUR = 5).
 */

import { SCENES_DATA } from './scenes-data.js';

export const SESSION_BOUNDARY_HOUR = 5;

export const WEEKDAYS_PT = [
  'domingo',
  'segunda-feira',
  'terça-feira',
  'quarta-feira',
  'quinta-feira',
  'sexta-feira',
  'sábado',
];

/**
 * Retorna o slot de horário do dia (8 divisões do OpenAmika).
 * @param {number} hour (0-23)
 * @returns {'alvorada'|'manha'|'almoco'|'tarde'|'entardecer'|'noite'|'tarde_da_noite'|'madrugada'}
 */
export function getTimeSlot(hour) {
  const h = ((Math.floor(hour) % 24) + 24) % 24;
  if (h >= 5 && h < 8) return 'alvorada';
  if (h >= 8 && h < 12) return 'manha';
  if (h >= 12 && h < 14) return 'almoco';
  if (h >= 14 && h < 17) return 'tarde';
  if (h >= 17 && h < 19) return 'entardecer';
  if (h >= 19 && h < 22) return 'noite';
  if (h >= 22 || h < 1) return 'tarde_da_noite';
  return 'madrugada';
}

/**
 * Retorna a data lógica considerando a virada às 05:00.
 * Se hora < 5, a data lógica é o dia anterior.
 * @param {Date|string|number} [dateInput]
 * @returns {Date}
 */
export function getLogicalDate(dateInput = new Date()) {
  const d = new Date(dateInput);
  if (isNaN(d.getTime())) return new Date();
  if (d.getHours() < SESSION_BOUNDARY_HOUR) {
    d.setDate(d.getDate() - 1);
  }
  return d;
}

/**
 * Formata data no padrão YYYY-MM-DD.
 * @param {Date} date
 * @returns {string}
 */
export function formatDateIso(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Hash determinístico de string de 32 bits (FNV-1a).
 * @param {string} str
 * @returns {number}
 */
export function hashString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  }
  return h >>> 0;
}

/**
 * Seleciona um item de forma determinística a partir de uma seed string.
 * @template T
 * @param {T[]} options
 * @param {string} seedStr
 * @returns {T}
 */
export function pickDeterministic(options, seedStr) {
  if (!Array.isArray(options) || options.length === 0) return '';
  if (typeof options === 'string') return options;
  const hash = hashString(seedStr);
  const index = hash % options.length;
  return options[index];
}

/**
 * Obtém o contexto diário e a cena física atual da Usami.
 *
 * @param {Object} [params]
 * @param {Date|string|number} [params.date]
 * @param {string} [params.username]
 * @param {Object} [params.scenesData]
 * @returns {{
 *   slotKey: string,
 *   period: string,
 *   dayType: 'weekday'|'weekend',
 *   logicalDateStr: string,
 *   dailyContext: string,
 *   currentScene: string,
 *   fallbackProactive: string
 * }}
 */
export function getDailyScene({ date = new Date(), username = 'você', scenesData = SCENES_DATA } = {}) {
  const actualDate = new Date(date);
  const validDate = isNaN(actualDate.getTime()) ? new Date() : actualDate;
  const hour = validDate.getHours();

  const logicalDate = getLogicalDate(validDate);
  const logicalDateStr = formatDateIso(logicalDate);

  const dayOfWeek = logicalDate.getDay(); // 0 = Domingo, 6 = Sábado
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
  const dayType = isWeekend ? 'weekend' : 'weekday';

  const period = getTimeSlot(hour);
  const slotKey = `${dayType}/${period}`;
  const fallbackSlotKey = 'weekday/noite';

  const weekdayName = WEEKDAYS_PT[dayOfWeek];
  const yesterdayDayOfWeek = (dayOfWeek + 6) % 7;
  const yesterdayWeekdayName = WEEKDAYS_PT[yesterdayDayOfWeek];

  const dailyContextOptions =
    scenesData.daily_context?.[slotKey] ||
    scenesData.daily_context?.[fallbackSlotKey] ||
    [];

  const seed = `${logicalDateStr}|${slotKey}`;
  const rawDailyContext = pickDeterministic(dailyContextOptions, seed);

  const rawCurrentScene =
    scenesData.current_scene?.[slotKey] ||
    scenesData.current_scene?.[fallbackSlotKey] ||
    '';

  const replacePlaceholders = (text) => {
    if (!text || typeof text !== 'string') return '';
    return text
      .replace(/{weekday}/g, weekdayName)
      .replace(/{weekday_yesterday}/g, yesterdayWeekdayName)
      .replace(/{username}/g, username);
  };

  const dailyContext = replacePlaceholders(rawDailyContext);
  const currentScene = replacePlaceholders(rawCurrentScene);

  const proactiveList = scenesData.proactive_fallbacks?.[period] || [];
  const rawProactive = pickDeterministic(proactiveList, `${seed}|proactive`);
  const fallbackProactive = replacePlaceholders(rawProactive);

  return {
    slotKey,
    period,
    dayType,
    logicalDateStr,
    dailyContext,
    currentScene,
    fallbackProactive,
  };
}
