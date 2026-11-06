import test from 'node:test';
import assert from 'node:assert/strict';

// A rota n8n só aceita o vocabulário conhecido — o mesmo contrato do director.
process.env.USE_NVIDIA = 'false';
process.env.USAMI_KEYS_FILE = process.env.USAMI_KEYS_FILE || 'no-keys.env';
const { createN8nCommandHandler: createHandler } = await import('../server.mjs');

const TEST_TOKEN = 'token-de-teste';
const createN8nCommandHandler = () => createHandler({ apiToken: TEST_TOKEN });

function mockReq({ method = 'POST', url = '/api/n8n/command', body = '', headers = { 'x-usami-token': TEST_TOKEN } } = {}) {
  return {
    method,
    url,
    headers: { origin: 'http://127.0.0.1:5173', host: '127.0.0.1:8787', 'content-type': 'application/json', ...headers },
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

test('sem token (ou com token errado) a fila do n8n responde 401', async () => {
  const handler = createN8nCommandHandler();
  const body = JSON.stringify({ type: 'gesture', name: 'clap' });
  assert.equal((await call(handler, mockReq({ body, headers: {} }))).statusCode, 401);
  assert.equal((await call(handler, mockReq({ body, headers: { 'x-usami-token': 'errado' } }))).statusCode, 401);
  assert.equal((await call(handler, mockReq({ method: 'GET', url: '/api/n8n/commands', headers: {} }))).statusCode, 401);
  assert.equal((await call(createHandler({}), mockReq({ body }))).statusCode, 503);
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
