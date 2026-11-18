import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPersona } from '../src/persona.js';
import { getDailyScene } from '../src/scenes.js';

// Quarta-feira, 16:30 no fuso local. A regressão era o prompt dizer "tarde"
// enquanto a cena vinha da noite: "YYYY-MM-DD" no Date vira meia-noite UTC.
const afternoon = new Date(2026, 10, 18, 16, 30);

test('getDailyScene usa a hora local do instante recebido (sem shift de UTC)', () => {
  const scene = getDailyScene({ date: afternoon });
  assert.equal(scene.slotKey, 'weekday/tarde');
  assert.equal(scene.logicalDateStr, '2026-11-18');
});

test('buildPersona injeta data, faixa do dia, relógio e cena do mesmo instante', () => {
  const prompt = buildPersona({ affinity: 40, username: 'Lucas', now: afternoon });
  assert.match(prompt, /Data: 2026-11-18 \(tarde\), agora são 16:30\./);

  const scene = getDailyScene({ date: afternoon, username: 'Lucas' });
  assert.ok(prompt.includes(`Cena atual: ${scene.currentScene}`));
});
