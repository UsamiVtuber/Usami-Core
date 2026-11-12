import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeSearchResults,
  normalizeFetchedPages,
  normalizeFirecrawlSearch,
  normalizeTinyFishSearch,
  validatePublicUrl,
} from '../research-core.mjs';

test('validatePublicUrl aceita http/https público e bloqueia localhost/IPs privados', () => {
  assert.equal(validatePublicUrl('https://docs.tinyfish.ai/api'), 'https://docs.tinyfish.ai/api');
  assert.throws(() => validatePublicUrl('http://127.0.0.1:8787/api/memory'), /bloqueada/);
  assert.throws(() => validatePublicUrl('http://localhost:5678'), /bloqueada/);
  assert.throws(() => validatePublicUrl('http://192.168.1.10'), /bloqueada/);
  assert.throws(() => validatePublicUrl('file:///etc/passwd'), /http ou https/);
});

test('mergeSearchResults deduplica URLs entre TinyFish e Firecrawl', () => {
  const tf = normalizeTinyFishSearch({
    results: [
      { url: 'https://example.com/guia/', title: 'Guia TinyFish', snippet: 'Resumo curto' },
      { url: 'https://a.example.com', title: 'Fonte A', snippet: 'Conteúdo A' },
    ],
  });
  const fc = normalizeFirecrawlSearch({
    data: [
      { url: 'https://example.com/guia', title: 'Guia Firecrawl', description: 'Descrição mais completa do guia' },
      { url: 'https://b.example.com', title: 'Fonte B', description: 'Conteúdo B' },
    ],
  });

  const merged = mergeSearchResults([tf, fc], 10);
  assert.equal(merged.length, 3);
  assert.deepEqual(merged[0].providers, ['tinyfish', 'firecrawl']);
  assert.equal(merged[0].snippet, 'Descrição mais completa do guia');

  const pages = normalizeFetchedPages({ results: [{ url: 'https://example.com', title: 'Ex', text: '# Olá' }] }, 'tinyfish');
  assert.equal(pages[0].markdown, '# Olá');
});

