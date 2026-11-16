/**
 * @fileoverview Schema declarativo e validação pura (sem deps externas) para
 * manifestos de personagens (`character.manifest.json`) na plataforma white-label.
 */

export const CHARACTER_MANIFEST_SCHEMA_ID = 'character.manifest.v1';
export const DEFAULT_CHARACTER_ID = 'usami-classic';
export const CHARACTER_ID_RE = /^[a-z0-9][a-z0-9_-]{1,62}$/;
export const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
export const VALID_VOICE_ENGINES = Object.freeze([
  'gemini_multimodal',
  'elevenlabs',
  'edge_tts',
  'vits_local',
]);
export const VALID_STORAGE_BACKENDS = Object.freeze(['lancedb', 'none']);
export const VALID_MODEL_FORMATS = Object.freeze(['vrm0.x', 'vrm1.0', 'vrm']);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isFiniteNumberInRange(value, min, max) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function isIntInRange(value, min, max) {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/**
 * Valida se o identificador do personagem é seguro e segue o padrão slug.
 * @param {unknown} id
 * @returns {boolean}
 */
export function isValidCharacterId(id) {
  return typeof id === 'string' && CHARACTER_ID_RE.test(id);
}

function validateMetadata(raw, errors) {
  if (!isPlainObject(raw)) {
    errors.push('metadata: deve ser um objeto.');
    return null;
  }
  if (!isValidCharacterId(raw.id)) {
    errors.push('metadata.id: identificador de personagem inválido (use 2-63 caracteres [a-z0-9_-]).');
  }
  if (!isNonEmptyString(raw.name)) {
    errors.push('metadata.name: nome do personagem é obrigatório.');
  }
  if (!isNonEmptyString(raw.displayName)) {
    errors.push('metadata.displayName: nome de exibição é obrigatório.');
  }
  if (typeof raw.version !== 'string' || !SEMVER_RE.test(raw.version.trim())) {
    errors.push('metadata.version: versão semver inválida (ex.: 1.0.0).');
  }
  if (raw.author !== undefined && typeof raw.author !== 'string') {
    errors.push('metadata.author: deve ser texto.');
  }
  if (raw.description !== undefined && typeof raw.description !== 'string') {
    errors.push('metadata.description: deve ser texto.');
  }

  return {
    id: typeof raw.id === 'string' ? raw.id : '',
    name: typeof raw.name === 'string' ? raw.name.trim() : '',
    displayName: typeof raw.displayName === 'string' ? raw.displayName.trim() : '',
    version: typeof raw.version === 'string' ? raw.version.trim() : '',
    ...(raw.author !== undefined ? { author: String(raw.author).trim() } : {}),
    ...(raw.description !== undefined ? { description: String(raw.description).trim() } : {}),
  };
}

function validateIdentity(raw, errors) {
  if (!isPlainObject(raw)) {
    errors.push('identity: deve ser um objeto.');
    return null;
  }
  if (!isNonEmptyString(raw.archetype)) {
    errors.push('identity.archetype: arquétipo do personagem é obrigatório.');
  }

  const sp = raw.systemPrompt;
  if (!isPlainObject(sp)) {
    errors.push('identity.systemPrompt: deve ser um objeto.');
    return null;
  }
  if (sp.baseTemplate !== undefined && typeof sp.baseTemplate !== 'string') {
    errors.push('identity.systemPrompt.baseTemplate: deve ser texto.');
  }
  if (sp.identityBlock !== undefined && typeof sp.identityBlock !== 'string') {
    errors.push('identity.systemPrompt.identityBlock: deve ser texto.');
  }
  if (!Array.isArray(sp.dialogueRules) || sp.dialogueRules.some(r => !isNonEmptyString(r))) {
    errors.push('identity.systemPrompt.dialogueRules: deve ser um array de regras em texto não vazio.');
  }
  if (sp.bannedWords !== undefined && (!Array.isArray(sp.bannedWords) || sp.bannedWords.some(w => typeof w !== 'string'))) {
    errors.push('identity.systemPrompt.bannedWords: deve ser um array de strings.');
  }

  const limits = sp.operationalLimits;
  if (!isPlainObject(limits)) {
    errors.push('identity.systemPrompt.operationalLimits: deve ser um objeto.');
  } else {
    if (!isIntInRange(limits.maxResponseTokens, 20, 4096)) {
      errors.push('identity.systemPrompt.operationalLimits.maxResponseTokens: deve ser um inteiro entre 20 e 4096.');
    }
    if (!isFiniteNumberInRange(limits.temperature, 0, 2)) {
      errors.push('identity.systemPrompt.operationalLimits.temperature: deve ser um número entre 0 e 2.');
    }
    if (limits.topP !== undefined && !isFiniteNumberInRange(limits.topP, 0, 1)) {
      errors.push('identity.systemPrompt.operationalLimits.topP: deve ser um número entre 0 e 1.');
    }
    if (limits.rateLimitMessagesPerMinute !== undefined && !isIntInRange(limits.rateLimitMessagesPerMinute, 1, 600)) {
      errors.push('identity.systemPrompt.operationalLimits.rateLimitMessagesPerMinute: deve ser um inteiro entre 1 e 600.');
    }
  }

  return {
    archetype: typeof raw.archetype === 'string' ? raw.archetype.trim() : '',
    systemPrompt: {
      ...(sp.baseTemplate !== undefined ? { baseTemplate: sp.baseTemplate } : {}),
      ...(sp.identityBlock !== undefined ? { identityBlock: sp.identityBlock } : {}),
      dialogueRules: Array.isArray(sp.dialogueRules) ? sp.dialogueRules.map(r => String(r).trim()) : [],
      bannedWords: Array.isArray(sp.bannedWords) ? sp.bannedWords.map(w => String(w)) : [],
      operationalLimits: isPlainObject(limits) ? {
        maxResponseTokens: limits.maxResponseTokens,
        temperature: limits.temperature,
        ...(limits.topP !== undefined ? { topP: limits.topP } : {}),
        ...(limits.rateLimitMessagesPerMinute !== undefined ? { rateLimitMessagesPerMinute: limits.rateLimitMessagesPerMinute } : {}),
      } : {},
    },
  };
}

function validateVoice(raw, errors) {
  if (!isPlainObject(raw)) {
    errors.push('voice: deve ser um objeto.');
    return null;
  }
  if (!VALID_VOICE_ENGINES.includes(raw.engine)) {
    errors.push(`voice.engine: motor inválido (use ${VALID_VOICE_ENGINES.join(' | ')}).`);
  }
  if (!isNonEmptyString(raw.defaultVoice)) {
    errors.push('voice.defaultVoice: identificador da voz padrão é obrigatório.');
  }
  if (raw.model !== undefined && typeof raw.model !== 'string') {
    errors.push('voice.model: deve ser texto.');
  }
  if (raw.baseInstruction !== undefined && typeof raw.baseInstruction !== 'string') {
    errors.push('voice.baseInstruction: deve ser texto.');
  }

  const pitchOffset = raw.pitchOffset === undefined ? 0 : raw.pitchOffset;
  if (!isFiniteNumberInRange(pitchOffset, -20, 20)) {
    errors.push('voice.pitchOffset: deve ser um número entre -20 e 20.');
  }

  const speakingRate = raw.speakingRate === undefined ? 1.0 : raw.speakingRate;
  if (!isFiniteNumberInRange(speakingRate, 0.25, 4.0)) {
    errors.push('voice.speakingRate: deve ser um número entre 0.25 e 4.0.');
  }

  let normalizedProsodyMap;
  if (raw.prosodyMap !== undefined) {
    if (!isPlainObject(raw.prosodyMap)) {
      errors.push('voice.prosodyMap: deve ser um objeto mapeando emoções.');
    } else {
      normalizedProsodyMap = {};
      for (const [emotion, entry] of Object.entries(raw.prosodyMap)) {
        if (!isPlainObject(entry)) {
          errors.push(`voice.prosodyMap.${emotion}: deve ser um objeto.`);
          continue;
        }
        if (entry.voice !== undefined && !isNonEmptyString(entry.voice)) {
          errors.push(`voice.prosodyMap.${emotion}.voice: deve ser texto não vazio.`);
        }
        if (entry.pitchOffset !== undefined && !isFiniteNumberInRange(entry.pitchOffset, -20, 20)) {
          errors.push(`voice.prosodyMap.${emotion}.pitchOffset: deve estar entre -20 e 20.`);
        }
        if (entry.rate !== undefined && !isFiniteNumberInRange(entry.rate, 0.25, 4.0)) {
          errors.push(`voice.prosodyMap.${emotion}.rate: deve estar entre 0.25 e 4.0.`);
        }
        if (entry.styleClause !== undefined && typeof entry.styleClause !== 'string') {
          errors.push(`voice.prosodyMap.${emotion}.styleClause: deve ser texto.`);
        }
        normalizedProsodyMap[emotion] = {
          ...(entry.voice !== undefined ? { voice: entry.voice.trim() } : {}),
          ...(entry.pitchOffset !== undefined ? { pitchOffset: entry.pitchOffset } : {}),
          ...(entry.rate !== undefined ? { rate: entry.rate } : {}),
          ...(entry.styleClause !== undefined ? { styleClause: entry.styleClause } : {}),
        };
      }
    }
  }

  return {
    engine: raw.engine,
    defaultVoice: typeof raw.defaultVoice === 'string' ? raw.defaultVoice.trim() : '',
    ...(raw.model !== undefined ? { model: raw.model.trim() } : {}),
    ...(raw.baseInstruction !== undefined ? { baseInstruction: raw.baseInstruction } : {}),
    pitchOffset,
    speakingRate,
    ...(normalizedProsodyMap ? { prosodyMap: normalizedProsodyMap } : {}),
  };
}

function validateAvatar(raw, errors) {
  if (!isPlainObject(raw)) {
    errors.push('avatar: deve ser um objeto.');
    return null;
  }
  if (!isNonEmptyString(raw.vrmPath)) {
    errors.push('avatar.vrmPath: caminho do modelo VRM é obrigatório.');
  }
  const modelFormat = raw.modelFormat === undefined ? 'vrm1.0' : raw.modelFormat;
  if (!VALID_MODEL_FORMATS.includes(modelFormat)) {
    errors.push(`avatar.modelFormat: formato inválido (use ${VALID_MODEL_FORMATS.join(' | ')}).`);
  }
  if (raw.defaultPose !== undefined && typeof raw.defaultPose !== 'string') {
    errors.push('avatar.defaultPose: deve ser texto.');
  }
  const scale = raw.scale === undefined ? 1.0 : raw.scale;
  if (!isFiniteNumberInRange(scale, 0.1, 10)) {
    errors.push('avatar.scale: deve ser um número entre 0.1 e 10.');
  }
  if (raw.cameraOffset !== undefined) {
    if (!Array.isArray(raw.cameraOffset) || raw.cameraOffset.length !== 3 || raw.cameraOffset.some(v => typeof v !== 'number' || !Number.isFinite(v))) {
      errors.push('avatar.cameraOffset: deve ser um array [x, y, z] com 3 números finitos.');
    }
  }
  const armClearanceCorrection = raw.armClearanceCorrection === undefined ? true : raw.armClearanceCorrection;
  if (typeof armClearanceCorrection !== 'boolean') {
    errors.push('avatar.armClearanceCorrection: deve ser booleano.');
  }
  if (raw.credit !== undefined && typeof raw.credit !== 'string') {
    errors.push('avatar.credit: deve ser texto.');
  }

  return {
    vrmPath: typeof raw.vrmPath === 'string' ? raw.vrmPath.trim() : '',
    modelFormat,
    ...(raw.defaultPose !== undefined ? { defaultPose: raw.defaultPose } : {}),
    scale,
    ...(raw.cameraOffset !== undefined ? { cameraOffset: [...raw.cameraOffset] } : {}),
    armClearanceCorrection,
    ...(raw.credit !== undefined ? { credit: raw.credit } : {}),
  };
}

function validateMemory(raw, errors) {
  if (!isPlainObject(raw)) {
    errors.push('memory: deve ser um objeto.');
    return null;
  }
  if (typeof raw.ragEnabled !== 'boolean') {
    errors.push('memory.ragEnabled: booleano obrigatório.');
  }
  const storageBackend = raw.storageBackend === undefined ? 'lancedb' : raw.storageBackend;
  if (!VALID_STORAGE_BACKENDS.includes(storageBackend)) {
    errors.push(`memory.storageBackend: backend inválido (use ${VALID_STORAGE_BACKENDS.join(' | ')}).`);
  }
  const isolatedNamespace = raw.isolatedNamespace === undefined ? true : raw.isolatedNamespace;
  if (typeof isolatedNamespace !== 'boolean') {
    errors.push('memory.isolatedNamespace: deve ser booleano.');
  }
  const embeddingModel = raw.embeddingModel === undefined ? 'Xenova/all-MiniLM-L6-v2' : raw.embeddingModel;
  if (!isNonEmptyString(embeddingModel)) {
    errors.push('memory.embeddingModel: deve ser texto não vazio.');
  }
  const similarityThreshold = raw.similarityThreshold === undefined ? 0.2 : raw.similarityThreshold;
  if (!isFiniteNumberInRange(similarityThreshold, 0, 1)) {
    errors.push('memory.similarityThreshold: deve ser um número entre 0 e 1.');
  }
  const maxContextChunks = raw.maxContextChunks === undefined ? 4 : raw.maxContextChunks;
  if (!isIntInRange(maxContextChunks, 1, 50)) {
    errors.push('memory.maxContextChunks: deve ser um inteiro entre 1 e 50.');
  }
  const decayFactorPerDay = raw.decayFactorPerDay === undefined ? 0.05 : raw.decayFactorPerDay;
  if (!isFiniteNumberInRange(decayFactorPerDay, 0, 1)) {
    errors.push('memory.decayFactorPerDay: deve ser um número entre 0 e 1.');
  }

  return {
    ragEnabled: Boolean(raw.ragEnabled),
    storageBackend,
    isolatedNamespace,
    embeddingModel: typeof embeddingModel === 'string' ? embeddingModel.trim() : 'Xenova/all-MiniLM-L6-v2',
    similarityThreshold,
    maxContextChunks,
    decayFactorPerDay,
  };
}

function validatePersonality(raw, errors) {
  if (!isPlainObject(raw)) {
    errors.push('personality: deve ser um objeto.');
    return null;
  }

  const normalizedTraits = {};
  if (!isPlainObject(raw.traits)) {
    errors.push('personality.traits: deve ser um objeto com traços numéricos.');
  } else {
    for (const [k, v] of Object.entries(raw.traits)) {
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        errors.push(`personality.traits.${k}: valor deve ser numérico finito.`);
      } else {
        normalizedTraits[k] = v;
      }
    }
  }

  const bond = raw.bondSystem;
  if (!isPlainObject(bond)) {
    errors.push('personality.bondSystem: deve ser um objeto.');
  } else {
    if (typeof bond.enabled !== 'boolean') {
      errors.push('personality.bondSystem.enabled: deve ser booleano.');
    }
    const initialScore = bond.initialScore === undefined ? 0 : bond.initialScore;
    if (typeof initialScore !== 'number' || !Number.isFinite(initialScore) || initialScore < 0) {
      errors.push('personality.bondSystem.initialScore: deve ser um número >= 0.');
    }
    if (!Array.isArray(bond.levels)) {
      errors.push('personality.bondSystem.levels: deve ser um array de níveis.');
    } else {
      bond.levels.forEach((lvl, idx) => {
        if (!isPlainObject(lvl)) {
          errors.push(`personality.bondSystem.levels[${idx}]: deve ser um objeto.`);
          return;
        }
        if (typeof lvl.level !== 'number' || !Number.isInteger(lvl.level) || lvl.level < 1) {
          errors.push(`personality.bondSystem.levels[${idx}].level: deve ser um inteiro >= 1.`);
        }
        if (typeof lvl.threshold !== 'number' || !Number.isFinite(lvl.threshold) || lvl.threshold < 0) {
          errors.push(`personality.bondSystem.levels[${idx}].threshold: deve ser um número >= 0.`);
        }
        if (!isNonEmptyString(lvl.title)) {
          errors.push(`personality.bondSystem.levels[${idx}].title: título é obrigatório.`);
        }
      });
    }
  }

  return {
    traits: normalizedTraits,
    bondSystem: isPlainObject(bond) ? {
      enabled: Boolean(bond.enabled),
      initialScore: bond.initialScore === undefined ? 0 : bond.initialScore,
      levels: Array.isArray(bond.levels) ? bond.levels.map(l => ({
        level: l?.level,
        threshold: l?.threshold,
        title: typeof l?.title === 'string' ? l.title.trim() : '',
      })) : [],
    } : { enabled: false, initialScore: 0, levels: [] },
  };
}

