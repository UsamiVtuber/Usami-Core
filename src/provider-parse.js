// Parse e limpeza de saídas de LLM — módulo puro (sem HTTP, sem stores).
//
// Antes estas funções moravam em server.mjs e src/flow-services.js importava
// dele, criando um ciclo com efeitos colaterais: avaliar o serviço de fluxo
// avaliava o servidor, criava os depósitos de memória/personalidade e exportava
// a chave NVIDIA para process.env (B12). O parser em si é puro: recebe texto e
// devolve objeto, então vive aqui e qualquer módulo de src/ pode importá-lo
// sem arrastar o servidor. O server.mjs re-exporta os nomes antigos para os
// testes e chamadores existentes continuarem funcionando.

import { DIRECTOR_VERBS, GESTURE_NAMES, SHAPE_NAMES } from './motion-director.js';
import { extractSpeechTags } from './speech-tags.js';
import { extractJsonCandidate } from './json-salvage.js';
import { MEMORY_SECTIONS } from './memory-store.js';

export const SPEECH_TRIGGERS = ['start', 'middle', 'end'];

// Teto do reply exibido no chat: falas viram balões curtos (decisão do
// usuário), então o servidor corta em fronteira de sentença — não só o prompt.
export const REPLY_CHAR_LIMIT = 220;

export function sanitizeCapabilities(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const names = (list, limit, allowed) => (Array.isArray(list) ? list.filter(value => typeof value === 'string' && value.length > 0).map(value => value.slice(0, 60)).filter(value => !allowed || allowed.includes(value)).slice(0, limit) : []);
  const meshes = Array.isArray(input.meshes) ? input.meshes.filter(mesh => typeof mesh?.name === 'string' && mesh.name.length > 0).map(mesh => ({ name: mesh.name.slice(0, 60), accessory: mesh.accessory === true })).slice(0, 100) : [];
  return {
    format: typeof input.format === 'string' ? input.format.slice(0, 40) : '',
    clips: names(input.clips, 40),
    morphs: names(input.morphs, 60),
    meshes,
    expressions: names(input.expressions, 20),
    gestures: names(input.gestures, 20, GESTURE_NAMES),
    sequences: input.sequences === true,
  };
}

export function sanitizeActions(raw) {
  const actions = Array.isArray(raw) ? raw : [];
  return actions.filter(action => action && typeof action === 'object' && !Array.isArray(action) && DIRECTOR_VERBS.includes(action.type)).slice(0, 5).map(action => {
    const base = { type: action.type, name: typeof action.name === 'string' ? action.name.slice(0, 60) : action.name };
    if (action.type === 'set_morph') base.value = action.value;
    if (action.type === 'set_mesh_visible') base.visible = action.visible;
    if (action.type === 'set_expression') base.weight = action.weight;
    // play_sequence: só o vocabulário (shape) e parâmetros numéricos limitados
    // passam; os keyframes são expandidos localmente pelo buildSequenceRequest.
    if (action.type === 'play_sequence') {
      if (!SHAPE_NAMES.includes(action.shape)) return null;
      base.shape = action.shape;
      if (action.side === 'left' || action.side === 'right') base.side = action.side;
      for (const key of ['amplitude', 'cycles', 'durationMs']) {
        if (Number.isFinite(action[key])) base[key] = action[key];
      }
    }
    // Timing por frase: delayMs (ms após o início da fala) e trigger
    // ('start' | 'middle' | 'end') são metadados do cliente, preservados
    // para agendamento sincronizado com o áudio TTS.
    if (typeof action.delayMs === 'number' && Number.isFinite(action.delayMs) && action.delayMs >= 0) {
      base.delayMs = Math.round(action.delayMs);
    }
    if (SPEECH_TRIGGERS.includes(action.trigger)) {
      base.trigger = action.trigger;
    }
    return base;
  }).filter(Boolean);
}

// O modelo inventa sinônimos para os verbos do diretor ("expression" em vez de
// "set_expression"); sem essa ponte a ação passa pelo filtro e morre no director.
const ACTION_TYPE_ALIASES = { expression: 'set_expression', emote: 'set_expression', morph: 'set_morph', vrma: 'play_vrma' };

export function filterActionsByCatalog(actions, capabilities) {
  const known = (list) => (!Array.isArray(list) ? null : new Set(list));
  const sets = capabilities ? {
    gesture: known(capabilities.gestures),
    play_clip: known(capabilities.clips),
    set_morph: known(capabilities.morphs),
    set_expression: known(capabilities.expressions),
    play_vrma: known(capabilities.gestures),
  } : {};
  return (Array.isArray(actions) ? actions : [])
    .map(action => {
      const alias = ACTION_TYPE_ALIASES[action?.type];
      return alias ? { ...action, type: alias } : action;
    })
    .filter(action => {
      const set = sets[action?.type];
      return set ? set.has(action?.name) : true; // sem catálogo conhecido → mantém
    });
}

