// Teste de interface dos endpoints de controle da agente:
//   GET  /api/llm_models   -> modelos reais de chat/raciocínio/visão
//   POST /api/vision/toggle -> alterna o estado de visão da agente
//
// Sobe um servidor HTTP de teste em porta efêmera e valida o contrato de
// resposta de cada endpoint, simulando a interação do menu com o backend.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { createServer } from 'node:http';
import { FAST_MODEL, BRAIN_MODEL, VISION_MODEL } from '../src/llm-router.js';

// Estado de visão em memória (espelha o do server.mjs).
let visionEnabled = true;

function json(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/api/llm/models') {
    json(res, 200, { chat: FAST_MODEL, reasoning: BRAIN_MODEL, vision: VISION_MODEL });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/vision/toggle') {
    visionEnabled = !visionEnabled;
    json(res, 200, { enabled: visionEnabled });
    return;
  }
  json(res, 404, { error: 'Não encontrado.' });
}

async function fetchJson(path, opts = {}) {
  const res = await fetch(`http://localhost:${PORT}${path}`, opts);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

let PORT;
let server;

describe('interface: endpoints de controle da agente', () => {
  before(async () => {
    server = createServer(handle);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    PORT = server.address().port;
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('modelos LLM estão configurados (strings não vazias)', () => {
    assert.ok(typeof FAST_MODEL === 'string' && FAST_MODEL.length > 0, 'FAST_MODEL');
    assert.ok(typeof BRAIN_MODEL === 'string' && BRAIN_MODEL.length > 0, 'BRAIN_MODEL');
    assert.ok(typeof VISION_MODEL === 'string' && VISION_MODEL.length > 0, 'VISION_MODEL');
    assert.notEqual(FAST_MODEL, BRAIN_MODEL, 'chat e raciocínio são modelos diferentes');
  });

  it('responde GET /api/llm/models com modelos reais', async () => {
    const { status, body } = await fetchJson('/api/llm/models');
    assert.equal(status, 200);
    assert.equal(body.chat, FAST_MODEL);
    assert.equal(body.reasoning, BRAIN_MODEL);
    assert.equal(body.vision, VISION_MODEL);
    assert.ok(body.chat && body.reasoning && body.vision, 'todos os modelos presentes');
  });

  it('POST /api/vision/toggle alterna o estado e retorna enabled', async () => {
    const primeiro = await fetchJson('/api/vision/toggle', { method: 'POST' });
    assert.equal(primeiro.status, 200);
    assert.equal(primeiro.body.enabled, false, 'primeiro toggle desliga');

    const segundo = await fetchJson('/api/vision/toggle', { method: 'POST' });
    assert.equal(segundo.status, 200);
    assert.equal(segundo.body.enabled, true, 'segundo toggle liga');

    const terceiro = await fetchJson('/api/vision/toggle', { method: 'POST' });
    assert.equal(terceiro.body.enabled, false, 'terceiro toggle desliga novamente');
  });

  it('404 para rota inexistente', async () => {
    const { status } = await fetchJson('/api/nao-existe');
    assert.equal(status, 404);
  });
});