/**
 * Valida e normaliza um manifesto completo de personagem (`character.manifest.v1`).
 * @param {unknown} raw
 * @returns {{ ok: boolean, value: object | null, errors: string[] }}
 */
export function validateCharacterManifest(raw) {
  const errors = [];
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      value: null,
      errors: ['manifesto: o documento deve ser um objeto JSON válido.'],
    };
  }

  if (raw.id !== undefined && raw.id !== CHARACTER_MANIFEST_SCHEMA_ID) {
    errors.push(`id: versão de schema inválida (esperado "${CHARACTER_MANIFEST_SCHEMA_ID}").`);
  }

  const metadata = validateMetadata(raw.metadata, errors);
  const identity = validateIdentity(raw.identity, errors);
  const voice = validateVoice(raw.voice, errors);
  const avatar = validateAvatar(raw.avatar, errors);
  const memory = validateMemory(raw.memory, errors);
  const personality = validatePersonality(raw.personality, errors);

  if (errors.length > 0) {
    return { ok: false, value: null, errors };
  }

  return {
    ok: true,
    value: {
      ...(raw.$schema ? { $schema: String(raw.$schema) } : {}),
      id: CHARACTER_MANIFEST_SCHEMA_ID,
      metadata,
      identity,
      voice,
      avatar,
      memory,
      personality,
    },
    errors: [],
  };
}