// Rubrica de roleplay: o modelo descreve a ação DENTRO de reply ("*bufa, braços
// cruzados*"). O balão e o /api/tts falam o texto cru, então a rubrica é lida em
// voz alta. A fala é só o que se diz; reação física tem canal próprio (actions/
// gesture), então o texto descritivo não tem para onde ir além de sair.
export function stripStageDirections(reply) {
  return String(reply ?? '')
    .replace(/\*+[^*\n]*\*+/g, ' ')
    .replace(/\*/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function capReplyLength(reply, limit = REPLY_CHAR_LIMIT) {
  if (reply.length <= limit) return reply;
  const window = reply.slice(0, limit);
  for (let i = window.length - 1; i >= 0; i -= 1) {
    if ('.!?;:'.includes(window[i])) return window.slice(0, i + 1).trimEnd();
  }
  const space = window.lastIndexOf(' ');
  return (space > 0 ? window.slice(0, space) : window).trimEnd();
}

// Única limpeza de JSON vazado do projeto (B14). Era copiada em server.mjs,
// streaming-parser.js (duas vezes) e nos parsers de técnica/media com drift;
// aqui é a fonte e o restante importa daqui.
export function stripLeakedJson(reply) {
  return String(reply ?? '')
    // Remove qualquer vazamento de chaves do schema JSON dentro ou no fim do reply
    // Ex.: `','gesture': 'angry','actions': [{'type':` ou `"gesture":"angry","actions":[...`
    .replace(/['",\s]*\\?["'](?:gesture|actions|remember|speechTags|set_expression|play_clip|set_morph|set_mesh_visible|play_sequence|play_vrma)\\?["']\s*:\s*[\s\S]*$/i, '')
    // Remove fragmentos truncados de arrays/objetos JSON no fim da frase (ex.: ` [{'type':` ou ` {"type":`)
    .replace(/[\s,'"]*\[\s*\{\s*\\?['"]?(?:type|name|section|fact)\\?['"]?\s*:?[\s\S]*$/i, '')
    // Remove aspas/vírgulas de fechamento de propriedade JSON vazadas no final (ex.: `!' ,'` ou `!",`)
    .replace(/['"]\s*,\s*['"]?\s*$/, '')
    .trim();
}

// Remove a cerca de código (```json ... ```) que alguns provedores devolvem em
// volta do JSON. Um único lugar para os quatro parsers.
export function stripCodeFence(text) {
  return String(text ?? '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '');
}

// JSON "quase": parse direto e, se falhar, o primeiro objeto balanceado (o
// modelo escreve raciocínio antes do JSON). Devolve { ok, value } — o chamador
// decide o fallback (default, warning, salvamento de reply).
export function parseJsonLoosely(raw) {
  const text = stripCodeFence(raw);
  try {
    return { ok: true, value: JSON.parse(text), text };
  } catch {
    const candidate = extractJsonCandidate(text);
    if (candidate) {
      try {
        return { ok: true, value: JSON.parse(candidate), text };
      } catch {}
    }
    return { ok: false, value: null, text };
  }
}

function salvageLeakedGesture(rawText) {
  const match = /['",\s]\\?["']gesture\\?["']\s*:\s*\\?["']([a-zA-Z0-9_-]+)\\?["']/i.exec(String(rawText ?? ''));
  if (!match) return null;
  const candidate = match[1].trim();
  return GESTURE_NAMES.includes(candidate) ? candidate : null;
}

function cleanReply(reply) {
  const { text, tags } = extractSpeechTags(stripStageDirections(stripLeakedJson(reply)));
  return { display: capReplyLength(text), tags };
}

// Extrai o valor da chave "reply" de JSON truncado/inválido: lê até a próxima
// aspa não escapada OU o fim da string (payload cortado no max_tokens),
// decodificando os escapes mais comuns. Retorna null sem conteúdo recuperável.
// A aspa de abertura da chave é opcional: modelos truncados já emitiram
// `{reply":"...` e o texto livre jamais deve chegar ao balão.
function extractReplyFromBrokenJson(text) {
  const keyMatch = /"?reply"?\s*:\s*"/.exec(text);
  if (!keyMatch) return null;
  let out = '';
  for (let i = keyMatch.index + keyMatch[0].length; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') break;
    if (ch === '\\') {
      const next = text[i + 1];
      if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) {
        out += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16));
        i += 5;
        continue;
      }
      if (next === 'n') { out += '\n'; i += 1; continue; }
      if (next === 't') { out += '\t'; i += 1; continue; }
      if (next && '"\\/bfr'.includes(next)) {
        out += next === 'b' ? '\b' : next === 'f' ? '\f' : next === 'r' ? '\r' : next;
        i += 1;
        continue;
      }
      // escape desconhecido: mantém o caractere, descarta a barra
      if (next) { out += next; i += 1; }
      continue;
    }
    out += ch;
  }
  return out.trim() || null;
}

// Fato "remember" do schema da persona: string (v1) ou {fact, section}.
// A string antiga ainda é aceita e cai em "other" — o modelo às vezes ignora
// o formato novo, e perder o fato seria pior que perdê-lo sem seção.
export function normalizeRemember(value) {
  const cleanFact = (fact) => {
    if (typeof fact !== 'string') return null;
    const trimmed = fact.trim();
    if (!trimmed || trimmed.toLowerCase() === 'null' || trimmed.toLowerCase() === 'undefined') return null;
    return trimmed.slice(0, 300);
  };
  if (typeof value === 'string') {
    const fact = cleanFact(value);
    return fact ? { fact, section: 'other' } : null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const fact = cleanFact(value.fact);
  if (!fact) return null;
  const section = MEMORY_SECTIONS.includes(value.section) ? value.section : 'other';
  return { fact, section };
}

export function parseProviderRaw(raw) {
  if (typeof raw !== 'string' || raw.length > 10000) {
    return { ok: false, status: 502, error: 'Resposta inválida do provedor.' };
  }
  let result;
  try {
    result = JSON.parse(stripCodeFence(raw));
  } catch {
    const trimmed = raw.trim();
    // Preâmbulo de raciocínio antes do JSON: o primeiro objeto balanceado ainda
    // é a resposta. Sem isto o texto do "pensamento" inteiro viria no balão.
    const embedded = extractJsonCandidate(trimmed);
    if (embedded) {
      try {
        result = JSON.parse(embedded);
      } catch {
        result = null;
      }
    }
    if (!result) {
      // Se a resposta parece JSON de erro ({"error": ...}), tenta extrair a mensagem
      if (/^[{[]/.test(trimmed)) {
        try {
          const errorJson = JSON.parse(trimmed);
          if (errorJson?.error?.message) {
            return { ok: false, status: 502, error: errorJson.error.message };
          }
        } catch {}
      }
      if (trimmed.startsWith('{')) {
        // JSON truncado/inválido: recupera apenas o "reply". As actions de um
        // payload incompleto são descartadas (decisão do usuário) e o texto
        // bruto jamais vira reply — sem conteúdo recuperável, erro amigável.
        const salvaged = extractReplyFromBrokenJson(trimmed);
        if (!salvaged) {
          return { ok: false, status: 502, error: 'O modelo retornou uma resposta inválida.' };
        }
        const cleaned = cleanReply(salvaged);
        if (!cleaned.display) {
          return { ok: false, status: 502, error: 'O modelo retornou uma resposta inválida.' };
        }
        const salvagedGesture = salvageLeakedGesture(trimmed) || 'neutral';
        return { ok: true, reply: cleaned.display, gesture: salvagedGesture, actions: [], remember: null, ...(cleaned.tags.length ? { speechTags: cleaned.tags } : {}) };
      }
      // Caso contrário, trata o texto bruto como resposta livre
      result = { reply: trimmed, gesture: 'neutral' };
    }
  }
  // A rubrica sai ANTES das validações: reply que era só descrição de ação não
  // é fala, e cai no 502 amigável em vez de chegar vazio ao cliente. As tags
  // não-verbais também saem do texto exibido e voltam em `speechTags`.
  if (typeof result?.reply !== 'string' || !result.reply.trim() || result.reply.length > 2000) {
    return { ok: false, status: 502, error: 'O modelo retornou uma resposta inválida.' };
  }
  const salvagedFromReply = salvageLeakedGesture(result.reply);
  const cleaned = cleanReply(result.reply);
  if (!cleaned.display) {
    return { ok: false, status: 502, error: 'O modelo retornou uma resposta inválida.' };
  }
  const rawGesture = (result.gesture && result.gesture !== 'neutral') ? result.gesture : salvagedFromReply;
  return {
    ok: true,
    reply: cleaned.display,
    gesture: GESTURE_NAMES.includes(rawGesture) ? rawGesture : 'neutral',
    actions: sanitizeActions(result.actions),
    remember: normalizeRemember(result.remember),
    ...(cleaned.tags.length ? { speechTags: cleaned.tags } : {}),
  };
}
