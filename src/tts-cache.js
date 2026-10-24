import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const CACHE_VERSION = 1;

function boundedText(value, fallback = '') {
  return String(value ?? fallback).normalize('NFC').trim().replace(/\s+/gu, ' ').slice(0, 2000);
}

function boundedStyle(value) {
  const style = boundedText(value, 'neutral').toLowerCase();
  return style.replace(/[^a-z0-9:_-]/g, '_').slice(0, 80) || 'neutral';
}

export function normalizeTtsCacheInput(input = {}) {
  return {
    version: CACHE_VERSION,
    provider: boundedStyle(input.provider || 'elevenlabs'),
    model: boundedStyle(input.model || 'default'),
    voiceId: boundedStyle(input.voiceId || 'default'),
    styleId: boundedStyle(input.styleId || 'neutral'),
    rate: Number.isFinite(Number(input.rate)) ? Math.max(.5, Math.min(2, Number(input.rate))) : 1,
    pitch: Number.isFinite(Number(input.pitch)) ? Math.max(.5, Math.min(2, Number(input.pitch))) : 1,
    format: boundedStyle(input.format || 'audio/mpeg'),
    text: boundedText(input.text),
  };
}

export function createTtsCacheKey(input) {
  const normalized = normalizeTtsCacheInput(input);
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

export function createFileTtsCache({ directory, fs = { mkdir, readFile, rename, unlink, writeFile } } = {}) {
  if (!directory) throw new Error('TTS cache directory is required.');
  const pathFor = key => join(directory, `${key}.audio`);

  return {
    async get(key) {
      try {
        return await fs.readFile(pathFor(key));
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
      return true;
    },
  };
}
