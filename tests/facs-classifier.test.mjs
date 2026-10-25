import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { classifyFacs } from '../src/facs-classifier.js';

test('classifyFacs: entrada vazia retorna sem AUs', () => {
  const result = classifyFacs('');
  assert.deepEqual(result.aus, []);
  assert.equal(result.intensity, 0);
  assert.equal(result.confidence, 0);

  const result2 = classifyFacs(null);
  assert.deepEqual(result2.aus, []);
});

test('classifyFacs: feliz mata AU6 e AU12', () => {
  const result = classifyFacs('estou muito feliz hoje');
  const auNames = result.aus.map(a => a.au);
  assert.ok(auNames.includes('AU6'), 'AU6 (bochecha elevada) esperado');
  assert.ok(auNames.includes('AU12'), 'AU12 (canto da boca elevado) esperado');
  assert.ok(result.confidence > 0, 'confiança deve ser positiva');
});

test('classifyFacs: triste mata AU1 e AU15', () => {
  const result = classifyFacs('estou triste e chorando');
  const auNames = result.aus.map(a => a.au);
  assert.ok(auNames.includes('AU1'), 'AU1 (sobrancelha interna) esperado');
  assert.ok(auNames.includes('AU15'), 'AU15 (canto da boca abaixado) esperado');
});

test('classifyFacs: raiva mata AU4 e AU24', () => {
  const result = classifyFacs('estou brava e irritada com isso');
  const auNames = result.aus.map(a => a.au);
  assert.ok(auNames.includes('AU4'), 'AU4 (sobrancelha abaixada) esperado');
  assert.ok(auNames.includes('AU24'), 'AU24 (lábios apertados) esperado');
});

test('classifyFacs: surpresa mata AU2, AU5, AU25, AU26', () => {
  const result = classifyFacs('nossa, uau, meu deus!');
  const auNames = result.aus.map(a => a.au);
  assert.ok(auNames.includes('AU2'), 'AU2 (sobrancelha externa) esperado');
  assert.ok(auNames.includes('AU5'), 'AU5 (olhos bem abertos) esperado');
});

test('classifyFacs: negação reduz intensidade mas não remove a AU', () => {
  const positivo = classifyFacs('estou feliz');
  const negado = classifyFacs('não estou feliz');
  const auPos = positivo.aus.find(a => a.au === 'AU12');
  const auNeg = negado.aus.find(a => a.au === 'AU12');
  assert.ok(auPos && auNeg, 'AU12 deve aparecer em ambos');
  assert.ok(auNeg.intensity < auPos.intensity, 'negação deve reduzir intensidade');
});

test('classifyFacs: intensificadores elevam intensidade global', () => {
  const normal = classifyFacs('estou feliz');
  const intenso = classifyFacs('estou muito feliz!!!');
  assert.ok(intenso.intensity >= normal.intensity, 'intensificadores devem elevar');
});

test('classifyFacs: sem match retorna confiança 0', () => {
  const result = classifyFacs('oi tudo bem por aqui');
  assert.equal(result.confidence, 0);
  assert.deepEqual(result.aus, []);
});

test('classifyFacs: mesmo input devolve mesmo resultado (determinístico)', () => {
  const a = classifyFacs('estou feliz e animada');
  const b = classifyFacs('estou feliz e animada');
  assert.deepEqual(a, b);
});
