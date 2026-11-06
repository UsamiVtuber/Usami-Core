import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSurfacePrompt,
  parseSurfaceResponse,
  generateLocalSurfaceReflex,
} from '../src/surface-reflex.js';

test('surface-reflex: buildSurfacePrompt inclui regras e variáveis', () => {
  const prompt = buildSurfacePrompt({ username: 'Lucas', timeOfDay: 'noite' });
  assert.ok(prompt.includes('Lucas'));
  assert.ok(prompt.includes('status: ok'));
  assert.ok(prompt.includes('say+think'));
  assert.ok(prompt.includes('FORMATO OBRIGATÓRIO'));
});

test('surface-reflex: parseSurfaceResponse faz o parse padrão', () => {
  const raw = `status: ok
tone: casual_happy
mode: say+think
gesture: head-scratch
reply: "Hmm, essa pergunta é boa..."`;

  const parsed = parseSurfaceResponse(raw);
  assert.equal(parsed.status, 'ok');
  assert.equal(parsed.tone, 'casual_happy');
  assert.equal(parsed.mode, 'say+think');
  assert.equal(parsed.gesture, 'head-scratch');
  assert.equal(parsed.reply, 'Hmm, essa pergunta é boa...');
});

test('surface-reflex: parseSurfaceResponse lida com not-for-me', () => {
  const raw = `status: not-for-me
tone: casual_neutral
mode: say
reply: Oi fulano`;

  const parsed = parseSurfaceResponse(raw);
  assert.equal(parsed.status, 'not-for-me');
  assert.equal(parsed.reply, '', 'reply deve ser vazio para not-for-me');
});

test('surface-reflex: parseSurfaceResponse resolve emoções desconhecidas', () => {
  const raw = `status: ok
tone: casual_curious
mode: say
reply: Oi!`;

  const parsed = parseSurfaceResponse(raw);
  // curious decai para casual_smile
  assert.equal(parsed.tone, 'casual_smile');
});

test('surface-reflex: generateLocalSurfaceReflex reações rápidas', () => {
  const greeting = generateLocalSurfaceReflex('oi Usami!');
  assert.equal(greeting.mode, 'say');
  assert.equal(greeting.gesture, 'wave');

  const question = generateLocalSurfaceReflex('como funciona o computador?');
  assert.equal(question.mode, 'say+think');
  assert.equal(question.gesture, 'tilt');
});
