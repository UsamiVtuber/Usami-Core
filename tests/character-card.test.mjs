import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import {
  PERSONALITY_PRESETS,
  embedCardInPng,
  extractCardFromPng,
  isPngBuffer,
  normalizeCardToManifest,
  slugifyCharacterId,
} from '../src/character-card.js';
import { createDefaultUsamiManifest } from '../src/character-manifest-schema.js';
import { createCharacterRegistry } from '../src/character-context.js';
import { createPersonalityStore } from '../src/personality-store.js';
import { createCharactersHandler } from '../server.mjs';
import { createPersonalityHandler } from '../src/routes/memory-routes.js';

function mockReq({ method = 'GET', url = '/', headers = {}, body = null } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = { host: '127.0.0.1:8787', ...headers };
  const chunkBuf = body == null
    ? null
    : (Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)));
  req[Symbol.asyncIterator] = async function* () {
    if (chunkBuf) yield chunkBuf;
  };
  process.nextTick(() => {
    if (chunkBuf) req.emit('data', chunkBuf);
    req.emit('end');
  });
  return req;
}

function mockRes() {
  let resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  const chunks = [];
  const res = {
    statusCode: 200,
    headers: {},
    body: '',
    rawBuffer: Buffer.alloc(0),
    writeHead(status, headers = {}) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(chunk = '') {
      if (Buffer.isBuffer(chunk)) {
        chunks.push(chunk);
        this.rawBuffer = Buffer.concat(chunks);
        this.body = this.rawBuffer.toString('utf8');
      } else if (chunk) {
        const buf = Buffer.from(String(chunk), 'utf8');
        chunks.push(buf);
        this.rawBuffer = Buffer.concat(chunks);
        this.body += String(chunk);
      }
      resolveDone(this);
    },
  };
  return { res, done };
}

test('character-card: embedCardInPng + extractCardFromPng faz round-trip idempotente', () => {
  const manifest = createDefaultUsamiManifest();
  manifest.metadata.id = 'luna-star';
  manifest.metadata.name = 'Luna';
  manifest.metadata.displayName = 'Luna Star';

  const png1 = embedCardInPng(manifest);
  assert.equal(isPngBuffer(png1), true);

  const extracted = extractCardFromPng(png1);
  assert.equal(extracted.ok, true);
  assert.equal(extracted.format, 'usami_card_v1');
  assert.equal(extracted.card.metadata.id, 'luna-star');
  assert.equal(extracted.card.metadata.displayName, 'Luna Star');

  // Re-embutir no PNG ja gerado nao duplica chunk nem corrompe
  manifest.metadata.displayName = 'Luna v2';
  const png2 = embedCardInPng(manifest, png1);
  const extracted2 = extractCardFromPng(png2);
  assert.equal(extracted2.ok, true);
  assert.equal(extracted2.card.metadata.displayName, 'Luna v2');
});

test('character-card: normalizeCardToManifest aceita card SillyTavern/YuriOS (chara v2)', () => {
  const charaV2 = {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: 'Yuri Órion',
      description: 'Companion calma especialista em astronomia.',
      personality: 'Curiosa, gentil e observadora',
      system_prompt: 'Fale com suavidade e curiosidade científica.',
      creator: 'YuriOS Community',
      character_version: '1.2.0',
      tags: ['astronomia', 'calma'],
    },
  };

  const res = normalizeCardToManifest(charaV2);
  assert.equal(res.ok, true, res.errors?.join('; '));
  assert.equal(res.format, 'chara_v2');
  assert.equal(res.manifest.metadata.id, 'yuri-orion');
  assert.equal(res.manifest.metadata.name, 'Yuri Órion');
  assert.equal(res.manifest.metadata.version, '1.2.0');
  assert.match(res.manifest.identity.systemPrompt.identityBlock, /astronomia|suavidade|Curiosa/i);
});

