// Respostas longas viram vários balões (e vários pedidos de TTS) para a voz
// sair mais rápido. Formato decidido pelo usuário: partes de ~60 caracteres,
// no máximo 5 balões, sem nunca perder texto.
//
// Módulo puro: sem imports e sem efeitos colaterais — roda em Node para
// teste e no browser igual.
//
// Estratégia:
//  1. divide por fronteira de frase (`.`, `!`, `?`, `…`, quebra de linha),
//     mantendo o delimitador na frase que ele encerra;
//  2. frases maiores que `maxChars` são cortadas em fronteira de palavra
//     (uma palavra sem fronteira maior que `maxChars` é fatiada — o texto
//     nunca é descartado);
//  3. empacota as frases greedy em partes de até `maxChars`;
//  4. se o resultado passar de `maxParts`, a ÚLTIMA parte absorve o resto.

const SENTENCE_ENDERS = new Set(['.', '!', '?', '…', '\n']);

export function splitReplyParts(reply, { maxChars = 60, maxParts = 5 } = {}) {
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 60;
  const cap = Number.isFinite(maxParts) && maxParts > 0 ? Math.floor(maxParts) : 5;
  const text = String(reply ?? '');
  if (!text.trim()) return [];

  // 1. Fronteiras de frase: o delimitador fica com a frase que ele encerra.
  const sentences = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (!SENTENCE_ENDERS.has(text[index])) continue;
    // Execução de pontuação ("...", "?!") é UMA fronteira: cortando a cada
    // caractere o balão sai "cobaias. . ." — artefato que também sai na voz.
    if (SENTENCE_ENDERS.has(text[index + 1] ?? '')) continue;
    sentences.push(text.slice(start, index + 1));
    start = index + 1;
  }
  if (start < text.length) sentences.push(text.slice(start));

  // 2. Átomos: frases limpas; as gigantes cortadas em fronteira de palavra.
  const atoms = [];
  for (const raw of sentences) {
    const sentence = raw.trim();
    if (!sentence) continue;
    if (sentence.length <= limit) { atoms.push(sentence); continue; }
    let line = '';
    for (const word of sentence.split(/\s+/)) {
      if (!word) continue;
      if (line && line.length + 1 + word.length <= limit) { line += ` ${word}`; continue; }
      if (line) atoms.push(line);
      // Palavra maior que o limite sem fronteira possível: fatia bruta.
      let rest = word;
      while (rest.length > limit) { atoms.push(rest.slice(0, limit)); rest = rest.slice(limit); }
      line = rest;
    }
    if (line) atoms.push(line);
  }

  // 3. Empacotamento greedy até `limit`.
  const parts = [];
  let pack = '';
  for (const atom of atoms) {
    if (!pack) { pack = atom; continue; }
    if (pack.length + 1 + atom.length <= limit) { pack += ` ${atom}`; continue; }
    parts.push(pack);
    pack = atom;
  }
  if (pack) parts.push(pack);

  // 4. Teto de balões: a última parte absorve o resto — nunca descarte.
  if (parts.length > cap) {
    const capped = parts.slice(0, cap - 1);
    capped.push(parts.slice(cap - 1).join(' '));
    return capped;
  }
  return parts;
}
