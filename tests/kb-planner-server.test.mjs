import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Isolamento: sem rede, sem LLM, sem vault real. Índice, notas e planner rodam
// contra um dataDir temporário; a "nota no vault" vai para um vault falso criado
// dentro do diretório temporário do teste.
process.env.USE_NVIDIA = 'false';

const { createTechniqueHandler, createPlannerHandler } = await import('../server.mjs');
const { createTechniqueStore } = await import('../src/technique-store.js');
const { createTechniqueIndex } = await import('../src/technique-index.js');
const { createLearningMemory } = await import('../src/learning-memory.js');

const SOURCE_ID = 'src-24772342f063';
const API_TOKEN = 'token-teste';

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
  const res = { statusCode: null, body: '' };
  res.writeHead = (status) => { res.statusCode = status; };
  res.end = (data) => { res.body = data; };
  return res;
}

const json = (res) => JSON.parse(res.body);
const headers = { origin: 'http://127.0.0.1:5173', 'content-type': 'application/json', host: '127.0.0.1:8787', 'x-usami-token': API_TOKEN };

async function fixture(options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'usami-kb-'));
  const dataDir = path.join(root, 'data');
  const vaultRoot = path.join(root, 'vault', 'Usami Obsidian', 'Usami', 'Inbox', 'Automations');
  const vaultDir = path.join(vaultRoot, 'Techniques');
  await mkdir(vaultDir, { recursive: true });
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
    index: createTechniqueIndex({ dataDir }),
    allowedOrigins: ['http://127.0.0.1:5173'],
    apiToken: API_TOKEN,
    vaultRoot,
    ...options,
  });
  const planner = createPlannerHandler({
    dataDir,
    techniques: createTechniqueStore({ dataDir }).list,
    memory: createLearningMemory({ dataDir }),
    allowedOrigins: ['http://127.0.0.1:5173'],
    apiToken: API_TOKEN,
  });
  return { root, dataDir, vaultRoot, vaultDir, handler, planner };
}

async function save(fixture, technique, status = 'proposta') {
  const res = mockRes();
  await fixture.handler(
    mockReq({ headers, body: JSON.stringify({ sourceId: SOURCE_ID, technique: { ...technique, tags: technique.tags ?? ['aceno'] }, status }) }),
    res,
  );
  assert.equal(res.statusCode, 200, res.body);
  return json(res).technique;
}

const ACENO = {
  name: 'aceno em três pulsos',
  summary: 'levantar o antebraço e oscilar a mão.',
  steps: ['levante o antebraço'],
  motions: [{ kind: 'shape', shape: 'wave-arm', amplitude: 0.3, cycles: 3, durationMs: 2400, side: 'right' }],
  tags: ['aceno', 'tchau'],
  confidence: 0.8,
};

const CUMPRIMENTO = {
  name: 'reverência curta',
  summary: 'inclinar a cabeça ao cumprimentar.',
  steps: ['incline a cabeça'],
  motions: [{ kind: 'shape', shape: 'nod', amplitude: 0.2, cycles: 1, durationMs: 1200, side: 'right' }],
  tags: ['saudacao'],
  confidence: 0.7,
};

// --- busca pela base -------------------------------------------------------

test('GET /api/techniques?q= usa o índice e devolve score e motivo', async () => {
  const fix = await fixture();
  await save(fix, ACENO);
  await save(fix, CUMPRIMENTO);
  const res = mockRes();
  await fix.handler(mockReq({ method: 'GET', url: '/api/techniques?q=aceno', headers }), res);
  const payload = json(res);
  assert.equal(res.statusCode, 200);
  assert.equal(payload.techniques.length, 1, 'a busca não devolve a reverência');
  assert.equal(payload.techniques[0].name, 'aceno em três pulsos');
  assert.ok(payload.techniques[0].score > 0);
  assert.ok(payload.techniques[0].why.length > 0, 'o resultado diz POR QUE bateu');
});

