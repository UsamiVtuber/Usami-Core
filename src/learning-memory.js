// Fase 5: memória de APRENDIZAGEM — o que o avatar já tentou, como foi medido e
// o que o humano achou. Separada de `memory-store.js` de propósito: aquela guarda
// conversa e afinidade (o que a personagem sabe SOBRE a pessoa); esta guarda
// histórico de movimento (o que o rig aprendeu sobre si mesmo). Misturar as duas
// faria um veredito visual virar "fato do usuário" e vice-versa.
//
// Nada aqui aprende sozinho: o módulo registra, valida e resume. A decisão de
// tentar de novo é do planner (animation-planner.js), que só lê números.
//
// Conteúdo fechado: ids, assinaturas, números, enums conhecidos e a nota humana
// (dado de auditoria, nunca interpretado). Texto de tutorial não entra — a técnica
// fica em `data/techniques`, o material bruto no pipeline de ingestão. Um arquivo
// desta memória com prosa de tutorial é sinal de wiring errado, e a validação de
// entrada existe justamente para tornar isso um erro e não um comportamento.
//
// Um registro por par (técnica, assinatura de movimento), com última escrita
// vencedora e origem da escrita em `source` (enum LEARNING_SOURCES). `record` grava
// o resultado OBJETIVO (veredito, nota, métrica, ajustamentos) e marca 'experimentador';
// `noteVisualVerdict` grava só o veredito humano e marca 'humano', sem jamais tocar
// em métrica ou score. Não há dois campos de veredito que possam se contradizer: o
// objetivo é o último resultado medido, o humano é a última observação, e `source`
// diz quem escreveu por último neste registro.
//
// (Não confundir com `source` do plano, que responde outra pergunta: de onde veio a
// animação escolhida — 'kb' ou 'fallback'. Os dois enums são exports próprios.)
//
// Corrupção é erro explícito e o arquivo continua intacto: histórico de
// aprendizagem serve para auditoria, e sobrescrever lixo com um estado vazio
// apagaria a evidência.

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { VISUAL_VERDICTS } from './motion-experiments.js';
import { SHAPE_PARAMS } from './sequence-shapes.js';

export const LEARNING_FILE = 'learning.json';
export const LEARNING_FILE_VERSION = 1;

// Veredito OBJETIVO do avaliador (motion-evaluation.js) — distinto do julgamento
// visual humano, que tem seus próprios enums em VISUAL_VERDICTS e nunca se confunde.
export const OBJECTIVE_VERDICTS = Object.freeze(['pass', 'warn', 'fail']);

// Origem da última escrita do registro. A métrica do motor e a observação humana
// são coisas diferentes, mas o histórico de uma tentativa é o mesmo assunto: em
// vez de dois campos que podem se contradizer, um registro por (técnica,
// assinatura) e a informação de quem escreveu por último.
export const LEARNING_SOURCES = Object.freeze(['experimentador', 'humano']);

export const LEARNING_LIMITS = Object.freeze({
  maxEntries: 5000,
  maxFileBytes: 2 * 1024 * 1024,
  maxNoteChars: 500,
  maxAdjustments: 8,
  maxAdjustmentParams: 4,
});

// Projeção das métricas do avaliador: os números que o planner pode comparar. Na
// escrita, o que não é número conhecido fica de fora (o objeto do avaliador traz
// `byChannel` e `conflicts`, que não servem para ranquear); na leitura do nosso
// próprio arquivo chave desconhecida é erro — nada de objeto arbitrário crescendo
// dentro da memória.
export const LEARNING_METRIC_KEYS = Object.freeze([
  'durationMs', 'channels', 'samples', 'sampleMs',
  'peakOffsetRad', 'peakVelocityRadS', 'peakAccelerationRadS2', 'peakJerkRadS3',
  'pathLengthRad', 'restDeltaStartRad', 'restDeltaEndRad', 'amplitudeUsage',
]);

