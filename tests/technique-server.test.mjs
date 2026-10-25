import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Isolamento: nenhuma chamada de rede nesta suíte. USE_NVIDIA=false desliga a
// rota NVIDIA e o llm do handler é sempre injetado.
process.env.USE_NVIDIA = 'false';

const { createTechniqueHandler, parseTechniqueBody, parseTechniqueRaw } = await import('../server.mjs');
const { createTechniqueStore, readIngestedFicha } = await import('../src/technique-store.js');
const { techniqueId } = await import('../src/technique-schema.js');

const SOURCE_ID = 'src-24772342f063';

function mockReq({ method = 'POST', url = '/api/technique', headers = {}, body = '' } = {}) {
  const chunks = body ? [Buffer.from(body)] : [];
  return {
    method,
    url,
    headers,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

function mockRes() {
  const res = { statusCode: null, headers: null, body: '' };
  res.writeHead = (status, headers) => { res.statusCode = status; res.headers = headers; };
  res.end = (data) => { res.body = data; };
  return res;
}

const json = (res) => JSON.parse(res.body);

async function fixture(options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'usami-technique-'));
  const dataDir = path.join(root, 'data');
  const ficha = {
    schema: 'usami.ingest.v1',
    id: SOURCE_ID,
    createdAt: '2026-10-25T12:00:00Z',
    source: { kind: 'video', path: 'tutorial.mp4', sha256: '1'.repeat(64), bytes: 10, title: 'demo: aceno em 3 passos' },
    media: { durationMs: 13000, width: 320, height: 240, fps: 15, hasAudio: true },
    transcript: { engine: 'faster-whisper', model: 'tiny', language: 'pt', text: 'levante o braço e gire o pulso', segments: [] },
    frames: [],
    technique: null,
    warnings: [],
  };
  await mkdir(path.join(dataDir, 'ingest', SOURCE_ID), { recursive: true });
  await writeFile(path.join(dataDir, 'ingest', SOURCE_ID, 'ficha.json'), JSON.stringify(ficha), 'utf8');
  const handler = createTechniqueHandler({
    dataDir,
    store: createTechniqueStore({ dataDir }),
    allowedOrigins: ['http://127.0.0.1:5173'],
    ...options,
  });
  return { root, dataDir, handler, ficha, techDir: () => path.join(dataDir, 'techniques') };
}

const OPERATOR_TECHNIQUE = {
  name: 'aceno em três pulsos',
  summary: 'levantar o antebraço e oscilar a mão.',
  steps: ['levante o antebraço', 'gire o pulso', 'volte ao repouso'],
  motions: [{ kind: 'shape', shape: 'wave-arm', amplitude: 0.3, cycles: 3, durationMs: 2400, side: 'right' }],
  expressions: [{ name: 'happy', weight: 0.6 }],
  tags: ['aceno'],
  confidence: 0.8,
};

// --- parse -----------------------------------------------------------------

test('parseTechniqueBody exige sourceId e aceita technique/dryRun/status', () => {
  assert.deepEqual(parseTechniqueBody(JSON.stringify({ sourceId: SOURCE_ID })), {
    ok: true, sourceId: SOURCE_ID, technique: null, dryRun: false, status: 'proposta',
  });
  assert.equal(parseTechniqueBody('not json').ok, false);
  assert.equal(parseTechniqueBody('[]').ok, false);
  assert.equal(parseTechniqueBody(JSON.stringify({ technique: {} })).ok, false);
  assert.equal(parseTechniqueBody(JSON.stringify({ sourceId: SOURCE_ID, technique: 'x' })).ok, false);
  assert.equal(parseTechniqueBody(JSON.stringify({ sourceId: SOURCE_ID, dryRun: 1 })).dryRun, false, 'só booleano true liga o dry-run');
});

test('parseTechniqueRaw tolera fence, rejeita não-JSON e payload enorme', () => {
  assert.deepEqual(parseTechniqueRaw('{"name":"x"}'), { ok: true, value: { name: 'x' } });
  assert.equal(parseTechniqueRaw('```json\n{"name":"x"}\n```').ok, true);
  assert.equal(parseTechniqueRaw('pensei bastante e não escrevi JSON').ok, false);
  assert.equal(parseTechniqueRaw('').ok, false);
  assert.equal(parseTechniqueRaw('[]').ok, false);
  assert.equal(parseTechniqueRaw(`[${'"x"'.repeat(3000)}]`).ok, false);
});

