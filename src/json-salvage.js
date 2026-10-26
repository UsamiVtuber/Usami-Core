// Modelos de raciocínio (nemotron e afins) escrevem prosa antes do JSON:
// "The user wants me to ... \n\n{"actions":[...]}". Um JSON.parse direto no
// texto inteiro falha e o chamador descartava as ações em silêncio.
//
// Varre o primeiro objeto balanceado, respeitando aspas e escapes. Devolve
// null quando o objeto não fecha — payload cortado no max_tokens, que tem
// tratamento próprio (salvagem do campo "reply").

export function extractJsonCandidate(text) {
  const source = String(text ?? '');
  const start = source.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return null;
}
