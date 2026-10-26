import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryStore } from '../src/memory-store.js';

// Isolamento: proíbe a rota NVIDIA (rede real) nos testes; força o caminho
// OpenRouter onde fetchImpl/getKey são injetados.
process.env.USE_NVIDIA = 'false';

// O handler do chat grava turno e afinidade em <dataDir>/memory.json. Antes, um
// `npm test` bastava para encher a memória real da companion com "oi/olá" de
// teste — por isso o diretório é trocado ANTES de importar o servidor, que cria
// o depósito na avaliação do módulo, e cada handler recebe o seu próprio.
const scratchMemoryDir = mkdtempSync(join(tmpdir(), 'usami-chat-memory-'));
process.env.USAMI_DATA_DIR = scratchMemoryDir;

const { createChatHandler, filterActionsByCatalog, isAllowedOrigin, parseChatBody, parseProviderRaw, sanitizeActions, sanitizeCapabilities, systemFor } = await import('../server.mjs');

const scratchMemoryStore = createMemoryStore({ dataDir: scratchMemoryDir });
scratchMemoryStore.load();
const chatHandler = (options = {}) => createChatHandler({ memoryStore: scratchMemoryStore, ...options });

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
  assert.deepEqual(parseProviderRaw('{"reply":"olá","gesture":"tilt"}'), { ok: true, reply: 'olá', gesture: 'tilt', actions: [], remember: null });
  assert.deepEqual(parseProviderRaw('```json\n{"reply":"oi","gesture":"neutral","actions":[{"type":"gesture","name":"wave"}]}\n```'), { ok: true, reply: 'oi', gesture: 'neutral', actions: [{ type: 'gesture', name: 'wave' }], remember: null });
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

test('filterActionsByCatalog traduz sinônimos de verbo para o diretor entender', () => {
  const capabilities = { gestures: [], clips: [], morphs: ['smile'], expressions: ['shy'] };
  const actions = [
    { type: 'expression', name: 'shy', weight: 0.8 },
    { type: 'emote', name: 'shy' },
    { type: 'morph', name: 'smile', value: 1 },
    { type: 'expression', name: 'inexistente' },
  ];
  assert.deepEqual(filterActionsByCatalog(actions, capabilities), [
    { type: 'set_expression', name: 'shy', weight: 0.8 },
    { type: 'set_expression', name: 'shy' },
    { type: 'set_morph', name: 'smile', value: 1 },
  ]);
});

test('sanitizeCapabilities: gestos da biblioteca passam e sequences é flag', () => {
  const sanitized = sanitizeCapabilities({
    gestures: ['clap', 'bow', 'point', 'voar'],
    sequences: true,
  });
  assert.deepEqual(sanitized.gestures, ['clap', 'bow', 'point']);
  assert.equal(sanitized.sequences, true);
  assert.equal(sanitizeCapabilities({ sequences: 'sim' }).sequences, false);
  assert.equal(sanitizeCapabilities({}).sequences, false);
});

test('sanitizeActions mantém play_sequence com shape válida e descarta inválida', () => {
  const actions = sanitizeActions([
    { type: 'play_sequence', shape: 'wave-arm', amplitude: 0.3, cycles: 2, durationMs: 1500, side: 'left', delayMs: 200 },
    { type: 'play_sequence', shape: 'moonwalk' },
    { type: 'play_sequence' },
    { type: 'play_sequence', shape: 'nod', amplitude: 'muito' },
  ]);
  assert.deepEqual(actions, [
    { type: 'play_sequence', name: undefined, shape: 'wave-arm', side: 'left', amplitude: 0.3, cycles: 2, durationMs: 1500, delayMs: 200 },
    { type: 'play_sequence', name: undefined, shape: 'nod' },
  ]);
  assert.deepEqual(sanitizeActions([{ type: 'play_sequence', tracks: [{ bone: 'head' }] }]).length, 0,
    'keyframes crus do LLM nunca passam: só shape+params');
});