// --- caminho offline (sem LLM) ---------------------------------------------

test('POST com technique do operador valida, grava e responde com proveniência', async () => {
  const { handler, dataDir } = await fixture();
  const res = mockRes();
  await handler(
    mockReq({ headers: { origin: 'http://127.0.0.1:5173', 'content-type': 'application/json', host: '127.0.0.1:8787' },
      body: JSON.stringify({ sourceId: SOURCE_ID, technique: OPERATOR_TECHNIQUE }) }),
    res,
  );
  assert.equal(res.statusCode, 200, res.body);
  const payload = json(res);
  assert.equal(payload.stored, true);
  assert.equal(payload.technique.sources[0].sourceId, SOURCE_ID);
  assert.equal(payload.technique.sources[0].title, 'demo: aceno em 3 passos');
  assert.equal(payload.technique.engine.provider, 'operador');
  assert.equal(payload.technique.id, techniqueId([{ sourceId: SOURCE_ID, kind: 'video', title: 'demo: aceno em 3 passos', schema: 'usami.ingest.v1' }], 'aceno em três pulsos'));

  const files = await readdir(path.join(dataDir, 'techniques'));
  assert.deepEqual(files, [`${payload.technique.id}.json`]);
  const stored = JSON.parse(await readFile(path.join(dataDir, 'techniques', files[0]), 'utf8'));
  assert.deepEqual(stored, payload.technique);
});

