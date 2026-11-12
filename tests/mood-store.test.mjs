import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMoodStore, deriveMood } from '../src/mood-store.js';
import { buildPersona } from '../src/persona.js';

test('mood-store evolui e persiste em mood.json com escrita atômica', () => {
  const dir = mkdtempSync(join(tmpdir(), 'usami-mood-store-'));
  let fakeNow = 1_700_000_000_000;
  try {
    const store = createMoodStore({ dataDir: dir, now: () => fakeNow });
    const initial = store.load();
    assert.equal(initial.id, 'soft');
    assert.equal(initial.expression.name, '03-prefab_happy03');

    fakeNow += 5_000;
    const excited = store.recordChatTurn({
      userMessage: 'ganhei um premio!',
      reply: 'Eba!! Que legal!!',
      gesture: 'clap',
      actions: [{ type: 'set_expression', name: '05-prefab_happy05', weight: 0.9 }],
      speechTags: ['casual_happy'],
    });
    assert.equal(excited.id, 'happy');
    assert.equal(excited.label, 'Animada');
    assert.equal(excited.expression.name, '05-prefab_happy05');
    assert.equal(excited.expression.label, 'Feliz radiante');
    assert.equal(excited.timeline.length, 1);

    // Recarregando do disco mantém o humor e histórico
    const reloaded = createMoodStore({ dataDir: dir, now: () => fakeNow }).load();
    assert.equal(reloaded.id, 'happy');
    assert.equal(reloaded.timeline.length, 1);

    // Após ~1h15 em silêncio, a energia decai para sonolenta
    fakeNow += 75 * 60 * 1000;
    const afterIdle = createMoodStore({ dataDir: dir, now: () => fakeNow }).load();
    assert.equal(afterIdle.id, 'sleepy');
    assert.equal(afterIdle.label, 'Sonolenta');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('deriveMood e buildPersona refletem o humor atual no prompt', () => {
  const grumpy = deriveMood({ valence: 25, energy: 70, warmth: 35, lastEmotion: 'angry' });
  assert.equal(grumpy.id, 'grumpy');

  const prompt = buildPersona({
    affinity: 50,
    date: '2026-11-11',
    mood: { label: 'Envergonhada', reason: 'Ficou corada com o elogio.' },
  });
  assert.match(prompt, /=== HUMOR ATUAL ===/);
  assert.match(prompt, /Envergonhada/);
  assert.match(prompt, /Ficou corada com o elogio/);

  const withoutMood = buildPersona({ affinity: 50, date: '2026-11-11' });
  assert.doesNotMatch(withoutMood, /=== HUMOR ATUAL ===/);
});
