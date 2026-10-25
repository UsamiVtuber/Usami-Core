import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  generateCandidates,
  runExperiments,
  signatureOf,
  aggregateByShape,
  createExperimentStore,
  ENGINE_VERSION,
  PARAM_GRIDS,
} from '../src/motion-experiments.js';

// O motor roda em node puro: se alguma dependência de three.js/DOM/rede entrar
// aqui por engano, este guard fails fast — é a separação teste vs produção.
test('motor de experimentação não precisa de navegador nem de rede', () => {
  assert.equal(typeof window, 'undefined');
  assert.equal(typeof document, 'undefined');
});

// --- candidatos -------------------------------------------------------------

test('grade de candidatos é determinística e cobre as shapes', () => {
  const first = generateCandidates({ perShape: 12 });
  const second = generateCandidates({ perShape: 12 });
  assert.deepEqual(first.map(item => item.signature), second.map(item => item.signature));
  assert.equal(new Set(first.map(item => item.signature)).size, first.length, 'assinaturas únicas');
  const shapes = new Set(first.map(item => item.shape));
  assert.deepEqual([...shapes].sort(), ['head-tilt-curve', 'nod', 'reach', 'shiver', 'sway-arms', 'wave-arm']);
  for (const shape of shapes) {
    const group = first.filter(item => item.shape === shape);
    assert.ok(group.length >= 4, `${shape} varia mais de uma dimensão com amostra pequena`);
    for (const key of Object.keys(group[0].request).filter(name => name !== 'shape')) {
      assert.ok(new Set(group.map(item => item.request[key])).size >= 2, `${shape}.${key} não varia`);
    }
  }
});

test('cada shape só varre os parâmetros que aceita', () => {
  const shiver = generateCandidates({ shapes: ['shiver'], perShape: 36 });
  assert.ok(shiver.every(candidate => candidate.request.amplitude !== undefined && candidate.request.durationMs !== undefined));
  assert.ok(shiver.every(candidate => candidate.request.cycles === undefined && candidate.request.side === undefined));
  const reach = generateCandidates({ shapes: ['reach'], perShape: 36 });
  assert.deepEqual([...new Set(reach.map(item => item.request.side))].sort(), ['left', 'right']);
});

test('assinatura não depende da ordem nem do nome da sequência', () => {
  const a = signatureOf({ shape: 'nod', amplitude: 0.2, durationMs: 1400, name: 'um' });
  const b = signatureOf({ name: 'outro', durationMs: 1400, shape: 'nod', amplitude: 0.2 });
  assert.equal(a, b);
  assert.notEqual(a, signatureOf({ shape: 'nod', amplitude: 0.3, durationMs: 1400 }));
});

test('grade anunciada bate com os valores gerados', () => {
  const amplitudes = new Set(generateCandidates({ shapes: ['reach'], perShape: 60 }).map(item => item.request.amplitude));
  assert.ok([...amplitudes].every(value => PARAM_GRIDS.amplitude.includes(value)));
});

// --- rodada -----------------------------------------------------------------

test('rodada avalia candidatos e produz registros auditáveis', () => {
  const { records, summary } = runExperiments({ candidates: generateCandidates({ shapes: ['nod', 'reach'], perShape: 4 }) });
  assert.equal(records.length, 8);
  assert.equal(summary.attempted, 8);
  assert.equal(summary.evaluated, records.length);
  assert.equal(summary.passed + summary.warned + summary.failed, summary.evaluated);
  const record = records[0];
  assert.equal(record.scope, 'experiment');
  assert.equal(record.engine, ENGINE_VERSION);
  assert.equal(record.visual, null, 'julgamento visual é campo separado, preenchido por humano');
  assert.equal(typeof record.score, 'number');
  assert.ok(record.metrics, 'shape válida sempre produz métrica');
  assert.ok(record.at.includes('T'));
  assert.equal(summary.best.length, Math.min(5, records.filter(item => item.metrics).length));
  assert.ok(summary.best[0].score >= summary.best.at(-1).score);
});

test('rodada é reproduzível: mesmas assinaturas e mesmas notas', () => {
  const candidates = generateCandidates({ shapes: ['shiver'], perShape: 5 });
  const a = runExperiments({ candidates });
  const b = runExperiments({ candidates });
  assert.deepEqual(a.records.map(item => [item.signature, item.score, item.verdict]), b.records.map(item => [item.signature, item.score, item.verdict]));
});