export const LEARNING_OUTCOME_KEYS = Object.freeze(['score', 'verdict', 'metrics', 'adjustments']);
export const LEARNING_ENTRY_KEYS = Object.freeze([
  'techniqueId', 'signature', 'attempts', 'successes', 'failures',
  'source', 'bestScore', 'lastScore', 'metrics', 'adjustments', 'visual', 'firstAt', 'lastAt',
]);

const TECHNIQUE_ID_RE = /^tc-[0-9a-f]{12}$/;
const SIGNATURE_RE = /^[0-9a-f]{12}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

const ADJUSTMENT_KEYS = Object.freeze([...new Set(Object.values(SHAPE_PARAMS).flatMap(spec => spec.names))]);
const SIDES = new Set(['left', 'right']);

const plainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const clone = value => JSON.parse(JSON.stringify(value));
const serializeFile = entries => `${JSON.stringify({ version: LEARNING_FILE_VERSION, entries }, null, 2)}\n`;
const fail = message => {
  throw new Error(message);
};

const isCount = value => Number.isInteger(value) && value >= 0;
const isScore = value => Number.isFinite(value) && value >= 0 && value <= 100;

function readTechniqueId(value, label) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !TECHNIQUE_ID_RE.test(value)) {
    fail(`${label}: id de técnica ${JSON.stringify(value)} fora do padrão tc-<12 hex>`);
  }
  return value;
}

function readSignature(value, label) {
  if (typeof value !== 'string' || !SIGNATURE_RE.test(value)) {
    fail(`${label}: assinatura ${JSON.stringify(value)} inválida (esperado hex de 12 chars de signatureOf)`);
  }
  return value;
}

function readNote(value, label) {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') fail(`${label}.note: nota deve ser texto`);
  const note = value.replace(/\s+/g, ' ').trim();
  if (note.length > LEARNING_LIMITS.maxNoteChars) {
    fail(`${label}.note: nota com ${note.length} caracteres excede ${LEARNING_LIMITS.maxNoteChars}`);
  }
  return note;
}

function readVisual(raw, label) {
  if (raw === null || raw === undefined) return null;
  if (!plainObject(raw)) fail(`${label}.visual: veredito visual deve ser objeto ou null`);
  if (!VISUAL_VERDICTS.includes(raw.verdict)) {
    fail(`${label}.visual: veredito ${JSON.stringify(raw.verdict)} fora de ${VISUAL_VERDICTS.join('/')}`);
  }
  const extra = Object.keys(raw).filter(key => !['verdict', 'note', 'at'].includes(key));
  if (extra.length) fail(`${label}.visual: campos desconhecidos ${extra.join(', ')}`);
  if (!ISO_RE.test(raw.at ?? '')) fail(`${label}.visual: judgedAt deve ser ISO-8601`);
  return { verdict: raw.verdict, note: readNote(raw.note, `${label}.visual`), at: raw.at };
}

// Métricas são projetadas sobre as chaves conhecidas. Chave desconhecida na ESCRITA
// é erro (contrato fechado); na LEITURA do nosso próprio arquivo é corrupção.
function readMetrics(raw, label, { strict } = {}) {
  if (raw === null || raw === undefined) return null;
  if (!plainObject(raw)) fail(`${label}.metrics: métricas devem ser objeto ou null`);
  const known = {};
  let conflicts = null;
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'conflicts') {
      const count = Array.isArray(value) ? value.length : value;
      if (!Number.isFinite(count) || count < 0) fail(`${label}.metrics.conflicts: número inválido`);
      conflicts = Math.round(count);
      continue;
    }
    if (!LEARNING_METRIC_KEYS.includes(key)) {
      // projeção: campos que não são número conhecido não entram na memória
      if (strict) fail(`${label}.metrics: chave desconhecida ${key}`);
      continue;
    }
    if (!Number.isFinite(value)) fail(`${label}.metrics.${key}: valor não numérico ${JSON.stringify(value)}`);
    known[key] = value;
  }
  if (conflicts !== null) known.conflicts = conflicts;
  return known;
}

