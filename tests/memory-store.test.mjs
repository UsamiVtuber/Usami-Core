import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryStore } from '../src/memory-store.js';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'usami-memory-'));
}

// relógio injetável: mutar clock.iso avança o tempo (e o "hoje" junto)
function makeStore(dir, clock) {
  return createMemoryStore({
    dataDir: dir,
    now: () => clock.iso,
    today: () => clock.iso.slice(0, 10),
  });
}

test('load() cria o arquivo padrão com score 0 e createdAt de hoje', () => {
  const dir = tempDir();
  try {
    const clock = { iso: '2026-10-24T10:00:00.000Z' };
    const store = makeStore(dir, clock);
    const data = store.load();
    assert.equal(data.version, 1);
    assert.equal(data.affinity.score, 0);
    assert.equal(data.affinity.totalDailyGainToday, 0);
    assert.equal(data.user.createdAt, '2026-10-24T10:00:00.000Z');
    assert.ok(existsSync(join(dir, 'memory.json')), 'load() deve criar data/memory.json');
    // recarregar relê o disco sem perder o createdAt
    assert.equal(store.load().user.createdAt, '2026-10-24T10:00:00.000Z');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('addCoreFact dedupe case-insensitive; addRecentFact grava TTL de 7 dias', () => {
  const dir = tempDir();
  try {
    const clock = { iso: '2026-10-24T12:00:00.000Z' };
    const store = makeStore(dir, clock);
    store.load();
    store.addCoreFact('Gosta de café gelado');
    store.addCoreFact('gosta de café GELADO'); // dedupe case-insensitive
    store.addCoreFact('aniversário em 15/03');
    assert.deepEqual(store.getCoreFacts(), ['Gosta de café gelado', 'aniversário em 15/03']);

    store.addRecentFact('começou a jogar Elden Ring');
    store.addRecentFact('GOSTA de café gelado'); // já é núcleo → ignorado
    const all = store.getAll();
    assert.equal(all.recentFacts.length, 1);
    assert.equal(all.recentFacts[0].fact, 'começou a jogar Elden Ring');
    assert.equal(all.recentFacts[0].date, '2026-10-24');
    assert.equal(all.recentFacts[0].expiresAt, '2026-10-31'); // hoje + 7 dias
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('getRecentFacts devolve strings válidas e expira após 7 dias', () => {
  const dir = tempDir();
  try {
    const clock = { iso: '2026-10-24T12:00:00.000Z' };
    const store = makeStore(dir, clock);
    store.load();
    store.addRecentFact('começou a jogar Elden Ring');
    // 6 dias depois: ainda visível
    assert.deepEqual(store.getRecentFacts('2026-10-30T23:59:59.000Z'), ['começou a jogar Elden Ring']);
    // 7 dias depois: expirado
    assert.deepEqual(store.getRecentFacts('2026-10-31T00:00:01.000Z'), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('appendHistory mantém máx 8 do dia; dias isolados; clearTodayHistory zera só o dia', () => {
  const dir = tempDir();
  try {
    const clock = { iso: '2026-10-24T12:00:00.000Z' };
    const store = makeStore(dir, clock);
    store.load();
    for (let i = 1; i <= 10; i += 1) store.appendHistory('user', 'msg ' + i, clock.iso);
    const history = store.getTodayHistory('2026-10-24');
    assert.equal(history.length, 8);
    assert.equal(history[0].content, 'msg 3'); // trunca as mais antigas
    assert.equal(history.at(-1).content, 'msg 10');

    // outro dia começa vazio e não vê o anterior
    clock.iso = '2026-10-25T09:00:00.000Z';
    assert.deepEqual(store.getTodayHistory('2026-10-25'), []);
    store.appendHistory('assistant', 'bom dia', clock.iso);
    assert.equal(store.getTodayHistory('2026-10-25').length, 1);
    assert.equal(store.getTodayHistory('2026-10-24').length, 8);

    store.clearTodayHistory('2026-10-25');
    assert.deepEqual(store.getTodayHistory('2026-10-25'), []);
    assert.equal(store.getTodayHistory('2026-10-24').length, 8);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('save/load round-trip preserva tudo e não deixa arquivos tmp', () => {
  const dir = tempDir();
  try {
    const clock = { iso: '2026-10-24T12:00:00.000Z' };
    const store = makeStore(dir, clock);
    store.load();
    store.addCoreFact('tem um gato chamado Mochi');
    store.addRecentFact('está aprendendo three.js');
    store.appendHistory('user', 'oi', '2026-10-24T12:00:01.000Z');
    store.appendHistory('assistant', 'hmph, oi', '2026-10-24T12:00:02.000Z');
    store.save({
      ...store.getAll(),
      affinity: { score: 23, lastDailyGainDate: '2026-10-24', totalDailyGainToday: 3 },
    });

    // nova instância lê o mesmo arquivo (simula restart do servidor)
    const second = makeStore(dir, { iso: '2026-10-24T15:00:00.000Z' });
    const reloaded = second.load();
    assert.deepEqual(reloaded.coreFacts, ['tem um gato chamado Mochi']);
    assert.deepEqual(second.getRecentFacts('2026-10-26T00:00:00.000Z'), ['está aprendendo three.js']);
    assert.equal(reloaded.dailyHistory['2026-10-24'].length, 2);
    assert.equal(reloaded.dailyHistory['2026-10-24'][1].content, 'hmph, oi');
    assert.equal(reloaded.affinity.score, 23);
    assert.equal(reloaded.affinity.lastDailyGainDate, '2026-10-24');
    assert.equal(reloaded.affinity.totalDailyGainToday, 3);
    // escrita atômica: nenhum tmp sobrou da operação
    assert.ok(readdirSync(dir).every((name) => !name.endsWith('.tmp')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('setAffinity faz clamp 0–100 e reseta o contador diário na virada do dia', () => {
  const dir = tempDir();
  try {
    const clock = { iso: '2026-10-24T12:00:00.000Z' };
    const store = makeStore(dir, clock);
    store.load();
    store.setAffinity(150, '2026-10-24');
    assert.equal(store.getAffinity().score, 100);
    store.setAffinity(-7, '2026-10-24');
    assert.equal(store.getAffinity().score, 0);

    // contador do dia preservado quando o dia não muda
    store.save({
      ...store.getAll(),
      affinity: { score: 10, lastDailyGainDate: '2026-10-24', totalDailyGainToday: 4 },
    });
    store.setAffinity(12, '2026-10-24');
    assert.equal(store.getAffinity().score, 12);
    assert.equal(store.getAffinity().totalDailyGainToday, 4);

    // virada de dia zera o contador e move a âncora
    store.setAffinity(14, '2026-10-25');
    const affinity = store.getAffinity();
    assert.equal(affinity.score, 14);
    assert.equal(affinity.totalDailyGainToday, 0);
    assert.equal(affinity.lastDailyGainDate, '2026-10-25');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
