import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// 4: rate/pitch saíram da chave no provedor gemini (o servidor não os envia ao
// Gemini; o cliente aplica playbackRate no elemento) e o cache ganhou eviction
// LRU por bytes. Versão na chave = áudio antigo nunca é servido depois de mudar
// a forma do áudio ou a direção de estilo.
// 3: a direção de estilo do gemini entrou na chave.
// (2: o WAV do provedor passou a ir intacto e a direção virou tag.)
const CACHE_VERSION = 4;

// Teto default do cache em disco. Configurável por env/opção; o valor só é
// aplicado quando uma gravação ultrapassa o teto (eviction no put).
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
const AUDIO_SUFFIX = '.audio';

function boundedText(value, fallback = '') {
  return String(value ?? fallback).normalize('NFC').trim().replace(/\s+/gu, ' ').slice(0, 2000);
}

function boundedStyle(value) {
  const style = boundedText(value, 'neutral').toLowerCase();
  return style.replace(/[^a-z0-9:_-]/g, '_').slice(0, 80) || 'neutral';
}

function boundedRate(value) {
  return Number.isFinite(Number(value)) ? Math.max(.5, Math.min(2, Number(value))) : 1;
}

export function normalizeTtsCacheInput(input = {}) {
  const provider = boundedStyle(input.provider || 'elevenlabs');
  // No Gemini o rate/pitch nunca sai daqui: o servidor manda só texto + voz e o
  // cliente desacelera no elemento. Mantê-los na chave gerava N arquivos
  // idênticos por frase (uma entrada por combinação de rate/pitch).
  const voiceControls = provider === 'gemini'
    ? {}
    : { rate: boundedRate(input.rate), pitch: boundedRate(input.pitch) };
  return {
    version: CACHE_VERSION,
    provider,
    model: boundedStyle(input.model || 'default'),
    voiceId: boundedStyle(input.voiceId || 'default'),
    styleId: boundedStyle(input.styleId || 'neutral'),
    instruction: boundedText(input.instruction),
    ...voiceControls,
    format: boundedStyle(input.format || 'audio/mpeg'),
    text: boundedText(input.text),
  };
}

export function createTtsCacheKey(input) {
  const normalized = normalizeTtsCacheInput(input);
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

export function resolveTtsCacheMaxBytes(value = process.env.USAMI_TTS_CACHE_MAX_BYTES) {
  const bytes = Number(value);
  return Number.isFinite(bytes) && bytes > 0 ? Math.floor(bytes) : DEFAULT_MAX_BYTES;
}

export function createFileTtsCache({
  directory,
  maxBytes = resolveTtsCacheMaxBytes(),
  fs = { mkdir, readFile, readdir, rename, stat, unlink, utimes, writeFile },
} = {}) {
  if (!directory) throw new Error('TTS cache directory is required.');
  const pathFor = key => join(directory, `${key}${AUDIO_SUFFIX}`);
  const limit = resolveTtsCacheMaxBytes(maxBytes);

  async function touch(filePath) {
    // mtime = "último uso" (leitura também conta como uso no put): LRU de fato,
    // não FIFO de gravação.
    try {
      const now = new Date();
      await fs.utimes(filePath, now, now);
    } catch {
      // arquivo sumiu entre o read e o touch: não é erro para o chamador
    }
  }

  // Apaga os arquivos mais antigos (mtime) até o total caber no teto. A entrada
  // recém-gravada (`keepKey`) nunca é apagada, mesmo sozinha acima do limite.
  async function evict(keepKey = null) {
    let names;
    try {
      names = await fs.readdir(directory);
    } catch {
      return 0;
    }
    const keep = keepKey ? `${keepKey}${AUDIO_SUFFIX}` : null;
    const entries = [];
    for (const name of names) {
      if (!name.endsWith(AUDIO_SUFFIX)) continue;
      const filePath = join(directory, name);
      try {
        const info = await fs.stat(filePath);
        entries.push({ name, path: filePath, size: info.size, mtimeMs: info.mtimeMs });
      } catch {
        // arquivo removido por outro processo: ignora
      }
    }
    let total = entries.reduce((sum, entry) => sum + entry.size, 0);
    if (total <= limit) return 0;
    entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
    let removed = 0;
    for (const entry of entries) {
      if (total <= limit) break;
      if (entry.name === keep) continue;
      try {
        await fs.unlink(entry.path);
        total -= entry.size;
        removed += 1;
      } catch {
        // já não existe: o total continua válido o suficiente para o próximo
      }
    }
    return removed;
  }

  return {
    maxBytes: limit,
    async get(key) {
      const filePath = pathFor(key);
      try {
        const audio = await fs.readFile(filePath);
        await touch(filePath);
        return audio;
      } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
      }
    },
    async put(key, audio) {
      if (!Buffer.isBuffer(audio) || audio.length === 0) return false;
      await fs.mkdir(directory, { recursive: true });
      const target = pathFor(key);
      const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(temporary, audio, { flag: 'wx' });
      try {
        await fs.rename(temporary, target);
      } catch (error) {
        try { await fs.unlink(temporary); } catch {}
        if (error?.code !== 'EEXIST' && error?.code !== 'EPERM') throw error;
      }
      await evict(key);
      return true;
    },
    evict,
  };
}
