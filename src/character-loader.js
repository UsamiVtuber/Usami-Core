/**
 * @fileoverview Carregador de manifestos declarativos de personagens (`character.manifest.json`).
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dataDir as resolveDataDir } from './data-paths.js';
import {
  DEFAULT_CHARACTER_ID,
  createDefaultUsamiManifest,
  isValidCharacterId,
  validateCharacterManifest,
} from './character-manifest-schema.js';

/**
 * Resolve o diretório base de um personagem dentro de `dataDir`.
 * @param {string} characterId
 * @param {string} [baseDataDir]
 * @returns {string}
 */
export function characterDir(characterId, baseDataDir = resolveDataDir()) {
  if (!isValidCharacterId(characterId)) {
    throw new Error(`characterId inválido: "${String(characterId ?? '')}"`);
  }
  return join(baseDataDir, 'characters', characterId);
}

/**
 * Resolve o caminho do `character.manifest.json` do personagem.
 * @param {string} characterId
 * @param {string} [baseDataDir]
 * @returns {string}
 */
export function characterManifestPath(characterId, baseDataDir = resolveDataDir()) {
  return join(characterDir(characterId, baseDataDir), 'character.manifest.json');
}

function parseAndValidateManifestText(rawText, characterId, source) {
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    return {
      ok: false,
      status: 400,
      manifest: null,
      errors: [`JSON inválido no manifesto: ${error?.message || 'erro de sintaxe'}`],
      source,
    };
  }

  const check = validateCharacterManifest(parsed);
  if (!check.ok) {
    return {
      ok: false,
      status: 400,
      manifest: null,
      errors: check.errors,
      source,
    };
  }

  if (check.value.metadata.id !== characterId) {
    return {
      ok: false,
      status: 400,
      manifest: null,
      errors: [
        `metadata.id (${check.value.metadata.id}) diverge do diretório solicitado (${characterId}).`,
      ],
      source,
    };
  }

  return {
    ok: true,
    status: 200,
    manifest: check.value,
    errors: [],
    source,
  };
}

/**
 * Carrega e valida de forma síncrona o manifesto do personagem.
 * @param {string} characterId
 * @param {Object} [options]
 * @param {string} [options.dataDir]
 * @param {boolean} [options.fallbackToDefaultUsami=true]
 */
export function loadCharacterManifestSync(characterId, {
  dataDir = resolveDataDir(),
  fallbackToDefaultUsami = true,
} = {}) {
  if (!isValidCharacterId(characterId)) {
    return {
      ok: false,
      status: 400,
      manifest: null,
      errors: ['characterId inválido.'],
      source: null,
    };
  }

  const filePath = characterManifestPath(characterId, dataDir);
  if (existsSync(filePath)) {
    let rawText;
    try {
      rawText = readFileSync(filePath, 'utf8');
    } catch (error) {
      return {
        ok: false,
        status: 500,
        manifest: null,
        errors: [`Falha ao ler manifesto: ${error?.message || error}`],
        source: filePath,
      };
    }
    return parseAndValidateManifestText(rawText, characterId, filePath);
  }

  if (characterId === DEFAULT_CHARACTER_ID && fallbackToDefaultUsami !== false) {
    return {
      ok: true,
      status: 200,
      manifest: createDefaultUsamiManifest(),
      errors: [],
      source: 'builtin-default',
    };
  }

  return {
    ok: false,
    status: 404,
    manifest: null,
    errors: [`Manifesto não encontrado para o personagem "${characterId}".`],
    source: null,
  };
}

/**
 * Carrega e valida de forma assíncrona o manifesto do personagem.
 * @param {string} characterId
 * @param {Object} [options]
 */
export async function loadCharacterManifest(characterId, {
  dataDir = resolveDataDir(),
  fallbackToDefaultUsami = true,
} = {}) {
  if (!isValidCharacterId(characterId)) {
    return {
      ok: false,
      status: 400,
      manifest: null,
      errors: ['characterId inválido.'],
      source: null,
    };
  }

  const filePath = characterManifestPath(characterId, dataDir);
  try {
    const rawText = await readFile(filePath, 'utf8');
    return parseAndValidateManifestText(rawText, characterId, filePath);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      return {
        ok: false,
        status: 500,
        manifest: null,
        errors: [`Falha ao ler manifesto: ${error?.message || error}`],
        source: filePath,
      };
    }
  }

  if (characterId === DEFAULT_CHARACTER_ID && fallbackToDefaultUsami !== false) {
    return {
      ok: true,
      status: 200,
      manifest: createDefaultUsamiManifest(),
      errors: [],
      source: 'builtin-default',
    };
  }

  return {
    ok: false,
    status: 404,
    manifest: null,
    errors: [`Manifesto não encontrado para o personagem "${characterId}".`],
    source: null,
  };
}

/**
 * Lista todos os personagens válidos disponíveis no diretório de dados,
 * garantindo a presença de `usami-classic`.
 * @param {Object} [options]
 * @param {string} [options.dataDir]
 * @returns {Array<{ characterId: string, manifest: object, source: string }>}
 */
export function listAvailableCharacters({ dataDir = resolveDataDir() } = {}) {
  const root = join(dataDir, 'characters');
  const results = [];
  const seen = new Set();

  if (existsSync(root)) {
    let entries = [];
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      entries = [];
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!isValidCharacterId(entry.name)) continue;
      const loaded = loadCharacterManifestSync(entry.name, {
        dataDir,
        fallbackToDefaultUsami: false,
      });
      if (loaded.ok && loaded.manifest) {
        seen.add(entry.name);
        results.push({
          characterId: entry.name,
          manifest: loaded.manifest,
          source: loaded.source,
        });
      }
    }
  }

  if (!seen.has(DEFAULT_CHARACTER_ID)) {
    results.unshift({
      characterId: DEFAULT_CHARACTER_ID,
      manifest: createDefaultUsamiManifest(),
      source: 'builtin-default',
    });
  }

  return results;
}
