/**
 * Consolidação de fatos da memória semântica (Fase 2).
 *
 * Complementa os resumos diários (Fase 1):
 *  1. Classifica durabilidade (`core` vs `recent`) com heurística mais rica que
 *     a regex original `DURABLE_FACT`.
 *  2. Reclassifica fatos presos em `other` (inclusive os migrados da v1 em
 *     `sectionsOverflow`) para `user`, `preferences`, `hobbies`, `relationship`
 *     ou `dates` de forma determinística (com adapter LLM opcional/injetável).
 *  3. Promove fatos recentes duráveis para o núcleo e remove fatos recentes
 *     expirados ou duplicados por forma normalizada (acentos/pontuação).
 */
import { MEMORY_SECTIONS } from './memory-store.js';

const SPECIFIC_SECTIONS = Object.freeze(['dates', 'relationship', 'hobbies', 'preferences', 'user']);
const DEFAULT_CONSOLIDATION_LIMIT = 20;

const inFlightStores = new WeakSet();

const normalizeText = value => String(value ?? '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/[^\p{L}\p{N}\s/]/gu, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const SECTION_RULES = Object.freeze([
  {
    section: 'dates',
    pattern: /\b(aniversario|nasceu|nascimento|casamento|data comemorativa|comemoracao|dia \d{1,2}\/\d{1,2})\b|\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/,
  },
  {
    section: 'relationship',
    pattern: /\b(apelido|chama de|carinhos\w*|trata como|nosso combinado|combinamos|confia em|conversa com a usami)\b/,
  },
  {
    section: 'hobbies',
    pattern: /\b(hobby|hobbies|joga|jogando|toca (?:violao|guitarra|piano|teclado|bateria|baixo)|desenha|pinta|coleciona|pratica|corre|pedala|natacao|academia|musculacao|assiste (?:anime|series?|filmes?)|le livros|le manga|fotografia|costura|croche)\b/,
  },
  {
    section: 'preferences',
    pattern: /\b(gosta|ama|adora|prefere|odeia|detesta|nao gosta|nao suporta|favorit\w*|preferid\w*|curte)\b/,
  },
  {
    section: 'user',
    pattern: /\b(nome|chama se|idade|\d{1,3} anos|mora em|vive em|mora no|mora na|trabalha|emprego|profissao|desenvolvedor\w*|engenheir\w*|estuda|cursa|faculdade|universidade|alergia|intolerancia|tem um|tem uma|tem \d+|gato|cachorro|pet|irma[oa]?|mae|pai|filh[oa]|espos[oa]|marido|mulher|namorad[oa])\b/,
  },
]);

const TRANSIENT_RE = /\b(hoje|ontem|amanha|agora|nesta semana|essa semana|nesse fim de semana|temporariamente|por enquanto|no momento|estou com|to com|cansad[oa] hoje|vai sair|vai viajar)\b/;
const STRONG_DURABLE_RE = /\b(aniversario|nasceu|nascimento|nome|chama se|mora em|vive em|mora no|mora na|trabalha|profissao|alergia|intolerancia|apelido|favorit\w*)\b|\b\d{1,2}\/\d{1,2}\b/;
const DURABLE_RE = /\b(gosta|ama|adora|prefere|odeia|detesta|nao gosta|hobby|hobbies|toca|coleciona|pratica|joga|tem um|tem uma|tem \d+|gato|cachorro|pet|irma[oa]?|mae|pai|filh[oa]|espos[oa]|namorad[oa]|cursa|faculdade|estuda)\b/;

/**
 * Classifica um fato extraído pelo chat em `'core'` (durável) ou `'recent'`
 * (efêmero, com TTL).
 */
export function classifyFactDurability(fact, section = 'other') {
  const normalized = normalizeText(fact);
  if (!normalized) return 'recent';

  if (STRONG_DURABLE_RE.test(normalized)) return 'core';
  if (section === 'dates' || section === 'relationship') {
    return TRANSIENT_RE.test(normalized) ? 'recent' : 'core';
  }

  if (TRANSIENT_RE.test(normalized)) return 'recent';
  if (DURABLE_RE.test(normalized)) return 'core';
  if (section === 'preferences' || section === 'hobbies' || section === 'user') {
    return normalized.split(' ').length >= 3 ? 'core' : 'recent';
  }
  return 'recent';
}

