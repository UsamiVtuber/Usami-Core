import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EpisodicMemoryStore } from '../src/episodic-memory.js';
import { EMBEDDING_DIMENSION } from '../src/local-embedder.js';

const DAY_MS = 86_400_000;

// Embedder determinístico: astronomia e culinária viram eixos ortogonais, o
// resto cai no eixo genérico. Ortogonalidade deixa a similaridade previsível.
function keywordEmbedder(text) {
  const vec = new Array(EMBEDDING_DIMENSION).fill(0);
  const lower = String(text ?? '').toLowerCase();
  if (lower.includes('rust') || lower.includes('concorrencia')) vec[0] = 1;
  else if (lower.includes('bolo') || lower.includes('culinaria')) vec[1] = 1;
  else vec[2] = 1;
  return Promise.resolve(vec);
}

function makeStore(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'usami-episodic-'));
  const store = new EpisodicMemoryStore({
    dataDir: dir,
    characterId: 'char-test',
    embedder: keywordEmbedder,
    flushIntervalMs: 0,
    ...overrides,
  });
  return { dir, store };
}

test('episodic: grava turno, indexa e recupera por semântica', async () => {
  const { dir, store } = makeStore();
  try {
    const res = store.recordTurn({
      userText: 'lembra daquele problema de concorrência no Rust que comentei?',
      assistantText: 'Lembro sim, era o deadlock no Arc<Mutex>.',
      ts: Date.now() - 5 * DAY_MS,
    });
    assert.equal(res.queued, true);
    assert.equal(await store.flush(), 1);
    assert.equal(await store.count(), 1);

    const hits = await store.search({ query: 'Rust concorrência', limit: 3 });
    assert.equal(hits.length, 1);
    assert.match(hits[0].text, /Rust/);
    assert.ok(hits[0].similarity > 0.9);
    assert.ok(hits[0].score <= hits[0].similarity);
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('episodic: deduplica o mesmo par de turno', async () => {
  const { dir, store } = makeStore();
  const turn = { userText: 'oi', assistantText: 'oi!', ts: Date.now() };
  try {
    store.recordTurn(turn);
    store.recordTurn(turn);
    await store.flush();
    assert.equal(await store.count(), 1);
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('episodic: decaimento coloca o recente na frente do antigo', async () => {
  const { dir, store } = makeStore();
  const now = Date.now();
  try {
    store.recordTurn({ userText: 'bug de concorrência no rust antigo', assistantText: 'debug', ts: now - 100 * DAY_MS, sessionId: 'old' });
    store.recordTurn({ userText: 'bug de concorrência no rust recente', assistantText: 'debug', ts: now, sessionId: 'new' });
    await store.flush();

    const hits = await store.search({ query: 'concorrência rust', limit: 2, nowMs: now });
    assert.equal(hits.length, 2);
    assert.match(hits[0].text, /recente/);
    assert.ok(hits[0].score > hits[1].score);
    assert.ok(hits[1].ageDays >= 90);
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('episodic: threshold filtra por relevância', async () => {
  const { dir, store } = makeStore();
  try {
    store.recordTurn({ userText: 'receita de bolo', assistantText: 'leva farinha', ts: Date.now() });
    await store.flush();
    const weak = await store.search({ query: 'concorrência rust', limit: 5, threshold: 0.6 });
    assert.equal(weak.length, 0);
    const strong = await store.search({ query: 'receita de bolo', limit: 5, threshold: 0.5 });
    assert.equal(strong.length, 1);
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('episodic: embedder quebrado grava degradado e nunca aparece na busca', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'usami-episodic-degraded-'));
  const store = new EpisodicMemoryStore({
    dataDir: dir,
    characterId: 'char-test',
    embedder: () => Promise.reject(new Error('onnx offline')),
    flushIntervalMs: 0,
    onError: () => {},
  });
  try {
    store.recordTurn({ userText: 'rust', assistantText: 'ok', ts: Date.now() });
    await store.flush();
    assert.equal(await store.count(), 1);
    assert.deepEqual(await store.search({ query: 'rust' }), []);
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('episodic: poda por quantidade mantém os mais recentes', async () => {
  const { dir, store } = makeStore();
  const now = Date.now();
  try {
    for (let i = 0; i < 3; i += 1) {
      store.recordTurn({ userText: `rust nota ${i}`, assistantText: 'ok', ts: now - (3 - i) * DAY_MS, sessionId: `s${i}` });
    }
    await store.flush();
    const res = await store.prune({ maxRows: 2, maxAgeDays: 0, nowMs: now });
    assert.equal(res.removedByRows, 1);
    assert.equal(await store.count(), 2);
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('episodic: backfill pareia histórico diário e é idempotente', async () => {
  const { dir, store } = makeStore();
  const history = {
    '2026-11-10': [
      { role: 'user', content: 'problema de concorrência em rust', timestamp: '2026-11-10T10:00:00.000Z' },
      { role: 'assistant', content: 'era o mutex', timestamp: '2026-11-10T10:00:05.000Z' },
      { role: 'user', content: 'e o bolo?', timestamp: '2026-11-10T10:01:00.000Z' },
      { role: 'assistant', content: 'leva farinha', timestamp: '2026-11-10T10:01:05.000Z' },
    ],
  };
  try {
    const first = await store.backfill(history);
    assert.equal(first.queued, 2);
    assert.equal(await store.count(), 2);
    const second = await store.backfill(history);
    assert.equal(second.queued, 0);
    assert.equal(await store.count(), 2);
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('episodic: personagens diferentes não compartilham tabela nem diretório', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'usami-episodic-mt-'));
  const alpha = new EpisodicMemoryStore({ dataDir: dir, characterId: 'char-alpha', embedder: keywordEmbedder, flushIntervalMs: 0 });
  const beta = new EpisodicMemoryStore({ dataDir: dir, characterId: 'char-beta', embedder: keywordEmbedder, flushIntervalMs: 0 });
  try {
    assert.equal(alpha.tableName, 'episodes_char_alpha');
    assert.notEqual(alpha.dbDir, beta.dbDir);
    alpha.recordTurn({ userText: 'rust', assistantText: 'a', ts: Date.now() });
    await alpha.flush();
    await beta.init();
    assert.equal(await alpha.count(), 1);
    assert.equal(await beta.count(), 0);
  } finally {
    await alpha.close();
    await beta.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('episodic: consulta vazia não toca o índice', async () => {
  const { dir, store } = makeStore();
  try {
    assert.deepEqual(await store.search({ query: '   ' }), []);
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// Embedder de vetores fixos: a similaridade vem do cosseno declarado, o que
// permite simular a faixa comprimida que o modelo real produce em pt-BR.
function fixedEmbedder(resolveVector) {
  return text => Promise.resolve(resolveVector(String(text)));
}

function cosineVector(cos) {
  const vec = new Array(EMBEDDING_DIMENSION).fill(0);
  vec[0] = cos;
  vec[1] = Math.sqrt(1 - cos * cos);
  return vec;
}

test('episodic: âncora lexical resgata consulta fraca e descarta ruído do piso', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'usami-episodic-anchor-'));
  const query = 'me lembra da pizza';
  // Cossenos escolhidos para similaridade 0,42 (pizza) e 0,43 (tempo) após o
  // mapeamento L2 do índice: ambos abaixo do piso 0,45 sem a âncora.
  const store = new EpisodicMemoryStore({
    dataDir: dir,
    characterId: 'char-test',
    flushIntervalMs: 0,
    embedder: fixedEmbedder(text => {
      if (text === query) return cosineVector(1);
      if (text.includes('pizza')) return cosineVector(0.32);
      return cosineVector(0.35);
    }),
  });
  try {
    store.recordTurn({ userText: 'pedido de pizza', assistantText: 'anotado', ts: Date.now() });
    store.recordTurn({ userText: 'previsão do tempo', assistantText: 'vai chover', ts: Date.now() });
    await store.flush();

    const hits = await store.search({ query, limit: 5 });
    assert.equal(hits.length, 1);
    assert.match(hits[0].text, /pizza/);
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('episodic: denso sem termo em comum e sem confiança alta não entra', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'usami-episodic-nodense-'));
  const query = 'tô cansado hoje';
  const store = new EpisodicMemoryStore({
    dataDir: dir,
    characterId: 'char-test',
    flushIntervalMs: 0,
    embedder: fixedEmbedder(text => {
      if (text === query) return cosineVector(1);
      return cosineVector(0.6157); // sim ~0,5654: acima do piso e sem âncora
    }),
  });
  try {
    store.recordTurn({ userText: 'como tá o tempo', assistantText: 'vai chover', ts: Date.now() });
    await store.flush();
    assert.deepEqual(await store.search({ query, limit: 5 }), []);
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('episodic: janela relativa mantém só o melhor quando a faixa é comprimida', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'usami-episodic-margin-'));
  const query = 'concorrência rust';
  const store = new EpisodicMemoryStore({
    dataDir: dir,
    characterId: 'char-test',
    flushIntervalMs: 0,
    embedder: fixedEmbedder(text => {
      if (text === query) return cosineVector(1);
      if (text.includes('grave')) return cosineVector(0.6667); // sim 0,60
      return cosineVector(0.5); // sim 0,50
    }),
  });
  try {
    store.recordTurn({ userText: 'rust deadlock grave', assistantText: 'ok', ts: Date.now() });
    store.recordTurn({ userText: 'rust leve', assistantText: 'ok', ts: Date.now() });
    await store.flush();

    const hits = await store.search({ query, limit: 5 });
    assert.equal(hits.length, 1);
    assert.match(hits[0].text, /grave/);
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('episodic: turno ao vivo e backfill do mesmo par não duplicam', async () => {
  const { dir, store } = makeStore();
  try {
    const ts = Date.parse('2026-11-12T10:00:00.000Z');
    store.recordTurn({ userText: 'problema no rust', assistantText: 'era o mutex', ts, sessionId: 'chat' });
    await store.flush();
    await store.backfill({
      '2026-11-12': [
        { role: 'user', content: 'problema no rust', timestamp: '2026-11-12T10:00:00.000Z' },
        { role: 'assistant', content: 'era o mutex', timestamp: '2026-11-12T10:00:05.000Z' },
      ],
    });
    assert.equal(await store.count(), 1);
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
