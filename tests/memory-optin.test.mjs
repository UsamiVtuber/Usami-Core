import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDefaultUsamiManifest } from '../src/character-manifest-schema.js';
import { LanceDbMemoryProvider, NullMemoryProvider, createMemoryProvider } from '../src/memory-provider.js';
import { createCharacterRegistry } from '../src/character-context.js';
import { createMemoryStore } from '../src/memory-store.js';

process.env.USE_NVIDIA = 'false';
const scratchDir = mkdtempSync(join(tmpdir(), 'usami-optin-init-'));
process.env.USAMI_DATA_DIR = scratchDir;
const { createChatHandler } = await import('../server.mjs');

function mockReq({ method = 'POST', url = '/api/chat', headers = {}, body = '' } = {}) {
  const chunks = body ? [Buffer.from(body)] : [];
  return {
    method,
    url,
    headers,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

function mockRes() {
  const res = { statusCode: null, headers: null, body: '' };
  res.writeHead = (status, headers) => { res.statusCode = status; res.headers = headers; };
  res.end = (data) => { res.body = data; };
  return res;
}

test('createMemoryProvider: ragEnabled=false instancia NullMemoryProvider com zero I/O e zero ONNX', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'usami-null-prov-'));
  let embedderCalls = 0;
  const manifest = createDefaultUsamiManifest();
  manifest.metadata.id = 'fast-bot';
  manifest.memory.ragEnabled = false;

  try {
    const provider = createMemoryProvider({
      manifest,
      characterId: 'fast-bot',
      dataDir: dir,
      embedder: async () => {
        embedderCalls += 1;
        return new Array(384).fill(0);
      },
    });

    assert.ok(provider instanceof NullMemoryProvider);
    assert.equal(provider.isEnabled(), false);

    await provider.initialize();
    await provider.store({ text: 'não deve gravar nada no disco' });
    const hits = await provider.query('qualquer assunto');
    const ctx = await provider.formatContext('qualquer assunto');

    assert.deepEqual(hits, []);
    assert.equal(ctx, null);
    assert.equal(await provider.count(), 0);
    assert.equal(embedderCalls, 0);
    assert.equal(existsSync(join(dir, 'characters', 'fast-bot', 'memory', 'lancedb')), false);
    await provider.close();
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { }
  }
});

test('createMemoryProvider: ragEnabled=true instancia LanceDbMemoryProvider isolado', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'usami-lance-prov-'));
  const manifest = createDefaultUsamiManifest();
  manifest.metadata.id = 'rag-bot';
  manifest.memory.ragEnabled = true;

  const provider = createMemoryProvider({
    manifest,
    characterId: 'rag-bot',
    dataDir: dir,
    embedder: async () => {
      const vec = new Array(384).fill(0);
      vec[0] = 1;
      return vec;
    },
  });

  try {
    assert.ok(provider instanceof LanceDbMemoryProvider);
    assert.equal(provider.isEnabled(), true);
    await provider.store({ file: 'lore.md', title: 'Lore', text: 'Gosta de chá verde gelado' });
    const formatted = await provider.formatContext('chá verde');
    assert.match(formatted, /Gosta de chá verde gelado/);
    assert.equal(await provider.count(), 1);
  } finally {
    await provider.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch { }
  }
});

test('createChatHandler: pula completamente vaultSearch/RAG quando ragEnabled=false no manifesto do personagem', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'usami-chat-optin-'));
  const registry = createCharacterRegistry({ dataDir: dir, allowSyntheticManifest: true });

  const noRagManifest = createDefaultUsamiManifest();
  noRagManifest.metadata.id = 'no-rag-bot';
  noRagManifest.metadata.name = 'NoRag';
  noRagManifest.metadata.displayName = 'NoRag Bot';
  noRagManifest.memory.ragEnabled = false;
  registry.getOrCreate('no-rag-bot', { manifest: noRagManifest });

  let vaultCalls = 0;
  let observedSystem = '';
  const memFallback = createMemoryStore({ dataDir: dir });
  memFallback.load();

  const handler = createChatHandler({
    characterRegistry: registry,
    memoryStore: memFallback,
    apiToken: 'tok-optin',
    getKey: async () => 'test-router-key',
    vaultSearch: async () => {
      vaultCalls += 1;
      return 'CONTEUDO_DO_VAULT_NAO_DEVE_ENTRAR';
    },
    fetchImpl: async (_url, opts) => {
      const sent = JSON.parse(opts.body);
      observedSystem = sent.messages.find(m => m.role === 'system')?.content || '';
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({ reply: 'Resposta rápida sem RAG!', gesture: 'nod', actions: [], remember: null }) } }],
        }),
      };
    },
  });

  try {
    const res = mockRes();
    await handler(mockReq({
      headers: {
        host: '127.0.0.1:8787',
        'content-type': 'application/json',
        'x-usami-token': 'tok-optin',
        'x-character-id': 'no-rag-bot',
      },
      body: JSON.stringify({ message: 'Me lembra do vault?' }),
    }), res);

    assert.equal(res.statusCode, 200);
    assert.equal(vaultCalls, 0);
    assert.ok(!observedSystem.includes('CONTEUDO_DO_VAULT_NAO_DEVE_ENTRAR'));
    assert.ok(observedSystem.includes('NoRag Bot'));
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { }
  }
});
