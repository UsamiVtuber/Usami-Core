import test from 'node:test';
import assert from 'node:assert/strict';

// A rota n8n só aceita o vocabulário conhecido — o mesmo contrato do director.
process.env.USE_NVIDIA = 'false';
process.env.USAMI_KEYS_FILE = process.env.USAMI_KEYS_FILE || 'no-keys.env';
const { createN8nCommandHandler: createHandler, refineAnimationInBackground } = await import('../server.mjs');
const { createN8nCommandQueue } = await import('../src/n8n-queue.js');

const TEST_TOKEN = 'token-de-teste';
const createN8nCommandHandler = () => createHandler({ apiToken: TEST_TOKEN });
// Fila isolada por teste (a compartilhada do processo acumularia comandos).
const isolated = () => {
  const queue = createN8nCommandQueue();
  return { queue, handler: createHandler({ apiToken: TEST_TOKEN, queue }) };
};

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
  const savedToken = process.env.USAMI_API_TOKEN;
  delete process.env.USAMI_API_TOKEN;
  try {
    const handler = createN8nCommandHandler();
    const body = JSON.stringify({ type: 'gesture', name: 'clap' });
    assert.equal((await call(handler, mockReq({ body, headers: {} }))).statusCode, 401);
    assert.equal((await call(handler, mockReq({ body, headers: { 'x-usami-token': 'errado' } }))).statusCode, 401);
    assert.equal((await call(handler, mockReq({ method: 'GET', url: '/api/n8n/commands', headers: {} }))).statusCode, 401);
    assert.equal((await call(createHandler({ apiToken: null }), mockReq({ body }))).statusCode, 503);
  } finally {
    if (savedToken !== undefined) process.env.USAMI_API_TOKEN = savedToken;
  }
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

// --- B6: fila por cliente + ack --------------------------------------------

// mockReq monta os headers do zero quando recebe um objeto: o token padrão não
// é herdado, então o helper de cliente inclui o token.
const clientHeaders = client => ({ 'x-usami-token': TEST_TOKEN, 'x-usami-client': client });

test('B6: duas abas não roubam o comando uma da outra', async () => {
  const { handler } = isolated();
  await call(handler, mockReq({
    headers: clientHeaders('aba-a'),
    body: JSON.stringify({ type: 'gesture', name: 'clap' }),
  }));

  const a = await call(handler, mockReq({ method: 'GET', url: '/api/n8n/commands', headers: clientHeaders('aba-a') }));
  assert.equal(a.json().commands.length, 1);
  const b = await call(handler, mockReq({ method: 'GET', url: '/api/n8n/commands', headers: clientHeaders('aba-b') }));
  assert.deepEqual(b.json().commands, [], 'a aba B não recebe o comando da aba A');
});

test('B6: refino do chat vai só para o cliente que pediu o turno', async () => {
  const { queue, handler } = isolated();
  const planner = async () => ({ actions: [{ type: 'gesture', name: 'wave' }] });

  await refineAnimationInBackground('oi!', null, { planner, clientId: 'aba-a', queue });

  const a = await call(handler, mockReq({ method: 'GET', url: '/api/n8n/commands', headers: clientHeaders('aba-a') }));
  assert.deepEqual(a.json().commands.map(cmd => cmd.type), ['gesture']);
  assert.equal(a.json().commands[0].name, 'wave');
  const b = await call(handler, mockReq({ method: 'GET', url: '/api/n8n/commands', headers: clientHeaders('aba-b') }));
  assert.deepEqual(b.json().commands, []);
});

test('B6: POST do n8n sem header faz fanout para clientes ativos (poll < 60 s)', async () => {
  const { handler } = isolated();
  // Registra a aba A como ativa (poll vazio).
  await call(handler, mockReq({ method: 'GET', url: '/api/n8n/commands', headers: clientHeaders('aba-a') }));

  const post = await call(handler, mockReq({ body: JSON.stringify({ type: 'gesture', name: 'clap' }) }));
  assert.equal(post.statusCode, 200);

  const a = await call(handler, mockReq({ method: 'GET', url: '/api/n8n/commands', headers: clientHeaders('aba-a') }));
  assert.deepEqual(a.json().commands.map(cmd => cmd.name), ['clap']);
  // A aba B nunca pollou: não estava registrada no fanout e não recebe.
  const b = await call(handler, mockReq({ method: 'GET', url: '/api/n8n/commands', headers: clientHeaders('aba-b') }));
  assert.deepEqual(b.json().commands, []);
});

