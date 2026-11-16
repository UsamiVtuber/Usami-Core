import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CHARACTER_MANIFEST_SCHEMA_ID,
  CharacterManifestSchema,
  DEFAULT_CHARACTER_ID,
  createDefaultUsamiManifest,
  isValidCharacterId,
  validateCharacterManifest,
} from '../src/character-manifest-schema.js';
import {
  characterDir,
  characterManifestPath,
  listAvailableCharacters,
  loadCharacterManifest,
  loadCharacterManifestSync,
} from '../src/character-loader.js';

test('createDefaultUsamiManifest: gera manifesto usami-classic válido pelo schema', () => {
  const manifest = createDefaultUsamiManifest();
  const check = validateCharacterManifest(manifest);
  assert.equal(check.ok, true);
  assert.deepEqual(check.errors, []);
  assert.equal(check.value.id, CHARACTER_MANIFEST_SCHEMA_ID);
  assert.equal(check.value.metadata.id, DEFAULT_CHARACTER_ID);

  const zodLike = CharacterManifestSchema.safeParse(manifest);
  assert.equal(zodLike.success, true);
  assert.equal(zodLike.data.metadata.name, 'Usami');
});

test('arquivo data/characters/usami-classic/character.manifest.json existe e valida em disco', () => {
  const loaded = loadCharacterManifestSync(DEFAULT_CHARACTER_ID, {
    dataDir: join(process.cwd(), 'data'),
    fallbackToDefaultUsami: false,
  });
  assert.equal(loaded.ok, true, `Erros: ${loaded.errors.join('; ')}`);
  assert.equal(loaded.manifest.metadata.id, 'usami-classic');
  assert.equal(loaded.manifest.voice.engine, 'gemini_multimodal');
  assert.equal(loaded.manifest.memory.ragEnabled, true);
});

test('validateCharacterManifest / CharacterManifestSchema: rejeita entradas inválidas com diagnóstico em pt-BR', () => {
  assert.equal(isValidCharacterId('luna-cyber'), true);
  assert.equal(isValidCharacterId('../evil'), false);
  assert.equal(isValidCharacterId('A'), false);

  const base = createDefaultUsamiManifest();
  const invalid = {
    ...base,
    metadata: { ...base.metadata, id: 'INVALIDO!', version: 'abc' },
    identity: {
      ...base.identity,
      systemPrompt: {
        ...base.identity.systemPrompt,
        operationalLimits: { maxResponseTokens: -5, temperature: 9 },
      },
    },
    voice: { ...base.voice, engine: 'motor-desconhecido' },
  };

  const res = CharacterManifestSchema.safeParse(invalid);
  assert.equal(res.success, false);
  assert.ok(res.errors.some(e => e.includes('metadata.id')));
  assert.ok(res.errors.some(e => e.includes('metadata.version')));
  assert.ok(res.errors.some(e => e.includes('maxResponseTokens')));
  assert.ok(res.errors.some(e => e.includes('temperature')));
  assert.ok(res.errors.some(e => e.includes('voice.engine')));

  assert.throws(() => CharacterManifestSchema.parse(invalid), /Manifesto inválido/);
});

test('character-loader: carrega manifesto customizado válido e rejeita JSON corrompido sem crashar', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'usami-manifest-loader-'));
  try {
    const custom = createDefaultUsamiManifest();
    custom.metadata.id = 'luna-cyber';
    custom.metadata.name = 'Luna';
    custom.metadata.displayName = 'Luna Cyber';
    custom.memory.ragEnabled = false;
    custom.memory.storageBackend = 'none';

    const lunaDir = characterDir('luna-cyber', dir);
    mkdirSync(lunaDir, { recursive: true });
    writeFileSync(characterManifestPath('luna-cyber', dir), JSON.stringify(custom, null, 2), 'utf8');

    const loaded = await loadCharacterManifest('luna-cyber', { dataDir: dir });
    assert.equal(loaded.ok, true);
    assert.equal(loaded.manifest.metadata.name, 'Luna');
    assert.equal(loaded.manifest.memory.ragEnabled, false);

    // JSON corrompido em outro diretório não crasha o processo nem a listagem
    const brokenDir = characterDir('broken-char', dir);
    mkdirSync(brokenDir, { recursive: true });
    writeFileSync(join(brokenDir, 'character.manifest.json'), '{ json invalido', 'utf8');

    const broken = await loadCharacterManifest('broken-char', { dataDir: dir });
    assert.equal(broken.ok, false);
    assert.equal(broken.status, 400);
    assert.match(broken.errors[0], /JSON inválido/);

    const missing = await loadCharacterManifest('nao-existe', { dataDir: dir });
    assert.equal(missing.ok, false);
    assert.equal(missing.status, 404);

    const list = listAvailableCharacters({ dataDir: dir });
    const ids = list.map(c => c.characterId);
    assert.ok(ids.includes('luna-cyber'));
    assert.ok(ids.includes('usami-classic'));
    assert.ok(!ids.includes('broken-char'));
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { }
  }
});
