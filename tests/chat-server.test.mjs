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

const { createChatHandler, createN8nCommandHandler, filterActionsByCatalog, isAllowedOrigin, parseChatBody, parseProviderRaw, refineAnimationInBackground, sanitizeActions, sanitizeCapabilities, stripStageDirections, systemFor, withCapabilities } = await import('../server.mjs');

const scratchMemoryStore = createMemoryStore({ dataDir: scratchMemoryDir });
scratchMemoryStore.load();
const chatHandler = (options = {}) => createChatHandler({ memoryStore: scratchMemoryStore, vaultSearch: async () => null, ...options });

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

test('isAllowedOrigin: allowlist fechada de Host e Origin (sem same-origin por Host)', () => {
  assert.equal(isAllowedOrigin('http://127.0.0.1:5173', '127.0.0.1:8787', ['http://127.0.0.1:5173']), true);
  assert.equal(isAllowedOrigin(undefined, '127.0.0.1:8787'), true);
  assert.equal(isAllowedOrigin(undefined, 'localhost:5173'), true);
  // DNS rebinding: Host e Origin são do atacante e coincidem entre si
  assert.equal(isAllowedOrigin('https://evil.com', 'evil.com'), false);
  assert.equal(isAllowedOrigin(undefined, 'evil.com'), false);
  assert.equal(isAllowedOrigin(undefined, undefined), false);
  assert.equal(isAllowedOrigin('https://evil.com', '127.0.0.1:8787'), false);
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

test('parseProviderRaw: remember vira {fact, section}; string antiga cai em other', () => {
  assert.deepEqual(
    parseProviderRaw('{"reply":"oi","remember":{"section":"preferences","fact":"gosta de café gelado"}}').remember,
    { fact: 'gosta de café gelado', section: 'preferences' },
  );
  // O modelo ainda devolve string às vezes: perder a seção é melhor que perder o fato.
  assert.deepEqual(
    parseProviderRaw('{"reply":"oi","remember":"gosta de café gelado"}').remember,
    { fact: 'gosta de café gelado', section: 'other' },
  );
  // Seção inventada não inventa categoria: cai em other.
  assert.deepEqual(
    parseProviderRaw('{"reply":"oi","remember":{"section":"inventada","fact":"x"}}').remember,
    { fact: 'x', section: 'other' },
  );
  assert.equal(parseProviderRaw('{"reply":"oi","remember":{"section":"user","fact":"  "}}').remember, null);
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
    gestures: ['clap', 'bow', 'point', 'voar', 'sleepy', 'clapping', 'goodbye', 'happy'],
    sequences: true,
  });
  assert.deepEqual(sanitized.gestures, ['clap', 'bow', 'point', 'sleepy', 'clapping', 'goodbye']);
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

test('handler: resume o dia anterior em background e o turno seguinte já lê o resumo', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'usami-chat-summary-'));
  const store = createMemoryStore({ dataDir: dir });
  store.load();
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  store.save({
    ...store.getAll(),
    dailyHistory: {
      [yesterday]: [{ role: 'user', content: 'meu gato chama Tofu', timestamp: `${yesterday}T12:00:00.000Z` }],
    },
  });

  const prompts = [];
  const fetchImpl = async (_url, init) => {
    prompts.push(JSON.parse(init.body).messages[0].content);
    return jsonResponse('{"reply":"entendi","gesture":"neutral"}');
  };
  const handler = createChatHandler({
    memoryStore: store,
    vaultSearch: async () => null,
    getKey: async () => 'k',
    fetchImpl,
  });
  const request = () => mockReq({
    headers: { 'content-type': 'application/json', host: '127.0.0.1:8787' },
    body: JSON.stringify({ message: 'oi' }),
  });

  const first = mockRes();
  await handler(request(), first);
  assert.equal(first.statusCode, 200);
  await new Promise((resolve) => setImmediate(resolve));

  const summaries = store.getSummaries();
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].date, yesterday);
  assert.match(summaries[0].summary, /Tofu/);

  const second = mockRes();
  await handler(request(), second);
  assert.equal(second.statusCode, 200);
  assert.match(prompts[1], /=== DIAS ANTERIORES ===/);
  assert.match(prompts[1], /Tofu/);
});

