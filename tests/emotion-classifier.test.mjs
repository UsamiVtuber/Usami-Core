import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyEmotion, DEFAULT_CONFIDENCE_THRESHOLD } from '../src/emotion-classifier.js';

test('frase feliz em pt-BR classifica como happy com confiança', () => {
  const result = classifyEmotion('Haha, que bom te ver! 😊');
  assert.equal(result.label, 'happy');
  assert.ok(result.confidence >= 0.55);
});

test('intensificadores elevam a intensidade além da base', () => {
  const result = classifyEmotion('Que INCRÍVEL!!! demais');
  assert.equal(result.label, 'happy');
  assert.ok(result.intensity > 0.7);
});

test('frase de saudade classifica como sad', () => {
  const result = classifyEmotion('Sinto muita saudade... 😢');
  assert.equal(result.label, 'sad');
  assert.ok(result.confidence >= 0.55);
});

test('frase sem emoção fica abaixo do limiar (neutro-incerto)', () => {
  const result = classifyEmotion('ok, então combinamos assim');
  assert.ok(result.confidence < 0.55);
  assert.equal(DEFAULT_CONFIDENCE_THRESHOLD, 0.55);
});

test('resposta positiva curta reconhece o sorriso com um único indício', () => {
  for (const phrase of ['Estou bem, obrigada!', 'Tô bem sim!', 'Ótima, obrigada por perguntar.']) {
    const result = classifyEmotion(phrase);
    assert.equal(result.label, 'happy', phrase);
    assert.ok(result.confidence >= DEFAULT_CONFIDENCE_THRESHOLD, phrase);
  }
});

test('negação até 3 tokens antes reduz o peso do match pela metade', () => {
  // Comportamento escolhido: a negação NÃO troca o rótulo (happy segue sendo o
  // maior placar), mas o único match cai de 0.55 para 0.275 — abaixo do
  // threshold, então o reply-emotion não aplica nada e o director segue com
  // as `actions` originais do LLM.
  const negated = classifyEmotion('não estou nada feliz');
  const plain = classifyEmotion('estou feliz');
  assert.equal(negated.label, 'happy');
  assert.ok(negated.confidence < 0.55);
  assert.equal(plain.confidence, 0.55);
  assert.ok(negated.confidence < plain.confidence);
});

test('entrada vazia ou não-string devolve neutral sem crash', () => {
  for (const value of ['', '   ', undefined, null, 42]) {
    assert.deepEqual(classifyEmotion(value), { label: 'neutral', intensity: 0, confidence: 0 });
  }
});

test('classificação é determinística entre chamadas', () => {
  const phrase = 'Haha, que bom! Mas será que ficou legal?';
  assert.deepEqual(classifyEmotion(phrase), classifyEmotion(phrase));
});

test('surpresa pontuada classifica como surprised', () => {
  const result = classifyEmotion('Sério?! Meu deus!');
  assert.equal(result.label, 'surprised');
  assert.ok(result.confidence >= 0.55);
});