test('assinaturas conhecidas são puladas (não repete experimento já tentado)', () => {
  const candidates = generateCandidates({ shapes: ['nod'], perShape: 4 });
  const known = new Set(candidates.slice(0, 2).map(item => item.signature));
  const { records, summary } = runExperiments({ candidates, knownSignatures: known });
  assert.equal(records.length, 2);
  assert.equal(summary.skippedKnown, 2);
  assert.equal(summary.attempted, 4);
});

test('orçamento de tempo encerra a rodada sem perder o que já mediu', () => {
  let clock = 0;
  const { records, summary } = runExperiments({
    candidates: generateCandidates({ perShape: 12 }),
    timeBudgetMs: 50,
    now: () => (clock += 20),
  });
  assert.equal(summary.budgetExhausted, true);
  assert.equal(summary.cancelled, false);
  assert.ok(records.length > 0 && records.length < 72);
});

test('cancelamento para a rodada na hora', () => {
  const { records, summary } = runExperiments({ candidates: generateCandidates({ perShape: 12 }), shouldCancel: () => true });
  assert.equal(records.length, 0);
  assert.equal(summary.cancelled, true);
  assert.equal(summary.attempted, 1);
});

test('candidato que arrebenta o motor não derruba a rodada', () => {
  const candidates = generateCandidates({ shapes: ['nod'], perShape: 3 });
  const exploding = [candidates[0], { shape: 'boom', request: { shape: 'boom' }, signature: 'boom-signature' }, candidates[1]];
  const build = request => {
    if (request.shape === 'boom') throw new Error('explosão proposital');
    return { ok: true, sequence: { name: 'x', durationMs: 1000, tracks: [{ bone: 'neck', keys: [{ t: 0, axis: 'x', value: 0 }, { t: 1000, axis: 'x', value: 0.1 }] }] } };
  };
  const { records, summary } = runExperiments({ candidates: exploding, build });
  const boom = records.find(record => record.shape === 'boom');
  assert.equal(boom.verdict, 'fail');
  assert.equal(boom.findings[0].code, 'engine-error');
  assert.match(boom.findings[0].message, /explosão proposital/);
  assert.equal(summary.errors, 1);
  assert.equal(records.length, 3, 'os demais candidatos continuam sendo avaliados');
});

test('build inválido vira registro de falha com motivo', () => {
  const { records } = runExperiments({ candidates: [{ shape: 'nod', request: { shape: 'nod' }, signature: 'x' }], build: () => ({ ok: false, errors: ['shape desconhecida'] }) });
  assert.equal(records[0].verdict, 'fail');
  assert.equal(records[0].metrics, null);
  assert.deepEqual(records[0].errors, ['shape desconhecida']);
  assert.equal(records[0].findings[0].code, 'build-invalid');
});

// --- agregação --------------------------------------------------------------

test('agregado por shape resume média, melhor nota e taxa de falha', () => {
  const records = [
    { scope: 'experiment', shape: 'nod', signature: 'a', score: 90, verdict: 'pass', metrics: {}, request: {} },
    { scope: 'experiment', shape: 'nod', signature: 'b', score: 60, verdict: 'warn', metrics: {}, request: {} },
    { scope: 'experiment', shape: 'nod', signature: 'c', score: 0, verdict: 'fail', metrics: null, request: {} },
    { scope: 'experiment', shape: 'reach', signature: 'd', score: 70, verdict: 'warn', metrics: {}, request: {} },
    { scope: 'producao', shape: 'reach', signature: 'e', score: 1, verdict: 'fail', metrics: {}, request: {} },
  ];
  const aggregate = aggregateByShape(records);
  assert.deepEqual(aggregate.map(item => item.shape), ['nod', 'reach'], 'ordenado pela melhor nota');
  const nod = aggregate.find(item => item.shape === 'nod');
  assert.equal(nod.runs, 2, 'registro sem métrica não conta como experimento');
  assert.equal(nod.bestScore, 90);
  assert.equal(nod.meanScore, 75);
  assert.equal(nod.failRate, 0);
  assert.deepEqual(nod.best.request, {});
});

// --- store ------------------------------------------------------------------

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'usami-exp-'));
  return { dir, store: createExperimentStore({ dataDir: dir, now: () => Date.parse('2026-10-25T12:00:00Z') }) };
}