/**
 * Infere a melhor seção semântica para um fato quando ele está em `other`
 * (ou quando `force` é verdadeiro).
 */
export function inferFactSection(fact, currentSection = 'other', { force = false } = {}) {
  if (!force && currentSection && currentSection !== 'other' && MEMORY_SECTIONS.includes(currentSection)) {
    return currentSection;
  }
  const normalized = normalizeText(fact);
  if (!normalized) return 'other';

  for (const rule of SECTION_RULES) {
    if (rule.pattern.test(normalized)) return rule.section;
  }
  return MEMORY_SECTIONS.includes(currentSection) ? currentSection : 'other';
}

function deduplicateSections(store) {
  const sections = store.getSections();
  const seen = new Set();
  let removed = 0;

  for (const section of [...SPECIFIC_SECTIONS, 'other']) {
    for (const fact of sections[section] || []) {
      const key = normalizeText(fact);
      if (!key) continue;
      if (seen.has(key)) {
        if (store.deleteFact(section, fact)) removed += 1;
        continue;
      }
      seen.add(key);
    }
  }
  return removed;
}

/**
 * Consolida a memória semântica em background ou sob demanda:
 * - remove `recentFacts` expirados (`expiresAt <= today`);
 * - promove `recentFacts` duráveis para as seções núcleo;
 * - reclassifica fatos de `other` (inclusive migrados da v1) para seções
 *   específicas usando `inferFactSection` e, opcionalmente, `consolidateWithLlm`;
 * - elimina duplicatas equivalentes após normalização de acentos/pontuação.
 */
export async function consolidateFacts({
  store,
  today,
  consolidateWithLlm = null,
  limit = DEFAULT_CONSOLIDATION_LIMIT,
} = {}) {
  if (!store || typeof store.getAll !== 'function') {
    throw new Error('consolidateFacts: store inválido.');
  }
  if (!today || typeof today !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(today)) {
    throw new Error('consolidateFacts: today deve ser YYYY-MM-DD.');
  }
  if (inFlightStores.has(store)) {
    return { skipped: true, moved: 0, promoted: 0, prunedExpired: 0, deduplicated: 0 };
  }

  inFlightStores.add(store);
  try {
    let prunedExpired = 0;
    let promoted = 0;
    let moved = 0;

    const snapshot = store.getAll();
    const recentList = Array.isArray(snapshot.recentFacts) ? [...snapshot.recentFacts] : [];

    for (const item of recentList) {
      if (!item || typeof item.fact !== 'string') continue;
      if (typeof item.expiresAt === 'string' && item.expiresAt <= today) {
        if (store.deleteRecentFact(item.fact)) prunedExpired += 1;
        continue;
      }
      if (classifyFactDurability(item.fact, item.section) === 'core') {
        const targetSection = inferFactSection(item.fact, item.section);
        store.addCoreFact(item.fact, targetSection);
        promoted += 1;
      }
    }

    const otherFacts = [...(store.getSections().other || [])].slice(0, Math.max(0, limit));
    const unresolvedOther = [];

    for (const fact of otherFacts) {
      const target = inferFactSection(fact, 'other');
      if (target !== 'other') {
        store.addCoreFact(fact, target);
        moved += 1;
      } else {
        unresolvedOther.push(fact);
      }
    }

    if (unresolvedOther.length > 0 && typeof consolidateWithLlm === 'function') {
      try {
        const suggestions = await consolidateWithLlm({
          facts: unresolvedOther,
          sections: SPECIFIC_SECTIONS,
        });
        if (Array.isArray(suggestions)) {
          for (const item of suggestions) {
            if (!item || typeof item.fact !== 'string' || !SPECIFIC_SECTIONS.includes(item.section)) continue;
            if (!unresolvedOther.includes(item.fact)) continue;
            store.addCoreFact(item.fact, item.section);
            moved += 1;
          }
        }
      } catch {
        // Falha do LLM opcional não interrompe consolidação determinística.
      }
    }

    const deduplicated = deduplicateSections(store);
    return {
      skipped: false,
      moved,
      promoted,
      prunedExpired,
      deduplicated,
    };
  } finally {
    inFlightStores.delete(store);
  }
}