test('handler: timing povoa as etapas do turno (llmMs mede a chamada ao provedor)', async () => {
  // fetchImpl falso que demora de verdade: sem isto o cronômetro enganava e
  // a resposta vinha com llmMs=0 mesmo havendo chamada ao provedor — o bug
  // que motivou a medição (turno real de 21,9 s reportando etapas zeradas).
  const handler = chatHandler({
    getKey: async () => 'k',
    fetchImpl: async () => {
      await new Promise(resolve => setTimeout(resolve, 30));
      return jsonResponse('{"reply":"olá","gesture":"neutral"}');
    },
  });
  const res = mockRes();
  await handler(mockReq({ headers: { 'content-type': 'application/json', host: '127.0.0.1:8787' }, body: JSON.stringify({ message: 'oi' }) }), res);
  assert.equal(res.statusCode, 200);
  const { timing } = JSON.parse(res.body);
  assert.ok(timing, 'a resposta 200 deve trazer timing');
  // chaves antigas preservadas (o navegador lê este objeto) + contextMs adicionada
  for (const key of ['llmMs', 'animationMs', 'totalMs', 'contextMs']) {
    assert.equal(typeof timing[key], 'number', `timing.${key} deve ser número`);
  }
  assert.ok(timing.llmMs > 0, `llmMs deve medir a chamada ao provedor, veio ${timing.llmMs}`);
  assert.ok(timing.totalMs >= timing.llmMs, `totalMs (${timing.totalMs}) deve cobrir llmMs (${timing.llmMs})`);
  assert.ok(timing.animationMs >= 0);
  assert.ok(timing.contextMs >= 0);
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
  assert.equal(result.reply, 'N-não é que eu me importe, b-baka!');
  assert.equal(result.gesture, 'neutral');
  assert.deepEqual(result.actions, []);
  assert.equal(result.remember, null);
});

test('parseProviderRaw: aspa de abertura da chave ausente ainda recupera o reply', () => {
  // Formato observado no chat vazando: o modelo emite `{reply":"...` e corta no max_tokens.
  const result = parseProviderRaw('{reply":"F-fofa..?! *orelhas vermelhas até a base*","actions":[{"type":"set_expression","name":"15-prefab_awkward02","weight":0.8},{"type');
  assert.equal(result.ok, true);
  assert.equal(result.reply, 'F-fofa..?!');
  assert.deepEqual(result.actions, []);
});

test('parseProviderRaw: remove vazamento de gesture/actions com aspas simples ou escapadas dentro do reply', () => {
  const rawSingleQuotes = `{"reply":"[casual_frustrated] H-hmph... me usando de cobaia de novo, baka? [intimate_shy]...M-mas se era teste de dormir, devia ter dito antes... fiquei preocupada à toa! ','gesture': 'angry','actions': [{'type':`;
  const res1 = parseProviderRaw(rawSingleQuotes);
  assert.equal(res1.ok, true);
  assert.ok(!res1.reply.includes('gesture'), `reply vazou gesture: ${res1.reply}`);
  assert.ok(!res1.reply.includes('actions'), `reply vazou actions: ${res1.reply}`);
  assert.equal(res1.gesture, 'angry');

  const rawEscaped = JSON.stringify({
    reply: '[casual_frustrated] N-não confunda as coisas! "gesture":"tilt","actions":[{"type":"set_expression","name":',
    gesture: 'neutral',
  });
  const res2 = parseProviderRaw(rawEscaped);
  assert.equal(res2.ok, true);
  assert.ok(!res2.reply.includes('gesture'), `reply vazou gesture: ${res2.reply}`);
  assert.equal(res2.gesture, 'tilt');

  const rawPrefabLeak = '{"reply":"Q-que?! B-baka! Por que eu iria querer ser sua mãe?! Hmph... você fala cada absurdo...\\n15-prefab_awkward01 0.8, 08-prefab_angry02 0.6],"}';
  const res3 = parseProviderRaw(rawPrefabLeak);
  assert.equal(res3.ok, true);
  assert.equal(res3.reply, 'Q-que?! B-baka! Por que eu iria querer ser sua mãe?! Hmph... você fala cada absurdo...');

  const rawTrailingBraces = '{"reply":"Já enviei a proposta de README pro Usami-Core. \\"}{"}';
  const resBraces = parseProviderRaw(rawTrailingBraces);
  assert.equal(resBraces.ok, true);
  assert.equal(resBraces.reply, 'Já enviei a proposta de README pro Usami-Core.');

  const rawPipeSpaceLeak = 'Entendido! Adicionando a entrevista TRINCA para hoje às 15:30 com 30 minutos de duração. .| gesture ": "nod';
  const res4 = parseProviderRaw(rawPipeSpaceLeak);
  assert.equal(res4.ok, true);
  assert.equal(res4.reply, 'Entendido! Adicionando a entrevista TRINCA para hoje às 15:30 com 30 minutos de duração.');
  assert.equal(res4.gesture, 'nod');
});