/**
 * Interface compatível com chamadas estilo Zod (`.safeParse` / `.parse`).
 */
export const CharacterManifestSchema = Object.freeze({
  safeParse(raw) {
    const res = validateCharacterManifest(raw);
    if (res.ok) {
      return { success: true, data: res.value };
    }
    return {
      success: false,
      error: {
        issues: res.errors.map(message => ({ message })),
        format: () => res.errors.join('\n'),
      },
      errors: res.errors,
    };
  },
  parse(raw) {
    const res = validateCharacterManifest(raw);
    if (!res.ok) {
      throw new Error(`Manifesto inválido: ${res.errors.join('; ')}`);
    }
    return res.value;
  },
});

/**
 * Retorna o manifesto padrão oficial do personagem legado `usami-classic`.
 * @returns {object}
 */
export function createDefaultUsamiManifest() {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    id: CHARACTER_MANIFEST_SCHEMA_ID,
    metadata: {
      id: DEFAULT_CHARACTER_ID,
      name: 'Usami',
      displayName: 'Usami (兎美)',
      version: '1.0.0',
      author: 'Usami Project',
      description: 'Companion virtual tsundere fofa e única',
    },
    identity: {
      archetype: 'tsundere_cyber_bunny',
      systemPrompt: {
        baseTemplate: 'prompts/system.liquid',
        dialogueRules: [
          'Use português natural com leves expressões japonesas quando emocionada',
          'Respostas curtas em balões sem asteriscos de ação no reply',
          'Nunca incentive dependência emocional tóxica',
        ],
        bannedWords: [],
        operationalLimits: {
          maxResponseTokens: 250,
          temperature: 0.7,
          topP: 0.92,
          rateLimitMessagesPerMinute: 30,
        },
      },
    },
    voice: {
      engine: 'gemini_multimodal',
      defaultVoice: 'Kore',
      model: 'gemini-2.5-flash-preview-tts',
      baseInstruction: '[em português do Brasil, voz de personagem de anime, muito aguda e brilhante, timbre leve e expressivo, dicção rápida e nítida] ',
      pitchOffset: 0,
      speakingRate: 1.0,
      prosodyMap: {
        angry: { voice: 'Kore', pitchOffset: 1.5, rate: 1.1 },
        sad: { voice: 'Kore', pitchOffset: -1.0, rate: 0.9 },
        happy: { voice: 'Kore', pitchOffset: 1.0, rate: 1.05 },
      },
    },
    avatar: {
      vrmPath: '/models/shiro.vrm',
      modelFormat: 'vrm0.x',
      defaultPose: 'idle',
      scale: 1.0,
      cameraOffset: [0, 1.35, 0.8],
      armClearanceCorrection: true,
      credit: 'Model by Sweet_nya555',
    },
    memory: {
      ragEnabled: true,
      storageBackend: 'lancedb',
      isolatedNamespace: true,
      embeddingModel: 'Xenova/all-MiniLM-L6-v2',
      similarityThreshold: 0.2,
      maxContextChunks: 4,
      decayFactorPerDay: 0.05,
    },
    personality: {
      traits: {
        extroversion: 0.7,
        tsundere: 0.85,
        empathy: 0.6,
        chaos: 0.4,
      },
      bondSystem: {
        enabled: true,
        initialScore: 0,
        levels: [
          { level: 1, threshold: 0, title: 'Conhecidos' },
          { level: 2, threshold: 25, title: 'Amigos Próximos' },
          { level: 3, threshold: 60, title: 'Parceiros' },
          { level: 4, threshold: 110, title: 'Confidentes' },
          { level: 5, threshold: 180, title: 'Almas Gêmeas' },
        ],
      },
    },
  };
}
