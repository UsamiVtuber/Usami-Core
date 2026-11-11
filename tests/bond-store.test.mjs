import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBondStore } from '../src/bond-store.js';

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'usami-bond-store-'));
  const store = createBondStore({ dataDir: dir, now: () => 1000 });
  store.load();
  return { dir, store };
}

test('awardChat aplica os deltas da resposta e persiste no disco', () => {
  const { dir, store } = scratch();
  try {
    const result = store.awardChat('oi, tudo bem?');
    assert.deepEqual(result.intimacy, { carinho: 1, humor: 0, companhia: 0 });
    assert.equal(result.gains.carinho, 1);
    assert.equal(result.event.kind, 'chat');
    assert.equal(result.event.text, 'Vocês conversaram');
    assert.equal(result.changed, true);
    assert.equal(result.summary.level, 1);

    const reloaded = createBondStore({ dataDir: dir });
    reloaded.load();
    assert.deepEqual(reloaded.getAll().intimacy, { carinho: 1, humor: 0, companhia: 0 });
    assert.equal(reloaded.getAll().log.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('risada e conversa longa/voz ganham humor e companhia; o texto nunca é guardado', () => {
  const { dir, store } = scratch();
  try {
    const laugh = store.awardChat('kkkk que demais');
    assert.equal(laugh.gains.humor, 2);
    assert.equal(laugh.event.kind, 'laugh');
    assert.equal(laugh.event.text, 'Vocês riram juntos');

    const long = store.awardChat('x'.repeat(130));
    assert.equal(long.gains.companhia, 2);
    assert.equal(long.event.kind, 'long');

    const spoken = store.awardChat('oi', { spoken: true });
    assert.equal(spoken.gains.companhia, 2);
    assert.equal(spoken.event.kind, 'voice');

    const raw = JSON.stringify(store.getAll());
    assert.ok(!raw.includes('kkkk'), 'conteúdo da conversa não vaza no histórico');
    assert.ok(!raw.includes('xxx'), 'texto longo não vaza no histórico');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('momentos iguais no mesmo instante agrupam com contador', () => {
  const { dir, store } = scratch();
  try {
    store.awardChat('oi');
    const second = store.awardChat('oi');
    assert.equal(second.log.length, 1);
    assert.equal(second.log[0].count, 2);
    assert.deepEqual(second.log[0].gains, { carinho: 2 });
    assert.equal(second.intimacy.carinho, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('subida de nível vira momento no topo do histórico', () => {
  const { dir, store } = scratch();
  try {
    store.importState({ intimacy: { carinho: 24 }, log: [] });
    const level = store.awardChat('oi');
    assert.equal(level.summary.level, 2);
    assert.equal(level.summary.name, 'Amigos Próximos');
    assert.equal(level.levelEvent.kind, 'level');
    assert.equal(level.levelEvent.text, 'Vínculo subiu para Nv.2 · Amigos Próximos');
    assert.equal(level.log[0].kind, 'level');
    assert.equal(level.log[1].kind, 'chat');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('o teto de 999 segura o XP e a resposta no teto não conta como mudança', () => {
  const { dir, store } = scratch();
  try {
    store.importState({ intimacy: { carinho: 998 }, log: [{ kind: 'chat', text: 'Vocês conversaram', at: 900 }] });
    const full = store.awardChat('oi');
    assert.equal(full.intimacy.carinho, 999);
    assert.equal(full.changed, true);

    const again = store.awardChat('oi');
    assert.equal(again.intimacy.carinho, 999);
    assert.equal(again.changed, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('importState só migra quando o core está vazio e higieniza o histórico', () => {
  const { dir, store } = scratch();
  try {
    const first = store.importState({
      intimacy: { carinho: 40, humor: 9999, companhia: -3 },
      log: [{ kind: 'chat', text: 'Vocês conversaram', at: 900, gains: { carinho: 2, bogus: 1 } }, { kind: 'inventado' }],
    });
    assert.equal(first.imported, true);
    assert.deepEqual(first.intimacy, { carinho: 40, humor: 999, companhia: 0 });
    assert.equal(first.log.length, 1);
    assert.deepEqual(first.log[0].gains, { carinho: 2 });

    const second = store.importState({ intimacy: { carinho: 1 }, log: [] });
    assert.equal(second.imported, false);
    assert.equal(second.intimacy.carinho, 40, 'o core já tinha dados; nada foi sobrescrito');

    const empty = createBondStore({ dataDir: join(dir, 'vazio') });
    empty.load();
    assert.equal(empty.importState({ intimacy: {}, log: [] }).imported, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reset zera medidores e histórico e grava no disco', () => {
  const { dir, store } = scratch();
  try {
    store.awardChat('oi');
    const cleared = store.reset();
    assert.deepEqual(cleared.intimacy, { carinho: 0, humor: 0, companhia: 0 });
    assert.deepEqual(cleared.log, []);
    const reloaded = createBondStore({ dataDir: dir });
    reloaded.load();
    assert.equal(reloaded.isEmpty(), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('conteúdo vazio não gera XP nem momento', () => {
  const { dir, store } = scratch();
  try {
    const result = store.awardChat('   ');
    assert.equal(result.changed, false);
    assert.equal(result.event, null);
    assert.deepEqual(result.intimacy, { carinho: 0, humor: 0, companhia: 0 });
    assert.equal(result.log.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