const recordFixture = (signature, overrides = {}) => ({
  id: `id-${signature}`,
  at: '2026-10-25T12:00:00.000Z',
  scope: 'experiment',
  engine: ENGINE_VERSION,
  shape: 'nod',
  request: { shape: 'nod', amplitude: 0.2 },
  signature,
  verdict: 'pass',
  score: 100,
  metrics: { durationMs: 1200 },
  findings: [],
  errors: [],
  visual: null,
  ...overrides,
});

test('histórico persiste em JSON atômico e volta idêntico', () => {
  const { dir, store } = tempStore();
  try {
    store.append([recordFixture('a'), recordFixture('b')]);
    const raw = JSON.parse(readFileSync(join(dir, 'experiments.json'), 'utf8'));
    assert.equal(raw.version, 1);
    assert.deepEqual(raw.records.map(item => item.signature), ['a', 'b']);
    assert.deepEqual(store.load().records.map(item => item.id), ['id-a', 'id-b']);
    assert.equal(store.stats().total, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('arquivo corrompido não apaga o histórico nem quebra a leitura', () => {
  const dir = mkdtempSync(join(tmpdir(), 'usami-exp-'));
  try {
    const filePath = join(dir, 'experiments.json');
    writeFileSync(filePath, '{ isso não é json', 'utf8');
    const store = createExperimentStore({ dataDir: dir });
    assert.deepEqual(store.load().records, []);
    assert.equal(readFileSync(filePath, 'utf8'), '{ isso não é json', 'leitura nunca reescreve o disco');
    store.append([recordFixture('a')]);
    assert.equal(store.load().records.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('re-experimento substitui o registro e conserva o julgamento visual', () => {
  const { dir, store } = tempStore();
  try {
    store.append([recordFixture('a')]);
    store.setVisual('id-a', { verdict: 'ajustar', note: 'braço passa perto demais do cabelo' });
    store.append([recordFixture('a', { score: 88, verdict: 'warn', id: 'id-a2' })]);
    const records = store.bySignature('a');
    assert.equal(records.length, 1);
    assert.equal(records[0].score, 88);
    assert.equal(records[0].visual.verdict, 'ajustar');
    assert.match(records[0].visual.note, /cabelo/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('julgamento visual é o único campo humano e tem veredito fechado', () => {
  const { dir, store } = tempStore();
  try {
    store.append([recordFixture('a')]);
    assert.deepEqual(store.setVisual('id-a', { verdict: 'aprovado', note: 'ok' }).visual.verdict, 'aprovado');
    assert.equal(store.setVisual('id-a', { verdict: 'ótimo' }).ok, false);
    assert.equal(store.setVisual('nao-existe', { verdict: 'aprovado' }), null);
    const stored = store.get('id-a');
    assert.equal(stored.score, 100, 'opinião humana não mexe na nota objetiva');
    assert.equal(stored.visual.note, 'ok');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('falha conhecida: recusa repetir o que já faliu ou foi reprovado', () => {
  const { dir, store } = tempStore();
  try {
    store.append([
      recordFixture('contrato', { verdict: 'fail', score: 0, metrics: null }),
      recordFixture('ruim', { verdict: 'warn', score: 30 }),
      recordFixture('reprovado', { verdict: 'pass', score: 100 }),
      recordFixture('bom', { verdict: 'pass', score: 100 }),
    ]);
    store.setVisual('id-reprovado', { verdict: 'reprovado', note: 'fica estranho' });
    assert.equal(store.isKnownFailure('contrato'), true);
    assert.equal(store.isKnownFailure('ruim'), true);
    assert.equal(store.isKnownFailure('reprovado'), true);
    assert.equal(store.isKnownFailure('bom'), false);
    assert.equal(store.isKnownFailure('desconhecida'), false);
    assert.deepEqual([...store.signatures()].sort(), ['bom', 'contrato', 'reprovado', 'ruim']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('histórico tem teto FIFO', () => {
  const dir = mkdtempSync(join(tmpdir(), 'usami-exp-'));
  try {
    const store = createExperimentStore({ dataDir: dir, maxRecords: 8 });
    const many = Array.from({ length: 12 }, (_, index) => recordFixture(`s${index}`, {
      id: `id-s${index}`,
      at: `2026-10-25T12:${String(index).padStart(2, '0')}:00.000Z`,
    }));
    store.append(many);
    const records = store.load().records;
    assert.equal(records.length, 8);
    assert.deepEqual(records.map(item => item.signature), ['s4', 's5', 's6', 's7', 's8', 's9', 's10', 's11']);
    assert.equal(store.aggregate().length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
