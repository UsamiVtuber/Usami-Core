import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createFileTtsCache,
  createTtsCacheKey,
  normalizeTtsCacheInput,
  resolveTtsCacheMaxBytes,
} from '../src/tts-cache.js';

test('normaliza a chave de TTS sem confundir estilos diferentes', () => {
  const base = { text: '  oi   Usami  ', model: 'gemini-tts', voiceId: 'usami', styleId: 'warm' };
  assert.deepEqual(normalizeTtsCacheInput(base).text, 'oi Usami');
  assert.equal(createTtsCacheKey(base), createTtsCacheKey({ ...base, text: 'oi Usami' }));
  assert.notEqual(createTtsCacheKey(base), createTtsCacheKey({ ...base, styleId: 'playful' }));
  // provider fora do gemini: rate/pitch mudam o áudio pedido e a chave
  assert.notEqual(createTtsCacheKey(base), createTtsCacheKey({ ...base, rate: 1.1 }));
});

test('gemini: rate/pitch não entram na chave (o servidor não os envia ao provedor)', () => {
  const base = { text: 'oi', provider: 'gemini', voiceId: 'usami', styleId: 'warm' };
  assert.equal(createTtsCacheKey(base), createTtsCacheKey({ ...base, rate: 1.4, pitch: 0.7 }));
  // o controle de voz fica fora do objeto normalizado no gemini
  assert.equal('rate' in normalizeTtsCacheInput(base), false);
  assert.equal('pitch' in normalizeTtsCacheInput(base), false);
});

test('cache de arquivo faz round-trip e escreve somente depois de criar a pasta', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'usami-tts-cache-'));
  try {
    const cache = createFileTtsCache({ directory });
    const key = createTtsCacheKey({ text: 'oi', styleId: 'neutral' });
    assert.equal(await cache.get(key), null);
    const audio = Buffer.from([1, 2, 3, 4]);
    assert.equal(await cache.put(key, audio), true);
    assert.deepEqual(await cache.get(key), audio);
    assert.deepEqual(await readFile(join(directory, `${key}.audio`)), audio);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('eviction LRU por bytes: descarta o mais antigo e preserva o recém-escrito', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'usami-tts-cache-'));
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  try {
    const cache = createFileTtsCache({ directory, maxBytes: 10 });
    assert.equal(cache.maxBytes, 10);
    const a = createTtsCacheKey({ text: 'a' });
    const b = createTtsCacheKey({ text: 'b' });
    const c = createTtsCacheKey({ text: 'c' });
    assert.equal(await cache.put(a, Buffer.alloc(4, 1)), true);
    await sleep(15);
    assert.equal(await cache.put(b, Buffer.alloc(4, 2)), true);
    await sleep(15);
    // ler A conta como uso (mtime): A fica mais nova que B
    assert.deepEqual(await cache.get(a), Buffer.alloc(4, 1));
    await sleep(15);
    // 4 + 4 + 4 = 12 > 10 → B (mais antiga) sai
    assert.equal(await cache.put(c, Buffer.alloc(4, 3)), true);
    assert.ok(existsSync(join(directory, `${a}.audio`)), 'A foi usada depois de B e permanece');
    assert.ok(!existsSync(join(directory, `${b}.audio`)), 'B era a mais antiga pelo mtime');
    assert.ok(existsSync(join(directory, `${c}.audio`)), 'a recém-gravada nunca é removida');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('entrada única acima do teto não é apagada pela própria gravação', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'usami-tts-cache-'));
  try {
    const cache = createFileTtsCache({ directory, maxBytes: 2 });
    const key = createTtsCacheKey({ text: 'grande' });
    assert.equal(await cache.put(key, Buffer.alloc(8, 7)), true);
    assert.deepEqual(await cache.get(key), Buffer.alloc(8, 7));
    assert.ok(existsSync(join(directory, `${key}.audio`)));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('teto do cache: env/opção inválida cai no default', () => {
  assert.equal(resolveTtsCacheMaxBytes('1024'), 1024);
  assert.equal(resolveTtsCacheMaxBytes('0'), 256 * 1024 * 1024);
  assert.equal(resolveTtsCacheMaxBytes('não-número'), 256 * 1024 * 1024);
  assert.equal(resolveTtsCacheMaxBytes(undefined), 256 * 1024 * 1024);
});