test('busca filtra por shape, tag e sourceId; status inválido é 400', async () => {
  const fix = await fixture();
  await save(fix, ACENO);
  await save(fix, CUMPRIMENTO);
  const byShape = mockRes();
  await fix.handler(mockReq({ method: 'GET', url: '/api/techniques?shape=nod', headers }), byShape);
  assert.equal(json(byShape).techniques.length, 1);
  assert.equal(json(byShape).techniques[0].name, 'reverência curta');
  const byTag = mockRes();
  await fix.handler(mockReq({ method: 'GET', url: '/api/techniques?tag=aceno', headers }), byTag);
  assert.equal(json(byTag).techniques.length, 1, 'tag é critério sozinho, sem texto de busca');
  const bySource = mockRes();
  await fix.handler(mockReq({ method: 'GET', url: `/api/techniques?sourceId=${SOURCE_ID}`, headers }), bySource);
  assert.equal(json(bySource).techniques.length, 2, 'proveniência é critério de busca');
  const badStatus = mockRes();
  await fix.handler(mockReq({ method: 'GET', url: '/api/techniques?sourceId=x&status=todas', headers }), badStatus);
  assert.equal(badStatus.statusCode, 400, 'status fora do ciclo de vida não vira lista livre');
});

test('busca não executa SQL do usuário e arquivo adulterado sai do índice', async () => {
  const fix = await fixture();
  const technique = await save(fix, ACENO);
  const injecao = mockRes();
  await fix.handler(mockReq({ method: 'GET', url: `/api/techniques?q=${encodeURIComponent("'; DROP TABLE techniques; --")}`, headers }), injecao);
  assert.equal(injecao.statusCode, 200);
  const depois = mockRes();
  await fix.handler(mockReq({ method: 'GET', url: '/api/techniques', headers }), depois);
  assert.equal(json(depois).total, 1, 'a base continua inteira depois da tentativa de injeção');

  const file = path.join(fix.dataDir, 'techniques', `${technique.id}.json`);
  const adulterada = JSON.parse(await readFile(file, 'utf8'));
  adulterada.motions[0] = { kind: 'shape', shape: 'dança-da-chuva' };
  await writeFile(file, JSON.stringify(adulterada), 'utf8');

  const busca = mockRes();
  await fix.handler(mockReq({ method: 'GET', url: '/api/techniques?q=aceno', headers }), busca);
  assert.equal(json(busca).techniques.length, 0, 'arquivo inválido não é servir');
  const detalhe = mockRes();
  await fix.handler(mockReq({ method: 'GET', url: `/api/technique?id=${technique.id}`, headers }), detalhe);
  assert.equal(detalhe.statusCode, 404, 'leitura direta é estrita: adulterado é erro, não silêncio');
  assert.match(json(detalhe).error, /inválida/);
});

// --- camada documental ------------------------------------------------------

test('POST /api/technique/note grava a nota dentro do vault e sobrevive à reexecução', async () => {
  const fix = await fixture();
  const technique = await save(fix, ACENO);
  const res = mockRes();
  await fix.handler(mockReq({ headers, url: '/api/technique/note', body: JSON.stringify({ id: technique.id, vaultDir: fix.vaultDir }) }), res);
  assert.equal(res.statusCode, 200, res.body);
  const written = json(res);
  assert.ok(written.path.startsWith(fix.vaultDir));
  const markdown = await readFile(written.path, 'utf8');
  assert.ok(markdown.includes(`usami.technique: "${technique.id}"`));
  assert.ok(markdown.includes('wave-arm'), 'a tabela de movimentos saiu da técnica');

  const again = mockRes();
  await fix.handler(mockReq({ headers, url: '/api/technique/note', body: JSON.stringify({ id: technique.id, vaultDir: fix.vaultDir }) }), again);
  assert.equal(again.statusCode, 200);
  assert.equal(json(again).path, written.path, 'regenerar a mesma nota não abre arquivo paralelo');
});

