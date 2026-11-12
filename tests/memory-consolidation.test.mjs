import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryStore } from '../src/memory-store.js';
import {
  classifyFactDurability,
  consolidateFacts,
  inferFactSection,
} from '../src/memory-consolidation.js';

function makeTempStore(t, iso = '2026-11-11T12:00:00.000Z') {
  const dir = mkdtempSync(join(tmpdir(), 'usami-consolidation-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = createMemoryStore({
    dataDir: dir,
    now: () => iso,
    today: () => iso.slice(0, 10),
  });
  store.load();
  return { dir, store };
}

test('classifyFactDurability separa fatos duráveis de circunstanciais', () => {
  assert.equal(classifyFactDurability('mora em São Paulo', 'user'), 'core');
  assert.equal(classifyFactDurability('prefere chá verde sem açúcar', 'preferences'), 'core');
  assert.equal(classifyFactDurability('toca violão nos fins de semana', 'hobbies'), 'core');
  assert.equal(classifyFactDurability('aniversário em 15/03', 'dates'), 'core');
  assert.equal(classifyFactDurability('está com dor de cabeça hoje', 'other'), 'recent');
  assert.equal(classifyFactDurability('vai viajar nesta semana', 'other'), 'recent');
  assert.equal(classifyFactDurability('almoçou tarde ontem', 'other'), 'recent');
});

test('inferFactSection classifica fatos de other para seções específicas', () => {
  assert.equal(inferFactSection('aniversário em 22/08', 'other'), 'dates');
  assert.equal(inferFactSection('gosta de música lo-fi', 'other'), 'preferences');
  assert.equal(inferFactSection('joga xadrez online', 'other'), 'hobbies');
  assert.equal(inferFactSection('mora em Curitiba e trabalha com design', 'other'), 'user');
  assert.equal(inferFactSection('tem o apelido carinhoso de chefe', 'other'), 'relationship');
  assert.equal(inferFactSection('detalhe genérico sem pista', 'other'), 'other');
  // Seção específica existente é preservada sem force.
  assert.equal(inferFactSection('gosta de café', 'user'), 'user');
  assert.equal(inferFactSection('gosta de café', 'user', { force: true }), 'preferences');
});

test('consolidateFacts rearranja fatos migrados da v1 em other, promove recentes duráveis e poda expirados', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'usami-consolidation-v1-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  writeFileSync(join(dir, 'memory.json'), JSON.stringify({
    version: 1,
    coreFacts: [
      'mora em Belo Horizonte',
      'prefere café sem açúcar',
      'toca piano clássico',
      'aniversário em 04/05',
      'chama de amiga querida',
      'fato neutro antigo 1',
      'fato neutro antigo 2',
      'fato neutro antigo 3',
      'fato neutro antigo 4',
      'fato neutro antigo 5',
    ],
    recentFacts: [
      { fact: 'está cansado hoje', section: 'other', date: '2026-11-01', expiresAt: '2026-11-08' },
      { fact: 'trabalha com engenharia de software', section: 'user', date: '2026-11-10', expiresAt: '2026-11-17' },
      { fact: 'vai sair agora', section: 'other', date: '2026-11-11', expiresAt: '2026-11-18' },
    ],
  }));

  const store = createMemoryStore({
    dataDir: dir,
    now: () => '2026-11-11T12:00:00.000Z',
    today: () => '2026-11-11',
  });
  store.load();

  const result = await consolidateFacts({ store, today: '2026-11-11' });
  assert.equal(result.skipped, false);
  assert.equal(result.prunedExpired, 1);
  assert.equal(result.promoted, 1);
  assert.equal(result.moved, 5);

  const sections = store.getSections();
  assert.ok(sections.user.includes('mora em Belo Horizonte'));
  assert.ok(sections.user.includes('trabalha com engenharia de software'));
  assert.ok(sections.preferences.includes('prefere café sem açúcar'));
  assert.ok(sections.hobbies.includes('toca piano clássico'));
  assert.ok(sections.dates.includes('aniversário em 04/05'));
  assert.ok(sections.relationship.includes('chama de amiga querida'));
  assert.equal(sections.other.length, 5);

  // Overflow limpo após `other` voltar abaixo do teto de 8.
  assert.equal(store.getAll().sectionsOverflow, undefined);

  // Fato circunstancial válido segue em recentFacts; expirado saiu.
  assert.deepEqual(store.getAll().recentFacts.map(item => item.fact), ['vai sair agora']);
});

test('consolidateFacts usa adapter LLM opcional para fatos ambíguos em other e elimina duplicatas normalizadas', async t => {
  const { store } = makeTempStore(t);
  store.addCoreFact('Gosta de cafe gelado!', 'preferences');
  store.addCoreFact('gosta de café gelado', 'user');
  store.addCoreFact('coleciona canecas antigas de viagem', 'other');
  store.addCoreFact('prefere programar de madrugada', 'other');

  const result = await consolidateFacts({
    store,
    today: '2026-11-11',
    consolidateWithLlm: async ({ facts }) => facts.map(fact => ({
      fact,
      section: fact.includes('madrugada') ? 'preferences' : 'hobbies',
    })),
  });

  assert.equal(result.skipped, false);
  assert.ok(result.moved >= 1);
  assert.equal(result.deduplicated, 1);
  const sections = store.getSections();
  assert.equal(sections.preferences.filter(f => f.toLowerCase().includes('caf')).length, 1);
  assert.ok(sections.hobbies.includes('coleciona canecas antigas de viagem'));
});

