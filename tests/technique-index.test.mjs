import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createTechniqueIndex } from '../src/technique-index.js';
import { sanitizeTechnique, techniqueId } from '../src/technique-schema.js';

const SOURCE = { sourceId: 'src-24772342f063', kind: 'video', title: 'demo', schema: 'usami.ingest.v1' };
const OUTRA_FONTE = { sourceId: 'src-081bc0a0ac42', kind: 'text', title: 'outro' };

function build(overrides = {}, options = {}) {
  const result = sanitizeTechnique({
    name: 'aceno em três pulsos',
    summary: 'levantar o antebraço e oscillar a mão três vezes.',
    steps: ['levante o antebraço', 'gire o pulso'],
    motions: [{ kind: 'shape', shape: 'wave-arm', amplitude: 0.3, cycles: 3, durationMs: 2400, side: 'right' }],
    tags: ['aceno'],
    confidence: 0.7,
    ...overrides,
  }, {
    sources: options.sources ?? [SOURCE],
    engine: { provider: 'nvidia', model: 'teste' },
    status: options.status,
    now: () => new Date(options.now ?? '2026-10-25T12:00:00Z'),
  });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  return result.technique;
}

async function fixture(options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'usami-tech-index-'));
  const dataDir = path.join(root, 'data');
  const techDir = path.join(dataDir, 'techniques');
  await mkdir(techDir, { recursive: true });
  const index = createTechniqueIndex({ dataDir, ...options });
  const cleanup = async () => { index.close(); await rm(root, { recursive: true, force: true }); };
  return { root, dataDir, techDir, index, cleanup };
}

function put(techDir, technique) {
  return writeFile(path.join(techDir, `${technique.id}.json`), `${JSON.stringify(technique, null, 2)}\n`, 'utf8');
}

// --- refresh ---------------------------------------------------------------

test('refresh indexa só o que validateTechnique aceita e search devolve resumo com score e motivo', async () => {
  const { techDir, index, cleanup } = await fixture();
  try {
    const tecnica = build({ name: 'saudação com aceno' });
    await put(techDir, tecnica);
    const result = index.refresh();
    assert.deepEqual(
      { total: result.total, added: result.added, updated: result.updated, removed: result.removed, invalid: result.invalid.length },
      { total: 1, added: 1, updated: 0, removed: 0, invalid: 0 },
    );
    const hits = index.search({ query: 'aceno' });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].id, tecnica.id);
    assert.equal(hits[0].name, 'saudação com aceno');
    assert.deepEqual(hits[0].motions, ['shape:wave-arm']);
    assert.deepEqual(hits[0].sources, ['src-24772342f063']);
    assert.ok(hits[0].score > 0);
    assert.ok(hits[0].why.some(reason => reason.includes('aceno')), JSON.stringify(hits[0].why));
    // busca sem acento acha a forma acentuada (texto normalizado nos dois backends)
    assert.equal(index.search({ query: 'saudacao' }).length, 1);
  } finally {
    await cleanup();
  }
});

test('arquivo adulterado aparece em invalid, sai do índice e volta quando corrigido', async () => {
  const tecnica = build();
  const { techDir, index, cleanup } = await fixture();
  try {
    await put(techDir, tecnica);
    assert.equal(index.refresh().total, 1);

    const forged = { ...tecnica, motions: [{ kind: 'shape', shape: 'lavagem-cerebral' }] };
    await writeFile(path.join(techDir, `${tecnica.id}.json`), JSON.stringify(forged), 'utf8');
    const second = index.refresh();
    assert.equal(second.invalid.length, 1, 'arquivo adulterado é reportado, nunca silencioso');
    assert.equal(second.invalid[0].id, tecnica.id);
    assert.ok(second.invalid[0].errors.some(error => error.includes('fora do vocabulário')));
    assert.equal(second.total, 0);
    assert.deepEqual(index.search({ query: 'aceno' }), []);
    assert.equal(index.stats().invalid.length, 1);
    assert.equal(index.get(tecnica.id).ok, false, 'get lê a fonte da verdade: arquivo adulterado é recusado');

    await put(techDir, tecnica);
    const third = index.refresh();
    assert.equal(third.invalid.length, 0);
    assert.equal(third.total, 1);
    assert.equal(index.search({ query: 'aceno' }).length, 1);
  } finally {
    await cleanup();
  }
});

