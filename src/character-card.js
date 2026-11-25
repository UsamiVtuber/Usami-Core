/**
 * @fileoverview Importacao e exportacao No-Code de Cartoes de Companheira (PNG/JSON)
 * e presets rapidos de personalidade para o Usami-Core.
 *
 * - Suporta leitura de chunks PNG `tEXt` com chave `usami_card_v1` (padrao Usami)
 *   e `chara` (compatibilidade com cards SillyTavern / YuriOS v1 e v2).
 * - Exporta qualquer `character.manifest.v1` em JSON ou PNG com chunk `usami_card_v1`
 *   embutido (CRC32 IEEE valido, sem dependencias externas).
 */

import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import { dataDir as resolveDataDir } from './data-paths.js';
import {
  CHARACTER_MANIFEST_SCHEMA_ID,
  createDefaultUsamiManifest,
  isValidCharacterId,
  validateCharacterManifest,
} from './character-manifest-schema.js';
import { characterManifestPath } from './character-loader.js';
import { normalizePersonality } from './personality-store.js';

export const CHARACTER_CARD_PNG_KEYWORD = 'usami_card_v1';
export const COMPAT_CARD_PNG_KEYWORD = 'chara';
export const MAX_CARD_PNG_BYTES = 5 * 1024 * 1024; // 5 MB

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// PNG 1x1 RGBA valido (Deep Blue #0B132B) usado como base quando nao ha imagem customizada.
const MINIMAL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==';

// Tabela CRC32 IEEE-802.3 para chunks PNG.
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    c = CRC32_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Converte um nome livre em slug valido para `metadata.id` (`[a-z0-9][a-z0-9_-]{1,62}`).
 * @param {string} rawName
 * @param {string} [fallback]
 * @returns {string}
 */
export function slugifyCharacterId(rawName, fallback = 'companion-custom') {
  const cleaned = String(rawName ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/-+/g, '-')
    .replace(/[-_]+$/, '')
    .slice(0, 60);
  if (isValidCharacterId(cleaned)) return cleaned;
  return isValidCharacterId(fallback) ? fallback : 'companion-custom';
}

/**
 * Verifica se o buffer comeca com a assinatura PNG padrao.
 * @param {Buffer|Uint8Array} buf
 * @returns {boolean}
 */
export function isPngBuffer(buf) {
  if (!Buffer.isBuffer(buf) && !(buf instanceof Uint8Array)) return false;
  const buffer = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  return buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE);
}

/**
 * Faz o parse dos chunks de um PNG valido.
 * @param {Buffer} buffer
 */
function parsePngChunks(buffer) {
  if (!isPngBuffer(buffer)) {
    return { ok: false, chunks: [], error: 'Arquivo não é um PNG válido.' };
  }
  const chunks = [];
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const crcEnd = dataEnd + 4;
    if (crcEnd > buffer.length) {
      return { ok: false, chunks: [], error: 'PNG truncado ou corrompido.' };
    }
    const data = buffer.subarray(dataStart, dataEnd);
    chunks.push({ type, data });
    offset = crcEnd;
    if (type === 'IEND') break;
  }
  if (!chunks.length || chunks[chunks.length - 1].type !== 'IEND') {
    return { ok: false, chunks: [], error: 'PNG sem chunk IEND válido.' };
  }
  return { ok: true, chunks, error: null };
}

function encodePngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function decodeCardTextPayload(rawText) {
  const trimmed = String(rawText ?? '').trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (isPlainObject(parsed)) return parsed;
    } catch {
      // tenta base64 abaixo
    }
  }
  try {
    const decoded = Buffer.from(trimmed, 'base64').toString('utf8').trim();
    if (decoded.startsWith('{')) {
      const parsed = JSON.parse(decoded);
      if (isPlainObject(parsed)) return parsed;
    }
  } catch {
    // invalido
  }
  return null;
}

/**
 * Extrai metadados de Cartao de Companheira de um buffer PNG (chunks `tEXt`).
 * Prioriza `usami_card_v1`; faz fallback para `chara` (SillyTavern / YuriOS).
 * @param {Buffer|Uint8Array} input
 */
