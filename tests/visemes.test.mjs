import test from 'node:test';
import assert from 'node:assert/strict';
import { planVisemes } from '../src/visemes.js';

test('vogais mapeiam para visemes e neutros apenas avançam', () => {
  // 'casa' -> c: 0-55 (neutro), a: 55-110, s: 110-165 (neutro), a: 165-220
  const { items, totalMs } = planVisemes('casa');
  assert.deepEqual(items, [
    { name: 'a', at: 55, hold: 55 },
    { name: 'a', at: 165, hold: 55 },
  ]);
  assert.equal(totalMs, 220);
});

test('chars consecutivos do mesmo viseme fundem em um item', () => {
  const { items, totalMs } = planVisemes('aa');
  assert.deepEqual(items, [{ name: 'a', at: 0, hold: 110 }]);
  assert.equal(totalMs, 110);
});

test('gap e consoante neutra quebram a fusão', () => {
  // 'a a': a em 0, espaço avança 40, a em 95
  assert.deepEqual(planVisemes('a a').items, [
    { name: 'a', at: 0, hold: 55 },
    { name: 'a', at: 95, hold: 55 },
  ]);
  // 'aba': b neutro avança 55, então os dois 'a' ficam separados
  assert.deepEqual(planVisemes('aba').items, [
    { name: 'a', at: 0, hold: 55 },
    { name: 'a', at: 110, hold: 55 },
  ]);
});

test('espaços e pontuação avançam gapMs e não emitem viseme', () => {
  // 'oi, tudo bem?': 9 chars faláveis (9 x 55) + 4 gaps (4 x 40) = 655
  const { items, totalMs } = planVisemes('oi, tudo bem?');
  assert.deepEqual(items, [
    { name: 'o', at: 0, hold: 55 },
    { name: 'I', at: 55, hold: 55 },
    { name: 'u', at: 245, hold: 55 },
    { name: 'o', at: 355, hold: 55 },
    { name: 'e', at: 505, hold: 55 },
  ]);
  assert.equal(totalMs, 655);
});

test('texto vazio retorna items [] e totalMs 0 mesmo com startMs', () => {
  assert.deepEqual(planVisemes(''), { items: [], totalMs: 0 });
  assert.deepEqual(planVisemes('', { startMs: 300 }), { items: [], totalMs: 0 });
});

test('acentos e maiúsculas dobram para o viseme da vogal base', () => {
  // 'mã': m neutro em 0-55, ã vira item 'a'
  assert.deepEqual(planVisemes('mã').items, [{ name: 'a', at: 55, hold: 55 }]);
  assert.deepEqual(planVisemes('õ').items, [{ name: 'o', at: 0, hold: 55 }]);
  assert.deepEqual(planVisemes('í').items, [{ name: 'I', at: 0, hold: 55 }]);
  assert.deepEqual(planVisemes('é').items, [{ name: 'e', at: 0, hold: 55 }]);
  assert.deepEqual(planVisemes('ú').items, [{ name: 'u', at: 0, hold: 55 }]);
  assert.deepEqual(planVisemes('BI').items, [{ name: 'I', at: 55, hold: 55 }]);
});

test('startMs desloca os timestamps sem mudar a duração falada', () => {
  const { items, totalMs } = planVisemes('casa', { startMs: 100 });
  assert.deepEqual(items, [
    { name: 'a', at: 155, hold: 55 },
    { name: 'a', at: 265, hold: 55 },
  ]);
  assert.equal(totalMs, 220);
});

test('charMs e gapMs customizados respeitam a matemática do timeline', () => {
  // 'oi!': o (10) + i (10) + '!' gap (5)
  const { items, totalMs } = planVisemes('oi!', { charMs: 10, gapMs: 5 });
  assert.deepEqual(items, [
    { name: 'o', at: 0, hold: 10 },
    { name: 'I', at: 10, hold: 10 },
  ]);
  assert.equal(totalMs, 25);
});

test('função é pura: repetições dão o mesmo plano e a entrada não muda', () => {
  const text = 'ãÃ oI';
  const first = planVisemes(text);
  const second = planVisemes(text);
  assert.deepEqual(first, second);
  assert.equal(text, 'ãÃ oI');
});
