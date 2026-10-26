import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { extractJsonCandidate } from '../src/json-salvage.js';

test('extrai o objeto quando o modelo escreve prosa antes do JSON', () => {
  const raw = 'The user wants me to animate. Available expressions:\n- "16-prefab_awkward02" fits\n\n{"actions":[{"type":"set_expression","name":"16-prefab_awkward02","weight":1}]}';
  assert.deepEqual(JSON.parse(extractJsonCandidate(raw)), {
    actions: [{ type: 'set_expression', name: '16-prefab_awkward02', weight: 1 }],
  });
});

test('chaves aninhadas fecham no balanceamento, não na primeira chave', () => {
  assert.equal(extractJsonCandidate('{"a":{"b":{"c":1}}} sobra'), '{"a":{"b":{"c":1}}}');
});

test('chaves e colchetes dentro de string não contam para o balanceamento', () => {
  assert.equal(extractJsonCandidate('{"reply":"olá {mundo} [tudo]","gesture":"neutral"}'), '{"reply":"olá {mundo} [tudo]","gesture":"neutral"}');
  assert.equal(extractJsonCandidate('{"reply":"aspas \\" escapadas \\"} ainda dentro"}'), '{"reply":"aspas \\" escapadas \\"} ainda dentro"}');
});

test('objeto que nunca fecha (corte no max_tokens) devolve null', () => {
  assert.equal(extractJsonCandidate('{"reply":"oi","actions":[{"type":"set_expression"'), null);
});

test('sem chave alguma devolve null', () => {
  assert.equal(extractJsonCandidate('oi, tudo bem?'), null);
  assert.equal(extractJsonCandidate(''), null);
  assert.equal(extractJsonCandidate(null), null);
  assert.equal(extractJsonCandidate(undefined), null);
});