test('B6: sem cliente ativo o POST fica pendente até o primeiro poll', async () => {
  const { queue, handler } = isolated();
  assert.equal(queue.activeClientIds().length, 0);
  await call(handler, mockReq({ body: JSON.stringify({ type: 'gesture', name: 'clap' }) }));

  const first = await call(handler, mockReq({ method: 'GET', url: '/api/n8n/commands', headers: clientHeaders('aba-a') }));
  assert.deepEqual(first.json().commands.map(cmd => cmd.name), ['clap']);
  // Pendente já foi entregue ao primeiro poll: o segundo cliente não vê.
  const second = await call(handler, mockReq({ method: 'GET', url: '/api/n8n/commands', headers: clientHeaders('aba-b') }));
  assert.deepEqual(second.json().commands, []);
});

test('B6: ack exige token, remove só os ids do cliente e ignora desconhecidos', async () => {
  const { queue, handler } = isolated();
  await call(handler, mockReq({
    headers: clientHeaders('aba-a'),
    body: JSON.stringify({ type: 'gesture', name: 'clap' }),
  }));
  const got = await call(handler, mockReq({ method: 'GET', url: '/api/n8n/commands', headers: clientHeaders('aba-a') }));
  const id = got.json().commands[0].id;

  // Sem token a escrita sensível é recusada.
  const noToken = await call(handler, mockReq({
    method: 'POST',
    url: '/api/n8n/commands/ack',
    headers: { 'x-usami-client': 'aba-a' },
    body: JSON.stringify({ ids: [id] }),
  }));
  assert.equal(noToken.statusCode, 401);

  const ack = await call(handler, mockReq({
    method: 'POST',
    url: '/api/n8n/commands/ack',
    headers: clientHeaders('aba-a'),
    body: JSON.stringify({ ids: [id, 'id-que-nao-existe'] }),
  }));
  assert.equal(ack.statusCode, 200);
  assert.deepEqual(ack.json(), { ok: true });
  assert.equal(queue.count(), 0);
  const again = await call(handler, mockReq({ method: 'GET', url: '/api/n8n/commands', headers: clientHeaders('aba-a') }));
  assert.deepEqual(again.json().commands, [], 'sem reentrega depois do ack');
});

test('B6: comando entregue e não confirmado é podado após 120 s, com log', async () => {
  const clock = { ms: 1_000_000 };
  const logs = [];
  const queue = createN8nCommandQueue({
    now: () => clock.ms,
    log: (...args) => logs.push(args.join(' ')),
  });
  const handler = createHandler({ apiToken: TEST_TOKEN, queue });

  await call(handler, mockReq({ body: JSON.stringify({ type: 'gesture', name: 'clap' }), headers: clientHeaders('aba-a') }));
  const got = await call(handler, mockReq({ method: 'GET', url: '/api/n8n/commands', headers: clientHeaders('aba-a') }));
  assert.equal(got.json().commands.length, 1);

  clock.ms += 121_000;
  queue.prune();
  assert.equal(queue.count(), 0);
  assert.ok(logs.some(line => line.includes('[n8n] comando não confirmado')), logs.join('\n'));
});

test('B6: POST não sobrescreve id/timestamp forjados', async () => {
  const { handler } = isolated();
  const posted = await call(handler, mockReq({
    headers: clientHeaders('aba-a'),
    body: JSON.stringify({
      type: 'gesture',
      name: 'clap',
      id: 'forjado',
      timestamp: '1999-01-01T00:00:00.000Z',
    }),
  }));
  assert.equal(posted.statusCode, 200);
  assert.notEqual(posted.json().id, 'forjado');

  const got = await call(handler, mockReq({ method: 'GET', url: '/api/n8n/commands', headers: clientHeaders('aba-a') }));
  const [command] = got.json().commands;
  assert.notEqual(command.id, 'forjado');
  assert.notEqual(command.timestamp, '1999-01-01T00:00:00.000Z');
  assert.match(command.timestamp, /^\d{4}-\d{2}-\d{2}T/);
});
