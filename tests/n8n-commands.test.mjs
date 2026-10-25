import test from 'node:test';
import assert from 'node:assert/strict';

// A rota n8n só aceita o vocabulário conhecido — o mesmo contrato do director.
process.env.USE_NVIDIA = 'false';
const { createN8nCommandHandler } = await import('../server.mjs');

function mockReq({ method = 'POST', url = '/api/n8n/command', body = '' } = {}) {
  return {
    method,
    url,
    headers: { origin: 'http://127.0.0.1:5173', host: '127.0.0.1:8787', 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(body); },
  };
}
function mockRes() {
  const res = { statusCode: null, body: '' };
  res.writeHead = status => { res.statusCode = status; };
  res.end = data => { res.body = data; };
  return res;
}
const call = async (handler, req) => { const res = mockRes(); await handler(req, res); return { ...res, json: () => JSON.parse(res.body) }; };

test('play_sequence entra na fila quando a shape é conhecida', async () => {
  const handler = createN8nCommandHandler();
  const post = await call(handler, mockReq({ body: JSON.stringify({ type: 'play_sequence', shape: 'wave-arm', amplitude: 0.25 }) }));
  assert.equal(post.statusCode, 200);
  assert.equal(post.json().ok, true);

  const drain = await call(handler, mockReq({ method: 'GET', url: '/api/n8n/commands' }));
  const commands = drain.json().commands;
  assert.equal(commands.length, 1);
  assert.equal(commands[0].type, 'play_sequence');
  assert.equal(commands[0].shape, 'wave-arm');

  // fila é drenada: a segunda leitura não duplica o comando
  const again = await call(handler, mockReq({ method: 'GET', url: '/api/n8n/commands' }));
  assert.deepEqual(again.json().commands, []);
});

test('shape inválida ou ausente em play_sequence é 400', async () => {
  const handler = createN8nCommandHandler();
  for (const body of [{ type: 'play_sequence', shape: 'moonwalk' }, { type: 'play_sequence' }, { type: 'play_sequence', shape: 42 }]) {
    const res = await call(handler, mockReq({ body: JSON.stringify(body) }));
    assert.equal(res.statusCode, 400, JSON.stringify(body));
  }
  const drain = await call(handler, mockReq({ method: 'GET', url: '/api/n8n/commands' }));
  assert.deepEqual(drain.json().commands, [], 'nada entrou na fila');
});

test('gesture fora da lista continua rejeitado', async () => {
  const handler = createN8nCommandHandler();
  assert.equal((await call(handler, mockReq({ body: JSON.stringify({ type: 'gesture', name: 'voar' }) }))).statusCode, 400);
  const res = await call(handler, mockReq({ body: JSON.stringify({ type: 'gesture', name: 'clap' }) }));
  assert.equal(res.statusCode, 200);
  await call(handler, mockReq({ method: 'DELETE', url: '/api/n8n/commands' }));
  const empty = await call(handler, mockReq({ method: 'GET', url: '/api/n8n/commands' }));
  assert.deepEqual(empty.json().commands, []);
});
