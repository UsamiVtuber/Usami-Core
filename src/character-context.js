/**
 * @fileoverview Container de contexto isolado por personagem (`CharacterContext`) e
 * registro multi-tenant (`createCharacterRegistry`) para desacoplar singletons de `server.mjs`.
 */

import { characterScopedDir, dataDir as resolveDataDir } from './data-paths.js';
import { createMemoryStore } from './memory-store.js';
import { createPersonalityStore } from './personality-store.js';
import { createBondStore } from './bond-store.js';
import { createMoodStore } from './mood-store.js';
import { createAchievementsStore } from './achievements-store.js';
import { createOperationalMemoryStore } from './operational-memory-store.js';
import { createN8nCommandQueue } from './n8n-queue.js';
import { createChatActivityRegistry } from './chat-activity.js';
import { createMemoryProvider } from './memory-provider.js';
import { createEpisodicMemory } from './episodic-memory.js';
import {
  CHARACTER_MANIFEST_SCHEMA_ID,
  DEFAULT_CHARACTER_ID,
  createDefaultUsamiManifest,
  isValidCharacterId,
} from './character-manifest-schema.js';
import { listAvailableCharacters, loadCharacterManifestSync } from './character-loader.js';

/**
 * Extrai e valida o cabeçalho `x-character-id` de uma requisição HTTP.
 * Ausência/string vazia faz fallback para `defaultId` (`usami-classic`).
 */
export function extractRequestCharacterId(req, defaultId = DEFAULT_CHARACTER_ID) {
  const raw = req?.headers?.['x-character-id'];
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    return { ok: true, characterId: defaultId, explicit: false };
  }
  const value = Array.isArray(raw) ? String(raw[0] ?? '').trim() : String(raw).trim();
  if (!value) {
    return { ok: true, characterId: defaultId, explicit: false };
  }
  if (!isValidCharacterId(value)) {
    return { ok: false, status: 400, error: 'Cabeçalho x-character-id inválido.' };
  }
  return { ok: true, characterId: value, explicit: true };
}

/**
 * Gera um manifesto válido sintético para um `characterId` solicitado dinamicamente
 * quando não há `character.manifest.json` em disco e `allowSyntheticManifest` está ativo.
 */
export function createSynthManifestForId(characterId) {
  if (!isValidCharacterId(characterId)) {
    throw new Error(`characterId inválido: "${String(characterId ?? '')}"`);
  }
  if (characterId === DEFAULT_CHARACTER_ID) {
    return createDefaultUsamiManifest();
  }
  const base = createDefaultUsamiManifest();
  return {
    ...base,
    id: CHARACTER_MANIFEST_SCHEMA_ID,
    metadata: {
      ...base.metadata,
      id: characterId,
      name: characterId,
      displayName: characterId,
      description: `Instância isolada de ${characterId}`,
    },
    identity: {
      ...base.identity,
      archetype: 'custom_companion',
      systemPrompt: {
        ...base.identity.systemPrompt,
        identityBlock: `Você é ${characterId}, uma companion virtual agnóstica executando em contexto isolado.`,
      },
    },
  };
}

function safeLoad(store) {
  if (!store || typeof store.load !== 'function') return;
  try {
    store.load();
  } catch {
    // falha ao carregar arquivo ausente/corrompido não derruba o contexto
  }
}

/**
 * Cria um contexto operacional completo e isolado em disco/memória para um personagem.
 */
export function createCharacterContext({
  characterId = DEFAULT_CHARACTER_ID,
  dataDir = resolveDataDir(),
  manifest = null,
  stores = {},
  vaultFallback = null,
  embedder = undefined,
} = {}) {
  if (!isValidCharacterId(characterId)) {
    throw new Error(`characterId inválido: "${String(characterId ?? '')}"`);
  }

  const tenantDataDir = characterId === DEFAULT_CHARACTER_ID
    ? dataDir
    : characterScopedDir(characterId, dataDir);

  let resolvedManifest = manifest;
  if (!resolvedManifest) {
    const loaded = loadCharacterManifestSync(characterId, {
      dataDir,
      fallbackToDefaultUsami: characterId === DEFAULT_CHARACTER_ID,
    });
    resolvedManifest = loaded.ok ? loaded.manifest : createSynthManifestForId(characterId);
  }

  const memoryStore = stores.memoryStore || (() => {
    const s = createMemoryStore({ dataDir: tenantDataDir });
    safeLoad(s);
    return s;
  })();

  const personalityStore = stores.personalityStore || (() => {
    const s = createPersonalityStore({ dataDir: tenantDataDir });
    safeLoad(s);
    return s;
  })();

  const bondStore = stores.bondStore || (() => {
    const s = createBondStore({ dataDir: tenantDataDir });
    safeLoad(s);
    return s;
  })();

  try {
    memoryStore.setBondMirror?.(bondStore.getAll?.());
  } catch {
    // best-effort
  }

  const moodStore = stores.moodStore || (() => {
    const s = createMoodStore({ dataDir: tenantDataDir });
    safeLoad(s);
    return s;
  })();

  const achievementsStore = stores.achievementsStore || (() => {
    const s = createAchievementsStore({ dataDir: tenantDataDir });
    safeLoad(s);
    return s;
  })();

  const operationalStore = stores.operationalStore || (() => {
    const s = createOperationalMemoryStore({ dataDir: tenantDataDir });
    safeLoad(s);
    return s;
  })();

  const memoryProvider = stores.memoryProvider || createMemoryProvider({
    manifest: resolvedManifest,
    characterId,
    dataDir,
    embedder,
    vaultFallback,
  });

  // Respeita o opt-out de memória do manifesto: sem RAG, sem índice episódico.
  const episodicEnabled = resolvedManifest?.memory?.ragEnabled !== false
    && resolvedManifest?.memory?.storageBackend !== 'none';
  const episodicMemory = stores.episodicMemory || (episodicEnabled ? createEpisodicMemory({
    characterId,
    dataDir,
    embedder,
  }) : null);

  const n8nQueue = stores.n8nQueue || createN8nCommandQueue();
  const chatActivity = stores.chatActivity || createChatActivityRegistry();

  return {
    characterId,
    dataDir: tenantDataDir,
    rootDataDir: dataDir,
    manifest: resolvedManifest,
    memoryStore,
    personalityStore,
    bondStore,
    moodStore,
    achievementsStore,
    operationalStore,
    memoryProvider,
    episodicMemory,
    n8nQueue,
    chatActivity,
    async close() {
      if (memoryProvider && typeof memoryProvider.close === 'function') {
        await memoryProvider.close();
      }
      if (episodicMemory && typeof episodicMemory.close === 'function') {
        await episodicMemory.close();
      }
    },
  };
}

