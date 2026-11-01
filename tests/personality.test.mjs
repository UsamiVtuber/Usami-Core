import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createPersonalityStore, defaultPersonality, normalizePersonality, buildTraitGuidance,
  sanitizeCustomPrompt, isNeutral, CUSTOM_PROMPT_MAX, PERSONALITY_FILE,
} from '../src/personality-store.js';
import { buildPersona } from '../src/persona.js';

// Isola o depósito de módulo do server.mjs antes do import (nunca toca em data/).
process.env.USAMI_DATA_DIR = mkdtempSync(join(tmpdir(), 'usami-personality-mod-'));
const { createPersonalityHandler } = await import('../server.mjs');

const TOKEN = 'token-de-teste';
const tmp = () => mkdtempSync(join(tmpdir(), 'usami-personality-'));

test('padrão é neutro e não gera instrução', () => {
  const value = defaultPersonality();
  assert.ok(isNeutral(value));
  assert.equal(buildTraitGuidance(value), '');
});

test('normalize: clampa, arredonda e cai no neutro com lixo', () => {
  const value = normalizePersonality({ traits: { warmth: 250, curiosity: -3, playfulness: 'abc', pride: 70.6, extra: 9 }, customPrompt: 42 });
  assert.equal(value.traits.warmth, 100);
  assert.equal(value.traits.curiosity, 0);
  assert.equal(value.traits.playfulness, 50);
  assert.equal(value.traits.pride, 71);
  assert.equal('extra' in value.traits, false);
  assert.equal(value.customPrompt, '');
  assert.deepEqual(normalizePersonality(null), defaultPersonality());
});

test('sanitize tira controles, limita o tamanho e preserva quebras', () => {
  assert.equal(sanitizeCustomPrompt('oi\u0000\u0007 mundo\r\n\n\n\nfim'), 'oi mundo\n\nfim');
  assert.equal(sanitizeCustomPrompt('x'.repeat(CUSTOM_PROMPT_MAX + 50)).length, CUSTOM_PROMPT_MAX);
});

test('guidance só inclui traços fora da zona neutra, com intensidade', () => {
  const text = buildTraitGuidance({ traits: { warmth: 90, pride: 38, curiosity: 55 }, customPrompt: 'fale de coelhos' });
  assert.match(text, /Carinho \(muito acima/);
  assert.match(text, /Orgulho \(tsundere\) \(um pouco abaixo/);
  assert.doesNotMatch(text, /Curiosidade/);
  assert.match(text, /fale de coelhos/);
});

test('persona sem ajustes é idêntica à anterior; com ajustes ganha o bloco', () => {
  const base = { affinity: 30, date: '2026-11-01', timeOfDay: 'noite' };
  assert.equal(buildPersona({ ...base, personality: defaultPersonality() }), buildPersona(base));
  const adjusted = buildPersona({ ...base, personality: { traits: { playfulness: 95 } } });
  assert.match(adjusted, /=== AJUSTES DE PERSONALIDADE/);
  assert.match(adjusted, /sem mudar o formato JSON/);
  assert.match(adjusted, /Brincadeira \(muito acima/);
  // O bloco entra antes dos fatos/contexto, nunca depois do CONTEXTO AGORA.
  assert.ok(adjusted.indexOf('AJUSTES DE PERSONALIDADE') < adjusted.indexOf('CONTEXTO AGORA'));
});

test('store: salva atomicamente, recarrega e reseta; arquivo corrompido volta ao padrão', () => {
  const dir = tmp();
  const store = createPersonalityStore({ dataDir: dir });
  store.save({ traits: { warmth: 80 }, customPrompt: 'me chame de capitão' });
  const reloaded = createPersonalityStore({ dataDir: dir });
  assert.equal(reloaded.load().traits.warmth, 80);
  assert.equal(reloaded.get().customPrompt, 'me chame de capitão');
  reloaded.reset();
  assert.ok(isNeutral(reloaded.get()));
  writeFileSync(join(dir, PERSONALITY_FILE), '{ não é json', 'utf8');
  assert.deepEqual(createPersonalityStore({ dataDir: dir }).load(), defaultPersonality());
  assert.throws(() => createPersonalityStore({}), /dataDir/);
});

function mockReq({ method = 'GET', headers = {}, body = '', url = '/api/personality' } = {}) {
  const chunks = body ? [Buffer.from(body)] : [];
  return {
    method, url,
    headers: { host: '127.0.0.1:8787', 'x-usami-token': TOKEN, ...headers },
    async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk; },
  };
}
async function call(handler, req) {
  const res = { statusCode: null, body: '' };
  res.writeHead = status => { res.statusCode = status; };
  res.end = data => { res.body = data; };
  await handler(req, res);
  return { status: res.statusCode, data: JSON.parse(res.body) };
}
const post = (payload, headers = {}) => mockReq({ method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(payload) });

test('API: exige token, origem e Content-Type; GET devolve ajustes e catálogo', async () => {
  const dir = tmp();
  const store = createPersonalityStore({ dataDir: dir });
  const handler = createPersonalityHandler({ personalityStore: store, apiToken: TOKEN });

  assert.equal((await call(handler, mockReq({ headers: { 'x-usami-token': 'errado' } }))).status, 401);
  assert.equal((await call(createPersonalityHandler({ personalityStore: store, apiToken: '' }), mockReq())).status, 503);
  assert.equal((await call(handler, mockReq({ headers: { origin: 'https://evil.example' } }))).status, 403);
  assert.equal((await call(handler, mockReq({ method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' }))).status, 403);

  const { status, data } = await call(handler, mockReq());
  assert.equal(status, 200);
  assert.deepEqual(data.traits.map(trait => trait.key), ['warmth', 'curiosity', 'playfulness', 'pride']);
  assert.equal(data.customPromptMax, CUSTOM_PROMPT_MAX);
  assert.ok(isNeutral(data.personality));
});

test('API: POST valida, persiste e reset volta ao padrão', async () => {
  const dir = tmp();
  const store = createPersonalityStore({ dataDir: dir });
  const handler = createPersonalityHandler({ personalityStore: store, apiToken: TOKEN });

  const saved = await call(handler, post({ traits: { warmth: 999, pride: 10 }, customPrompt: 'oi\u0000' }));
  assert.equal(saved.status, 200);
  assert.equal(saved.data.personality.traits.warmth, 100);
  assert.equal(saved.data.personality.traits.pride, 10);
  assert.equal(saved.data.personality.customPrompt, 'oi');
  assert.equal(JSON.parse(readFileSync(join(dir, PERSONALITY_FILE), 'utf8')).traits.warmth, 100);

  assert.equal((await call(handler, mockReq({ method: 'POST', headers: { 'content-type': 'application/json' }, body: '{quebrado' }))).status, 400);
  assert.equal((await call(handler, post([1, 2]))).status, 400);
  assert.equal((await call(handler, post({ customPrompt: 'x'.repeat(5000) }))).status, 413);

  const reset = await call(handler, post({ reset: true }));
  assert.equal(reset.status, 200);
  assert.ok(isNeutral(reset.data.personality));
  assert.equal(existsSync(join(dir, PERSONALITY_FILE)), true);
});