test('refresh é idempotente e reconcilia linha órfã sem tocar nos arquivos JSON', async () => {
  const a = build({ name: 'aceno primeiro' });
  const b = build({ name: 'aceno segundo' });
  const { techDir, index, cleanup } = await fixture();
  try {
    await put(techDir, a);
    await put(techDir, b);
    assert.equal(index.refresh().added, 2);
    const second = index.refresh();
    assert.deepEqual({ added: second.added, updated: second.updated, removed: second.removed }, { added: 0, updated: 0, removed: 0 },
      'segunda passada com arquivos intactos não re-indexa nada');

    const filePath = path.join(techDir, `${a.id}.json`);
    await rm(filePath);
    const third = index.refresh();
    assert.equal(third.removed, 1, 'linha órfã (arquivo apagado) sai do índice');
    assert.equal(third.total, 1);
    assert.deepEqual(index.search({}).map(hit => hit.id), [b.id]);
    assert.ok(existsSync(path.join(techDir, `${b.id}.json`)), 'o índice jamais apaga arquivos JSON');

    await put(techDir, a);
    assert.equal(index.refresh().added, 1, 'linha volta quando o arquivo volta');
    assert.deepEqual(index.search({}).map(hit => hit.id).sort(), [a.id, b.id]);
  } finally {
    await cleanup();
  }
});

// --- search ----------------------------------------------------------------

test('busca por shape, tag, status e sourceId filtra pelo índice', async () => {
  const aceno = build({ name: 'aceno de braços' });
  const cabeca = build(
    { name: 'acenar com a cabeça', tags: ['saudação'], motions: [{ kind: 'shape', shape: 'nod' }, { kind: 'gesture', name: 'bow' }] },
    { sources: [OUTRA_FONTE], status: 'validada', now: '2026-10-26T12:00:00Z' },
  );
  const { techDir, index, cleanup } = await fixture();
  try {
    await put(techDir, aceno);
    await put(techDir, cabeca);
    index.refresh();

    assert.deepEqual(index.search({ shape: 'nod' }).map(hit => hit.id), [cabeca.id]);
    assert.deepEqual(index.search({ shape: 'wave-arm' }).map(hit => hit.id), [aceno.id]);
    assert.deepEqual(index.search({ tag: 'Saudação' }).map(hit => hit.id), [cabeca.id], 'tag é comparada normalizada');
    assert.deepEqual(index.search({ status: 'validada' }).map(hit => hit.id), [cabeca.id]);
    assert.deepEqual(index.search({ sourceId: 'src-081bc0a0ac42' }).map(hit => hit.id), [cabeca.id]);
    assert.deepEqual(index.search({ shape: 'nod', tag: 'saudacao', status: 'validada' }).map(hit => hit.id), [cabeca.id]);
    assert.deepEqual(index.search({ shape: 'shape-inexistente' }), []);
  } finally {
    await cleanup();
  }
});

test('status desconhecido no filtro é erro de parâmetro, não filtro vazio', async () => {
  const { index, cleanup } = await fixture();
  try {
    assert.throws(() => index.search({ status: 'liberada-no-prod' }), /status de busca inválido/);
    assert.throws(() => index.search({ status: "rejeitada' OR '1'='1" }), /status de busca inválido/);
    assert.deepEqual(index.search({ status: 'proposta' }), [], 'índice continua íntegro depois das recusas');
  } finally {
    await cleanup();
  }
});

test('padrão da busca exclui rejeitada e obsoleta; pedidas explicitamente elas aparecem', async () => {
  const proposta = build({ name: 'aceno proposta' });
  const validada = build({ name: 'aceno validado' }, { status: 'validada' });
  const rejeitada = build({ name: 'aceno rejeitado' }, { status: 'rejeitada' });
  const obsoleta = build({ name: 'aceno obsoleto' }, { status: 'obsoleta' });
  const { techDir, index, cleanup } = await fixture();
  try {
    for (const tecnica of [proposta, validada, rejeitada, obsoleta]) await put(techDir, tecnica);
    index.refresh();
    assert.equal(index.stats().total, 4, 'o índice guarda o acervo inteiro; a exclusão é da busca');
    assert.deepEqual(index.search({}).map(hit => hit.id).sort(), [proposta.id, validada.id].sort());
    assert.deepEqual(index.search({ status: 'rejeitada' }).map(hit => hit.id), [rejeitada.id]);
    assert.deepEqual(index.search({ status: 'obsoleta' }).map(hit => hit.id), [obsoleta.id]);
  } finally {
    await cleanup();
  }
});

test('injeção na query não destrói nada: tudo vira parâmetro vinculado, não sintaxe', async () => {
  const tecnica = build();
  const { techDir, index, cleanup } = await fixture();
  try {
    await put(techDir, tecnica);
    index.refresh();

    for (const payload of ["'; DROP TABLE techniques; --", 'aceno OR 1=1 --', "' UNION SELECT payload FROM techniques --", '%_%', 'aceno"; DELETE FROM technique_tags']) {
      assert.doesNotThrow(() => index.search({ query: payload }));
    }
    assert.equal(index.search({ query: "'; DROP TABLE techniques; --" }).length, 0, 'texto de ataque não casa com nada');
    assert.equal(index.stats().total, 1, 'tabela intacta');
    assert.equal(index.search({ query: 'aceno' }).length, 1, 'busca continua funcionando depois das tentativas');
    assert.equal(index.refresh().total, 1, 'refresh continua operando');
  } finally {
    await cleanup();
  }
});

