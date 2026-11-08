import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { readBodyBuffer, readRequestBody } from '../server.mjs';

// B13: um único leitor de corpo (Buffers concatenados, um único decode UTF-8).
// Estes testes usam HTTP real para provar que o 413 CHEGA ao cliente (o `break`
// antigo destruía o socket e a resposta nunca saía) e que um caractere multibyte
// partido entre dois chunks não vira U+FFFD.

async function withServer(handler, run) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  try {
    await run(port);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

function postInChunks(port, chunks, { delayMs = 10 } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: '127.0.0.1',
      port,
      path: '/api/teste',
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
    }, response => {
      const data = [];
      response.on('data', chunk => data.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(data).toString('utf8') }));
    });
    request.on('error', reject);
    (async () => {
      for (const chunk of chunks) {
        request.write(chunk);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
      request.end();
    })().catch(reject);
  });
}

test('corpo multibyte partido em dois chunks chega intacto (decode único)', async () => {
  const text = 'café com pão 😀 ação — fim';
  const bytes = Buffer.from(text, 'utf8');
  // divide DENTRO do emoji de 4 bytes: decodificar por chunk geraria U+FFFD
  const emoji = Buffer.from('😀', 'utf8');
  const split = bytes.indexOf(emoji) + 2;
  assert.ok(split > 0 && split < bytes.length);

  await withServer(async (req, res) => {
    const read = await readRequestBody(req, { limit: 1024 });
    res.writeHead(read.ok ? 200 : read.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(read.ok ? { body: read.body } : { error: 'grande' }));
  }, async port => {
    const response = await postInChunks(port, [bytes.subarray(0, split), bytes.subarray(split)]);
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(response.body).body, text);
    assert.ok(!response.body.includes('\uFFFD'), 'nenhum caractere de substituição');
  });
});

test('corpo acima do limite responde 413 e o cliente RECEBE a resposta', async () => {
  await withServer(async (req, res) => {
    const read = await readRequestBody(req, { limit: 16 });
    if (!read.ok) {
      res.writeHead(read.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Muito grande.' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ body: read.body }));
  }, async port => {
    const payload = Buffer.alloc(100, 0x61); // 100 > 16
    const response = await postInChunks(port, [payload.subarray(0, 40), payload.subarray(40)]);
    assert.equal(response.status, 413, 'a resposta 413 precisa chegar, não morrer com o socket');
    assert.deepEqual(JSON.parse(response.body), { error: 'Muito grande.' });
  });
});

test('readBodyBuffer: limites por bytes e corpo binário fiel', async () => {
  const binario = Buffer.from([0x00, 0xff, 0x10, 0x7f, 0x80]);
  const req = {
    async *[Symbol.asyncIterator]() {
      yield binario.subarray(0, 2);
      yield binario.subarray(2);
    },
  };
  const ok = await readBodyBuffer(req, { limit: 5 });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.buffer, binario);

  const grande = await readBodyBuffer({
    async *[Symbol.asyncIterator]() {
      yield Buffer.alloc(10);
      yield Buffer.alloc(10);
    },
  }, { limit: 15 });
  assert.deepEqual(grande, { ok: false, status: 413 });
});
