// Maps reply text to a mouth-viseme timeline for the VRM avatar (shiro).
// The model exposes exactly five viseme morphs — a, I, u, e, o (capital I) —
// and this pure helper turns plain text into a schedule the integrator can
// "mime" while the response streams in: no audio, no engine calls, no
// mutable global state. Vowels (accented or not) open the mouth; other
// letters and digits hold a near-closed mouth for one slot; spaces and
// punctuation only add a short gap to the advance.
//
//   planVisemes('casa')
//   -> { items: [{ name: 'a', at: 55, hold: 55 },
//                { name: 'a', at: 165, hold: 55 }], totalMs: 220 }
//
// `at` is an absolute timestamp (startMs + accumulated offset), `hold` is
// how long the viseme stays applied, and `totalMs` is the total speech
// duration — 0 for empty input, independent of startMs.

// VRM viseme morph names, keyed by base (unaccented, lowercase) vowel.
const VISEME_BY_VOWEL = new Map([
  ['a', 'a'],
  ['e', 'e'],
  ['i', 'I'],
  ['o', 'o'],
  ['u', 'u'],
]);

// Letters and digits occupy a full charMs slot; everything else (spaces,
// punctuation, symbols) is a silent gapMs step.
const SPEAKABLE = /[\p{L}\p{N}]/u;

function visemeFor(char) {
  // Decompose first so any accented vowel folds back to its base letter
  // (ã -> a, í -> i, É -> e, ...), then match case-insensitively.
  const base = Array.from(char.normalize('NFD'))[0].toLowerCase();
  return VISEME_BY_VOWEL.get(base) ?? null;
}

export function planVisemes(text, { charMs = 55, gapMs = 40, startMs = 0 } = {}) {
  const source = String(text ?? '').normalize('NFC');
  const items = [];
  let at = startMs;

  // Only a viseme emitted by the immediately previous char can be merged
  // into; anything else (neutral letter/digit, gap char) closes the run.
  let openItem = null;

  for (const char of source) {
    const speakable = SPEAKABLE.test(char);
    const name = speakable ? visemeFor(char) : null;

    if (name) {
      if (openItem && openItem.name === name) {
        openItem.hold += charMs; // consecutive same-viseme chars fuse
      } else {
        openItem = { name, at, hold: charMs };
        items.push(openItem);
      }
    } else {
      openItem = null;
    }

    at += speakable ? charMs : gapMs;
  }

  return { items, totalMs: at - startMs };
}
