import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyReply, createChatHandler, filterActionsByCatalog, isAllowedOrigin, parseChatBody, parseProviderRaw, sanitizeActions, sanitizeCapabilities, systemFor } from '../server.mjs';

function mockReq({ method = 'POST', url = '/api/chat', headers = {}, body = '' } = {}) {
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

function jsonResponse(content, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => ({ choices: [{ message: { content } }] }) };
}

test('isAllowedOrigin: localhost e same-origin', () => {
  assert.equal(isAllowedOrigin('http://127.0.0.1:5173', '127.0.0.1:8787', ['http://127.0.0.1:5173']), true);
  assert.equal(isAllowedOrigin(undefined, 'example.com'), true);
  assert.equal(isAllowedOrigin('https://example.com', 'example.com'), true);
  assert.equal(isAllowedOrigin('https://evil.com', 'example.com'), false);
});

test('parseChatBody: valida mensagem', () => {
  const result = parseChatBody(JSON.stringify({ message: 'oi' }));
  assert.equal(result.ok, true);
  assert.equal(result.message, 'oi');
  assert.equal(result.input.message, undefined);
  assert.equal(parseChatBody('not json').ok, false);
  assert.equal(parseChatBody(JSON.stringify({ message: '' })).ok, false);
  assert.equal(parseChatBody(JSON.stringify({ message: 'x'.repeat(2001) })).ok, false);
  assert.equal(parseChatBody(JSON.stringify({})).ok, false);
});

test('parseProviderRaw: JSON válido e fence', () => {
  assert.deepEqual(parseProviderRaw('{"reply":"olá","gesture":"tilt"}'), { ok: true, reply: 'olá', gesture: 'tilt', actions: [] });
  assert.deepEqual(parseProviderRaw('```json\n{"reply":"oi","gesture":"neutral","actions":[{"type":"gesture","name":"wave"}]}\n```'), { ok: true, reply: 'oi', gesture: 'neutral', actions: [{ type: 'gesture', name: 'wave' }] });
  assert.equal(parseProviderRaw('{"reply":"","gesture":"neutral"}').ok, false);
  assert.equal(parseProviderRaw('not json but short').ok, true);
  assert.equal(parseProviderRaw('[' + 'x'.repeat(2100)).ok, false);
});

test('sanitizeActions elimina verbs desconhecidos e limita a 5', () => {
  const sanitized = sanitizeActions([
    { type: 'gesture', name: 'wave' },
    { type: 'set_morph', name: 'smile', value: 0.5, extra: 'ignored' },
    { type: 'set_mesh_visible', name: 'Hat', visible: false },
    { type: 'invasor' },
    'não é objeto',
    { type: 'set_morph', name: 'long'.repeat(100), value: 0.1 },
    { type: 'play_clip', name: 'Clip' },
    { type: 'set_morph', name: 'x', value: 0.2 },
    { type: 'set_morph', name: 'y', value: 0.3 },
    { type: 'set_morph', name: 'z', value: 0.4 },
  ]);
  assert.equal(sanitized.length, 5);
  assert.deepEqual(sanitized[1], { type: 'set_morph', name: 'smile', value: 0.5 });
  assert.deepEqual(sanitized[2], { type: 'set_mesh_visible', name: 'Hat', visible: false });
  assert.equal(sanitized[3].name.length, 60);
  assert.deepEqual(sanitizeActions('não array'), []);
  assert.deepEqual(sanitizeActions([null, undefined]), []);
  assert.deepEqual(sanitizeActions([{ type: 'set_expression', name: 'happy', weight: 0.8 }]), [{ type: 'set_expression', name: 'happy', weight: 0.8 }]);
});

test('filterActionsByCatalog descarta ações fora do catálogo anunciado', () => {
  const capabilities = { gestures: [], clips: ['Dance'], morphs: ['smile'], expressions: ['happy'] };
  const actions = [
    { type: 'gesture', name: 'tilt' },
    { type: 'gesture', name: 'wave' },
    { type: 'play_clip', name: 'Dance' },
    { type: 'play_clip', name: 'Inexistente' },
    { type: 'set_morph', name: 'smile' },
    { type: 'set_expression', name: 'happy' },
    { type: 'set_mesh_visible', name: 'Hat', visible: false },
    { type: 'set_expression', name: 'unknown' },
  ];
  assert.deepEqual(filterActionsByCatalog(actions, capabilities), [
    { type: 'play_clip', name: 'Dance' },
    { type: 'set_morph', name: 'smile' },
    { type: 'set_expression', name: 'happy' },
    { type: 'set_mesh_visible', name: 'Hat', visible: false },
  ]);
  // sem capabilities (ou catálogo ausente no objeto) → mantém tudo
  assert.deepEqual(filterActionsByCatalog(actions, null), actions);
  assert.deepEqual(filterActionsByCatalog(actions, {}), actions);
  assert.deepEqual(filterActionsByCatalog('não array', capabilities), []);
});