test('nota recusada fora da subárvore do vault; id inexistente é 404', async () => {
  const fix = await fixture();
  const technique = await save(fix, ACENO);
  const fora = mockRes();
  await fix.handler(mockReq({ headers, url: '/api/technique/note', body: JSON.stringify({ id: technique.id, vaultDir: path.join(fix.root, 'sai-do-vault') }) }), fora);
  assert.equal(fora.statusCode, 422, 'fora da subárvore não é escrito em silêncio');
  const inexistente = mockRes();
  await fix.handler(mockReq({ headers, url: '/api/technique/note', body: JSON.stringify({ id: 'tc-000000000000', vaultDir: fix.vaultDir }) }), inexistente);
  assert.equal(inexistente.statusCode, 404);
  const forjado = mockRes();
  await fix.handler(mockReq({ headers, url: '/api/technique/note', body: JSON.stringify({ id: '../../vault/segredo', vaultDir: fix.vaultDir }) }), forjado);
  assert.equal(forjado.statusCode, 400, 'id de nota não vira caminho de arquivo');
});

// --- planner ---------------------------------------------------------------

test('POST /api/plan escolhe da base só o que foi validado por humano', async () => {
  const fix = await fixture();
  const capabilities = { sequences: true, gestures: ['wave'], clips: [] };
  const proposta = await save(fix, ACENO, 'proposta');
  const antes = mockRes();
  await fix.planner(mockReq({ headers, url: '/api/plan', body: JSON.stringify({ intent: 'wave', text: 'acena pra mim', capabilities }) }), antes);
  assert.equal(antes.statusCode, 200, antes.body);
  assert.equal(json(antes).plan.source, 'fallback', 'proposta ainda não alimenta o avatar');
  assert.equal(json(antes).plan.techniqueId, null);
  assert.ok(json(antes).plan.rejected.some(item => item.techniqueId === proposta.id));

  await save(fix, ACENO, 'validada');
  const depois = mockRes();
  await fix.planner(mockReq({ headers, url: '/api/plan', body: JSON.stringify({ intent: 'wave', text: 'acena pra mim', capabilities }) }), depois);
  const plan = json(depois).plan;
  assert.equal(plan.source, 'kb');
  assert.equal(plan.name, 'aceno em três pulsos');
  assert.equal(json(depois).actions[0].type, 'play_sequence');
  assert.equal(json(depois).actions[0].shape, 'wave-arm');
});

test('planner é determinístico e obedece ao manifesto: sem sequences, nada de shape', async () => {
  const fix = await fixture();
  await save(fix, ACENO, 'validada');
  const capabilities = { sequences: false, gestures: ['wave'], clips: [] };
  const um = mockRes();
  const dois = mockRes();
  await fix.planner(mockReq({ headers, url: '/api/plan', body: JSON.stringify({ intent: 'wave', capabilities }) }), um);
  await fix.planner(mockReq({ headers, url: '/api/plan', body: JSON.stringify({ intent: 'wave', capabilities }) }), dois);
  assert.equal(um.body, dois.body, 'mesma entrada, mesmo plano');
  const plan = json(um).plan;
  assert.equal(plan.source, 'fallback', 'a shape da técnica não pode ser oferecida');
  assert.equal(json(um).actions.length, 1);
  assert.equal(json(um).actions[0].type, 'gesture');
});

test('planner rejeita pedido fora do contrato e origem não permitida', async () => {
  const fix = await fixture();
  const ruim = mockRes();
  await fix.planner(mockReq({ headers, url: '/api/plan', body: JSON.stringify({ intent: 'dança', execute: 'rm -rf' }) }), ruim);
  assert.equal(ruim.statusCode, 400, 'campos desconhecidos não entram no contrato');
  const semOrigin = mockRes();
  await fix.planner(mockReq({ headers: { ...headers, origin: 'https://exemplo.com' }, url: '/api/plan', body: '{}' }), semOrigin);
  assert.equal(semOrigin.statusCode, 403);
});

