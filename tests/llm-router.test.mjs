import { strict as assert } from 'node:assert';
import { test } from 'node:test';

// Isolamento: sem chave NVIDIA no processo de teste o roteador cai nos
// classificadores locais, e `npm test` não faz chamada de rede.
delete process.env.NVIDIA_API_KEY;

const { classifyUserMessage, generateReplyWithActions, jsonText, planAnimation } = await import('../src/llm-router.js');

test('jsonText: pega o content quando ele já é JSON', () => {
  assert.equal(jsonText({ content: '{"actions":[]}', reasoning: 'prosa de raciocínio' }), '{"actions":[]}');
});

test('jsonText: resgata o JSON do raciocínio quando o content é só prosa', () => {
  // Raciocínio que transbordou para content: o JSON ficou preso no reasoning_content.
  assert.equal(
    jsonText({ content: 'The user wants me to create animation actions for a VRM avatar...', reasoning: 'plano {"actions":[{"type":"gesture","name":"tilt"}]} fim' }),
    'plano {"actions":[{"type":"gesture","name":"tilt"}]} fim',
  );
});

test('jsonText: sem JSON em nenhum campo devolve o texto disponível', () => {
  assert.equal(jsonText({ content: 'sem json aqui', reasoning: 'nem aqui' }), 'sem json aqui');
  assert.equal(jsonText({ content: '', reasoning: 'só raciocínio' }), 'só raciocínio');
  assert.equal(jsonText(), '');
});

test('jsonText: com chave exigida, só usa o raciocínio se ele tiver o objeto pedido', () => {
  const reasoningComReply = { content: 'prosa solta', reasoning: 'blah {"reply":"oi!"} blah' };
  assert.equal(jsonText(reasoningComReply, 'reply'), 'blah {"reply":"oi!"} blah');
  // O raciocínio do modelo reescreve o system prompt; sem o JSON-chave ele NÃO pode
  // virar resposta, sob pena de a Usami "falar o próprio prompt".
  const reasoningSemReply = {
    content: 'prosa solta',
    reasoning: 'System Prompt: Você é Usami, uma companion acolhedora. {"nota":"x"}',
  };
  assert.equal(jsonText(reasoningSemReply, 'reply'), 'prosa solta');
  assert.equal(jsonText({ content: '{"reply":"oi","gesture":"tilt"}', reasoning: '{"reply":"vazada"}' }, 'reply'), '{"reply":"oi","gesture":"tilt"}');
});

// Mock do sharedClient para não depender da chave NVIDIA real.
const originalClient = globalThis.sharedClientMockPlaceholder;

test('classifyUserMessage: sem chave NVIDIA usa classificador local', async () => {
  // Garante que não há variável de ambiente (o teste roda no ambiente real;
  // se NVIDIA_API_KEY estiver definida, este teste pode ir para o caminho NVIDIA).
  if (process.env.NVIDIA_API_KEY) {
    // Ainda assim, o classificador local é o fallback em caso de erro de rede.
    // Apenas verifica que a função retorna uma estrutura válida.
    const result = await classifyUserMessage('estou feliz');
    assert.ok(['neutral','happy','shy','sad','soft','angry','surprised','doubtful'].includes(result.emotion));
    assert.ok(result.confidence >= 0 && result.confidence <= 1);
    assert.ok(result.intensity >= 0 && result.intensity <= 1);
    assert.ok(Array.isArray(result.facs));
    assert.ok(['local-deterministic','nvidia','local-deterministic-fallback'].includes(result.source));
    return;
  }

  const result = await classifyUserMessage('estou feliz');
  assert.equal(result.source, 'local-deterministic');
  assert.equal(result.emotion, 'happy');
  assert.ok(result.confidence > 0);
  assert.ok(Array.isArray(result.facs));
  assert.ok(result.facs.length > 0);
});

test('classifyUserMessage: frase triste retorna sad', async () => {
  if (process.env.NVIDIA_API_KEY) return;
  const result = await classifyUserMessage('estou triste e chorando');
  assert.equal(result.source, 'local-deterministic');
  assert.equal(result.emotion, 'sad');
});

test('planAnimation: sem chave NVIDIA retorna vazio', async () => {
  if (process.env.NVIDIA_API_KEY) return;
  const result = await planAnimation('oi tudo bem?', {});
  assert.equal(result.source, 'no-nvidia-key');
  assert.deepEqual(result.actions, []);
});

// --- generateReplyWithActions ---------------------------------------------
//
// Uma chamada mesclada (reply + gesture + actions + remember). O roteador só
// entrega o texto cru: o cliente é injetável, então nada aqui toca a rede.

// Espera o mesmo modelo que o roteador resolve no carregamento do módulo.
const EXPECTED_MODEL = process.env.NVIDIA_GENERATION_MODEL || 'nvidia/nemotron-3-ultra-550b-a55b';

// Fake de NvidiaClient: registra cada chatJson e devolve o que o teste pedir.
function fakeClient({ result = null, error = null } = {}) {
  const calls = [];
  return {
    calls,
    async chatJson(args) {
      calls.push(args);
      if (error) throw error;
      return result;
    },
  };
}

// Chave falsa só para passar na guarda do roteador; apagada no finally, para
// o resto do arquivo continuar sem rede (padrão de isolamento do topo).
async function withFakeKey(run) {
  const previous = process.env.NVIDIA_API_KEY;
  process.env.NVIDIA_API_KEY = 'chave-falsa-de-teste';
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.NVIDIA_API_KEY;
    else process.env.NVIDIA_API_KEY = previous;
  }
}

