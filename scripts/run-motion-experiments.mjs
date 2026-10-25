// CLI da Fase 2: varredura de experimentos de movimento, 100% offline e sem
// custo — não abre rede, não lê chaves, não toca no avatar.
//
//   node scripts/run-motion-experiments.mjs [--per-shape 12] [--shape nod]
//     [--budget 5000] [--no-save] [--json] [--resume]
//
// `--resume` pula assinaturas já presentes no histórico (data/experiments.json);
// sem `--no-save` os registros da rodada são anexados ao histórico auditável.

import { parseArgs } from 'node:util';
import { SHAPE_NAMES } from '../src/sequence-shapes.js';
import { describeEvaluation } from '../src/motion-evaluation.js';
import { createExperimentStore, generateCandidates, runExperiments, aggregateByShape } from '../src/motion-experiments.js';

const { values: options } = parseArgs({
  options: {
    'per-shape': { type: 'string', default: '12' },
    shape: { type: 'string', multiple: true, default: [] },
    budget: { type: 'string', default: '5000' },
    'no-save': { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
    resume: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});

if (options.help) {
  console.log('uso: node scripts/run-motion-experiments.mjs [--per-shape N] [--shape nod]... [--budget ms] [--resume] [--no-save] [--json]');
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

const startedAt = performance.now();
const { records, summary } = runExperiments({
  candidates,
  knownSignatures: options.resume ? store.signatures() : null,
  timeBudgetMs: Number(options.budget) || 5000,
});
const wallMs = Math.round(performance.now() - startedAt);

if (!options['no-save'] && records.length) store.append(records);

if (options.json) {
  console.log(JSON.stringify({ summary, records, aggregated: aggregateByShape(records) }, null, 2));
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
}
