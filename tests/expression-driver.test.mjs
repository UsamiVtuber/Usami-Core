import test from 'node:test';
import assert from 'node:assert/strict';
import { createExpressionDriver, ATTACK_TAU_MS, RELEASE_TAU_MS, DEFAULT_TTL_MS, EPSILON } from '../src/expression-driver.js';

// Fábrica de harness: relógio fake + setRaw gravador, no idioma dos testes locais.
function makeHarness({ blinkName = null, withSetRaw = true } = {}) {
  let t = 1000;
  const calls = [];
  const driver = createExpressionDriver({
    setRaw: withSetRaw ? (name, weight) => calls.push([name, weight]) : null,
    blinkName,
    now: () => t,
  });
  return {
    driver, calls,
    advance: ms => { t += ms; },
    weightsFor: name => calls.filter(call => call[0] === name).map(call => call[1]),
  };
}

test('constantes exportadas', () => {
  assert.equal(ATTACK_TAU_MS, 60);
  assert.equal(RELEASE_TAU_MS, 160);
  assert.equal(DEFAULT_TTL_MS, 4000);
  assert.equal(EPSILON, 0.01);
});

test('set aplica o alvo e o update interpola subindo com rampa de ataque', () => {
  const h = makeHarness();
  assert.equal(h.driver.set('01-prefab_happy04', 1), true);
  h.driver.update(); // primeiro update: dt = 0, apenas escreve o current inicial
  assert.deepEqual(h.weightsFor('01-prefab_happy04'), [0]);
  for (let step = 0; step < 3; step++) { h.advance(ATTACK_TAU_MS); h.driver.update(); }
  const weights = h.weightsFor('01-prefab_happy04');
  assert.equal(weights.length, 4);
  for (let i = 1; i < weights.length; i++) assert.ok(weights[i] > weights[i - 1], `peso crescente no passo ${i}`);
  assert.ok(weights[weights.length - 1] > 0.5, 'após ~3×ATTACK_TAU_MS o peso passa de 0.5');
  assert.deepEqual(h.driver.active(), [{ name: '01-prefab_happy04', current: weights[weights.length - 1], target: 1 }]);
});

test('após o TTL o alvo vira 0, decai, escreve 0 exato e remove a entry', () => {
  const h = makeHarness();
  h.driver.set('19-prefab_doubt', 1, { ttlMs: 500 });
  for (let step = 0; step < 4; step++) { h.advance(ATTACK_TAU_MS); h.driver.update(); }
  const peak = h.driver.getWeight('19-prefab_doubt');
  assert.ok(peak > 0.9, 'rampa de ataque chegou perto de 1');
  h.advance(300); // t = 1540 > expiresAt = 1500
  h.driver.update();
  assert.equal(h.driver.active()[0].target, 0, 'expirado: alvo zerado');
  const decaying = h.driver.getWeight('19-prefab_doubt');
  assert.ok(decaying > 0 && decaying < peak, 'current caindo na rampa de release');
  let guard = 0;
  while (h.driver.active().length && guard++ < 50) { h.advance(RELEASE_TAU_MS); h.driver.update(); }
  assert.equal(h.driver.active().length, 0, 'entry removida na limpeza');
  const weights = h.weightsFor('19-prefab_doubt');
  assert.equal(weights[weights.length - 1], 0, 'setRaw recebeu 0 exato na limpeza');
  const count = h.calls.length;
  h.advance(5 * RELEASE_TAU_MS);
  h.driver.update();
  assert.equal(h.calls.length, count, 'sem entry o driver não escreve mais');
});

