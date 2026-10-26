import test from 'node:test';
import assert from 'node:assert/strict';
import { splitReplyParts } from '../src/reply-parts.js';

// O invariante central: splitReplyParts nunca descarta texto. Comparar com
// os caracteres não-espaços é mais forte que `parts.join(' ')` — cobriria
// também os espaços extras introduzidos no empacotamento e nas junções.
const keptChars = parts => parts.join('').replace(/\s+/g, '');
const sourceChars = text => String(text ?? '').replace(/\s+/g, '');

test('texto vazio ou só espaço vira lista vazia', () => {
  assert.deepEqual(splitReplyParts(''), []);
  assert.deepEqual(splitReplyParts('   \n  '), []);
  assert.deepEqual(splitReplyParts(null), []);
  assert.deepEqual(splitReplyParts(undefined), []);
});

test('resposta curta e frases curtas viram um único balão', () => {
  assert.deepEqual(splitReplyParts('Oi! Tudo bem?'), ['Oi! Tudo bem?']);
  assert.deepEqual(
    splitReplyParts('Amana o guarda-chuva. Vai chover hoje?'),
    ['Amana o guarda-chuva. Vai chover hoje?'],
  );
});

test('quebra nas fronteiras de frase (. ! ? … newline) e empacota até maxChars', () => {
  const reply = 'Primeira frase bem explicada aqui. Segunda frase vem depois! Terceira pergunta? Quarta... quinta final.';
  const parts = splitReplyParts(reply);
  assert.ok(parts.length >= 2, `esperava múltiplas partes, veio ${parts.length}`);
  assert.ok(parts.every(part => part.length <= 60));
  assert.ok(parts[0].startsWith('Primeira frase'));
  assert.equal(keptChars(parts), sourceChars(reply));
});

test('frase gigante sem delimitador é cortada em fronteira de palavra', () => {
  const words = Array.from({ length: 40 }, (_, index) => `palavra${index}`);
  const reply = words.join(' '); // ~430 chars, sem nenhum ponto
  const parts = splitReplyParts(reply, { maxChars: 60, maxParts: 50 });
  assert.ok(parts.length > 5);
  assert.ok(parts.every(part => part.length <= 60), 'nenhum pedaço passa de maxChars');
  // fronteiras de palavra: nenhum pedaço termina no meio de "palavraN"
  for (const part of parts) assert.ok(/(^|\s)palavra\d+$/.test(part), part);
  assert.equal(keptChars(parts).length, sourceChars(reply).length);
  assert.deepEqual(keptParts(parts), keptWords(words));
});

const keptParts = parts => parts.join(' ').split(/\s+/).filter(Boolean);
const keptWords = words => words.join(' ').split(/\s+/).filter(Boolean);

test('palavra única maior que maxChars é fatiada sem perder caracteres', () => {
  const reply = `a${'x'.repeat(150)}b.`;
  const parts = splitReplyParts(reply, { maxChars: 30 });
  assert.ok(parts.length >= 5);
  assert.equal(keptChars(parts), sourceChars(reply));
});

test('acima de maxParts a última parte absorve o resto (nunca descarte)', () => {
  const sentences = Array.from({ length: 10 }, (_, index) => `Frase ${index} completa.`);
  // cada frase tem ~18 chars; duas não cabem juntas em maxChars=25 → 10 partes
  const parts = splitReplyParts(sentences.join(' '), { maxChars: 25, maxParts: 5 });
  // as partes 0..3 ficam isoladas e a quinta absorve as frases 4..9
  assert.equal(parts.length, 5);
  assert.ok(parts[0].startsWith('Frase 0'));
  // a última parte carrega TODAS as frases restantes (4..9)
  for (let index = 4; index < 10; index += 1) {
    assert.ok(parts[4].includes(`Frase ${index} completa.`), `faltou a frase ${index}`);
  }
  assert.equal(keptChars(parts), sourceChars(sentences.join(' ')));
});

test('maxParts = 1 vira um balão só com o texto inteiro', () => {
  const reply = 'Uma. Duas. Três. Quatro.';
  const parts = splitReplyParts(reply, { maxParts: 1 });
  assert.equal(parts.length, 1);
  assert.equal(keptChars(parts), sourceChars(reply));
});

test('quebra de linha também é fronteira de frase', () => {
  const parts = splitReplyParts('Linha um\nLinha dois', { maxChars: 10, maxParts: 5 });
  assert.deepEqual(parts, ['Linha um', 'Linha dois']);
});

test('execução de pontuação não vira balão picotado (regressão do chat)', () => {
  // Observado na tela: "C-cobaia? !" e "cobaias. . ." — cada caractere de
  // pontuação virava uma fronteira própria.
  const parts = splitReplyParts('C-cobaia?! Eu sou uma coelha, b-baka! Coelhos são perfeitos... muito melhores que cobaias. Hmph!');
  assert.ok(parts.every(part => !/[.!?] [.!?]/.test(part)), JSON.stringify(parts));
  assert.ok(!parts.some(part => /^\s*[.!?]/.test(part)), JSON.stringify(parts));
  assert.equal(keptChars(parts), sourceChars('C-cobaia?! Eu sou uma coelha, b-baka! Coelhos são perfeitos... muito melhores que cobaias. Hmph!'));
});

test('opções fora do intervalo caem nos padrões (60 / 5)', () => {
  const reply = Array.from({ length: 12 }, (_, index) => `Frase ${index}.`).join(' ');
  const parts = splitReplyParts(reply, { maxChars: 0, maxParts: -3 });
  assert.ok(parts.length <= 5);
  assert.ok(parts.slice(0, -1).every(part => part.length <= 60));
  assert.equal(keptChars(parts), sourceChars(reply));
});
