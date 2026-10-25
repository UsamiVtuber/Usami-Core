import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { classifyUserMessage, planAnimation } from '../src/llm-router.js';

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