export function extractCardFromPng(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
  const parsed = parsePngChunks(buffer);
  if (!parsed.ok) {
    return { ok: false, format: null, card: null, error: parsed.error };
  }

  let compatCandidate = null;
  for (const chunk of parsed.chunks) {
    if (chunk.type !== 'tEXt') continue;
    const nulIdx = chunk.data.indexOf(0);
    if (nulIdx <= 0) continue;
    const keyword = chunk.data.subarray(0, nulIdx).toString('latin1');
    const textValue = chunk.data.subarray(nulIdx + 1).toString('utf8');

    if (keyword === CHARACTER_CARD_PNG_KEYWORD) {
      const card = decodeCardTextPayload(textValue);
      if (card) return { ok: true, format: 'usami_card_v1', card, error: null };
    } else if (keyword === COMPAT_CARD_PNG_KEYWORD && !compatCandidate) {
      const card = decodeCardTextPayload(textValue);
      if (card) compatCandidate = card;
    }
  }

  if (compatCandidate) {
    return { ok: true, format: 'chara_v2', card: compatCandidate, error: null };
  }

  return {
    ok: false,
    format: null,
    card: null,
    error: 'Nenhum metadado de cartão (usami_card_v1 ou chara) encontrado neste PNG.',
  };
}

/**
 * Embute um manifesto `character.manifest.v1` em um PNG valido via chunk `tEXt` (`usami_card_v1`).
 * Se `basePngBuffer` nao for fornecido, usa um PNG minimo valido de 1x1.
 * @param {object} manifest
 * @param {Buffer|null} [basePngBuffer]
 * @returns {Buffer}
 */
export function embedCardInPng(manifest, basePngBuffer = null) {
  const source = basePngBuffer && isPngBuffer(basePngBuffer)
    ? (Buffer.isBuffer(basePngBuffer) ? basePngBuffer : Buffer.from(basePngBuffer))
    : Buffer.from(MINIMAL_PNG_BASE64, 'base64');

  const parsed = parsePngChunks(source);
  if (!parsed.ok) {
    throw new Error(parsed.error || 'PNG base inválido.');
  }

  const encodedPayload = Buffer.from(JSON.stringify(manifest), 'utf8').toString('base64');
  const textData = Buffer.concat([
    Buffer.from(CHARACTER_CARD_PNG_KEYWORD, 'latin1'),
    Buffer.from([0]),
    Buffer.from(encodedPayload, 'ascii'),
  ]);
  const cardChunk = encodePngChunk('tEXt', textData);

  const outChunks = [PNG_SIGNATURE];
  for (const chunk of parsed.chunks) {
    if (chunk.type === 'tEXt') {
      const nulIdx = chunk.data.indexOf(0);
      const keyword = nulIdx > 0 ? chunk.data.subarray(0, nulIdx).toString('latin1') : '';
      if (keyword === CHARACTER_CARD_PNG_KEYWORD) continue;
    }
    if (chunk.type === 'IEND') {
      outChunks.push(cardChunk);
    }
    outChunks.push(encodePngChunk(chunk.type, chunk.data));
  }
  return Buffer.concat(outChunks);
}