test('parseProviderRaw: rejeita tokens em CJK e fragmentos espúrios de raciocínio como 502', () => {
  const cjkGarbage = '!\n\n 0. csal_那些物ck_着的表示 required for';
  assert.equal(parseProviderRaw(cjkGarbage).ok, false);

  const jsonWithCjk = JSON.stringify({ reply: 'csal_那些物ck_着的表示' });
  assert.equal(parseProviderRaw(jsonWithCjk).ok, false);
});

test('parseProviderRaw: rubrica de roleplay nunca chega ao reply', () => {
  // O balão e o /api/tts falam o texto cru: "*bufa*" virava voz.
  assert.equal(parseProviderRaw('{"reply":"Hmph... *bufa, braços cruzados* Não diga que é fofo."}').reply, 'Hmph... Não diga que é fofo.');
  assert.equal(parseProviderRaw('{"reply":"**engasga** Q-que?!"}').reply, 'Q-que?!');
  // Órfão (sem fechamento) também sai — continuaria sendo lido.
  assert.equal(parseProviderRaw('{"reply":"*desvia o olhar N-nada..."}').reply, 'desvia o olhar N-nada...');
  // Só rubrica não é fala: erro amigável em vez de balão vazio.
  assert.equal(parseProviderRaw('{"reply":"*silêncio*"}').ok, false);
});

test('parseProviderRaw: tags não-verbais vão para speechTags, nunca para o balão', () => {
  const result = parseProviderRaw('{"reply":"Pai! Você demorou! <chuckle>"}');
  assert.equal(result.reply, 'Pai! Você demorou!');
  assert.deepEqual(result.speechTags, ['chuckle']);
  // Sem tag o objeto continua idêntico ao formato antigo.
  assert.equal('speechTags' in parseProviderRaw('{"reply":"Oi"}'), false);
  // Só tag não é fala.
  assert.equal(parseProviderRaw('{"reply":"<laugh>"}').ok, false);
});

test('stripStageDirections: preserva a fala e a quebra de linha dos balões', () => {
  assert.equal(stripStageDirections('sem rubrica aqui'), 'sem rubrica aqui');
  const multiline = stripStageDirections('Bom dia!\n*espreguiça* Vamos continuar?');
  assert.ok(multiline.includes('\n') && !multiline.includes('*'), multiline);
  assert.equal(stripStageDirections('a  *b*  c'), 'a c');
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
  assert.equal(data.reply, 'Ora, vê com os próprios olhos!');
  assert.deepEqual(data.actions, []);
});

test('handler: timeout vira 502', async () => {
  const handler = chatHandler({ getKey: async () => 'k', fetchImpl: async () => { const e = new Error('timeout'); e.name = 'TimeoutError'; throw e; } });
  const res = mockRes();
  await handler(mockReq({ headers: { 'content-type': 'application/json', host: '127.0.0.1:8787' }, body: JSON.stringify({ message: 'oi' }) }), res);
  assert.equal(res.statusCode, 502);
  assert.match(JSON.parse(res.body).error, /expirou/);
});

// --- Geração única: catálogo no prompt + refino de animação em background ---