test('dryRun não escreve nada no disco', async () => {
  const { handler, dataDir } = await fixture();
  const res = mockRes();
  await handler(mockReq({ headers: { origin: 'http://127.0.0.1:5173', 'content-type': 'application/json', host: '127.0.0.1:8787' },
    body: JSON.stringify({ sourceId: SOURCE_ID, technique: OPERATOR_TECHNIQUE, dryRun: true }) }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(json(res).stored, false);
  await assert.rejects(() => readdir(path.join(dataDir, 'techniques')));
});

test('origem, content-type e tamanho do corpo são barrados antes de tudo', async () => {
  const { handler } = await fixture();
  const evil = mockRes();
  await handler(mockReq({ headers: { origin: 'https://exemplo.com', 'content-type': 'application/json', host: '127.0.0.1:8787' }, body: '{}' }), evil);
  assert.equal(evil.statusCode, 403);

  const wrongType = mockRes();
  await handler(mockReq({ headers: { origin: 'http://127.0.0.1:5173', 'content-type': 'text/plain', host: '127.0.0.1:8787' }, body: '{}' }), wrongType);
  assert.equal(wrongType.statusCode, 403);

  const big = mockRes();
  await handler(mockReq({ headers: { origin: 'http://127.0.0.1:5173', 'content-type': 'application/json', host: '127.0.0.1:8787' },
    body: JSON.stringify({ sourceId: SOURCE_ID, technique: { ...OPERATOR_TECHNIQUE, notes: 'x'.repeat(40_000) } }) }), big);
  assert.equal(big.statusCode, 413);

  const notFound = mockRes();
  await handler(mockReq({ url: '/api/outra-coisa', headers: { origin: 'http://127.0.0.1:5173', 'content-type': 'application/json', host: '127.0.0.1:8787' }, body: '{}' }), notFound);
  assert.equal(notFound.statusCode, 404);
});

test('sourceId forjado não vira caminho de arquivo', async () => {
  const { handler, dataDir } = await fixture();
  const cases = [
    ['', 400],
    ['   ', 400],
    ['../../vault/notes', 404],
    ['src-ZZZ', 404],
    ['src-24772342f063/../../techniques', 404],
  ];
  for (const [sourceId, expected] of cases) {
    const res = mockRes();
    await handler(mockReq({ headers: { origin: 'http://127.0.0.1:5173', 'content-type': 'application/json', host: '127.0.0.1:8787' },
      body: JSON.stringify({ sourceId, technique: OPERATOR_TECHNIQUE }) }), res);
    assert.equal(res.statusCode, expected, `${sourceId}: ${res.body}`);
  }
  assert.equal((await readIngestedFicha('../../vault/notes', { dataDir })).ok, false);
  assert.equal((await readIngestedFicha(undefined, { dataDir })).ok, false);
});

// --- caminho com modelo -----------------------------------------------------

test('modelo estruturando a ficha: saída cercada de markdown ainda vira técnica', async () => {
  const calls = [];
  const { handler } = await fixture({
    llm: async (prompt) => {
      calls.push(prompt);
      return { raw: '```json\n' + JSON.stringify({ ...OPERATOR_TECHNIQUE, motions: [{ kind: 'shape', shape: 'wave-arm', amplitude: 9, cycles: 99, durationMs: 99_999 }, { kind: 'gesture', name: 'dança-da-chuva' }] }) + '\n```', provider: 'nvidia', model: 'modelo-teste' };
    },
  });
  const res = mockRes();
  await handler(mockReq({ headers: { origin: 'http://127.0.0.1:5173', 'content-type': 'application/json', host: '127.0.0.1:8787' },
    body: JSON.stringify({ sourceId: SOURCE_ID }) }), res);
  assert.equal(res.statusCode, 200, res.body);
  const technique = json(res).technique;
  assert.equal(technique.engine.model, 'modelo-teste');
  assert.equal(technique.motions.length, 1, 'gesto inventado fora da allowlist não entra');
  assert.deepEqual(technique.motions[0].request, { shape: 'wave-arm', amplitude: 0.5, cycles: 8, durationMs: 8000, side: 'right' });
  assert.equal(json(res).discarded.length, 1);
  assert.ok(calls[0].includes('levante o braço e gire o pulso'), 'a transcrição da ficha vai para o prompt');
});

test('modelo que devolve prosa é 422 e nada é gravado', async () => {
  const { handler, dataDir } = await fixture({ llm: async () => ({ raw: 'Ótimo tutorial! Não consigo colocar em JSON.', provider: 'nvidia', model: 'm' }) });
  const res = mockRes();
  await handler(mockReq({ headers: { origin: 'http://127.0.0.1:5173', 'content-type': 'application/json', host: '127.0.0.1:8787' },
    body: JSON.stringify({ sourceId: SOURCE_ID }) }), res);
  assert.equal(res.statusCode, 422);
  await assert.rejects(() => readdir(path.join(dataDir, 'techniques')));
});

test('sem provedor configurado é 503 com saída offline disponível', async () => {
  const { handler } = await fixture({ llm: async () => { throw new Error('no-llm-provider'); } });
  const res = mockRes();
  await handler(mockReq({ headers: { origin: 'http://127.0.0.1:5173', 'content-type': 'application/json', host: '127.0.0.1:8787' },
    body: JSON.stringify({ sourceId: SOURCE_ID }) }), res);
  assert.equal(res.statusCode, 503);
  assert.match(json(res).error, /technique/);
});

test('modelo lento estoura o timeout e vira 504', async () => {
  const { handler } = await fixture({
    timeoutMs: 30,
    llm: () => new Promise(resolve => setTimeout(() => resolve({ raw: '{}', provider: 'nvidia', model: 'm' }), 500)),
  });
  const res = mockRes();
  await handler(mockReq({ headers: { origin: 'http://127.0.0.1:5173', 'content-type': 'application/json', host: '127.0.0.1:8787' },
    body: JSON.stringify({ sourceId: SOURCE_ID }) }), res);
  assert.equal(res.statusCode, 504);
});

test('falha do provedor é 502 com mensagem curta', async () => {
  const { handler } = await fixture({ llm: async () => { throw new Error(`limite de taxa ${'x'.repeat(500)}`); } });
  const res = mockRes();
  await handler(mockReq({ headers: { origin: 'http://127.0.0.1:5173', 'content-type': 'application/json', host: '127.0.0.1:8787' },
    body: JSON.stringify({ sourceId: SOURCE_ID }) }), res);
  assert.equal(res.statusCode, 502);
  assert.ok(json(res).error.length < 300);
});

// --- recuperação ------------------------------------------------------------

test('GET recupera a técnica com a fonte; id inválido ou inexistente é 404', async () => {
  const { handler } = await fixture();
  const post = mockRes();
  await handler(mockReq({ headers: { origin: 'http://127.0.0.1:5173', 'content-type': 'application/json', host: '127.0.0.1:8787' },
    body: JSON.stringify({ sourceId: SOURCE_ID, technique: OPERATOR_TECHNIQUE }) }), post);
  const id = json(post).technique.id;

  const got = mockRes();
  await handler(mockReq({ method: 'GET', url: `/api/technique?id=${id}`, headers: { origin: 'http://127.0.0.1:5173', host: '127.0.0.1:8787' } }), got);
  assert.equal(got.statusCode, 200);
  assert.equal(json(got).technique.sources[0].sourceId, SOURCE_ID);

  const missing = mockRes();
  await handler(mockReq({ method: 'GET', url: '/api/technique?id=tc-000000000000', headers: { origin: 'http://127.0.0.1:5173', host: '127.0.0.1:8787' } }), missing);
  assert.equal(missing.statusCode, 404);

  const traversal = mockRes();
  await handler(mockReq({ method: 'GET', url: '/api/technique?id=../../data/memory', headers: { origin: 'http://127.0.0.1:5173', host: '127.0.0.1:8787' } }), traversal);
  assert.equal(traversal.statusCode, 404);
});

test('GET /api/techniques lista resumido e filtra por status', async () => {
  const { handler } = await fixture();
  const headers = { origin: 'http://127.0.0.1:5173', 'content-type': 'application/json', host: '127.0.0.1:8787' };
  const first = mockRes();
  await handler(mockReq({ headers, body: JSON.stringify({ sourceId: SOURCE_ID, technique: OPERATOR_TECHNIQUE }) }), first);
  const second = mockRes();
  await handler(mockReq({ headers, body: JSON.stringify({ sourceId: SOURCE_ID, status: 'validada', technique: { ...OPERATOR_TECHNIQUE, name: 'aceninho tímido' } }) }), second);

  const list = mockRes();
  await handler(mockReq({ method: 'GET', url: '/api/techniques', headers }), list);
  assert.equal(list.statusCode, 200);
  assert.equal(json(list).total, 2);
  assert.equal(json(list).techniques[0].summary, undefined, 'lista é resumo, não despejo');
  assert.ok(json(list).techniques.every(item => Array.isArray(item.sources) && item.sources[0].startsWith('src-')));

  const approved = mockRes();
  await handler(mockReq({ method: 'GET', url: '/api/techniques?status=validada', headers }), approved);
  assert.equal(json(approved).total, 1);
  assert.equal(json(approved).techniques[0].name, 'aceninho tímido');
});

// --- store -----------------------------------------------------------------

test('store recusa técnica inválida e reler arquivo adulterado falha', async () => {
  const { handler, dataDir } = await fixture();
  const store = createTechniqueStore({ dataDir });
  assert.equal((await store.save({ name: 'pela metade' })).ok, false);

  const post = mockRes();
  await handler(mockReq({ headers: { origin: 'http://127.0.0.1:5173', 'content-type': 'application/json', host: '127.0.0.1:8787' },
    body: JSON.stringify({ sourceId: SOURCE_ID, technique: OPERATOR_TECHNIQUE }) }), post);
  const saved = await store.save(json(post).technique);
  assert.equal(saved.ok, true);

  const tampered = JSON.parse(await readFile(saved.path, 'utf8'));
  tampered.motions = [{ kind: 'shape', shape: 'lavagem-cerebral' }];
  await writeFile(saved.path, JSON.stringify(tampered), 'utf8');
  const reload = await store.get(tampered.id);
  assert.equal(reload.ok, false);
  assert.match(reload.errors[0], /armazenada inválida/);
  assert.deepEqual(await store.list(), [], 'arquivo inválido não aparece na lista');
});

test('leitura de ficha: ausente e JSON corrompido são erro, não porta aberta', async () => {
  const { dataDir } = await fixture();
  assert.match((await readIngestedFicha('src-000000000000', { dataDir })).errors[0], /não encontrada/);

  const brokenDir = path.join(dataDir, 'ingest', 'src-000000000001');
  await mkdir(brokenDir, { recursive: true });
  await writeFile(path.join(brokenDir, 'ficha.json'), '{ nao é json', 'utf8');
  assert.match((await readIngestedFicha('src-000000000001', { dataDir })).errors[0], /ilegível/);
});