test('systemFor anuncia a shape e o prompt traz o vocabulário de sequências', () => {
  const system = systemFor({ clips: [], morphs: [], gestures: ['tilt'], expressions: [], meshes: [], sequences: true });
  assert.match(system, /play_sequence/);
  assert.match(system, /wave-arm/);
  assert.match(system, /sequences/);
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

test('handler: 404 para método/rota incorretos', async () => {
  const handler = chatHandler({ getKey: async () => 'k', fetchImpl: async () => jsonResponse('') });
  const res = mockRes();
  await handler(mockReq({ method: 'GET', url: '/api/chat' }), res);
  assert.equal(res.statusCode, 404);
  const res2 = mockRes();
  await handler(mockReq({ url: '/other' }), res2);
  assert.equal(res2.statusCode, 404);
});

test('handler: 403 origem inválida', async () => {
  const handler = chatHandler({ getKey: async () => 'k', fetchImpl: async () => jsonResponse(''), allowedOrigins: ['http://127.0.0.1:5173'] });
  const res = mockRes();
  await handler(mockReq({ headers: { origin: 'https://evil.com', 'content-type': 'application/json', host: '127.0.0.1:8787' } }), res);
  assert.equal(res.statusCode, 403);
});

test('handler: 403 content-type inválido', async () => {
  const handler = chatHandler({ getKey: async () => 'k', fetchImpl: async () => jsonResponse('') });
  const res = mockRes();
  await handler(mockReq({ headers: { 'content-type': 'text/plain', host: '127.0.0.1:8787' } }), res);
  assert.equal(res.statusCode, 403);
});

test('handler: 413 body muito grande', async () => {
  const handler = chatHandler({ getKey: async () => 'k', fetchImpl: async () => jsonResponse('') });
  const res = mockRes();
  await handler(mockReq({ headers: { 'content-type': 'application/json', host: '127.0.0.1:8787' }, body: 'x'.repeat(9000) }), res);
  assert.equal(res.statusCode, 413);
});

test('handler: 400 mensagem inválida', async () => {
  const handler = chatHandler({ getKey: async () => 'k', fetchImpl: async () => jsonResponse('') });
  const res = mockRes();
  await handler(mockReq({ headers: { 'content-type': 'application/json', host: '127.0.0.1:8787' }, body: JSON.stringify({ message: '' }) }), res);
  assert.equal(res.statusCode, 400);
});

test('handler: modo offline quando não há chave de LLM', async () => {
  const handler = chatHandler({ getKey: async () => null, fetchImpl: async () => { throw new Error('não deve chamar rede no modo offline'); } });
  const res = mockRes();
  await handler(mockReq({ headers: { 'content-type': 'application/json', host: '127.0.0.1:8787' }, body: JSON.stringify({ message: 'oi' }) }), res);
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.source, 'offline');
  assert.ok(typeof data.reply === 'string' && data.reply.length > 0);
  assert.deepEqual(data.actions, []);
});

test('handler: 200 com resposta válida', async () => {
  let calls = 0;
  const handler = chatHandler({ getKey: async () => 'k', fetchImpl: async () => { calls++; return jsonResponse('{"reply":"olá","gesture":"tilt"}'); } });
  const res = mockRes();
  await handler(mockReq({ headers: { 'content-type': 'application/json', host: '127.0.0.1:8787' }, body: JSON.stringify({ message: 'oi' }) }), res);
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.reply, 'olá');
  assert.equal(data.gesture, 'tilt');
  assert.deepEqual(data.actions, []);
  assert.equal(calls, 1);
});

test('handler: 200 applies the actions returned by the LLM in a single call', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return jsonResponse('{"reply":"olá","gesture":"tilt","actions":[{"type":"set_expression","name":"happy","weight":0.5}]}');
  };
  const handler = chatHandler({ getKey: async () => 'k', fetchImpl });
  const res = mockRes();
  await handler(mockReq({ headers: { 'content-type': 'application/json', host: '127.0.0.1:8787' }, body: JSON.stringify({ message: 'oi', capabilities: { expressions: ['happy'], gestures: ['tilt'] } }) }), res);
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.reply, 'olá');
  assert.equal(data.gesture, 'tilt');
  assert.deepEqual(data.actions, [{ type: 'set_expression', name: 'happy', weight: 0.5 }]);
  assert.equal(calls, 1);
});