test('withCapabilities: o catálogo chega ao prompt de quem escolhe as ações', () => {
  const capabilities = { gestures: ['wave'], clips: [], morphs: [], expressions: ['01-prefab_happy01'], meshes: [], sequences: false };
  const withCaps = withCapabilities('PERSONA', capabilities);
  assert.match(withCaps, /^PERSONA Capabilidades disponíveis neste modelo: /);
  assert.ok(JSON.parse(withCaps.match(/: (\{.*\})\.$/)[1]).expressions.includes('01-prefab_happy01'));
  assert.equal(withCapabilities('PERSONA', null), 'PERSONA');
  // systemFor é a mesma anexação sobre o DEFAULT_SYSTEM (caminho OpenRouter)
  assert.match(systemFor(capabilities), /"actions"/);
  assert.match(systemFor(capabilities), /Capabilidades disponíveis neste modelo: /);
});

test('refino em background: o diretor preenche a fila de comandos depois da resposta', async () => {
  const capabilities = sanitizeCapabilities({
    gestures: ['wave'], clips: ['Idle'], morphs: ['happy'], expressions: ['01-prefab_happy01'], meshes: [], sequences: false,
  });
  const planner = async () => ({
    actions: [
      { type: 'gesture', name: 'wave', delayMs: 400 },
      { type: 'set_expression', name: '01-prefab_happy01', weight: 0.8 },
      { type: 'play_clip', name: 'Idle' },
      { type: 'gesture', name: 'facepalm' },
    ],
  });
  await refineAnimationInBackground('oi!', capabilities, { planner });
  const res = mockRes();
  await createN8nCommandHandler({ apiToken: 't' })(mockReq({ method: 'GET', url: '/api/n8n/commands', headers: { host: '127.0.0.1:8787', 'x-usami-token': 't' } }), res);
  const { commands } = JSON.parse(res.body);
  // play_clip não é comando da fila e facepalm não está no catálogo do modelo:
  // só o que o avatar realmente consegue fazer chega ao cliente.
  assert.deepEqual(commands.map(command => command.type), ['gesture', 'set_expression']);
  assert.equal(commands[0].name, 'wave');
  assert.equal(commands[0].delayMs, 400);
  assert.equal(commands[1].weight, 0.8);
});

test('refino em background: falha do diretor é silenciosa, nunca do turno', async () => {
  await refineAnimationInBackground('oi!', null, { planner: async () => { throw new Error('rate limit'); } });
  const res = mockRes();
  await createN8nCommandHandler({ apiToken: 't' })(mockReq({ method: 'GET', url: '/api/n8n/commands', headers: { host: '127.0.0.1:8787', 'x-usami-token': 't' } }), res);
  assert.deepEqual(JSON.parse(res.body).commands, []);
});

// Contador atômico de turnos: com booleano, o primeiro turno a terminar
// liberava a proatividade mesmo com outro ainda em andamento (duas abas).
test('B16: turnos sobrepostos só liberam proactive busy quando o último termina', async () => {
  const busy = [];
  const proactiveEngine = {
    markUserActivity() {},
    setBusy(value) { busy.push(value); },
  };
  const handler = chatHandler({
    getKey: async () => 'k',
    proactiveEngine,
    fetchImpl: async () => {
      await new Promise(resolve => setTimeout(resolve, 40));
      return jsonResponse('{"reply":"oi","gesture":"neutral"}');
    },
  });
  const request = () => mockReq({
    headers: { 'content-type': 'application/json', host: '127.0.0.1:8787' },
    body: JSON.stringify({ message: 'oi' }),
  });

  const first = handler(request(), mockRes());
  const second = handler(request(), mockRes());
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.deepEqual(busy, [true], 'dois turnos ativos = um único setBusy(true)');

  await first;
  assert.deepEqual(busy, [true], 'o primeiro turno não libera enquanto o segundo roda');

  await second;
  assert.deepEqual(busy, [true, false]);
});

// --- Hedge NVIDIA → OpenRouter -------------------------------------------

// useNvidia() é avaliado por chamada, então o teste liga a rota NVIDIA só
// enquanto roda — o resto do arquivo continua no caminho OpenRouter puro.
async function withNvidiaRoute(fn) {
  process.env.USE_NVIDIA = 'true';
  try {
    return await fn();
  } finally {
    process.env.USE_NVIDIA = 'false';
  }
}

const chatRequest = () => mockReq({
  headers: { 'content-type': 'application/json', host: '127.0.0.1:8787' },
  body: JSON.stringify({ message: 'oi' }),
});

