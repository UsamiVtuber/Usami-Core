import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { applyFacsToDriver } from '../src/facs-apply.js';

function fakeDriver() {
  const sets = [];
  return {
    set: (name, weight, options) => { sets.push({ name, weight, options }); return true; },
    sets,
  };
}

test('facs-apply: entrada vazia não aplica nada', () => {
  const driver = fakeDriver();
  const result = applyFacsToDriver([], 1, driver);
  assert.equal(result.applied, 0);
  assert.deepEqual(result.weights, {});
  assert.equal(driver.sets.length, 0);
});

test('facs-apply: AU6 e AU12 mapeiam para happy02 com pesos corretos', () => {
  const driver = fakeDriver();
  const aus = [
    { au: 'AU6', intensity: 1 },
    { au: 'AU12', intensity: 1 },
  ];
  const result = applyFacsToDriver(aus, 1, driver);
  assert.equal(result.applied, 1); // AU6 e AU12 mapeiam para a mesma expressão (02-prefab_happy02)
  const happy02 = driver.sets.find(s => s.name === '02-prefab_happy02');
  assert.ok(happy02, '02-prefab_happy02 deve ser aplicada');
  assert.equal(happy02.weight, 0.8); // max(0.6*1, 0.8*1) = 0.8
  assert.equal(happy02.options.ttlMs, 4000);
});

test('facs-apply: AU4 mapeia para angry02', () => {
  const driver = fakeDriver();
  const result = applyFacsToDriver([{ au: 'AU4', intensity: 1 }], 1, driver);
  assert.equal(result.applied, 1);
  const angry02 = driver.sets.find(s => s.name === '08-prefab_angry02');
  assert.ok(angry02);
  assert.equal(angry02.weight, 0.8);
});

test('facs-apply: intensidade reduz o peso da expressão', () => {
  const driver = fakeDriver();
  applyFacsToDriver([{ au: 'AU12', intensity: 1 }], 0.5, driver);
  const happy02 = driver.sets.find(s => s.name === '02-prefab_happy02');
  assert.equal(happy02.weight, 0.4); // 0.8 * 1 * 0.5
});

test('facs-apply: sem driver não aplica nada', () => {
  const result = applyFacsToDriver([{ au: 'AU12', intensity: 1 }], 1, null);
  assert.equal(result.applied, 0);
});

test('facs-apply: driver sem set não aplica nada', () => {
  const result = applyFacsToDriver([{ au: 'AU12', intensity: 1 }], 1, { foo: 'bar' });
  assert.equal(result.applied, 0);
});

test('facs-apply: AU desconhecida é ignorada', () => {
  const driver = fakeDriver();
  const result = applyFacsToDriver([{ au: 'AU99', intensity: 1 }], 1, driver);
  assert.equal(result.applied, 0);
  assert.equal(driver.sets.length, 0);
});
