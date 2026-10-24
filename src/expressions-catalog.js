// A curated catalog of VRM expressions. A model's raw `expressionNames` list
// mixes presets, authorial names and prefab separators (shiro exposes 38
// entries); this pure module cleans that list into a bounded, prioritized,
// tagged catalog the chat classifier and the expression panel can consume
// directly. No imports, no side effects: runs the same in Node (server.mjs)
// and in the browser.
import { EXPRESSION_LABELS, EXPRESSION_TAGS } from './emotion-map.js';

// Garbage names: composed only of symbols/underscores/hyphens.
const GARBAGE_NAME_RE = /^[\W_]+$/;
const MIN_NAME_LENGTH = 1;
const MAX_NAME_LENGTH = 40;

// Tag rules, checked in order: the first tag whose keyword list matches wins.
// Keywords are case-insensitive substring tests on the lowercased name.
const TAG_RULES = [
  { tag: 'happy', keywords: ['happy', 'joy', 'smile', 'fun', 'glad'] },
  { tag: 'sad', keywords: ['sad', 'cry', 'sorrow', 'tear'] },
  { tag: 'angry', keywords: ['angry', 'mad', 'rage', 'annoy'] },
  { tag: 'awkward', keywords: ['awkward', 'shy', 'embarrass'] },
  { tag: 'surprised', keywords: ['surprise', 'shock', 'wow', 'amaze'] },
  { tag: 'doubtful', keywords: ['doubt', 'doubtful', 'question'] },
  { tag: 'relaxed', keywords: ['relax', 'calm', 'sleepy', 'tired', 'content'] },
];

// Visemes are exact single-letter names; the remaining speak/blink keywords
// are substring tests, just like the emotion keywords above.
const SPEAK_EXACT_NAMES = new Set(['a', 'i', 'u', 'e', 'o']);
const SPEAK_KEYWORDS = ['viseme', 'talk', 'mouth', 'voice'];
const BLINK_KEYWORDS = ['blink', 'wink', 'closed'];

// Priority groups for ordering: emotions first, then untagged names, then
// mouth mechanics (speak/blink) last.
function priorityGroup(tag) {
  if (tag === 'speak' || tag === 'blink') return 2;
  if (tag === 'other') return 1;
  return 0;
}

function tagExpression(lowerName) {
  if (EXPRESSION_TAGS[lowerName]) return EXPRESSION_TAGS[lowerName];
  for (const rule of TAG_RULES) {
    if (rule.keywords.some(keyword => lowerName.includes(keyword))) return rule.tag;
  }
  if (SPEAK_EXACT_NAMES.has(lowerName)) return 'speak';
  if (SPEAK_KEYWORDS.some(keyword => lowerName.includes(keyword))) return 'speak';
  if (BLINK_KEYWORDS.some(keyword => lowerName.includes(keyword))) return 'blink';
  return 'other';
}

export function labelExpression(name) {
  return EXPRESSION_LABELS[name] || name;
}

// Curates raw expressionNames into { curated, dropped }:
//   1. drops non-strings, empty names, names longer than 40 chars and
//      symbol-only names; dedupes case-insensitively, keeping the first
//      original form;
//   2. tags each survivor by the keyword rules above (first match wins);
//   3. orders emotions -> other -> speak/blink, stable within each group,
//      then truncates to `limit` (default 12).
// `dropped` counts everything that did not make the cut — garbage, duplicates
// and truncation — i.e. list.length - curated.length.
export function curateExpressions(list, { limit = 12 } = {}) {
  const names = Array.isArray(list) ? list : [];

  const seen = new Set();
  const tagged = [];
  let dropped = 0;

  for (const name of names) {
    const valid = typeof name === 'string'
      && name.length >= MIN_NAME_LENGTH
      && name.length <= MAX_NAME_LENGTH
      && !GARBAGE_NAME_RE.test(name);
    if (!valid) {
      dropped += 1;
      continue;
    }
    const key = name.toLowerCase();
    if (seen.has(key)) {
      dropped += 1;
      continue;
    }
    seen.add(key);
    tagged.push({ name, tag: tagExpression(key) });
  }

  const curated = tagged
    .map((entry, index) => ({ entry, index, group: priorityGroup(entry.tag) }))
    .sort((a, b) => a.group - b.group || a.index - b.index)
    .map(({ entry }) => entry)
    .slice(0, limit);

  return { curated, dropped: dropped + (tagged.length - curated.length) };
}
