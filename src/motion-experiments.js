// Fase 2: motor de experimentação — varre a grade de parâmetros das shapes,
// avalia cada candidato com métricas objetivas e registra o resultado.
//
// Nada aqui toca o avatar: o experimento roda em dado puro (mesma curva que o
// runtime amostra), então é reproduzível, custa ~nada e não pode quebrar a
// personagem. O registro é o histórico auditável — cada linha guarda o pedido,
// a assinatura determinística, as métricas, os achados e o veredito OBRIGATÓRIO,
// e um campo `visual` separado que só humano preenche. Métrica não é opinião e
// opinião não entra no score.
//
// Escopo de segurança: `scope: 'experiment'` nunca é aceito pelo caminho de
// produção (o director só vê sequências vindas do chat/fila), e a escrita é
// atômica (tmp + rename, padrão de memory-store.js).

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { SHAPE_NAMES, SHAPE_PARAMS, buildSequenceRequest } from './sequence-shapes.js';
import { evaluateSequence } from './motion-evaluation.js';

export const ENGINE_VERSION = 'motion-experiments-v1';

// Grade de varredura. Os valores estão dentro dos clamps de buildSequenceRequest
// (amplitude 0.02..0.5, cycles 1..8, durationMs 600..8000), então o motor sonda
// a região que o runtime realmente aceita — inclusive seus extremos.
export const PARAM_GRIDS = Object.freeze({
  amplitude: [0.06, 0.12, 0.2, 0.3, 0.4, 0.5],
  cycles: [1, 2, 3, 4, 6, 8],
  durationMs: [800, 1400, 2200, 3200, 4600, 6500],
  side: ['right', 'left'],
});

export const VISUAL_VERDICTS = Object.freeze(['aprovado', 'ajustar', 'reprovado']);

// Assinatura determinística: mesma entrada → mesma chave (serve para dedupe de
// experimento repetido e para a memória do planner na Fase 5).
export function signatureOf(request) {
  const names = SHAPE_PARAMS[request?.shape]?.names ?? Object.keys(request ?? {});
  const params = Object.keys(request ?? {})
    .filter(key => key !== 'name' && key !== 'shape' && names.includes(key))
    .sort()
    .map(key => `${key}=${request[key]}`)
    .join(',');
  return createHash('sha1').update(`${request?.shape ?? ''}|${params}`).digest('hex').slice(0, 12);
}

// Varredura determinística em "round-robin" a partir de um anchor (o valor do
// meio de cada grade): cada candidato difere do anchor em uma dimensão por vez,
// e as dimensões se alternam a cada rodada. Com amostra pequena isso ainda cobre
// todas as dimensões — e o resultado é legível ("o que a velocidade muda sozinha?").
export function generateCandidates({ shapes = SHAPE_NAMES, grids = PARAM_GRIDS, perShape = 12 } = {}) {
  const candidates = [];
  for (const shape of shapes) {
    const spec = SHAPE_PARAMS[shape];
    if (!spec) continue;
    const axes = spec.names
      .map(name => ({ name, values: grids[name] ?? [] }))
      .filter(axis => axis.values.length);
    if (!axes.length) continue;
    const anchor = Object.fromEntries(axes.map(axis => [axis.name, axis.values[Math.floor(axis.values.length / 2)]]));
    const picked = new Map();
    const push = params => {
      const request = { shape, ...params };
      const signature = signatureOf(request);
      if (!picked.has(signature)) picked.set(signature, { shape, request, signature });
    };
    push(anchor);
    const maxRounds = Math.max(...axes.map(axis => axis.values.length));
    for (let round = 0; round < maxRounds && picked.size < perShape; round += 1) {
      for (const [axisIndex, axis] of axes.entries()) {
        if (picked.size >= perShape) break;
        push({ ...anchor, [axis.name]: axis.values[(round + axisIndex) % axis.values.length] });
      }
    }
    candidates.push(...picked.values());
  }
  return candidates;
}

// Id do registro determinístico (relógio + contador da rodada): reproduzir a
// mesma varredura dá as mesmas chaves, o que torna o histórico auditável.
let recordCounter = 0;
function newId(now) {
  recordCounter += 1;
  return `${now().toString(36)}-${recordCounter.toString(36)}`;
}

