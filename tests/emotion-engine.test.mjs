import test from 'node:test';
import assert from 'node:assert/strict';
import { createExpressionDriver, ATTACK_TAU_MS, RELEASE_TAU_MS } from '../src/expression-driver.js';
import { createEmotionEngine } from '../src/emotion-engine.js';

// Driver real + relógio fake; o wrapper grava as chamadas de set que o engine faz.
function makeHarness() {
  let t = 1000;
  const raw = [];
  const driver = createExpressionDriver({ setRaw: (name, weight) => raw.push([name, weight]), now: () => t });
  const setCalls = [];
  const recorded = {
    set(name, weight, options) { setCalls.push({ name, weight, options }); return driver.set(name, weight, options); },
    update: () => driver.update(),
    releaseAll: () => driver.releaseAll(),
    clear: () => driver.clear(),
    getWeight: name => driver.getWeight(name),
  };
  const engine = createEmotionEngine({ driver: recorded });
  return { engine, driver, setCalls, raw, advance: ms => { t += ms; } };
}

test("apply('happy') aplica o mapa com peso 1 e TTL de 4500 ms", () => {
  const h = makeHarness();
  assert.deepEqual(h.engine.apply({ label: 'happy' }), { applied: true, label: 'happy' });
  assert.equal(h.setCalls.length, 1);
  assert.equal(h.setCalls[0].name, '01-prefab_happy04');
  assert.equal(h.setCalls[0].weight, 1);
  assert.equal(h.setCalls[0].options.ttlMs, 4500);
  assert.deepEqual(h.driver.active(), [{ name: '01-prefab_happy04', current: 0, target: 1 }]);
});

test('a intensidade escala o peso do mapa e passa por clamp01', () => {
  const h = makeHarness();
  h.engine.apply({ label: 'happy', intensity: 0.5, durationMs: 2000 });
  assert.equal(h.setCalls[0].weight, 0.5);
  assert.equal(h.setCalls[0].options.ttlMs, 2000, 'duração personalizada é repassada');
  h.engine.apply({ label: 'happy', intensity: 7 });
  assert.equal(h.setCalls[1].weight, 1, 'intensidade > 1 vira 1');
});

test('label desconhecido, ausente ou neutral libera tudo como neutral', () => {
  const h = makeHarness();
  h.engine.apply({ label: 'happy' });
  assert.equal(h.driver.active().length, 1);
  assert.deepEqual(h.engine.apply({ label: 'nao-existe' }), { applied: true, label: 'neutral' });
  assert.equal(h.driver.active()[0].target, 0, 'releaseAll derrubou o alvo');
  assert.deepEqual(h.engine.apply({}), { applied: true, label: 'neutral' });
  assert.deepEqual(h.engine.apply({ label: 'neutral' }), { applied: true, label: 'neutral' });
});

test('blinkMultiplier suprime o blink com expressão de olhos fechados ativa', () => {
  const h = makeHarness();
  assert.equal(h.engine.blinkMultiplier(), 1, 'nada ativo: blink livre');
  h.engine.apply({ label: 'happy' }); // happy fecha os olhos no mapa
  for (let step = 0; step < 6; step++) { h.advance(ATTACK_TAU_MS); h.engine.update(); }
  const weight = h.driver.getWeight('01-prefab_happy04');
  assert.ok(weight > 0.95, `peso da expressão ~1 (obtido ${weight})`);
  assert.ok(h.engine.blinkMultiplier() < 0.1, 'blink quase totalmente suprimido');
  h.engine.apply({ label: 'neutral' });
  for (let step = 0; step < 30; step++) { h.advance(RELEASE_TAU_MS); h.engine.update(); }
  assert.equal(h.engine.blinkMultiplier(), 1, 'blink volta após decair e limpar');
});

test("apply('soft') usa o peso 0.6 do mapa e a intensidade multiplica", () => {
  const h = makeHarness();
  h.engine.apply({ label: 'soft' });
  assert.equal(h.setCalls[0].name, '12-prefab_sad01');
  assert.equal(h.setCalls[0].weight, 0.6);
  h.engine.apply({ label: 'soft', intensity: 0.5 });
  assert.equal(h.setCalls[1].weight, 0.3);
});

test('reset limpa o driver imediatamente (setRaw 0 e sem entries)', () => {
  const h = makeHarness();
  h.engine.apply({ label: 'happy' });
  h.advance(ATTACK_TAU_MS);
  h.engine.update();
  assert.equal(h.driver.active().length, 1);
  h.engine.reset();
  assert.deepEqual(h.driver.active(), []);
  const last = h.raw[h.raw.length - 1];
  assert.deepEqual(last, ['01-prefab_happy04', 0]);
});

test('label conhecido sem expressões apenas libera (mapa customizado)', () => {
  let t = 1000;
  const driver = createExpressionDriver({ setRaw: () => {}, now: () => t });
  const engine = createEmotionEngine({
    driver,
    map: { neutral: { expressions: {}, eyesClosed: false }, blank: { expressions: {}, eyesClosed: false } },
  });
  driver.set('01-prefab_happy04', 1);
  assert.deepEqual(engine.apply({ label: 'blank' }), { applied: true, label: 'blank' });
  assert.equal(driver.active()[0].target, 0);
  assert.equal(engine.blinkMultiplier(), 1, 'sem eyesClosed no mapa o blink não é suprimido');
});