test('character-card: rejeita PNG invalido e gera slug seguro', () => {
  const bad = extractCardFromPng(Buffer.from('nao e png'));
  assert.equal(bad.ok, false);
  assert.equal(slugifyCharacterId('  Áurea * 2026! '), 'aurea-2026');
  assert.equal(slugifyCharacterId('!!!', 'fallback-ok'), 'fallback-ok');
});

test('HTTP /api/characters/import-card e /export-card suportam JSON, PNG e exigem token', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'usami-card-http-'));
  try {
    const registry = createCharacterRegistry({ dataDir: tmpDir });
    const token = 'test-secret-token-card';
    const handler = createCharactersHandler({
      characterRegistry: registry,
      dataDir: tmpDir,
      apiToken: token,
    });

    // 1. Sem token -> 401
    {
      const req = mockReq({ method: 'POST', url: '/api/characters/import-card', headers: { 'content-type': 'application/json' }, body: { name: 'Teste' } });
      const { res, done } = mockRes();
      await handler(req, res);
      await done;
      assert.equal(res.statusCode, 401);
    }

    // 2. Import JSON (formato chara v2) com ativacao automatica
    {
      const req = mockReq({
        method: 'POST',
        url: '/api/characters/import-card',
        headers: { 'content-type': 'application/json', 'x-usami-token': token },
        body: {
          spec: 'chara_card_v2',
          data: { name: 'Hana Live', description: 'Co-host de games', personality: 'Animada' },
        },
      });
      const { res, done } = mockRes();
      await handler(req, res);
      await done;
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.ok, true);
      assert.equal(body.characterId, 'hana-live');
      assert.equal(body.activated, true);
      assert.equal(registry.getActiveCharacterId(), 'hana-live');
    }

    // 3. Export PNG e re-import via image/png cru
    let exportedPng;
    {
      const req = mockReq({
        method: 'GET',
        url: '/api/characters/hana-live/export-card?format=png',
        headers: { 'x-usami-token': token },
      });
      const { res, done } = mockRes();
      await handler(req, res);
      await done;
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers['Content-Type'], 'image/png');
      assert.equal(isPngBuffer(res.rawBuffer), true);
      exportedPng = res.rawBuffer;
    }

    {
      const req = mockReq({
        method: 'POST',
        url: '/api/characters/import-card?activate=false',
        headers: { 'content-type': 'image/png', 'x-usami-token': token },
        body: exportedPng,
      });
      const { res, done } = mockRes();
      await handler(req, res);
      await done;
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.ok, true);
      assert.equal(body.characterId, 'hana-live');
      assert.equal(body.format, 'usami_card_v1');
      assert.equal(body.activated, false);
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('HTTP /api/personality/presets e /api/personality/preset aplicam presets no-code', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'usami-preset-http-'));
  try {
    const store = createPersonalityStore({ dataDir: tmpDir });
    const token = 'test-preset-token';
    const handler = createPersonalityHandler({ personalityStore: store, apiToken: token });

    // GET presets
    {
      const req = mockReq({ method: 'GET', url: '/api/personality/presets', headers: { 'x-usami-token': token } });
      const { res, done } = mockRes();
      await handler(req, res);
      await done;
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.ok, true);
      assert.equal(body.presets.length, PERSONALITY_PRESETS.length);
    }

    // POST preset valido (cohost)
    {
      const req = mockReq({
        method: 'POST',
        url: '/api/personality/preset',
        headers: { 'content-type': 'application/json', 'x-usami-token': token },
        body: { presetId: 'cohost' },
      });
      const { res, done } = mockRes();
      await handler(req, res);
      await done;
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.ok, true);
      assert.equal(body.presetId, 'cohost');
      assert.equal(body.personality.traits.playfulness, 85);
      assert.equal(store.get().traits.curiosity, 85);
    }

    // POST preset invalido -> 400
    {
      const req = mockReq({
        method: 'POST',
        url: '/api/personality/preset',
        headers: { 'content-type': 'application/json', 'x-usami-token': token },
        body: { presetId: 'inexistente' },
      });
      const { res, done } = mockRes();
      await handler(req, res);
      await done;
      assert.equal(res.statusCode, 400);
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