test('sanitizeCapabilities normaliza resumo do cliente', () => {
  const sanitized = sanitizeCapabilities({
    format: 'GLB / glTF '.padEnd(60, 'x'),
    clips: ['Dance_Asset', 42, 'long'.repeat(80), ''],
    morphs: ['smile', 7],
    meshes: [{ name: 'Body' }, { name: 'Hat', accessory: true }, { name: '' }, 9, 'not object'],
    gestures: ['tilt', 'idle', 'wave', 'coisa demais'],
    expressions: ['happy', 42, 'long'.repeat(80), ''],
    aliens: ['x'],
  });
  assert.equal(sanitized.format.length, 40);
  assert.deepEqual(sanitized.clips, ['Dance_Asset', 'long'.repeat(15)]);
  assert.deepEqual(sanitized.morphs, ['smile']);
  assert.deepEqual(sanitized.meshes, [{ name: 'Body', accessory: false }, { name: 'Hat', accessory: true }]);
  assert.deepEqual(sanitized.gestures, ['tilt', 'idle', 'wave']);
  assert.deepEqual(sanitized.expressions, ['happy', 'long'.repeat(15)]);
  assert.equal(sanitizeCapabilities(null), null);
  assert.equal(sanitizeCapabilities('x'), null);
  assert.deepEqual(sanitizeCapabilities({}).clips, []);
});

test('systemFor embute capabilities no prompt', () => {
  assert.ok(systemFor(null).length > 0);
  assert.ok(systemFor({ clips: ['Dance'] }).includes('"Dance"'));
});

test('classifyReply gates the second model call and survives provider failures', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return jsonResponse('{"actions":[{"type":"set_expression","name":"happy","weight":0.7}]}');
  };
  const classified = await classifyReply({ fetchImpl, key: 'key', model: 'model', reply: 'que bom te ver hoje', capabilities: { expressions: ['happy'], gestures: ['tilt'] } });
  assert.deepEqual(classified, [{ type: 'set_expression', name: 'happy', weight: 0.7 }]);
  assert.equal(calls, 1);

  let gestureCalls = 0;
  const gestureFetch = async () => {
    gestureCalls++;
    return jsonResponse('{"actions":[]}');
  };
  const gestureOnly = await classifyReply({ fetchImpl: gestureFetch, key: 'key', model: 'model', reply: 'oi', capabilities: { gestures: ['tilt', 'wave'] } });
  assert.equal(gestureOnly, null);
  assert.equal(gestureCalls, 0);

  const failed = await classifyReply({ fetchImpl: async () => { throw new Error('boom'); }, key: 'key', model: 'model', reply: 'oi', capabilities: { expressions: ['happy'] } });
  assert.equal(failed, null);
});

test('handler: 404 para método/rota incorretos', async () => {
  const handler = createChatHandler({ getKey: async () => 'k', fetchImpl: async () => jsonResponse('') });
  const res = mockRes();
  await handler(mockReq({ method: 'GET', url: '/api/chat' }), res);
  assert.equal(res.statusCode, 404);
  const res2 = mockRes();
  await handler(mockReq({ url: '/other' }), res2);
  assert.equal(res2.statusCode, 404);
});

test('handler: 403 origem inválida', async () => {
  const handler = createChatHandler({ getKey: async () => 'k', fetchImpl: async () => jsonResponse(''), allowedOrigins: ['http://127.0.0.1:5173'] });
  const res = mockRes();
  await handler(mockReq({ headers: { origin: 'https://evil.com', 'content-type': 'application/json', host: '127.0.0.1:8787' } }), res);
  assert.equal(res.statusCode, 403);
});

test('handler: 403 content-type inválido', async () => {
  const handler = createChatHandler({ getKey: async () => 'k', fetchImpl: async () => jsonResponse('') });
  const res = mockRes();
  await handler(mockReq({ headers: { 'content-type': 'text/plain', host: '127.0.0.1:8787' } }), res);
  assert.equal(res.statusCode, 403);
});

test('handler: 413 body muito grande', async () => {
  const handler = createChatHandler({ getKey: async () => 'k', fetchImpl: async () => jsonResponse('') });
  const res = mockRes();
  await handler(mockReq({ headers: { 'content-type': 'application/json', host: '127.0.0.1:8787' }, body: 'x'.repeat(9000) }), res);
  assert.equal(res.statusCode, 413);
});