test('handler: 200 filtra gesture fora do catálogo anunciado', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return jsonResponse('{"reply":"olá","gesture":"tilt","actions":[{"type":"gesture","name":"tilt"},{"type":"set_expression","name":"happy","weight":0.5}]}');
  };
  const handler = chatHandler({ getKey: async () => 'k', fetchImpl });
  const res = mockRes();
  await handler(mockReq({ headers: { 'content-type': 'application/json', host: '127.0.0.1:8787' }, body: JSON.stringify({ message: 'oi', capabilities: { expressions: ['happy'], gestures: [] } }) }), res);
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.reply, 'olá');
  assert.deepEqual(data.actions, [{ type: 'set_expression', name: 'happy', weight: 0.5 }]);
  assert.equal(calls, 1);
});

test('handler: 502 quando OpenRouter retorna erro HTTP', async () => {
  const handler = chatHandler({ getKey: async () => 'k', fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }) });
  const res = mockRes();
  await handler(mockReq({ headers: { 'content-type': 'application/json', host: '127.0.0.1:8787' }, body: JSON.stringify({ message: 'oi' }) }), res);
  assert.equal(res.statusCode, 502);
});

test('handler: 502 quando provedor retorna formato inválido', async () => {
  // Conteúdo vazio não tem como virar reply — 502. Texto livre (sem começar
  // por "{") é tolerado de propósito pelo parseProviderRaw; JSON truncado só
  // aproveita o "reply" recuperável.
  const handler = chatHandler({ getKey: async () => 'k', fetchImpl: async () => jsonResponse('   ') });
  const res = mockRes();
  await handler(mockReq({ headers: { 'content-type': 'application/json', host: '127.0.0.1:8787' }, body: JSON.stringify({ message: 'oi' }) }), res);
  assert.equal(res.statusCode, 502);
});

test('parseProviderRaw: texto livre vira reply; vazio ou gigante é 502', () => {
  assert.equal(parseProviderRaw('oi!').ok, true);
  assert.equal(parseProviderRaw('oi!').reply, 'oi!');
  assert.equal(parseProviderRaw('   ').ok, false);
  assert.equal(parseProviderRaw('x'.repeat(10001)).ok, false);
  assert.equal(parseProviderRaw(null).ok, false);
});

test('parseProviderRaw: JSON truncado recupera o "reply" e descarta actions', () => {
  const truncated = '{"reply":"N-não é que eu me importe, b-baka! *desvia o olhar*","actions":[{"type":"set_expression","name":"16-prefab_awkward02","weight":0.8},{"type';
  const result = parseProviderRaw(truncated);
  assert.equal(result.ok, true);
  assert.equal(result.reply, 'N-não é que eu me importe, b-baka! *desvia o olhar*');
  assert.equal(result.gesture, 'neutral');
  assert.deepEqual(result.actions, []);
  assert.equal(result.remember, null);
});

test('parseProviderRaw: aspa de abertura da chave ausente ainda recupera o reply', () => {
  // Formato observado no chat vazando: o modelo emite `{reply":"...` e corta no max_tokens.
  const result = parseProviderRaw('{reply":"F-fofa..?! *orelhas vermelhas até a base*","actions":[{"type":"set_expression","name":"15-prefab_awkward02","weight":0.8},{"type');
  assert.equal(result.ok, true);
  assert.equal(result.reply, 'F-fofa..?! *orelhas vermelhas até a base*');
  assert.deepEqual(result.actions, []);
});