test('limit tem teto de 100 e default de 20', async () => {
  const { techDir, index, cleanup } = await fixture();
  try {
    for (let i = 0; i < 105; i += 1) await put(techDir, build({ name: `aceno número ${i}` }));
    index.refresh();
    assert.equal(index.stats().total, 105);
    assert.equal(index.search({}).length, 20);
    assert.equal(index.search({ limit: 5 }).length, 5);
    assert.equal(index.search({ limit: 1000 }).length, 100);
    assert.equal(index.search({ limit: 'muita' }).length, 20, 'lixo numérico cai no default, não em unlimited');
  } finally {
    await cleanup();
  }
});

test('ordenação é por relevância e depois createdAt descendente', async () => {
  const antiga = build({ name: 'aceno lento de boas-vindas', tags: ['aceno'] }, { now: '2026-10-01T12:00:00Z' });
  const recente = build({ name: 'aceno rápido', summary: 'nada a ver com boas vindas textuais', tags: ['aceno'] }, { now: '2026-10-20T12:00:00Z' });
  const { techDir, index, cleanup } = await fixture();
  try {
    await put(techDir, antiga);
    await put(techDir, recente);
    index.refresh();
    const hits = index.search({ query: 'aceno' });
    assert.deepEqual(hits.map(hit => hit.id), [recente.id, antiga.id], 'empate de score resolvido por createdAt mais novo primeiro');
    const alvo = index.search({ query: 'boas-vindas' });
    assert.equal(alvo[0].id, antiga.id, 'quem casa com o nome pontua acima de quem só casa com texto');
  } finally {
    await cleanup();
  }
});

// --- get / stats / close / fallback ---------------------------------------

test('get devolve a fonte da verdade e recusa id forjado ou inexistente', async () => {
  const tecnica = build();
  const { techDir, index, cleanup } = await fixture();
  try {
    await put(techDir, tecnica);
    index.refresh();
    const got = index.get(tecnica.id);
    assert.equal(got.ok, true);
    assert.deepEqual(got.technique.motions[0].request, { shape: 'wave-arm', amplitude: 0.3, cycles: 3, durationMs: 2400, side: 'right' });
    assert.equal(got.technique.id, techniqueId([SOURCE], tecnica.name));
    assert.equal(index.get('../../vault/segredo').ok, false, 'id vira parâmetro de caminho só depois do regex');
    assert.equal(index.get('tc-000000000000').ok, false);
  } finally {
    await cleanup();
  }
});

test('stats reporta backend, journal, por status e inválidos sem esconder nada', async () => {
  const { techDir, index, cleanup } = await fixture();
  try {
    await put(techDir, build());
    await put(techDir, build({ name: 'aceno validado' }, { status: 'validada' }));
    index.refresh();
    const stats = index.stats();
    assert.equal(stats.total, 2);
    assert.deepEqual(stats.byStatus, { proposta: 1, validada: 1 });
    assert.deepEqual(stats.invalid, []);
    assert.equal(stats.sources, 1);
    assert.ok(['fts5', 'like'].includes(stats.backend));
    assert.ok(['wal', 'delete'].includes(stats.journalMode));
    assert.equal(stats.indexFile, path.join(path.dirname(techDir), 'techniques-index.sqlite'));
  } finally {
    await cleanup();
  }
});

test('close fecha o índice e qualquer uso depois disso é erro explícito', async () => {
  const { index } = await fixture();
  index.close();
  index.close();
  assert.throws(() => index.refresh(), /fechado/);
  assert.throws(() => index.search({}), /fechado/);
});

test('fallback LIKE (sem FTS5) entrega a mesma forma de resultado', async () => {
  const tecnica = build({ name: 'saudação com aceno' });
  const { techDir, index, cleanup } = await fixture({ allowFts: false });
  try {
    await put(techDir, tecnica);
    index.refresh();
    assert.equal(index.stats().backend, 'like');
    const hits = index.search({ query: 'saudacao' });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].id, tecnica.id);
    assert.ok(hits[0].score > 0 && hits[0].why.length > 0);
    assert.deepEqual(index.search({ query: "'; DROP TABLE techniques; --" }), [], 'injeção também é inofensiva no caminho LIKE');
    assert.equal(index.stats().total, 1);
  } finally {
    await cleanup();
  }
});