test('handler: 400 mensagem inválida', async () => {
  const handler = createChatHandler({ getKey: async () => 'k', fetchImpl: async () => jsonResponse('') });
  const res = mockRes();
  await handler(mockReq({ headers: { 'content-type': 'application/json', host: '127.0.0.1:8787' }, body: JSON.stringify({ message: '' }) }), res);
  assert.equal(res.statusCode, 400);
});

test('handler: 503 sem chave', async () => {
  const handler = createChatHandler({ getKey: async () => null, fetchImpl: async () => jsonResponse('') });
  const res = mockRes();
  await handler(mockReq({ headers: { 'content-type': 'application/json', host: '127.0.0.1:8787' }, body: JSON.stringify({ message: 'oi' }) }), res);
  assert.equal(res.statusCode, 503);
});

test('handler: 200 com resposta válida', async () => {
  let calls = 0;
  const handler = createChatHandler({ getKey: async () => 'k', fetchImpl: async () => { calls++; return jsonResponse('{"reply":"olá","gesture":"tilt"}'); } });
  const res = mockRes();
  await handler(mockReq({ headers: { 'content-type': 'application/json', host: '127.0.0.1:8787' }, body: JSON.stringify({ message: 'oi' }) }), res);
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.reply, 'olá');
  assert.equal(data.gesture, 'tilt');
  assert.deepEqual(data.actions, []);
  assert.equal(calls, 1);
});

test('handler: 200 classifies the reply when capabilities include expressions', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return jsonResponse(calls === 1 ? '{"reply":"olá","gesture":"tilt","actions":[]}' : '{"actions":[{"type":"set_expression","name":"happy","weight":0.5}]}');
  };
  const handler = createChatHandler({ getKey: async () => 'k', fetchImpl });
  const res = mockRes();
  await handler(mockReq({ headers: { 'content-type': 'application/json', host: '127.0.0.1:8787' }, body: JSON.stringify({ message: 'oi', capabilities: { expressions: ['happy'], gestures: ['tilt'] } }) }), res);
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.reply, 'olá');
  assert.equal(data.gesture, 'tilt');
  assert.deepEqual(data.actions, [{ type: 'set_expression', name: 'happy', weight: 0.5 }]);
  assert.equal(calls, 2);
});

test('handler: 200 filtra gesture fora do catálogo anunciado', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return jsonResponse(calls === 1 ? '{"reply":"olá","gesture":"tilt","actions":[]}' : '{"actions":[{"type":"gesture","name":"tilt"},{"type":"set_expression","name":"happy","weight":0.5}]}');
  };
  const handler = createChatHandler({ getKey: async () => 'k', fetchImpl });
  const res = mockRes();
  await handler(mockReq({ headers: { 'content-type': 'application/json', host: '127.0.0.1:8787' }, body: JSON.stringify({ message: 'oi', capabilities: { expressions: ['happy'], gestures: [] } }) }), res);
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.reply, 'olá');
  assert.deepEqual(data.actions, [{ type: 'set_expression', name: 'happy', weight: 0.5 }]);
  assert.equal(calls, 2);
});

test('handler: 502 quando OpenRouter retorna erro HTTP', async () => {
  const handler = createChatHandler({ getKey: async () => 'k', fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }) });
  const res = mockRes();
  await handler(mockReq({ headers: { 'content-type': 'application/json', host: '127.0.0.1:8787' }, body: JSON.stringify({ message: 'oi' }) }), res);
  assert.equal(res.statusCode, 502);
});

test('handler: 502 quando provedor retorna formato inválido', async () => {
  const handler = createChatHandler({ getKey: async () => 'k', fetchImpl: async () => jsonResponse('{"bad":') });
  const res = mockRes();
  await handler(mockReq({ headers: { 'content-type': 'application/json', host: '127.0.0.1:8787' }, body: JSON.stringify({ message: 'oi' }) }), res);
  assert.equal(res.statusCode, 502);
});

test('handler: timeout vira 502', async () => {
  const handler = createChatHandler({ getKey: async () => 'k', fetchImpl: async () => { const e = new Error('timeout'); e.name = 'TimeoutError'; throw e; } });
  const res = mockRes();
  await handler(mockReq({ headers: { 'content-type': 'application/json', host: '127.0.0.1:8787' }, body: JSON.stringify({ message: 'oi' }) }), res);
  assert.equal(res.statusCode, 502);
  assert.match(JSON.parse(res.body).error, /expirou/);
});