test('weight passa por clamp01: 2 vira 1; <= 0 inicia release preservando o current', () => {
  const h = makeHarness();
  h.driver.set('07-prefab_angry02', 2);
  assert.equal(h.driver.active()[0].target, 1);
  h.advance(ATTACK_TAU_MS);
  h.driver.update();
  const current = h.driver.getWeight('07-prefab_angry02');
  assert.ok(current > 0 && current < 1);
  assert.equal(h.driver.set('07-prefab_angry02', -1), true);
  const entry = h.driver.active()[0];
  assert.equal(entry.target, 0);
  assert.equal(entry.current, current, 'current preservado no release');
  assert.equal(h.driver.set('20-prefab_startled', 0), true, 'release sem entry prévia não quebra');
  assert.equal(h.driver.getWeight('20-prefab_startled'), 0);
  assert.ok(!h.driver.active().some(item => item.name === '20-prefab_startled'), 'release sem entry prévia não cria entry');
});

test('re-set preserva o current e estende o TTL', () => {
  const h = makeHarness();
  h.driver.set('15-prefab_awkward02', 1, { ttlMs: 200 });
  h.advance(ATTACK_TAU_MS);
  h.driver.update();
  const current = h.driver.getWeight('15-prefab_awkward02');
  assert.ok(current > 0.5);
  h.advance(50); // t = 1110; novo expiresAt = 1110 + 1000 = 2110
  assert.equal(h.driver.set('15-prefab_awkward02', 0.8, { ttlMs: 1000 }), true);
  const entry = h.driver.active()[0];
  assert.equal(entry.current, current, 'current preservado no re-set');
  assert.equal(entry.target, 0.8);
  h.advance(150); // t = 1260 > 1200 (TTL antigo), muito antes do novo
  h.driver.update();
  const after = h.driver.active()[0];
  assert.ok(after, 'entry sobrevive ao TTL antigo');
  assert.equal(after.target, 0.8, 'alvo não foi zerado pelo TTL antigo');
});

test('set no blinkName retorna false e não cria entry; outros nomes seguem normais', () => {
  const h = makeHarness({ blinkName: 'Blinking' });
  assert.equal(h.driver.set('Blinking', 1), false);
  assert.deepEqual(h.driver.active(), []);
  assert.equal(h.driver.set('19-prefab_doubt', 1), true);
  h.driver.update();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0][0], '19-prefab_doubt');
});

test('releaseAll decai tudo no update; clear zera imediato e esvazia', () => {
  const h = makeHarness();
  h.driver.set('01-prefab_happy04', 1);
  h.driver.set('07-prefab_angry02', 1);
  h.advance(2 * ATTACK_TAU_MS);
  h.driver.update();
  assert.ok(h.driver.getWeight('01-prefab_happy04') > 0.5);
  assert.ok(h.driver.getWeight('07-prefab_angry02') > 0.5);
  h.driver.releaseAll();
  assert.ok(h.driver.active().every(item => item.target === 0));
  assert.equal(h.calls.length, 2, 'releaseAll não escreve direto no setRaw');
  h.advance(2 * RELEASE_TAU_MS);
  h.driver.update();
  const decaying = h.driver.getWeight('01-prefab_happy04');
  assert.ok(decaying > 0 && decaying < 0.5, 'decai com o tempo, sem salto');
  assert.equal(h.driver.active().length, 2, 'entries ainda presentes durante o decaimento');
  h.driver.clear();
  assert.deepEqual(h.driver.active(), []);
  assert.equal(h.weightsFor('01-prefab_happy04').pop(), 0, 'clear escreve 0 imediato');
  assert.equal(h.weightsFor('07-prefab_angry02').pop(), 0);
  const count = h.calls.length;
  h.driver.update();
  assert.equal(h.calls.length, count, 'após clear o driver não escreve mais');
});

test('sem setRaw o set retorna false e nada quebra', () => {
  const h = makeHarness({ withSetRaw: false });
  assert.equal(h.driver.set('01-prefab_happy04', 1), false);
  assert.deepEqual(h.driver.active(), []);
  h.driver.update();
  h.driver.releaseAll();
  h.driver.clear();
  assert.equal(h.driver.getWeight('01-prefab_happy04'), 0);
});