// Rodada de experimentos. Defesas: orçamento de tempo, botão de cancelamento,
// try/catch por candidato (um candidato explosivo não derruba a rodada) e
// `knownSignatures` para não repetir o que já foi tentado.
export function runExperiments({
  candidates = generateCandidates(),
  build = buildSequenceRequest,
  evaluate = evaluateSequence,
  limits,
  thresholds,
  knownSignatures = null,
  timeBudgetMs = 5000,
  now = () => Date.now(),
  shouldCancel = () => false,
} = {}) {
  const startedAt = now();
  const records = [];
  const summary = {
    attempted: 0, evaluated: 0, passed: 0, warned: 0, failed: 0,
    skippedKnown: 0, duplicateOfRun: 0, errors: 0,
    cancelled: false, budgetExhausted: false,
  };
  const seen = new Set();

  for (const candidate of candidates) {
    summary.attempted += 1;
    const elapsedMs = now() - startedAt;
    if (shouldCancel()) { summary.cancelled = true; break; }
    if (Number.isFinite(timeBudgetMs) && elapsedMs > timeBudgetMs) { summary.budgetExhausted = true; break; }
    if (knownSignatures?.has(candidate.signature)) { summary.skippedKnown += 1; continue; }
    if (seen.has(candidate.signature)) { summary.duplicateOfRun += 1; continue; }
    seen.add(candidate.signature);

    const record = {
      id: newId(now),
      at: new Date(now()).toISOString(),
      scope: 'experiment',
      engine: ENGINE_VERSION,
      shape: candidate.shape,
      request: candidate.request,
      signature: candidate.signature,
      verdict: 'fail',
      score: 0,
      metrics: null,
      findings: [],
      errors: [],
      visual: null,
    };
    try {
      const built = build(candidate.request);
      if (!built?.ok) {
        record.errors = built?.errors ?? ['build falhou sem motivo'];
        record.findings = [{ code: 'build-invalid', severity: 'error', message: record.errors.join('; ') }];
      } else {
        const evaluation = evaluate(built.sequence, { ...(limits ? { limits } : {}), ...(thresholds ? { thresholds } : {}) });
        record.verdict = evaluation.verdict;
        record.score = evaluation.score;
        record.metrics = evaluation.metrics;
        record.findings = evaluation.findings ?? [];
        record.errors = evaluation.errors ?? [];
        if (evaluation.sequence?.name) record.sequenceName = evaluation.sequence.name;
      }
    } catch (error) {
      summary.errors += 1;
      record.verdict = 'fail';
      record.findings = [{ code: 'engine-error', severity: 'error', message: error?.message ?? String(error) }];
    }
    if (record.verdict === 'pass') summary.passed += 1;
    else if (record.verdict === 'warn') summary.warned += 1;
    else summary.failed += 1;
    summary.evaluated += 1;
    records.push(record);
  }

  summary.durationMs = now() - startedAt;
  summary.best = records.filter(record => record.metrics).slice().sort((a, b) => b.score - a.score).slice(0, 5)
    .map(record => ({ signature: record.signature, shape: record.shape, score: record.score, request: record.request }));
  return { records, summary };
}

// Agregação por shape — é isto que o planner da Fase 5 lê para decidir onde
// vale a pena tentar de novo, sem olhar recordação crua.
export function aggregateByShape(records) {
  const byShape = new Map();
  for (const record of records) {
    if (record.scope !== 'experiment' || !record.metrics) continue;
    const bucket = byShape.get(record.shape) ?? { shape: record.shape, runs: 0, scoreSum: 0, bestScore: 0, failCount: 0, warnCount: 0, best: null };
    bucket.runs += 1;
    bucket.scoreSum += record.score;
    if (record.score > bucket.bestScore) { bucket.bestScore = record.score; bucket.best = { signature: record.signature, request: record.request, score: record.score }; }
    if (record.verdict === 'fail') bucket.failCount += 1;
    if (record.verdict === 'warn') bucket.warnCount += 1;
    byShape.set(record.shape, bucket);
  }
  return [...byShape.values()]
    .map(bucket => ({
      shape: bucket.shape,
      runs: bucket.runs,
      meanScore: Number((bucket.scoreSum / bucket.runs).toFixed(1)),
      bestScore: bucket.bestScore,
      failRate: Number((bucket.failCount / bucket.runs).toFixed(2)),
      warnRate: Number((bucket.warnCount / bucket.runs).toFixed(2)),
      best: bucket.best,
    }))
    .sort((a, b) => b.bestScore - a.bestScore || b.meanScore - a.meanScore);
}

