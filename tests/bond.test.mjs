import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LEVELS, LEVEL_NAMES, levelFor, bondSummary, describeChatGains, appendBondEvent,
  sanitizeBondLog, loadBondLog, saveBondLog, relativeDay, BOND_LOG_KEY, MAX_BOND_LOG,
} from '../src/bond.js';

test('bondSummary usa o medidor mais alto e calcula o que falta', () => {
  const s = bondSummary({ carinho: 40, humor: 3, companhia: 10 });
  assert.equal(s.level, 2);
  assert.equal(s.name, 'Amigos Próximos');
  assert.equal(s.xp, 40);
  assert.equal(s.next, 60);
  assert.equal(s.remaining, 20);
  assert.ok(Math.abs(s.progress - 15 / 35) < 1e-9);
  assert.equal(s.max, false);
});

test('bondSummary no nível máximo não tem próximo nível', () => {
  const s = bondSummary({ carinho: 999 });
  assert.equal(s.level, LEVELS.length);
  assert.equal(s.name, LEVEL_NAMES.at(-1));
  assert.equal(s.next, null);
  assert.equal(s.remaining, 0);
  assert.equal(s.progress, 1);
  assert.equal(s.max, true);
});

test('bondSummary com dados vazios começa em Conhecidos', () => {
  const s = bondSummary({});
  assert.equal(s.level, 1);
  assert.equal(s.name, 'Conhecidos');
  assert.equal(s.remaining, 25);
  assert.equal(levelFor(25), 2);
});

test('describeChatGains prioriza risada, depois voz e conversa longa', () => {
  assert.equal(describeChatGains({ carinho: 1, humor: 2 }, { spoken: true }).kind, 'laugh');
  assert.equal(describeChatGains({ carinho: 1, companhia: 2 }, { spoken: true }).kind, 'voice');
  assert.equal(describeChatGains({ carinho: 1, companhia: 2 }).kind, 'long');
  assert.equal(describeChatGains({ carinho: 1 }).kind, 'chat');
});

test('appendBondEvent agrupa momentos iguais no mesmo dia e soma o XP', () => {
  const day = new Date(2026, 10, 7, 10).getTime();
  let log = appendBondEvent([], { kind: 'chat', text: 'Vocês conversaram', at: day, gains: { carinho: 1 } });
  log = appendBondEvent(log, { kind: 'chat', text: 'Vocês conversaram', at: day + 1000, gains: { carinho: 1 } });
  assert.equal(log.length, 1);
  assert.equal(log[0].count, 2);
  assert.deepEqual(log[0].gains, { carinho: 2 });
  log = appendBondEvent(log, { kind: 'chat', text: 'Vocês conversaram', at: day + 86400000, gains: { carinho: 1 } });
  assert.equal(log.length, 2, 'outro dia vira outra linha');
  assert.equal(log[0].count, 1);
});

test('appendBondEvent não agrupa subida de nível, respeita o teto e recusa lixo', () => {
  const at = Date.now();
  let log = appendBondEvent([], { kind: 'level', text: 'Nv.2', at });
  log = appendBondEvent(log, { kind: 'level', text: 'Nv.2', at });
  assert.equal(log.length, 2);
  assert.equal(appendBondEvent(log, { kind: 'inventado', text: 'x' }), log);
  let big = [];
  for (let i = 0; i < MAX_BOND_LOG + 5; i++) big = appendBondEvent(big, { kind: 'call', text: `Chamada ${i}`, at: at + i });
  assert.equal(big.length, MAX_BOND_LOG);
  assert.equal(big[0].text, `Chamada ${MAX_BOND_LOG + 4}`);
});

test('persistência descarta entradas inválidas e sobrevive a JSON quebrado', () => {
  const store = new Map();
  const storage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  saveBondLog([{ kind: 'chat', text: 'oi', at: 1, gains: { carinho: 1, bogus: 5 } }, { kind: 'x' }], storage);
  assert.deepEqual(loadBondLog(storage), [{ kind: 'chat', text: 'oi', at: 1, count: 1, gains: { carinho: 1 } }]);
  store.set(BOND_LOG_KEY, '{quebrado');
  assert.deepEqual(loadBondLog(storage), []);
  assert.deepEqual(sanitizeBondLog(null), []);
});

test('relativeDay: Hoje, Ontem e data curta', () => {
  const now = new Date(2026, 10, 7, 3).getTime();
  assert.equal(relativeDay(new Date(2026, 10, 7, 0, 5).getTime(), now), 'Hoje');
  assert.equal(relativeDay(new Date(2026, 10, 6, 23).getTime(), now), 'Ontem');
  assert.equal(relativeDay(new Date(2026, 10, 1, 12).getTime(), now), '01/11');
});
