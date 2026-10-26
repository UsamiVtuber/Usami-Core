import { strict as assert } from 'node:assert';
import { test } from 'node:test';

// Isolamento: sem chave NVIDIA no processo de teste o roteador cai nos
// classificadores locais, e `npm test` não faz chamada de rede.
delete process.env.NVIDIA_API_KEY;

const { classifyUserMessage, jsonText, planAnimation } = await import('../src/llm-router.js');

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