test('planner: POST /api/plan exige token; GET /api/learning continua aberto', async () => {
  const fix = await fixture();
  const { 'x-usami-token': _omit, ...noToken } = headers;
  const denied = mockRes();
  await fix.planner(mockReq({
    headers: noToken,
    url: '/api/plan',
    body: JSON.stringify({ intent: 'wave', capabilities: { sequences: true, gestures: ['wave'], clips: [] } }),
  }), denied);
  assert.equal(denied.statusCode, 401);
  assert.deepEqual(json(denied), { error: 'Token ausente ou inválido.' });

  const leitura = mockRes();
  await fix.planner(mockReq({ method: 'GET', url: '/api/learning', headers: noToken }), leitura);
  assert.equal(leitura.statusCode, 200, leitura.body);
});

// --- memória de aprendizagem -----------------------------------------------

test('veredito humano entra pela rota e muda a escolha do planner', async () => {
  const fix = await fixture();
  const capabilities = { sequences: true, gestures: ['wave'], clips: [] };
  const boa = await save(fix, ACENO, 'validada');
  const ruim = await save(fix, {
    ...ACENO,
    name: 'aceno largo demais',
    motions: [{ kind: 'shape', shape: 'wave-arm', amplitude: 0.5, cycles: 5, durationMs: 4000, side: 'right' }],
  }, 'validada');

  // duas candidatas igualmente aderentes à intenção; o desempate vem da história
  const humano = mockRes();
  await fix.planner(mockReq({ headers, url: '/api/learning/verdict', body: JSON.stringify({ techniqueId: ruim.id, signature: null, verdict: 'reprovado', note: 'braço bate no cenário' }) }), humano);
  assert.equal(humano.statusCode, 422, 'sem assinatura o registro não existe — a rota não inventa chave');

  const memory = createLearningMemory({ dataDir: fix.dataDir });
  const { signatureOf } = await import('../src/motion-experiments.js');
  const badSignature = signatureOf(ruim.motions[0].request);
  memory.record({ techniqueId: ruim.id, signature: badSignature, outcome: { score: 91, verdict: 'pass' } });
  const goodSignature = signatureOf(boa.motions[0].request);
  memory.record({ techniqueId: boa.id, signature: goodSignature, outcome: { score: 60, verdict: 'pass' } });

  const antes = mockRes();
  await fix.planner(mockReq({ headers, url: '/api/plan', body: JSON.stringify({ intent: 'wave', text: 'acena', capabilities }) }), antes);
  assert.equal(json(antes).plan.techniqueId, ruim.id, 'nota objetiva maior ganha antes do julgamento humano');

  const veredito = mockRes();
  await fix.planner(mockReq({ headers, url: '/api/learning/verdict', body: JSON.stringify({ techniqueId: ruim.id, signature: badSignature, verdict: 'reprovado', note: 'o braço cruza o cenário' }) }), veredito);
  assert.equal(veredito.statusCode, 200, veredito.body);

  const depois = mockRes();
  await fix.planner(mockReq({ headers, url: '/api/plan', body: JSON.stringify({ intent: 'wave', text: 'acena', capabilities }) }), depois);
  assert.equal(json(depois).plan.techniqueId, boa.id, 'o veredito humano pesa contra, mesmo com métrica ótima');
});

test('GET /api/learning é somente-leitura e serializa totais', async () => {
  const fix = await fixture();
  const technique = await save(fix, ACENO, 'validada');
  const { signatureOf } = await import('../src/motion-experiments.js');
  createLearningMemory({ dataDir: fix.dataDir }).record({
    techniqueId: technique.id,
    signature: signatureOf(technique.motions[0].request),
    outcome: { score: 77, verdict: 'pass' },
  });
  const res = mockRes();
  await fix.planner(mockReq({ method: 'GET', url: '/api/learning', headers }), res);
  assert.equal(res.statusCode, 200);
  const payload = json(res);
  assert.equal(payload.entries.length, 1);
  assert.equal(payload.totals.entries, 1);
  assert.equal(payload.entries[0].lastScore, 77);
});
