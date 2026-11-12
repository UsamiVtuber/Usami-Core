// Modelos de raciocínio (nemotron e afins) escrevem prosa antes do JSON:
// "The user wants me to ... \n\n{"actions":[...]}". Um JSON.parse direto no
// texto inteiro falha e o chamador descartava as ações em silêncio.
//
// Varre o primeiro objeto balanceado, respeitando aspas e escapes. Devolve
// null quando o objeto não fecha — payload cortado no max_tokens, que tem
// tratamento próprio (salvagem do campo "reply").

export function extractAllJsonCandidates(text) {
  const source = String(text ?? '');
  const candidates = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        candidates.push(source.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return candidates;
}

export function extractJsonCandidate(text) {
  return extractAllJsonCandidates(text)[0] ?? null;
}
