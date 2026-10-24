import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileTtsCache, createTtsCacheKey, normalizeTtsCacheInput } from '../src/tts-cache.js';

test('normaliza a chave de TTS sem confundir estilos diferentes', () => {
  const base = { text: '  oi   Usami  ', model: 'gemini-tts', voiceId: 'usami', styleId: 'warm' };
  assert.deepEqual(normalizeTtsCacheInput(base).text, 'oi Usami');
  assert.equal(createTtsCacheKey(base), createTtsCacheKey({ ...base, text: 'oi Usami' }));
  assert.notEqual(createTtsCacheKey(base), createTtsCacheKey({ ...base, styleId: 'playful' }));
  assert.notEqual(createTtsCacheKey(base), createTtsCacheKey({ ...base, rate: 1.1 }));
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