function buildManifestFromCharaCard(rawCard, fallbackId) {
  const data = isPlainObject(rawCard.data) ? rawCard.data : rawCard;
  const base = createDefaultUsamiManifest();
  const name = String(data.name || 'Companheira').trim().slice(0, 80) || 'Companheira';
  const id = slugifyCharacterId(rawCard.id || data.id || name, fallbackId);
  const description = String(data.description || data.personality || '').trim().slice(0, 600);
  const author = String(data.creator || 'Importado via Card').trim().slice(0, 80);
  const versionRaw = String(data.character_version || '1.0.0').trim();
  const version = /^\d+\.\d+\.\d+/.test(versionRaw) ? versionRaw : '1.0.0';

  const identityLines = [];
  if (data.system_prompt) identityLines.push(String(data.system_prompt).trim());
  if (data.personality) identityLines.push(`Personalidade: ${String(data.personality).trim()}`);
  if (data.scenario) identityLines.push(`Cenário: ${String(data.scenario).trim()}`);

  const rules = [
    ...base.identity.systemPrompt.dialogueRules,
    ...(Array.isArray(data.tags) && data.tags.length
      ? [`Estilo e temas: ${data.tags.slice(0, 8).map(t => String(t).trim()).filter(Boolean).join(', ')}`]
      : []),
  ];

  return {
    ...base,
    id: CHARACTER_MANIFEST_SCHEMA_ID,
    metadata: {
      id,
      name,
      displayName: name,
      version,
      author,
      description: description || `Companheira ${name} importada via cartão.`,
    },
    identity: {
      ...base.identity,
      archetype: 'imported_card_companion',
      systemPrompt: {
        ...base.identity.systemPrompt,
        identityBlock: identityLines.join('\n').slice(0, 2000) || `Você é ${name}, uma companion virtual.`,
        dialogueRules: rules,
      },
    },
  };
}

/**
 * Converte um payload de cartao (Usami manifest v1 completo/parcial ou SillyTavern/YuriOS `chara`)
 * em um `character.manifest.v1` validado.
 * @param {unknown} rawCard
 * @param {object} [options]
 * @param {string} [options.fallbackId]
 */
export function normalizeCardToManifest(rawCard, { fallbackId = 'companion-custom' } = {}) {
  if (!isPlainObject(rawCard)) {
    return { ok: false, manifest: null, format: null, errors: ['Cartão deve ser um objeto JSON.'] };
  }

  // Formato 1: SillyTavern / YuriOS chara card (v2 com `spec`/`data` ou v1 com `name` na raiz sem `metadata`)
  const isCharaCard =
    typeof rawCard.spec === 'string'
    || (isPlainObject(rawCard.data) && typeof rawCard.data.name === 'string' && !rawCard.metadata)
    || (typeof rawCard.name === 'string' && !rawCard.metadata);

  if (isCharaCard) {
    const candidate = buildManifestFromCharaCard(rawCard, fallbackId);
    const check = validateCharacterManifest(candidate);
    if (!check.ok) {
      return { ok: false, manifest: null, format: 'chara_v2', errors: check.errors };
    }
    return { ok: true, manifest: check.value, format: 'chara_v2', errors: [] };
  }

  // Formato 2: Manifesto Usami (`character.manifest.v1` completo ou parcial com defaults)
  const base = createDefaultUsamiManifest();
  const rawMeta = isPlainObject(rawCard.metadata) ? rawCard.metadata : {};
  const resolvedName = String(rawMeta.name || rawMeta.displayName || 'Companheira').trim();
  const resolvedId = isValidCharacterId(rawMeta.id)
    ? rawMeta.id
    : slugifyCharacterId(rawMeta.id || resolvedName, fallbackId);

  const merged = {
    ...base,
    ...rawCard,
    id: CHARACTER_MANIFEST_SCHEMA_ID,
    metadata: {
      ...base.metadata,
      ...rawMeta,
      id: resolvedId,
      name: resolvedName,
      displayName: String(rawMeta.displayName || resolvedName).trim(),
      version: typeof rawMeta.version === 'string' && /^\d+\.\d+\.\d+/.test(rawMeta.version.trim())
        ? rawMeta.version.trim()
        : base.metadata.version,
    },
    identity: {
      ...base.identity,
      ...(isPlainObject(rawCard.identity) ? rawCard.identity : {}),
      systemPrompt: {
        ...base.identity.systemPrompt,
        ...(isPlainObject(rawCard.identity?.systemPrompt) ? rawCard.identity.systemPrompt : {}),
        operationalLimits: {
          ...base.identity.systemPrompt.operationalLimits,
          ...(isPlainObject(rawCard.identity?.systemPrompt?.operationalLimits)
            ? rawCard.identity.systemPrompt.operationalLimits
            : {}),
        },
      },
    },
    voice: {
      ...base.voice,
      ...(isPlainObject(rawCard.voice) ? rawCard.voice : {}),
    },
    avatar: {
      ...base.avatar,
      ...(isPlainObject(rawCard.avatar) ? rawCard.avatar : {}),
    },
    memory: {
      ...base.memory,
      ...(isPlainObject(rawCard.memory) ? rawCard.memory : {}),
    },
    personality: {
      ...base.personality,
      ...(isPlainObject(rawCard.personality) ? rawCard.personality : {}),
    },
  };

  const check = validateCharacterManifest(merged);
  if (!check.ok) {
    return { ok: false, manifest: null, format: 'usami_card_v1', errors: check.errors };
  }
  return { ok: true, manifest: check.value, format: 'usami_card_v1', errors: [] };
}

