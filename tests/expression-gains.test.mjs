import test from 'node:test';
import assert from 'node:assert/strict';
import { FACE_P90_MM, REFERENCE_P90_MM, MAX_BOOST, MAX_CUT, gainFor, buildExpressionGains } from '../src/expression-gains.js';

test('a régua cobre as 20 expressões curadas do shiro', () => {
  assert.equal(Object.keys(FACE_P90_MM).length, 20);
  for (const value of Object.values(FACE_P90_MM)) assert.ok(Number.isFinite(value) && value > 0);
});

test('referência é a mediana da régua', () => {
  const sorted = Object.values(FACE_P90_MM).sort((a, b) => a - b);
  const median = (sorted[9] + sorted[10]) / 2;
  assert.equal(REFERENCE_P90_MM, median);
});

test('nome sem medição não mexe no peso (outro modelo, outra expressão)', () => {
  assert.equal(gainFor('blink'), 1);
  assert.equal(gainFor('21-prefab_emoji'), 1);
  assert.equal(gainFor(undefined), 1);
});

test('equalização: a dispersão medida cai para perto de 1 ordem de grandeza', () => {
  const before = Object.values(FACE_P90_MM);
  const after = Object.entries(FACE_P90_MM).map(([name, mm]) => mm * gainFor(name));
  assert.ok(Math.max(...before) / Math.min(...before) > 50, 'a régua mede uma dispersão enorme');
  // As expressões que sobram do recorte de ganho ficam na referência; as que
  // esbarram no teto continuam fracas — ganho não cria movimento que não existe.
  const mid = after.filter(value => value > 0.9);
  assert.ok(Math.max(...mid) / Math.min(...mid) < 10, `faixa equalizada: ${Math.min(...mid).toFixed(1)}–${Math.max(...mid).toFixed(1)} mm`);
});

test('extremos da régua batem nos limites de ganho', () => {
  assert.equal(gainFor('09-prefab_angry03'), MAX_BOOST, 'a mais fraca satura no teto de boost');
  assert.ok(gainFor('11-prefab_angry05') >= MAX_CUT && gainFor('11-prefab_angry05') < 0.3, 'a mais forte é cortada');
  assert.ok(gainFor('02-prefab_happy02') > 1 && gainFor('02-prefab_happy02') < 1.3);
});

test('buildExpressionGains só entrega nomes medidos e diferentes de 1', () => {
  const gains = buildExpressionGains(['08-prefab_angry02', 'blink', '21-prefab_emoji', null, 7, '17-prefab_awkward03']);
  assert.deepEqual(Object.keys(gains).sort(), ['08-prefab_angry02', '17-prefab_awkward03'].sort());
  assert.ok(gains['08-prefab_angry02'] < 0.3);
  assert.ok(Math.abs(gains['17-prefab_awkward03'] - 1) < 0.05, 'quase na referência: ganho ~1 some da tabela');
  assert.deepEqual(buildExpressionGains(undefined), {});
});

test('referência alternativa recalibra sem editar a régua', () => {
  assert.equal(gainFor('11-prefab_angry05', { reference: 49.2 }), 1);
  assert.equal(gainFor('11-prefab_angry05', { reference: 300 }), MAX_BOOST);
});

