// CLI da Fase 2: varredura de experimentos de movimento, 100% offline e sem
// custo — não abre rede, não lê chaves, não toca no avatar.
//
//   node scripts/run-motion-experiments.mjs [--per-shape 12] [--shape nod]
//     [--budget 5000] [--no-save] [--json] [--resume] [--learn]
//
// `--resume` pula assinaturas já presentes no histórico (data/experiments.json);
// sem `--no-save` os registros da rodada são anexados ao histórico auditável.
// `--learn` fecha o ciclo: cada medida cuja assinatura bate com uma técnica da
// base vira tentativa na memória de aprendizagem, que o planner lê ao escolher.

import { parseArgs } from 'node:util';
import { SHAPE_NAMES } from '../src/sequence-shapes.js';
import { describeEvaluation } from '../src/motion-evaluation.js';
import { createExperimentStore, generateCandidates, runExperiments, aggregateByShape, signatureOf } from '../src/motion-experiments.js';
import { createTechniqueStore } from '../src/technique-store.js';
import { techniqueShapeRequests } from '../src/technique-schema.js';
import { createLearningMemory } from '../src/learning-memory.js';

const { values: options } = parseArgs({
  options: {
    'per-shape': { type: 'string', default: '12' },
    shape: { type: 'string', multiple: true, default: [] },
    budget: { type: 'string', default: '5000' },
    'no-save': { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
    resume: { type: 'boolean', default: false },
    learn: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});

if (options.help) {
  console.log('uso: node scripts/run-motion-experiments.mjs [--per-shape N] [--shape nod]... [--budget ms] [--resume] [--learn] [--no-save] [--json]');
  console.log(`shapes conhecidas: ${SHAPE_NAMES.join(', ')}`);
  process.exit(0);
}

for (const shape of options.shape) {
  if (!SHAPE_NAMES.includes(shape)) {
    console.error(`shape desconhecida: ${shape} (conhecidas: ${SHAPE_NAMES.join(', ')})`);
    process.exit(2);
  }
}

const store = createExperimentStore();
const candidates = generateCandidates({
  shapes: options.shape.length ? options.shape : SHAPE_NAMES,
  perShape: Math.max(1, Number(options.perShape) || 12),
});

// `--learn` mede primeiro o que a base realmente usa: sem isso a varredura por
// grade quase nunca produz a assinatura exata de um motion gravado, e a memória
// de aprendizagem ficaria cheia de números que nenhuma técnica consome.
const kbTechniques = options.learn ? await createTechniqueStore().list() : [];
const gridSignatures = new Set(candidates.map(candidate => candidate.signature));
const bySignature = new Map();
for (const technique of kbTechniques) {
  for (const request of techniqueShapeRequests(technique)) {
    const signature = signatureOf(request);
    const known = bySignature.get(signature);
    if (known) known.techniqueIds.push(technique.id);
    else bySignature.set(signature, { shape: request.shape, request, signature, techniqueIds: [technique.id] });
  }
}
for (const candidate of bySignature.values()) {
  if (gridSignatures.has(candidate.signature)) continue;
  if (options.shape.length && !options.shape.includes(candidate.shape)) continue;
  candidates.push(candidate);
}

const startedAt = performance.now();
const { records, summary } = runExperiments({
  candidates,
  knownSignatures: options.resume ? store.signatures() : null,
  timeBudgetMs: Number(options.budget) || 5000,
});
const wallMs = Math.round(performance.now() - startedAt);

if (!options['no-save'] && records.length) store.append(records);

let learning = null;
if (options.learn && records.length) {
  // A base é a única forma de saber a qual técnica uma medida pertence: a
  // assinatura do movimento é a junção. Medida sem técnica correspondente não é
  // punida — ausência de evidência não é evidência de fracasso.
  const memory = createLearningMemory();
  let written = 0;
  let unmatched = 0;
  for (const record of records) {
    if (!record.metrics) continue;
    const bound = bySignature.get(record.signature)?.techniqueIds;
    if (!bound?.length) { unmatched += 1; continue; }
    for (const techniqueId of bound) {
      memory.record({
        techniqueId,
        signature: record.signature,
        outcome: { score: record.score, verdict: record.verdict, metrics: record.metrics },
      });
      written += 1;
    }
  }
  learning = { written, unmatched, techniques: kbTechniques.length, file: memory.filePath };
}

if (options.json) {
  console.log(JSON.stringify({ summary, records, aggregated: aggregateByShape(records), learning }, null, 2));
} else {
  for (const record of records) {
    console.log(`${record.shape.padEnd(16)} ${JSON.stringify(record.request).padEnd(58)} ${record.verdict.padEnd(5)} ${String(record.score).padEnd(5)} ${describeEvaluation(record)}`);
  }
  console.log('\npor shape (objetivo):');
  for (const bucket of aggregateByShape(records)) {
    console.log(`  ${bucket.shape.padEnd(16)} runs ${String(bucket.runs).padStart(3)}  média ${String(bucket.meanScore).padStart(5)}  melhor ${String(bucket.bestScore).padStart(5)}  falha ${bucket.failRate}  alerta ${bucket.warnRate}`);
  }
  console.log(`\ntentadas ${summary.attempted} | avaliadas ${summary.evaluated} | ok ${summary.passed} | alerta ${summary.warned} | falha ${summary.failed} | puladas ${summary.skippedKnown + summary.duplicateOfRun} | erros ${summary.errors}`);
  if (summary.cancelled) console.log('cancelada por pedido');
  if (summary.budgetExhausted) console.log(`orçamento de tempo esgotado (${options.budget} ms)`);
  console.log(`custo ${wallMs} ms de CPU, zero rede/chaves | histórico: ${store.filePath} (${store.stats().total} registros)`);
  if (learning) {
    console.log(`aprendizagem: ${learning.written} tentativa(s) em ${learning.file} a partir de ${learning.techniques} técnica(s); ${learning.unmatched} medida(s) sem técnica correspondente`);
  }
}