test('hedge: OpenRouter vence quando a NVIDIA passa do limite e a perdedora é abortada', async () => {
  await withNvidiaRoute(async () => {
    let aborted = false;
    let routerCalls = 0;
    const handler = chatHandler({
      getKey: async () => 'k',
      hedgeAfterMs: 20,
      // NVIDIA lenta de mentira: só termina (ou é abortada) se o hedge não agir.
      generateReply: (_system, _message, { signal }) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve('{"reply":"nvidia","gesture":"tilt"}'), 1000);
        signal.addEventListener('abort', () => {
          aborted = true;
          clearTimeout(timer);
          reject(Object.assign(new Error('perdeu a corrida'), { name: 'AbortError' }));
        }, { once: true });
      }),
      fetchImpl: async () => { routerCalls++; return jsonResponse('{"reply":"router","gesture":"neutral"}'); },
    });

    const startedAt = Date.now();
    const res = mockRes();
    await handler(chatRequest(), res);
    const elapsed = Date.now() - startedAt;

    assert.equal(res.statusCode, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.source, 'openrouter');
    assert.equal(data.reply, 'router');
    assert.equal(routerCalls, 1);
    assert.ok(elapsed < 900, `a resposta não pode esperar a NVIDIA lenta (levou ${elapsed}ms)`);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(aborted, true, 'a chamada perdedora precisa ser abortada, não deixada correndo');
  });
});

test('hedge: NVIDIA que responde antes do limite vence sem chamar o OpenRouter', async () => {
  await withNvidiaRoute(async () => {
    let routerCalls = 0;
    const handler = chatHandler({
      getKey: async () => 'k',
      hedgeAfterMs: 200,
      generateReply: async () => '{"reply":"nvidia","gesture":"tilt","actions":[{"type":"gesture","name":"tilt"}]}',
      fetchImpl: async () => { routerCalls++; return jsonResponse('{"reply":"router"}'); },
    });

    const res = mockRes();
    await handler(chatRequest(), res);
    assert.equal(res.statusCode, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.source, 'nvidia');
    assert.equal(data.reply, 'nvidia');
    assert.deepEqual(data.actions, [{ type: 'gesture', name: 'tilt' }]);
    // O cronômetro do hedge dispara depois, mas não pode gerar chamada extra.
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(routerCalls, 0);
  });
});

test('fallback sequencial: NVIDIA falha antes do hedge e o OpenRouter responde uma vez', async () => {
  await withNvidiaRoute(async () => {
    let routerCalls = 0;
    const handler = chatHandler({
      getKey: async () => 'k',
      hedgeAfterMs: 5000,
      generateReply: async () => { throw new Error('NVIDIA fora'); },
      fetchImpl: async () => { routerCalls++; return jsonResponse('{"reply":"router","gesture":"neutral"}'); },
    });

    const res = mockRes();
    await handler(chatRequest(), res);
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).source, 'openrouter');
    assert.equal(routerCalls, 1);
  });
});

test('hedge: os dois falhando devolvem o 502 do OpenRouter sem repetir a chamada', async () => {
  await withNvidiaRoute(async () => {
    let routerCalls = 0;
    const handler = chatHandler({
      getKey: async () => 'k',
      hedgeAfterMs: 5000,
      generateReply: async () => { throw new Error('NVIDIA fora'); },
      fetchImpl: async () => { routerCalls++; return { ok: false, status: 503, json: async () => ({}) }; },
    });

    const res = mockRes();
    await handler(chatRequest(), res);
    assert.equal(res.statusCode, 502);
    assert.match(JSON.parse(res.body).error, /OpenRouter recusou/);
    assert.equal(routerCalls, 1, 'o fallback já tentado não pode ser repetido no bloco sequencial');
  });
});

test('sem chave do OpenRouter não há corrida: NVIDIA falha e cai no modo offline', async () => {
  await withNvidiaRoute(async () => {
    const handler = chatHandler({
      getKey: async () => null,
      hedgeAfterMs: 10,
      generateReply: async () => { throw new Error('NVIDIA fora'); },
      fetchImpl: async () => { throw new Error('não deveria chamar a rede'); },
    });

    const res = mockRes();
    await handler(chatRequest(), res);
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).source, 'offline');
  });
});
