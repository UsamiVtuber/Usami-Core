import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAchievementsStore } from '../src/achievements-store.js';
import { ACHIEVEMENTS } from '../src/achievements.js';

function scratch(now = () => 1000) {
  const dir = mkdtempSync(join(tmpdir(), 'usami-achievements-store-'));
  const store = createAchievementsStore({ dataDir: dir, now });
  store.load();
  return { dir, store };
}

// Snapshot mínimo no formato devolvido por bondStore.getAll().
const bondWith = log => ({ intimacy: {}, meters: {}, log, updatedAt: '2026-11-10T00:00:00.000Z', summary: { level: 1 } });

test('catálogo tem id, name, description, icon e condição em todos os itens', () => {
  assert.ok(ACHIEVEMENTS.length >= 6, 'o desktop espera pelo menos as 6 badges');
  const ids = new Set();
  for (const achievement of ACHIEVEMENTS) {
    assert.ok(achievement.id && typeof achievement.id === 'string');
    assert.ok(achievement.name && typeof achievement.name === 'string');
    assert.ok(achievement.description && typeof achievement.description === 'string');
    assert.ok(achievement.icon && achievement.icon.length <= 12, 'icon é uma string curta estável');
    assert.equal(typeof achievement.condition, 'function');
    assert.ok(!ids.has(achievement.id), `id duplicado: ${achievement.id}`);
    ids.add(achievement.id);
  }
});

test('reevaluate destrava com a data do evento e persiste no disco', () => {
  const { dir, store } = scratch();
  try {
    const result = store.reevaluate(bondWith([{ kind: 'chat', text: 'Vocês conversaram', at: 5000 }]));
    assert.deepEqual(result.newlyUnlocked, ['primeira-conversa']);
    assert.equal(result.unlocked['primeira-conversa'], new Date(5000).toISOString());

    const reloaded = createAchievementsStore({ dataDir: dir });
    reloaded.load();
    assert.equal(reloaded.getAll().unlocked['primeira-conversa'], new Date(5000).toISOString());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('desbloqueio é idempotente: reavaliação não reescreve unlockedAt', () => {
  const { dir, store } = scratch();
  try {
    store.reevaluate(bondWith([{ kind: 'chat', text: 'Vocês conversaram', at: 5000 }]));
    const again = store.reevaluate(bondWith([
      { kind: 'laugh', text: 'Vocês riram juntos', at: 9000 },
      { kind: 'chat', text: 'Vocês conversaram', at: 5000 },
    ]));
    assert.equal(again.unlocked['primeira-conversa'], new Date(5000).toISOString(), 'unlockedAt original preservado');
    assert.equal(again.newlyUnlocked.includes('primeira-conversa'), false);
    assert.equal(again.newlyUnlocked.includes('risada-juntos'), true, 'só o desbloqueio novo aparece');

    const reloaded = createAchievementsStore({ dataDir: dir });
    reloaded.load();
    assert.equal(reloaded.getAll().unlocked['primeira-conversa'], new Date(5000).toISOString());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reavaliação recupera desbloqueios perdidos a partir do estado (sem hook pontual)', () => {
  const { dir, store } = scratch();
  try {
    // Estado "antigo": a atividade já aconteceu, mas nenhum evento novo chegou.
    const bond = bondWith([
      { kind: 'level', text: 'Vínculo subiu para Nv.2 · Amigos Próximos', at: 8000 },
      { kind: 'call', text: 'Chamada de voz · 5 min', at: 6000 },
      { kind: 'laugh', text: 'Vocês riram juntos', at: 4000 },
    ]);
    bond.summary = { level: 2 };
    const result = store.reevaluate(bond);
    for (const id of ['primeira-conversa', 'risada-juntos', 'na-linha', 'nivel-2']) {
      assert.ok(result.unlocked[id], `${id} destravado pela reavaliação`);
    }
    assert.equal(result.unlocked['nivel-3'], undefined, 'nível ainda não alcançado fica travado');
    assert.equal(result.unlocked['nivel-2'], new Date(8000).toISOString(), 'data vem do evento de nível');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('list devolve o contrato: unlocked boolean e unlockedAt ISO ou null', () => {
  const { dir, store } = scratch();
  try {
    const locked = store.list();
    assert.equal(locked.length, ACHIEVEMENTS.length);
    for (const item of locked) {
      assert.equal(item.unlocked, false);
      assert.equal(item.unlockedAt, null);
      assert.ok('condition' in item === false, 'condição não vaza no contrato');
    }

    store.reevaluate(bondWith([{ kind: 'chat', text: 'Vocês conversaram', at: 5000 }]));
    const first = store.list().find(item => item.id === 'primeira-conversa');
    assert.equal(first.unlocked, true);
    assert.equal(first.unlockedAt, new Date(5000).toISOString());
    assert.ok(first.name && first.description && first.icon);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('normalize descarta ids desconhecidos e unlockedAt inválidos', async () => {
  const { dir, store } = scratch();
  try {
    store.reevaluate(bondWith([{ kind: 'chat', text: 'Vocês conversaram', at: 5000 }]));
    const reloaded = createAchievementsStore({ dataDir: dir });
    reloaded.load();
    reloaded.getAll(); // snapshot carregado

    // Simula um arquivo adulterado/manual com lixo.
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dir, 'achievements.json'), JSON.stringify({
      version: 99,
      unlocked: {
        'primeira-conversa': new Date(5000).toISOString(),
        'conquista-inventada': new Date(7000).toISOString(),
        'risada-juntos': 42,
      },
    }));
    const cleaned = createAchievementsStore({ dataDir: dir });
    cleaned.load();
    assert.deepEqual(cleaned.getAll().unlocked, { 'primeira-conversa': new Date(5000).toISOString() });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
