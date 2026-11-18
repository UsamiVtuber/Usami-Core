import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDefaultUsamiManifest } from '../src/character-manifest-schema.js';
import { characterDir, characterManifestPath } from '../src/character-loader.js';
import { createCharacterRegistry } from '../src/character-context.js';
import { buildPersona } from '../src/persona.js';

process.env.USE_NVIDIA = 'false';
const scratchDir = mkdtempSync(join(tmpdir(), 'usami-e2e-wl-init-'));
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

test('buildPersona: mantém texto idêntico ao legado quando usami-classic ou sem manifesto', () => {
  const opts = {
    affinity: 45,
    sections: { user: ['Lucas'], preferences: [], hobbies: [], relationship: [], dates: [], other: [] },
    recentFacts: [],
    history: [{ role: 'user', content: 'oi' }],
    summaries: [],
    username: 'Lucas',
    date: '2026-11-16',
    timeOfDay: 'tarde',
    now: new Date('2026-11-16T15:00:00'),
  };
  const legacyPrompt = buildPersona(opts);
  const manifestPrompt = buildPersona({ ...opts, manifest: createDefaultUsamiManifest() });
  assert.equal(manifestPrompt, legacyPrompt);
});

test('white-label E2E: concorrência entre usami-classic (RAG on) e luna-cyber (RAG off) sem state bleeding', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'usami-wl-e2e-'));

  const lunaManifest = createDefaultUsamiManifest();
  lunaManifest.metadata.id = 'luna-cyber';
  lunaManifest.metadata.name = 'Luna';
  lunaManifest.metadata.displayName = 'Luna Cyber';
  lunaManifest.identity.archetype = 'hacker_astronaut';
  lunaManifest.identity.systemPrompt.identityBlock = 'Você é Luna, uma astronauta hacker especialista em satélites.';
  lunaManifest.identity.systemPrompt.dialogueRules = ['Fale usando jargões espaciais'];
  lunaManifest.identity.systemPrompt.bannedWords = ['coelho'];
  lunaManifest.voice.defaultVoice = 'Aoede';
  lunaManifest.memory.ragEnabled = false;
  lunaManifest.memory.storageBackend = 'none';

  mkdirSync(characterDir('luna-cyber', dir), { recursive: true });
  writeFileSync(characterManifestPath('luna-cyber', dir), JSON.stringify(lunaManifest, null, 2), 'utf8');

  let vaultQueries = 0;
  const registry = createCharacterRegistry({
    dataDir: dir,
    allowSyntheticManifest: false,
    vaultFallback: async () => {
      vaultQueries += 1;
      return 'Memória secreta do Vault da Usami';
    },
  });

  const capturedSystems = {};
  const handler = createChatHandler({
    characterRegistry: registry,
    getKey: async () => 'test-router-key',
    fetchImpl: async (_url, opts) => {
      const payload = JSON.parse(opts.body);
      const sys = payload.messages.find(m => m.role === 'system')?.content || '';
      const userMsg = payload.messages.find(m => m.role === 'user')?.content || '';
      if (sys.includes('Luna Cyber')) {
        capturedSystems.luna = sys;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{
              message: {
                content: JSON.stringify({
                  reply: `Telemetria orbital ok para ${userMsg}`,
                  gesture: 'nod',
                  actions: [],
                  remember: { section: 'preferences', fact: 'gosta de satélites' },
                }),
              },
            }],
          }),
        };
      }
      capturedSystems.usami = sys;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{
            message: {
              content: JSON.stringify({
                reply: `Hmph, ouvi seu ${userMsg}`,
                gesture: 'tilt',
                actions: [],
                remember: { section: 'preferences', fact: 'adora cenouras' },
              }),
            },
          }],
        }),
      };
    },
  });

  try {
    const resUsami = mockRes();
    const resLuna = mockRes();

    // Executa ambos os personagens em paralelo (concorrência multi-tenant)
    await Promise.all([
      handler(mockReq({
        headers: { host: '127.0.0.1:8787', 'content-type': 'application/json', 'x-character-id': 'usami-classic' },
        body: JSON.stringify({ message: 'bom dia Usami' }),
      }), resUsami),
      handler(mockReq({
        headers: { host: '127.0.0.1:8787', 'content-type': 'application/json', 'x-character-id': 'luna-cyber' },
        body: JSON.stringify({ message: 'bom dia Luna' }),
      }), resLuna),
    ]);

    assert.equal(resUsami.statusCode, 200);
    assert.equal(resLuna.statusCode, 200);

    // Usami teve RAG consultado, Luna não (ragEnabled=false)
    assert.equal(vaultQueries, 1);
    assert.match(capturedSystems.usami, /Memória secreta do Vault da Usami/);
    assert.ok(!capturedSystems.luna.includes('Memória secreta do Vault da Usami'));

    // Identidade de cada prompt preservada e isolada
    assert.match(capturedSystems.luna, /astronauta hacker/);
    assert.match(capturedSystems.luna, /Palavras\/expressões proibidas \(JAMAIS use\): coelho/);
    assert.match(capturedSystems.usami, /companion virtual tsundere/);

    // Isolamento completo dos fatos gravados (remember) e ausência de vazamento entre stores
    const usamiFacts = registry.getOrCreate('usami-classic').memoryStore.getSections();
    const lunaFacts = registry.getOrCreate('luna-cyber').memoryStore.getSections();
    assert.ok(usamiFacts.preferences.includes('adora cenouras'));
    assert.ok(!usamiFacts.preferences.includes('gosta de satélites'));
    assert.ok(lunaFacts.preferences.includes('gosta de satélites'));
    assert.ok(!lunaFacts.preferences.includes('adora cenouras'));

    // Luna nunca criou pasta lancedb porque opt-out estava desligado
    assert.equal(existsSync(join(dir, 'characters', 'luna-cyber', 'memory', 'lancedb')), false);

    // Reload fecha e recria contexto sem erro
    const reloaded = await registry.reload('luna-cyber');
    assert.equal(reloaded.ok, true);
  } finally {
    await registry.getOrCreate('usami-classic').close();
    await registry.getOrCreate('luna-cyber').close();
    try { rmSync(dir, { recursive: true, force: true }); } catch { }
  }
});
