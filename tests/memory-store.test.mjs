import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryStore, MEMORY_SECTIONS } from '../src/memory-store.js';

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

test('load() cria o arquivo padrão v2 com seções vazias, score 0 e createdAt de hoje', () => {
  const dir = tempDir();
  try {
    const clock = { iso: '2026-10-24T10:00:00.000Z' };
    const store = makeStore(dir, clock);
    const data = store.load();
    assert.equal(data.version, 2);
    assert.deepEqual(Object.keys(data.sections), MEMORY_SECTIONS);
    assert.ok(MEMORY_SECTIONS.every((section) => data.sections[section].length === 0));
    assert.deepEqual(data.summaries, []);
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

test('addCoreFact grava na seção; dedupe case-insensitive; muda de seção sem duplicar', () => {
  const dir = tempDir();
  try {
    const clock = { iso: '2026-10-24T12:00:00.000Z' };
    const store = makeStore(dir, clock);
    store.load();
    store.addCoreFact('Gosta de café gelado', 'preferences');
    store.addCoreFact('gosta de café GELADO', 'preferences'); // dedupe
    store.addCoreFact('aniversário em 15/03', 'dates');
    assert.deepEqual(store.getSections().preferences, ['Gosta de café gelado']);
    assert.deepEqual(store.getSections().dates, ['aniversário em 15/03']);
    assert.equal(store.getSections().other.length, 0);

    // reclassificar move o fato, nunca duplica entre seções
    store.addCoreFact('Gosta de café gelado', 'user');
    assert.deepEqual(store.getSections().preferences, []);
    assert.deepEqual(store.getSections().user, ['Gosta de café gelado']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cada seção tem teto FIFO próprio', () => {
  const dir = tempDir();
  try {
    const clock = { iso: '2026-10-24T12:00:00.000Z' };
    const store = makeStore(dir, clock);
    store.load();
    for (let i = 1; i <= 13; i += 1) store.addCoreFact('fato ' + i, 'user');
    const facts = store.getSections().user;
    assert.equal(facts.length, 12); // SECTION_LIMITS.user
    assert.equal(facts[0], 'fato 2'); // o mais antigo saiu
    assert.equal(facts.at(-1), 'fato 13');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migra memory.json v1 (coreFacts plano) para a seção other sem perder fatos', () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, 'memory.json'), JSON.stringify({
      version: 1,
      user: { name: 'Lucas', nickname: null, createdAt: '2026-10-01T00:00:00.000Z' },
      coreFacts: ['tem um gato chamado Mochi', 'mora em São Paulo'],
      recentFacts: [{ fact: 'está aprendendo three.js', date: '2026-10-23', expiresAt: '2026-10-30' }],
      dailyHistory: { '2026-10-23': [{ role: 'user', content: 'oi', timestamp: '2026-10-23T10:00:00.000Z' }] },
      affinity: { score: 33, lastDailyGainDate: '2026-10-23', totalDailyGainToday: 2 },
    }));

    const clock = { iso: '2026-10-24T12:00:00.000Z' };
    const store = makeStore(dir, clock);
    const data = store.load();
    assert.equal(data.version, 2);
    assert.deepEqual(data.sections.other, ['tem um gato chamado Mochi', 'mora em São Paulo']);
    assert.equal(data.recentFacts[0].section, 'other');
    assert.equal(data.recentFacts[0].fact, 'está aprendendo three.js');
    assert.equal(data.affinity.score, 33);
    assert.equal(data.user.name, 'Lucas');

    // load() não reescreve o disco; o próximo save consolida em v2
    assert.equal(JSON.parse(readFileSync(join(dir, 'memory.json'), 'utf8')).version, 1);
    store.save(data);
    const onDisk = JSON.parse(readFileSync(join(dir, 'memory.json'), 'utf8'));
    assert.equal(onDisk.version, 2);
    assert.deepEqual(onDisk.sections.other, ['tem um gato chamado Mochi', 'mora em São Paulo']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('addRecentFact grava TTL de 7 dias e a seção; fato que virou núcleo sai do recente', () => {
  const dir = tempDir();
  try {
    const clock = { iso: '2026-10-24T12:00:00.000Z' };
    const store = makeStore(dir, clock);
    store.load();
    store.addRecentFact('começou a jogar Elden Ring', 7, 'hobbies');
    store.addRecentFact('GOSTA de café gelado', 7, 'preferences');
    store.addCoreFact('gosta de café gelado', 'preferences'); // promove

    const all = store.getAll();
    assert.equal(all.recentFacts.length, 1);
    assert.equal(all.recentFacts[0].fact, 'começou a jogar Elden Ring');
    assert.equal(all.recentFacts[0].section, 'hobbies');
    assert.equal(all.recentFacts[0].date, '2026-10-24');
    assert.equal(all.recentFacts[0].expiresAt, '2026-10-31'); // hoje + 7 dias

    // 6 dias depois: ainda visível; 7 dias: expirado
    assert.deepEqual(store.getRecentFacts('2026-10-30T23:59:59.000Z'), ['começou a jogar Elden Ring']);
    assert.deepEqual(store.getRecentFacts('2026-10-31T00:00:01.000Z'), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('summaries: upsert por dia, teto de 14 e delete', () => {
  const dir = tempDir();
  try {
    const clock = { iso: '2026-10-24T12:00:00.000Z' };
    const store = makeStore(dir, clock);
    store.load();
    store.upsertSummary('2026-10-24', 'primeiro resumo');
    store.upsertSummary('2026-10-24', 'resumo corrigido'); // substitui o do dia
    assert.deepEqual(store.getSummaries(), [{ date: '2026-10-24', summary: 'resumo corrigido' }]);

    for (let day = 1; day <= 15; day += 1) {
      const date = '2026-09-' + String(day).padStart(2, '0');
      store.upsertSummary(date, 'resumo ' + day);
    }
    const summaries = store.getSummaries();
    assert.equal(summaries.length, 14);
    assert.equal(summaries.at(-1).date, '2026-10-24');
    assert.equal(summaries[0].date, '2026-09-03'); // os mais antigos saíram

    assert.equal(store.deleteSummary('2026-10-24'), true);
    assert.equal(store.deleteSummary('2026-10-24'), false);
    assert.equal(store.getSummaries().length, 13);
    store.clearSummaries();
    assert.deepEqual(store.getSummaries(), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('exclusões granulares: fato, seção, recente, histórico e reset', () => {
  const dir = tempDir();
  try {
    const clock = { iso: '2026-10-24T12:00:00.000Z' };
    const store = makeStore(dir, clock);
    store.load();
    store.addCoreFact('tem um gato chamado Mochi', 'user');
    store.addCoreFact('gosta de café gelado', 'preferences');
    store.addRecentFact('está aprendendo three.js', 7, 'hobbies');
    store.appendHistory('user', 'oi', clock.iso);
    store.setAffinity(40, '2026-10-24');

    assert.equal(store.deleteFact('user', 'TEM UM GATO chamado mochi'), true);
    assert.equal(store.deleteFact('user', 'não existe'), false);
    assert.deepEqual(store.getSections().user, []);

    assert.equal(store.deleteRecentFact('está aprendendo three.js'), true);
    assert.equal(store.getAll().recentFacts.length, 0);

    assert.equal(store.clearSection('preferences'), 1);
    assert.equal(store.clearSection('preferences'), 0);
    assert.deepEqual(store.getSections().preferences, []);

    assert.equal(store.clearAllHistory(), 1);
    assert.deepEqual(store.getAll().dailyHistory, {});

    store.reset();
    const data = store.getAll();
    assert.equal(data.version, 2);
    assert.equal(data.affinity.score, 0);
    assert.equal(data.user.createdAt, clock.iso); // novo createdAt do reset
    assert.ok(MEMORY_SECTIONS.every((section) => data.sections[section].length === 0));
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

test('save/load round-trip preserva seções, recentes, resumos, histórico e afinidade', () => {
  const dir = tempDir();
  try {
    const clock = { iso: '2026-10-24T12:00:00.000Z' };
    const store = makeStore(dir, clock);
    store.load();
    store.addCoreFact('tem um gato chamado Mochi', 'user');
    store.addCoreFact('gosta de café gelado', 'preferences');
    store.addRecentFact('está aprendendo three.js', 7, 'hobbies');
    store.upsertSummary('2026-10-23', 'conversamos sobre gatos');
    store.appendHistory('user', 'oi', '2026-10-24T12:00:01.000Z');
    store.appendHistory('assistant', 'hmph, oi', '2026-10-24T12:00:02.000Z');
    store.save({
      ...store.getAll(),
      affinity: { score: 23, lastDailyGainDate: '2026-10-24', totalDailyGainToday: 3 },
    });

    // nova instância lê o mesmo arquivo (simula restart do servidor)
    const second = makeStore(dir, { iso: '2026-10-24T15:00:00.000Z' });
    const reloaded = second.load();
    assert.deepEqual(reloaded.sections.user, ['tem um gato chamado Mochi']);
    assert.deepEqual(reloaded.sections.preferences, ['gosta de café gelado']);
    assert.equal(reloaded.recentFacts[0].section, 'hobbies');
    assert.deepEqual(second.getRecentFacts('2026-10-26T00:00:00.000Z'), ['está aprendendo three.js']);
    assert.deepEqual(reloaded.summaries, [{ date: '2026-10-23', summary: 'conversamos sobre gatos' }]);
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
