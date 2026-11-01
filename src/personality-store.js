// Personalidade ajustável da Usami: sliders de traços + instruções extras do
// usuário, persistidos em data/personality.json (escrita atômica tmp+rename,
// como o memory.json). A persona base continua em `persona.js`; este módulo só
// guarda os ajustes e os traduz em texto para o prompt (`buildTraitGuidance`).
//
// Os traços são intensidades 0–100 com 50 = persona original. Só o desvio do
// neutro vira instrução: com tudo em 50 o prompt fica idêntico ao de antes.

import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export const PERSONALITY_FILE = 'personality.json';
export const NEUTRAL = 50;
// Desvio mínimo para a instrução entrar no prompt (evita ruído em 48/52).
const DEADBAND = 12;
export const CUSTOM_PROMPT_MAX = 600;

export const TRAITS = {
  warmth: {
    label: 'Carinho',
    low: 'Seja mais reservada e contida: demonstre afeto raramente e sem efusão.',
    high: 'Seja mais calorosa e demonstrativa: elogie, console e deixe o afeto aparecer cedo.',
  },
  curiosity: {
    label: 'Curiosidade',
    low: 'Pergunte pouco; responda ao que foi dito sem puxar assuntos novos.',
    high: 'Seja muito curiosa: faça perguntas sobre o dia, os gostos e os planos dele.',
  },
  playfulness: {
    label: 'Brincadeira',
    low: 'Seja séria e direta, com poucas piadas e provocações.',
    high: 'Seja brincalhona: provoque de leve, faça piadas e use humor travesso.',
  },
  pride: {
    label: 'Orgulho (tsundere)',
    low: 'Baixe a guarda: o tsundere aparece pouco, o afeto sai mais direto.',
    high: 'Reforce o tsundere: negue o próprio carinho, gagueje e se faça de difícil antes de ceder.',
  },
};

export const TRAIT_KEYS = Object.keys(TRAITS);

export function defaultPersonality() {
  return {
    version: 1,
    traits: Object.fromEntries(TRAIT_KEYS.map(key => [key, NEUTRAL])),
    customPrompt: '',
  };
}

const clampTrait = value => {
  const number = Number(value);
  if (!Number.isFinite(number)) return NEUTRAL;
  return Math.min(100, Math.max(0, Math.round(number)));
};

// Remove caracteres de controle (menos quebra de linha) e limita o tamanho:
// o texto vai para o system prompt, então precisa ser curto e inofensivo ao
// formato de resposta.
export function sanitizeCustomPrompt(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, CUSTOM_PROMPT_MAX);
}

// Aceita qualquer entrada (arquivo corrompido, payload parcial) e devolve um
// registro válido; traço ausente ou inválido cai no neutro.
export function normalizePersonality(raw) {
  const base = defaultPersonality();
  const source = raw && typeof raw === 'object' ? raw : {};
  const traits = source.traits && typeof source.traits === 'object' ? source.traits : {};
  for (const key of TRAIT_KEYS) {
    if (key in traits) base.traits[key] = clampTrait(traits[key]);
  }
  base.customPrompt = sanitizeCustomPrompt(source.customPrompt);
  return base;
}

export function isNeutral(personality) {
  const value = normalizePersonality(personality);
  return !value.customPrompt && TRAIT_KEYS.every(key => Math.abs(value.traits[key] - NEUTRAL) < DEADBAND);
}

// Bloco de texto para o system prompt; '' quando não há nada a ajustar.
export function buildTraitGuidance(personality) {
  const value = normalizePersonality(personality);
  const lines = [];
  for (const key of TRAIT_KEYS) {
    const delta = value.traits[key] - NEUTRAL;
    if (Math.abs(delta) < DEADBAND) continue;
    const intensity = Math.abs(delta) >= 35 ? 'muito' : 'um pouco';
    lines.push(`- ${TRAITS[key].label} (${intensity} ${delta > 0 ? 'acima' : 'abaixo'} do normal): ${delta > 0 ? TRAITS[key].high : TRAITS[key].low}`);
  }
  if (value.customPrompt) lines.push(`- Instruções dele sobre o seu jeito: ${value.customPrompt}`);
  return lines.join('\n');
}

export function createPersonalityStore({ dataDir } = {}) {
  if (!dataDir || typeof dataDir !== 'string') throw new Error('createPersonalityStore: dataDir é obrigatório.');
  const filePath = join(dataDir, PERSONALITY_FILE);
  let data = defaultPersonality();

  // Arquivo ausente ou ilegível volta ao padrão: personalidade nunca derruba o chat.
  function load() {
    try {
      data = normalizePersonality(JSON.parse(readFileSync(filePath, 'utf8')));
    } catch {
      data = defaultPersonality();
    }
    return data;
  }

  function save(next) {
    data = normalizePersonality(next);
    mkdirSync(dataDir, { recursive: true });
    const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temporary, JSON.stringify(data, null, 2), 'utf8');
    try {
      renameSync(temporary, filePath);
    } catch (error) {
      try { unlinkSync(temporary); } catch {}
      if (error?.code !== 'EEXIST' && error?.code !== 'EPERM') throw error;
    }
    return data;
  }

  return {
    load,
    save,
    reset: () => save(defaultPersonality()),
    get: () => normalizePersonality(data),
  };
}