test('parseProviderRaw: escapes do "reply" truncado são decodificados', () => {
  const result = parseProviderRaw('{"reply":"linha1\\n\\"shiro\\"\\tcafé \\u00e9 bom","actions":[{"type"');
  assert.equal(result.ok, true);
  assert.equal(result.reply, 'linha1\n"shiro"\tcafé é bom');
});

test('parseProviderRaw: preâmbulo de raciocínio antes do JSON não vaza e mantém actions', () => {
  const raw = 'This is a classic tsundere response - denying while looking away.\n\nAvailable expressions: "16-prefab_awkward02" fits the mood.\n\n{"reply":"N-não fiquei! Hmph.","gesture":"neutral","actions":[{"type":"set_expression","name":"16-prefab_awkward02","weight":0.9}]}';
  const result = parseProviderRaw(raw);
  assert.equal(result.ok, true);
  assert.equal(result.reply, 'N-não fiquei! Hmph.');
  assert.deepEqual(result.actions, [{ type: 'set_expression', name: '16-prefab_awkward02', weight: 0.9 }]);
});

test('parseProviderRaw: texto livre com chaves soltas continua sendo texto', () => {
  const result = parseProviderRaw('olá {tudo} bem?');
  assert.equal(result.ok, true);
  assert.equal(result.reply, 'olá {tudo} bem?');
});

test('parseProviderRaw: JSON truncado sem "reply" recuperável é 502 (texto bruto nunca vira reply)', () => {
  for (const raw of [
    '{"actions":[{"type":"set_expression","name":"16-prefab_awkward02"',
    '{"bad":',
    '{"reply":"   ","actions":[{"type',
  ]) {
    const result = parseProviderRaw(raw);
    assert.equal(result.ok, false);
    assert.equal(result.status, 502);
    assert.equal(result.error, 'O modelo retornou uma resposta inválida.');
  }
});

test('parseProviderRaw: reply longo é cortado em fronteira de sentença, sem elipse', () => {
  const result = parseProviderRaw(JSON.stringify({ reply: 'Frase curta de chat. '.repeat(30) }));
  assert.equal(result.ok, true);
  assert.ok(result.reply.length <= 220, `esperava <=220, veio ${result.reply.length}`);
  assert.ok(result.reply.length >= 180);
  assert.ok(result.reply.endsWith('.'));
  assert.ok(!result.reply.includes('…'));

  // sem pontuação, com espaços: corta no último espaço antes do limite
  const spaced = parseProviderRaw(JSON.stringify({ reply: 'palavra '.repeat(40) }));
  assert.ok(spaced.reply.length <= 220);
  assert.ok(spaced.reply.length >= 200);
  assert.ok(!spaced.reply.endsWith(' '));

  // sem pontuação nem espaço: corte duro no limite
  const hard = parseProviderRaw(JSON.stringify({ reply: 'a'.repeat(300) }));
  assert.equal(hard.reply.length, 220);
});

test('handler: 200 com reply recuperado de JSON truncado, sem vazar o payload bruto', async () => {
  const handler = chatHandler({
    getKey: async () => 'k',
    fetchImpl: async () => jsonResponse('{"reply":"Ora, vê com os próprios olhos! *sorri*","actions":[{"type"'),
  });
  const res = mockRes();
  await handler(mockReq({ headers: { 'content-type': 'application/json', host: '127.0.0.1:8787' }, body: JSON.stringify({ message: 'oi' }) }), res);
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.reply, 'Ora, vê com os próprios olhos! *sorri*');
  assert.deepEqual(data.actions, []);
});

test('handler: timeout vira 502', async () => {
  const handler = chatHandler({ getKey: async () => 'k', fetchImpl: async () => { const e = new Error('timeout'); e.name = 'TimeoutError'; throw e; } });
  const res = mockRes();
  await handler(mockReq({ headers: { 'content-type': 'application/json', host: '127.0.0.1:8787' }, body: JSON.stringify({ message: 'oi' }) }), res);
  assert.equal(res.statusCode, 502);
  assert.match(JSON.parse(res.body).error, /expirou/);
});
