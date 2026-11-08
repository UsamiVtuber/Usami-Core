// Vínculo com a Usami (estilo visual novel): medidores, níveis nomeados e o
// histórico recente de momentos que renderam XP. Tudo aqui é puro para poder
// ser testado em node; a persistência recebe o storage injetado.

export const METER_KEYS = ['carinho', 'humor', 'companhia'];
export const LEVELS = [0, 25, 60, 110, 180];
export const LEVEL_NAMES = ['Conhecidos', 'Amigos Próximos', 'Parceiros', 'Confidentes', 'Almas Gêmeas'];
export const LEVEL_LINES = [
  'Que bom te ver por aqui ♡',
  'Você me deixa muito feliz! ♡',
  'Gosto tanto das nossas conversas…',
  'Posso te contar tudo, né? ♡',
  'Você é a minha pessoa favorita ♡',
];

export const levelFor = xp => LEVELS.reduce((level, threshold, index) => xp >= threshold ? index + 1 : level, 1);

export const meterProgress = xp => {
  const level = levelFor(xp);
  if (level >= LEVELS.length) return 1;
  const base = LEVELS[level - 1];
  return Math.min(1, Math.max(0, (xp - base) / (LEVELS[level] - base)));
};

// O nível exibido é o do medidor mais alto (mesma regra do pill `♥ Nível N`),
// então a barra de EXP acompanha esse medidor.
export function bondSummary(intimacy = {}) {
  const xp = Math.max(0, ...METER_KEYS.map(key => Math.floor(Number(intimacy[key]) || 0)));
  const level = levelFor(xp);
  const max = level >= LEVELS.length;
  const next = max ? null : LEVELS[level];
  return {
    xp,
    level,
    name: LEVEL_NAMES[level - 1],
    line: LEVEL_LINES[level - 1],
    next,
    remaining: max ? 0 : next - xp,
    progress: meterProgress(xp),
    max,
  };
}

export const BOND_LOG_KEY = 'usami.intimidade.historico.v1';
export const MAX_BOND_LOG = 20;
const EVENT_KINDS = new Set(['chat', 'voice', 'laugh', 'long', 'call', 'level']);

// Converte o ganho de uma mensagem num momento legível. O texto da mensagem
// nunca entra no histórico: só o tipo do momento.
export function describeChatGains(gains = {}, { spoken = false } = {}) {
  if (gains.humor) return { kind: 'laugh', text: 'Vocês riram juntos' };
  if (spoken) return { kind: 'voice', text: 'Vocês conversaram por voz' };
  if (gains.companhia) return { kind: 'long', text: 'Você contou algo com calma' };
  return { kind: 'chat', text: 'Vocês conversaram' };
}

const sameLocalDay = (a, b) => {
  const x = new Date(a), y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
};

const addGains = (a = {}, b = {}) => {
  const out = {};
  METER_KEYS.forEach(key => {
    const value = (Number(a[key]) || 0) + (Number(b[key]) || 0);
    if (value) out[key] = value;
  });
  return out;
};

// Mais recente primeiro. Momentos repetidos no mesmo dia viram um só com
// contador, para o histórico não virar uma lista de "Vocês conversaram".
export function appendBondEvent(log, event, max = MAX_BOND_LOG) {
  const list = Array.isArray(log) ? log : [];
  if (!event || !EVENT_KINDS.has(event.kind) || !event.text) return list;
  const at = Number(event.at) || Date.now();
  const gains = addGains({}, event.gains);
  const top = list[0];
  if (top && event.kind !== 'level' && top.kind === event.kind && top.text === event.text && sameLocalDay(top.at, at)) {
    return [{ ...top, at, count: (top.count || 1) + 1, gains: addGains(top.gains, gains) }, ...list.slice(1)];
  }
  return [{ kind: event.kind, text: event.text, at, count: 1, gains }, ...list].slice(0, max);
}

export function sanitizeBondLog(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(item => item && EVENT_KINDS.has(item.kind) && typeof item.text === 'string' && Number.isFinite(Number(item.at)))
    .slice(0, MAX_BOND_LOG)
    .map(item => ({
      kind: item.kind,
      text: item.text.slice(0, 80),
      at: Number(item.at),
      count: Math.max(1, Math.floor(Number(item.count) || 1)),
      gains: addGains({}, item.gains),
    }));
}

export function loadBondLog(storage = globalThis.localStorage) {
  try { return sanitizeBondLog(JSON.parse(storage?.getItem(BOND_LOG_KEY) || 'null')); } catch { return []; }
}

export function saveBondLog(log, storage = globalThis.localStorage) {
  try { storage?.setItem(BOND_LOG_KEY, JSON.stringify(sanitizeBondLog(log))); } catch {}
}

export function relativeDay(at, now = Date.now()) {
  if (sameLocalDay(at, now)) return 'Hoje';
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (sameLocalDay(at, yesterday.getTime())) return 'Ontem';
  const date = new Date(at);
  return `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}`;
}