/**
 * Registro multi-tenant de personagens ativos em runtime.
 */
export function createCharacterRegistry({
  dataDir = resolveDataDir(),
  defaultCharacterId = DEFAULT_CHARACTER_ID,
  defaultStores = {},
  allowSyntheticManifest = true,
  vaultFallback = null,
  embedder = undefined,
} = {}) {
  if (!isValidCharacterId(defaultCharacterId)) {
    throw new Error(`defaultCharacterId inválido: "${String(defaultCharacterId ?? '')}"`);
  }

  const contexts = new Map();
  let activeCharacterId = defaultCharacterId;

  function resolveManifestFor(characterId) {
    const loaded = loadCharacterManifestSync(characterId, {
      dataDir,
      fallbackToDefaultUsami: characterId === DEFAULT_CHARACTER_ID,
    });
    if (loaded.ok && loaded.manifest) {
      return { ok: true, manifest: loaded.manifest };
    }
    if (!loaded.ok && loaded.status === 400) {
      return { ok: false, status: 400, errors: loaded.errors };
    }
    if (allowSyntheticManifest) {
      return { ok: true, manifest: createSynthManifestForId(characterId) };
    }
    return {
      ok: false,
      status: loaded.status || 404,
      errors: loaded.errors || [`Personagem "${characterId}" não encontrado.`],
    };
  }

  function getOrCreate(characterId = activeCharacterId, { manifest = null } = {}) {
    const targetId = characterId || activeCharacterId;
    if (!isValidCharacterId(targetId)) {
      throw new Error(`characterId inválido: "${String(targetId ?? '')}"`);
    }
    if (contexts.has(targetId) && !manifest) {
      return contexts.get(targetId);
    }

    let resolvedManifest = manifest;
    if (!resolvedManifest) {
      const res = resolveManifestFor(targetId);
      if (!res.ok) {
        const err = new Error(res.errors.join('; '));
        err.status = res.status;
        throw err;
      }
      resolvedManifest = res.manifest;
    }

    const stores = targetId === defaultCharacterId ? defaultStores : {};
    const ctx = createCharacterContext({
      characterId: targetId,
      dataDir,
      manifest: resolvedManifest,
      stores,
      vaultFallback,
      embedder,
    });
    contexts.set(targetId, ctx);
    return ctx;
  }

  function getActive() {
    return getOrCreate(activeCharacterId);
  }

  function setActive(characterId) {
    if (!isValidCharacterId(characterId)) {
      return { ok: false, status: 400, errors: ['characterId inválido.'] };
    }
    try {
      const ctx = getOrCreate(characterId);
      activeCharacterId = characterId;
      return { ok: true, status: 200, context: ctx };
    } catch (error) {
      return {
        ok: false,
        status: error?.status || 404,
        errors: [error?.message || String(error)],
      };
    }
  }

  async function reload(characterId = activeCharacterId) {
    if (!isValidCharacterId(characterId)) {
      return { ok: false, status: 400, errors: ['characterId inválido.'] };
    }
    const existing = contexts.get(characterId);
    if (existing) {
      try {
        await existing.close();
      } catch {
        // best-effort
      }
      contexts.delete(characterId);
    }
    try {
      const ctx = getOrCreate(characterId);
      return { ok: true, status: 200, context: ctx };
    } catch (error) {
      return {
        ok: false,
        status: error?.status || 404,
        errors: [error?.message || String(error)],
      };
    }
  }

  function list() {
    const onDisk = listAvailableCharacters({ dataDir });
    const map = new Map(onDisk.map(item => [item.characterId, item.manifest]));
    for (const [id, ctx] of contexts.entries()) {
      if (!map.has(id)) map.set(id, ctx.manifest);
    }
    return Array.from(map.entries()).map(([characterId, manifest]) => ({
      characterId,
      name: manifest?.metadata?.name || characterId,
      displayName: manifest?.metadata?.displayName || characterId,
      archetype: manifest?.identity?.archetype || 'companion',
      active: characterId === activeCharacterId,
      loaded: contexts.has(characterId),
      ragEnabled: Boolean(manifest?.memory?.ragEnabled),
      manifest,
    }));
  }

  return {
    getActiveCharacterId: () => activeCharacterId,
    getOrCreate,
    getActive,
    setActive,
    reload,
    list,
  };
}