export function createExperimentStore({
  dataDir = join(process.cwd(), 'data'),
  fileName = 'experiments.json',
  now = () => Date.now(),
  maxRecords = 400,
} = {}) {
  const filePath = join(dataDir, fileName);
  let data = { version: 1, records: [] };
  let loaded = false;

  const normalize = next => ({
    version: 1,
    records: (Array.isArray(next?.records) ? next.records : []).filter(record => record && typeof record === 'object' && record.signature),
  });

  // Leitura tolerante: arquivo ausente ou corrompido nunca sobrescreve o disco.
  function load() {
    if (loaded) return data;
    loaded = true;
    try {
      data = normalize(JSON.parse(readFileSync(filePath, 'utf8')));
    } catch {
      data = { version: 1, records: [] };
    }
    return data;
  }

  function save(next) {
    data = normalize(next);
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

  // Anexa e mantém FIFO limitada; substitui registro de mesma assinatura só
  // quando a nova rodada trouxer métrica (re-experimento atualiza, histórico de
  // julgamento visual não se perde porque `visual` migra junto).
  function append(records) {
    load();
    const incoming = (Array.isArray(records) ? records : [records]).filter(Boolean);
    const bySignature = new Map(data.records.map(record => [record.signature, record]));
    for (const record of incoming) {
      const previous = bySignature.get(record.signature);
      bySignature.set(record.signature, previous?.visual && !record.visual ? { ...record, visual: previous.visual } : record);
    }
    const merged = [...bySignature.values()].sort((a, b) => String(a.at).localeCompare(String(b.at)));
    return save({ records: merged.slice(Math.max(0, merged.length - maxRecords)) }).records;
  }

  function get(id) {
    return load().records.find(record => record.id === id) ?? null;
  }

  function bySignature(signature) {
    return load().records.filter(record => record.signature === signature);
  }

  const signatures = () => new Set(load().records.map(record => record.signature));

  // Falha conhecida = contrato rompeu, score ruim, ou humano reprovou. É a
  // memória que impede o planner de insistir na mesma tentativa.
  function isKnownFailure(signature) {
    return bySignature(signature).some(record => record.verdict === 'fail' || record.visual?.verdict === 'reprovado' || (record.metrics && record.score < 50));
  }

  // Único ponto de entrada do julgamento humano; nunca mexe em métrica/score.
  function setVisual(id, judgment) {
    load();
    const record = data.records.find(item => item.id === id);
    if (!record) return null;
    const verdict = VISUAL_VERDICTS.includes(judgment?.verdict) ? judgment.verdict : null;
    if (!verdict) return { ok: false, errors: [`veredito visual deve ser um de ${VISUAL_VERDICTS.join('/')}`] };
    record.visual = {
      verdict,
      note: typeof judgment?.note === 'string' ? judgment.note.slice(0, 500) : '',
      judgedAt: new Date(now()).toISOString(),
    };
    save(data);
    return record;
  }

  function stats() {
    const records = load().records;
    const counts = { total: records.length, pass: 0, warn: 0, fail: 0, visuallyJudged: 0 };
    for (const record of records) {
      if (record.verdict === 'pass') counts.pass += 1;
      else if (record.verdict === 'warn') counts.warn += 1;
      else counts.fail += 1;
      if (record.visual) counts.visuallyJudged += 1;
    }
    return counts;
  }

  return { filePath, load, save, append, get, bySignature, signatures, isKnownFailure, setVisual, stats, aggregate: () => aggregateByShape(load().records) };
}