function readAdjustParams(raw, label) {
  if (!plainObject(raw)) fail(`${label}.params: adjustments aceitos devem ser um objeto de parâmetros`);
  const keys = Object.keys(raw);
  if (!keys.length) fail(`${label}.params: adjustments vazio`);
  if (keys.length > LEARNING_LIMITS.maxAdjustmentParams) {
    fail(`${label}.params: ${keys.length} parâmetros excede ${LEARNING_LIMITS.maxAdjustmentParams}`);
  }
  const params = {};
  for (const key of keys) {
    if (!ADJUSTMENT_KEYS.includes(key)) fail(`${label}.params: parâmetro ${JSON.stringify(key)} fora do vocabulário de shapes`);
    const value = raw[key];
    if (key === 'side') {
      if (!SIDES.has(value)) fail(`${label}.params.side: ${JSON.stringify(value)} fora de left/right`);
      params.side = value;
      continue;
    }
    if (!Number.isFinite(value)) fail(`${label}.params.${key}: número não finito ${JSON.stringify(value)}`);
    params[key] = value;
  }
  return params;
}

function readAdjustments(raw, label) {
  if (raw === null || raw === undefined) return undefined;
  if (!plainObject(raw)) fail(`${label}: adjustments deve ser objeto de parâmetros`);
  return { at: null, params: readAdjustParams(raw, label) };
}

function readOutcome(raw, label) {
  if (!plainObject(raw)) fail(`${label}: outcome deve ser objeto { score?, verdict?, metrics?, adjustments? }`);
  const extra = Object.keys(raw).filter(key => !LEARNING_OUTCOME_KEYS.includes(key));
  if (extra.length) fail(`${label}: campos desconhecidos em outcome (${extra.join(', ')})`);
  if (raw.score !== undefined && !isScore(raw.score)) {
    fail(`${label}.score: nota deve ser número finito entre 0 e 100 (recebido ${JSON.stringify(raw.score)})`);
  }
  if (raw.verdict !== undefined && !OBJECTIVE_VERDICTS.includes(raw.verdict)) {
    fail(`${label}.verdict: ${JSON.stringify(raw.verdict)} fora de ${OBJECTIVE_VERDICTS.join('/')}`);
  }
  const outcome = {
    metrics: readMetrics(raw.metrics, label),
    adjustments: readAdjustments(raw.adjustments, label),
  };
  if (raw.score !== undefined) outcome.score = raw.score;
  if (raw.verdict !== undefined) outcome.verdict = raw.verdict;
  if (outcome.metrics === null && outcome.adjustments === undefined && raw.score === undefined && raw.verdict === undefined) {
    fail(`${label}: outcome vazio — registre ao menos uma métrica, nota ou veredito`);
  }
  return outcome;
}

// Leitura do arquivo: nada é "consertado". Cada campo é revalidado; um número
// impossível ou uma enumeração desconhecida é erro, porque esse arquivo foi
// gravado por nós e não deveria conter isso.
function readEntry(raw, position) {
  const label = `learning.entries[${position}]`;
  if (!plainObject(raw)) fail(`${label}: entrada deve ser objeto`);
  const extra = Object.keys(raw).filter(key => !LEARNING_ENTRY_KEYS.includes(key));
  if (extra.length) fail(`${label}: campos desconhecidos (${extra.join(', ')})`);
  if (!isCount(raw.attempts) || !isCount(raw.successes) || !isCount(raw.failures)) {
    fail(`${label}: contadores devem ser inteiros não negativos`);
  }
  if (raw.successes + raw.failures > raw.attempts) fail(`${label}: successes+failures excede attempts`);
  if (raw.bestScore !== null && !isScore(raw.bestScore)) fail(`${label}: bestScore inválido`);
  if (raw.lastScore !== null && !isScore(raw.lastScore)) fail(`${label}: lastScore inválido`);
  if (!LEARNING_SOURCES.includes(raw.source)) {
    fail(`${label}: source ${JSON.stringify(raw.source)} fora de ${LEARNING_SOURCES.join('/')}`);
  }
  if (!ISO_RE.test(raw.firstAt ?? '') || !ISO_RE.test(raw.lastAt ?? '')) fail(`${label}: timestamps devem ser ISO-8601`);
  if (!Array.isArray(raw.adjustments) || raw.adjustments.length > LEARNING_LIMITS.maxAdjustments) {
    fail(`${label}: adjustments deve ser lista de até ${LEARNING_LIMITS.maxAdjustments} itens`);
  }
  return {
    techniqueId: readTechniqueId(raw.techniqueId, label),
    signature: readSignature(raw.signature, label),
    attempts: raw.attempts,
    successes: raw.successes,
    failures: raw.failures,
    source: raw.source,
    bestScore: raw.bestScore,
    lastScore: raw.lastScore,
    metrics: readMetrics(raw.metrics, label, { strict: true }),
    adjustments: raw.adjustments.map((item, index) => {
      if (!plainObject(item) || Object.keys(item).some(key => key !== 'at' && key !== 'params')) {
        fail(`${label}.adjustments[${index}]: espera { at, params }`);
      }
      if (!ISO_RE.test(item.at ?? '')) fail(`${label}.adjustments[${index}]: at deve ser ISO-8601`);
      return { at: item.at, params: readAdjustParams(item, `${label}.adjustments[${index}]`) };
    }),
    visual: readVisual(raw.visual, label),
    firstAt: raw.firstAt,
    lastAt: raw.lastAt,
  };
}