const MERGED_JSON = '{"reply":"Hmph, n-não é que eu me importe.","gesture":"tilt","actions":[{"type":"set_expression","name":"15-prefab_awkward01","weight":0.8}],"remember":"gosta de café gelado"}';

test('generateReplyWithActions: content já sendo JSON volta verbatim', async () => {
  const client = fakeClient({ result: { content: MERGED_JSON, reasoning: '', finishReason: 'stop' } });
  const raw = await withFakeKey(() => generateReplyWithActions('SYSTEM', 'usuário', { client }));
  assert.equal(raw, MERGED_JSON);
  assert.equal(client.calls.length, 1);
});

test('generateReplyWithActions: repassa model/messages/temperature/max_tokens ao chatJson', async () => {
  const client = fakeClient({ result: { content: '{"reply":"oi"}', reasoning: '', finishReason: 'stop' } });
  await withFakeKey(() => generateReplyWithActions('PROMPT DA USA MI', 'frase do usuário', {
    client,
    temperature: 0.42,
    maxTokens: 1234,
  }));
  const [call] = client.calls;
  assert.equal(call.model, EXPECTED_MODEL);
  assert.equal(call.temperature, 0.42);
  assert.equal(call.max_tokens, 1234);
  assert.deepEqual(call.messages, [
    { role: 'system', content: 'PROMPT DA USA MI' },
    { role: 'user', content: 'frase do usuário' },
  ]);
});

// --- knob de raciocínio (NVIDIA_LLM_THINKING) ------------------------------
//
// O raciocínio é o que domina o turno (medido: 23,8s/527 tokens com thinking,
// 2,2s/72 sem), mas a comparação de fala ainda não foi feita — então o padrão é
// o comportamento de sempre e o desligamento é knob de teste, lido por chamada.

async function callWithThinkingEnv(value) {
  const previous = process.env.NVIDIA_LLM_THINKING;
  if (value === undefined) delete process.env.NVIDIA_LLM_THINKING;
  else process.env.NVIDIA_LLM_THINKING = value;
  const client = fakeClient({ result: { content: '{"reply":"oi"}', reasoning: '', finishReason: 'stop' } });
  try {
    await withFakeKey(() => generateReplyWithActions('SYSTEM', 'usuário', { client }));
  } finally {
    if (previous === undefined) delete process.env.NVIDIA_LLM_THINKING;
    else process.env.NVIDIA_LLM_THINKING = previous;
  }
  return client.calls[0].extra;
}

test('thinking: sem o knob o extra é null (raciocínio ligado, como sempre foi)', async () => {
  assert.equal(await callWithThinkingEnv(undefined), null);
  assert.equal(await callWithThinkingEnv('on'), null);
});

test('thinking: NVIDIA_LLM_THINKING=off manda enable_thinking false no corpo', async () => {
  assert.deepEqual(await callWithThinkingEnv('off'), { chat_template_kwargs: { enable_thinking: false } });
});

test('generateReplyWithActions: defaults de temperatura e orçamento de tokens', async () => {
  const client = fakeClient({ result: { content: '{"reply":"oi"}' } });
  await withFakeKey(() => generateReplyWithActions('s', 'u', { client }));
  assert.equal(client.calls[0].temperature, 0.7);
  // 1800 tokens: folga para modelos com reasoning ativo não estourarem ao processar contexto de skills
  assert.equal(client.calls[0].max_tokens, 1800);
});

test('generateReplyWithActions: JSON preso no reasoning é resgatado', async () => {
  // Raciocínio estourou o orçamento: content virou prosa e o JSON nasceu em
  // reasoning_content. O texto do raciocínio é devolvido cru para o parse do
  // chamador, que recupera o objeto com extractJsonCandidate.
  const client = fakeClient({
    result: {
      content: 'The user greeted me, so I should answer as a tsundere companion...',
      reasoning: 'plano {"reply":"B-baka! Eu não estava esperando você.","actions":[]} fim',
      finishReason: 'length',
    },
  });
  const raw = await withFakeKey(() => generateReplyWithActions('s', 'u', { client }));
  assert.equal(raw, 'plano {"reply":"B-baka! Eu não estava esperando você.","actions":[]} fim');
});

test('generateReplyWithActions: raciocínio que reescreve o prompt não vira reply', async () => {
  // Guarda do requiredKey='reply': sem um objeto JSON com "reply" no
  // raciocínio, devolvemos o content — senão a Usami "fala o próprio prompt".
  const leakedPrompt = 'System Prompt: Você é Usami (兎美), uma companion virtual tsundere. {"nota":"lembrar do estágio"}';
  const client = fakeClient({
    result: { content: 'N-não sei do que você está falando. Hmph.', reasoning: leakedPrompt, finishReason: 'stop' },
  });
  const raw = await withFakeKey(() => generateReplyWithActions('s', 'u', { client }));
  assert.equal(raw, 'N-não sei do que você está falando. Hmph.');
  assert.ok(!raw.includes('兎美'));
});

test('generateReplyWithActions: erro do cliente propaga (fallback é do chamador)', async () => {
  const client = fakeClient({ error: new Error('NVIDIA API HTTP 503') });
  await assert.rejects(
    withFakeKey(() => generateReplyWithActions('s', 'u', { client })),
    /NVIDIA API HTTP 503/,
  );
});

test('generateReplyWithActions: sem chave NVIDIA lança antes de chamar o cliente', async () => {
  const client = fakeClient({ result: { content: MERGED_JSON } });
  await assert.rejects(
    generateReplyWithActions('s', 'u', { client }),
    /NVIDIA_API_KEY não configurada/,
  );
  assert.equal(client.calls.length, 0);
});
