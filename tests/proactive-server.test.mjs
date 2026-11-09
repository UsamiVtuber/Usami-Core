import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProactiveStore } from '../src/proactive-events.js';
import { createProactiveEngine } from '../src/proactive-engine.js';

const scratchDir = mkdtempSync(join(tmpdir(), 'usami-proactive-api-'));
process.env.USAMI_DATA_DIR = scratchDir;
process.env.USAMI_KEYS_FILE = process.env.USAMI_KEYS_FILE || join(scratchDir, 'no-keys.env');

const { createProactiveHandler } = await import('../server.mjs');

const TEST_TOKEN = 'token-proactive-teste';

function mockReq({ method = 'GET', url = '/api/proactive/events', headers = {}, body = '' } = {}) {
  const chunks = body ? [Buffer.from(body)] : [];
  return {
    method,
    url,
    headers: { host: '127.0.0.1:8787', 'x-usami-token': TEST_TOKEN, ...headers },
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

async function call(handler, req) {
  const res = mockRes();
  await handler(req, res);
  return { status: res.statusCode, data: JSON.parse(res.body || '{}') };
}

test('proactive-server: rotas events, ack e state', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'usami-proactive-harness-'));
  try {
    let nowMs = new Date('2026-11-09T14:00:00.000Z').getTime();
    const nowFn = () => nowMs;

    const store = createProactiveStore({ dataDir: dir, now: nowFn });
    let activityMarked = false;
    const engine = {
      getState: () => ({ idleMs: 12000 }),
      checkAndTrigger: async () => ({ triggered: false }),
      markUserActivity: () => { activityMarked = true; },
    };

    const handler = createProactiveHandler({
      proactiveStore: store,
      proactiveEngine: engine,
      apiToken: TEST_TOKEN,
    });

    // 1. GET /api/proactive/events inicial vazio + registra atividade
    const r1 = await call(handler, mockReq({
      method: 'GET',
      url: '/api/proactive/events',
      headers: { 'x-usami-activity': 'active' },
    }));
    assert.equal(r1.status, 200);
    assert.deepEqual(r1.data.events, []);
    assert.ok(r1.data.serverTime);
    assert.equal(activityMarked, true);

    // 2. POST /api/proactive/events cria evento
    const expiresAt = new Date(nowMs + 3600 * 1000).toISOString();
    const rCreate = await call(handler, mockReq({
      method: 'POST',
      url: '/api/proactive/events',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'reminder',
        text: 'Consulta marcada às 15h',
        expiresAt,
        dedupeKey: 'consulta-1',
      }),
    }));
    assert.equal(rCreate.status, 201);
    assert.equal(rCreate.data.ok, true);
    const eventId = rCreate.data.id;
    assert.ok(eventId);

    // 3. GET /api/proactive/events agora devolve o evento criado
    const rGet = await call(handler, mockReq({
      method: 'GET',
      url: '/api/proactive/events',
    }));
    assert.equal(rGet.status, 200);
    assert.equal(rGet.data.events.length, 1);
    assert.equal(rGet.data.events[0].id, eventId);
    assert.equal(rGet.data.events[0].text, 'Consulta marcada às 15h');

    // 4. POST /api/proactive/events/ack confirma exibição
    const rAck = await call(handler, mockReq({
      method: 'POST',
      url: '/api/proactive/events/ack',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        acks: [{ id: eventId, outcome: 'shown' }],
      }),
    }));
    assert.equal(rAck.status, 200);
    assert.equal(rAck.data.ok, true);
    assert.equal(rAck.data.acked, 1);

    // 5. GET subsequente não devolve mais o evento
    const rEmpty = await call(handler, mockReq({
      method: 'GET',
      url: '/api/proactive/events',
    }));
    assert.equal(rEmpty.status, 200);
    assert.equal(rEmpty.data.events.length, 0);

    // 6. GET /api/proactive/state expõe engine e store
    const rState = await call(handler, mockReq({
      method: 'GET',
      url: '/api/proactive/state',
    }));
    assert.equal(rState.status, 200);
    assert.equal(rState.data.engine.idleMs, 12000);
    assert.equal(rState.data.store.eventCount, 0);
    assert.equal(rState.data.store.tombstoneCount, 1);
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});