function readEntries(rawEntries) {
  if (!Array.isArray(rawEntries)) fail('learning.entries: ausência de lista de entradas');
  const seen = new Set();
  return rawEntries.map((item, index) => {
    const entry = readEntry(item, index);
    const key = `${entry.techniqueId ?? '*'}|${entry.signature}`;
    if (seen.has(key)) fail(`learning.entries[${index}]: duplicata de técnica+assinatura`);
    seen.add(key);
    return entry;
  });
}

const keyOf = entry => `${entry.techniqueId ?? '*'}|${entry.signature}`;

/**
 * Memória persistente de aprendizagem.
 * @param {{ dataDir?: string, now?: () => number, maxEntries?: number, maxFileBytes?: number }} options
 * Relógio injetável; toda leitura é validada e toda escrita é atômica (tmp + rename).
 */
export function createLearningMemory({
  dataDir = 'data',
  now = () => Date.now(),
  maxEntries = LEARNING_LIMITS.maxEntries,
  maxFileBytes = LEARNING_LIMITS.maxFileBytes,
} = {}) {
  if (typeof dataDir !== 'string' || !dataDir) fail('createLearningMemory: dataDir é string não vazia.');
  if (!Number.isInteger(maxEntries) || maxEntries < 1) fail('createLearningMemory: maxEntries deve ser inteiro positivo.');
  if (!Number.isInteger(maxFileBytes) || maxFileBytes < 1) fail('createLearningMemory: maxFileBytes deve ser inteiro positivo.');

  const filePath = join(dataDir, LEARNING_FILE);
  let state = null;

  function load() {
    if (state) return state;
    let raw;
    try {
      raw = readFileSync(filePath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') {
        state = { version: LEARNING_FILE_VERSION, entries: [] };
        return state;
      }
      fail(`memória de aprendizagem ilegível em ${filePath}: ${error.message}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      fail(`memória de aprendizagem corrompida em ${filePath}: JSON inválido (${error.message}). Arquivo preservado — corrija ou remova antes de gravar.`);
    }
    if (!plainObject(parsed)) fail(`memória de aprendizagem inválida em ${filePath}: topo deve ser objeto`);
    if (parsed.version !== LEARNING_FILE_VERSION) fail(`memória de aprendizagem inválida em ${filePath}: version esperada ${LEARNING_FILE_VERSION}`);
    state = { version: LEARNING_FILE_VERSION, entries: readEntries(parsed.entries) };
    return state;
  }

  // FIFO por data da última atividade + teto de bytes do arquivo (o tamanho
  // medido é o do arquivo inteiro, com o invólucro e a indentação).
  function trim(entries) {
    const ordered = [...entries].sort((a, b) => a.lastAt.localeCompare(b.lastAt) || keyOf(a).localeCompare(keyOf(b)));
    let kept = ordered.slice(Math.max(0, ordered.length - maxEntries));
    const bytes = value => Buffer.byteLength(serializeFile(value), 'utf8');
    while (kept.length > 1 && bytes(kept) > maxFileBytes) {
      kept = kept.slice(Math.ceil(kept.length * 0.1));
    }
    return kept;
  }

  function persist() {
    state = { version: LEARNING_FILE_VERSION, entries: trim(load().entries) };
    mkdirSync(dataDir, { recursive: true });
    const temporary = `${filePath}.${process.pid}.${now()}.tmp`;
    writeFileSync(temporary, serializeFile(state.entries), 'utf8');
    try {
      renameSync(temporary, filePath);
    } catch (error) {
      try {
        unlinkSync(temporary);
      } catch {}
      if (error?.code !== 'EEXIST' && error?.code !== 'EPERM') throw error;
    }
    return state;
  }

  function freshEntry(techniqueId, signature, at) {
    return {
      techniqueId,
      signature,
      attempts: 0,
      successes: 0,
      failures: 0,
      source: null,
      bestScore: null,
      lastScore: null,
      metrics: null,
      adjustments: [],
      visual: null,
      firstAt: at,
      lastAt: at,
    };
  }

  function findOrCreate(techniqueId, signature) {
    const entries = load().entries;
    const key = keyOf({ techniqueId, signature });
    const existing = entries.find(item => keyOf(item) === key);
    if (existing) return existing;
    const entry = freshEntry(techniqueId, signature, new Date(now()).toISOString());
    entries.push(entry);
    return entry;
  }

  /** Registra uma tentativa e o resultado objetivo do avaliador. */
  function record(input) {
    if (!plainObject(input)) fail('record: espera { techniqueId, signature, outcome }.');
    const extra = Object.keys(input).filter(key => !['techniqueId', 'signature', 'outcome'].includes(key));
    if (extra.length) fail(`record: campos desconhecidos (${extra.join(', ')})`);
    const techniqueId = readTechniqueId(input.techniqueId, 'record.techniqueId');
    const signature = readSignature(input.signature, 'record.signature');
    const outcome = readOutcome(input.outcome, 'record.outcome');

    const at = new Date(now()).toISOString();
    const entry = findOrCreate(techniqueId, signature);
    entry.attempts += 1;
    // contadores objetivivos: veredito do avaliador. 'warn' conta como tentativa
    // sem ser sucesso nem fracasso — não inflar nem punir sinal ambíguo.
    if (outcome.verdict === 'pass') entry.successes += 1;
    else if (outcome.verdict === 'fail') entry.failures += 1;
    // quem escreveu por último: medida do avaliador
    entry.source = 'experimentador';
    if (outcome.score !== undefined) {
      entry.lastScore = outcome.score;
      entry.bestScore = entry.bestScore === null ? outcome.score : Math.max(entry.bestScore, outcome.score);
    }
    if (outcome.metrics !== null) entry.metrics = outcome.metrics;
    if (outcome.adjustments) {
      entry.adjustments = [...entry.adjustments, { ...outcome.adjustments, at }].slice(-LEARNING_LIMITS.maxAdjustments);
    }
    entry.lastAt = at;
    return clone(persist().entries.find(item => item === entry));
  }

  /** Anexo do humano: veredito visual e nota. Não toca em métrica nem em score. */
  function noteVisualVerdict(input) {
    if (!plainObject(input)) fail('noteVisualVerdict: espera { techniqueId, signature, verdict, note }.');
    const extra = Object.keys(input).filter(key => !['techniqueId', 'signature', 'verdict', 'note'].includes(key));
    if (extra.length) fail(`noteVisualVerdict: campos desconhecidos (${extra.join(', ')})`);
    const techniqueId = readTechniqueId(input.techniqueId, 'noteVisualVerdict.techniqueId');
    const signature = readSignature(input.signature, 'noteVisualVerdict.signature');
    if (!VISUAL_VERDICTS.includes(input.verdict)) {
      fail(`noteVisualVerdict.verdict: ${JSON.stringify(input.verdict)} fora de ${VISUAL_VERDICTS.join('/')}`);
    }
    const note = readNote(input.note, 'noteVisualVerdict');
    const at = new Date(now()).toISOString();
    const entry = findOrCreate(techniqueId, signature);
    entry.visual = { verdict: input.verdict, note, at };
    entry.source = 'humano';
    entry.lastAt = at;
    return clone(persist().entries.find(item => item === entry));
  }

  // statsFor aceita id de técnica OU assinatura — os dois padrões são distinguíveis,
  // então não há ambiguidade adivinhar o que foi pedido. O agregado diz quantos
  // registros entraram na conta (`matched`), porque técnica e assinatura podem
  // cobrir conjuntos diferentes de tentativas.
  function lookup(key) {
    if (typeof key === 'string' && TECHNIQUE_ID_RE.test(key)) return load().entries.filter(entry => entry.techniqueId === key);
    if (typeof key === 'string' && SIGNATURE_RE.test(key)) return load().entries.filter(entry => entry.signature === key);
    fail(`statsFor: ${JSON.stringify(key)} não é id de técnica (tc-<12 hex>) nem assinatura (12 hex)`);
  }

  function aggregate(entries) {
    const ordered = [...entries].sort((a, b) => b.lastAt.localeCompare(a.lastAt) || keyOf(a).localeCompare(keyOf(b)));
    const scores = entries.map(entry => entry.bestScore).filter(value => value !== null);
    const judged = ordered.find(entry => entry.visual);
    return {
      attempts: entries.reduce((sum, entry) => sum + entry.attempts, 0),
      successes: entries.reduce((sum, entry) => sum + entry.successes, 0),
      failures: entries.reduce((sum, entry) => sum + entry.failures, 0),
      bestScore: scores.length ? Math.max(...scores) : null,
      lastScore: ordered[0].lastScore,
      lastSource: ordered[0].source,
      metrics: ordered.find(entry => entry.metrics)?.metrics ?? null,
      adjustments: ordered[0].adjustments,
      visual: judged ? judged.visual : null,
      firstAt: entries.map(entry => entry.firstAt).sort()[0],
      lastAt: ordered[0].lastAt,
    };
  }

  function statsFor(key) {
    const found = lookup(key);
    if (!found.length) return null;
    return clone({ matched: found.length, ...aggregate(found) });
  }

  /** Melhor assinatura entre as que têm histórico (nota máxima, depois sucesso). */
  function bestFor(signatures) {
    const list = (Array.isArray(signatures) ? signatures : [signatures]).map(item => readSignature(item, 'bestFor'));
    if (!list.length) return null;
    const wanted = new Set(list);
    const candidates = load().entries.filter(entry => wanted.has(entry.signature));
    if (!candidates.length) return null;
    const ranked = candidates.sort((a, b) =>
      (b.bestScore ?? -1) - (a.bestScore ?? -1)
      || b.successes - a.successes
      || a.failures - b.failures
      || b.lastAt.localeCompare(a.lastAt)
      || keyOf(a).localeCompare(keyOf(b)));
    return clone(ranked[0]);
  }

  function entries() {
    return clone(load().entries);
  }

  /** Dump serializável para auditoria: estado bruto + totais. */
  function exportState() {
    const collected = entries();
    return {
      file: LEARNING_FILE,
      version: LEARNING_FILE_VERSION,
      generatedAt: new Date(now()).toISOString(),
      totals: {
        entries: collected.length,
        attempts: collected.reduce((sum, entry) => sum + entry.attempts, 0),
        successes: collected.reduce((sum, entry) => sum + entry.successes, 0),
        failures: collected.reduce((sum, entry) => sum + entry.failures, 0),
        visuallyJudged: collected.filter(entry => entry.visual).length,
      },
      entries: collected,
    };
  }

  return { filePath, record, noteVisualVerdict, statsFor, bestFor, entries, export: exportState };
}
