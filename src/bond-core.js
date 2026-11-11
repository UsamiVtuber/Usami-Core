// Regras puras do vínculo (medidores, níveis e histórico de momentos).
// Desde a frente D quem decide o XP é o core local: ele usa `gainsFor` e
// `applyGains` a cada resposta. O frontend importa as mesmas funções só para
// exibição e para o fallback offline — nenhuma regra fica duplicada.

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

export const MAX_BOND_XP = 999;
export const BOND_LOG_LIMIT = 20;
export const LAUGHTER_PATTERN = /kkk|haha|rsrs|😂|🤣|risada/i;
export const BOND_EVENT_KINDS = new Set(['chat', 'voice', 'laugh', 'long', 'call', 'level']);

export const levelFor = xp => LEVELS.reduce((level, threshold, index) => xp >= threshold ? index + 1 : level, 1);

export const meterProgress = xp => {
  const level = levelFor(xp);
  if (level >= LEVELS.length) return 1;
  const base = LEVELS[level - 1];
  return Math.min(1, Math.max(0, (xp - base) / (LEVELS[level] - base)));
};

const clampXp = value => Math.min(MAX_BOND_XP, Math.max(0, Math.floor(Number(value) || 0)));

export function clampMeters(intimacy = {}) {
  const out = {};
  for (const key of METER_KEYS) out[key] = clampXp(intimacy?.[key]);
  return out;
}

// O nível exibido é o do medidor mais alto (mesma regra do pill `♥ Nível N`),
// então a barra de EXP acompanha esse medidor.
export function bondSummary(intimacy = {}) {
  const xp = Math.max(0, ...METER_KEYS.map(key => clampXp(intimacy?.[key])));
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

export function topXp(intimacy = {}) {
  return Math.max(0, ...METER_KEYS.map(key => clampXp(intimacy?.[key])));
}

// Ganho de uma resposta da Usami. A mensagem em si nunca é guardada: só os
// deltas e o tipo do momento.
export function gainsFor(content, { spoken = false } = {}) {
  const text = typeof content === 'string' ? content : '';
  const gains = { carinho: 1 };
  if (LAUGHTER_PATTERN.test(text)) gains.humor = 2;
  if (text.length > 120 || spoken) gains.companhia = 2;
  return gains;
}

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
  for (const key of METER_KEYS) {
    const value = (Number(a[key]) || 0) + (Number(b[key]) || 0);
    if (value) out[key] = value;
  }
  return out;
};

// Mais recente primeiro. Momentos repetidos no mesmo dia viram um só com
// contador, para o histórico não virar uma lista de "Vocês conversaram".
export function appendBondEvent(log, event, max = BOND_LOG_LIMIT) {
  const list = Array.isArray(log) ? log : [];
  if (!event || !BOND_EVENT_KINDS.has(event.kind) || !event.text) return list;
  const at = Number(event.at) || Date.now();
  const gains = addGains({}, event.gains);
  const top = list[0];
  if (top && event.kind !== 'level' && top.kind === event.kind && top.text === event.text && sameLocalDay(top.at, at)) {
    return [{ ...top, at, count: (top.count || 1) + 1, gains: addGains(top.gains, gains) }, ...list.slice(1)];
  }
  return [{ kind: event.kind, text: event.text, at, count: 1, gains }, ...list].slice(0, max);
}

export function sanitizeBondLog(raw, max = BOND_LOG_LIMIT) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(item => item && BOND_EVENT_KINDS.has(item.kind) && typeof item.text === 'string' && Number.isFinite(Number(item.at)))
    .slice(0, max)
    .map(item => ({
      kind: item.kind,
      text: item.text.slice(0, 80),
      at: Number(item.at),
      count: Math.max(1, Math.floor(Number(item.count) || 1)),
      gains: addGains({}, item.gains),
    }));
}

// Aplica os ganhos respeitando o teto e devolve se algo mudou.
export function applyGains(intimacy, gains) {
  const before = clampMeters(intimacy);
  const next = {};
  let changed = false;
  for (const key of METER_KEYS) {
    next[key] = Math.min(MAX_BOND_XP, before[key] + Math.max(0, clampXp(gains?.[key])));
    if (next[key] !== before[key]) changed = true;
  }
  return { intimacy: next, changed };
}

// Subida de nível vira um momento no histórico; sem subida, null.
export function levelUpEvent(previous, next, at = Date.now()) {
  const before = levelFor(topXp(previous));
  const after = levelFor(topXp(next));
  if (after <= before) return null;
  return { kind: 'level', text: `Vínculo subiu para Nv.${after} · ${LEVEL_NAMES[after - 1]}`, at, gains: {} };
}