/**
 * Persiste um manifesto validado de forma atomica em `dataDir/characters/<id>/character.manifest.json`.
 * @param {object} manifest
 * @param {object} [options]
 * @param {string} [options.dataDir]
 */
export function saveCharacterManifest(manifest, { dataDir = resolveDataDir() } = {}) {
  const check = validateCharacterManifest(manifest);
  if (!check.ok) {
    return { ok: false, characterId: null, manifest: null, filePath: null, errors: check.errors };
  }
  const characterId = check.value.metadata.id;
  const filePath = characterManifestPath(characterId, dataDir);
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(check.value, null, 2)}\n`, 'utf8');
  renameSync(tmpPath, filePath);
  return { ok: true, characterId, manifest: check.value, filePath, errors: [] };
}

/**
 * Presets rapidos No-Code de personalidade (inspirado em ai-companion-integration / YuriOS).
 * Mapeados diretamente para os 4 tracos de `personality-store.js`.
 */
export const PERSONALITY_PRESETS = Object.freeze([
  Object.freeze({
    id: 'classic',
    name: 'Usami Clássica',
    description: 'Equilíbrio original da persona: tsundere leve, curiosa e brincalhona na medida.',
    traits: Object.freeze({ warmth: 50, curiosity: 50, playfulness: 50, pride: 50 }),
    customPrompt: '',
  }),
  Object.freeze({
    id: 'cohost',
    name: 'Co-Host Energética',
    description: 'Mais falante, brincalhona e curiosa — ideal para jogos, lives e conversa animada.',
    traits: Object.freeze({ warmth: 75, curiosity: 85, playfulness: 85, pride: 35 }),
    customPrompt: 'Mantenha ritmo animado de co-host, reaja com energia e puxe gancho sobre o que está acontecendo.',
  }),
  Object.freeze({
    id: 'focus',
    name: 'Foco & Estudo',
    description: 'Mais direta, calma e objetiva para sessões de trabalho, código ou pomodoro.',
    traits: Object.freeze({ warmth: 55, curiosity: 40, playfulness: 25, pride: 30 }),
    customPrompt: 'Seja objetiva e encorajadora, ajudando a manter o foco sem distrações longas.',
  }),
  Object.freeze({
    id: 'calm',
    name: 'Modo Calmo',
    description: 'Calorosa, acolhedora e suave — perfeita para fim de noite e modo companhia.',
    traits: Object.freeze({ warmth: 85, curiosity: 45, playfulness: 35, pride: 20 }),
    customPrompt: 'Fale com calma, acolhimento e gentileza, em tom tranquilo.',
  }),
]);

export function getPersonalityPreset(presetId) {
  const key = String(presetId ?? '').trim().toLowerCase();
  return PERSONALITY_PRESETS.find(p => p.id === key) || null;
}

export function applyPersonalityPresetToStore(store, presetId) {
  const preset = getPersonalityPreset(presetId);
  if (!preset) return { ok: false, error: `Preset desconhecido: "${String(presetId ?? '')}".` };
  const saved = store.save(normalizePersonality({
    traits: { ...preset.traits },
    customPrompt: preset.customPrompt,
  }));
  return { ok: true, preset, personality: saved };
}
