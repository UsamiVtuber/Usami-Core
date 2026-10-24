import test from 'node:test';
import assert from 'node:assert/strict';
import { createFlowExecutor } from '../src/flow-executor.js';
import { buildServices } from '../src/flow-services.js';
import { createMemoryStore } from '../src/memory-store.js';
import { classifyEmotion, DEFAULT_CONFIDENCE_THRESHOLD } from '../src/emotion-classifier.js';
import { createEmotionEngine } from '../src/emotion-engine.js';
import { createExpressionDriver } from '../src/expression-driver.js';

function makeServices() {
  const memoryStore = createMemoryStore({ dataDir: 'data' });
  try { memoryStore.load(); } catch {}
  const emotionEngine = createEmotionEngine({
    driver: createExpressionDriver({ setRaw: () => {}, now: () => Date.now() }),
  });
  return buildServices({
    fetchImpl: globalThis.fetch,
    getKey: async () => 'test-key',
    model: 'test-model',
    memoryStore,
    classifyEmotion,
    emotionEngine,
    expressionDriver: createExpressionDriver({ setRaw: () => {}, now: () => Date.now() }),
    gestureLayer: null,
    transcribeAudio: async ({ audioBuffer }) => '',
  });
}

test('FlowExecutor executa chat flow completo (mockado)', async () => {
  const services = makeServices();
  // Mock LLM
  services.llm = {
    async chat({ message, capabilities }) {
      return { reply: 'Olá! Tudo bem?', gesture: 'wave', actions: [{ type: 'gesture', name: 'wave' }] };
    },
  };
  // Mock emotion (baixa confiança para não aplicar)
  services.emotion = {
    async classifyAndApply({ reply }) {
      return { label: 'neutral', intensity: 0, confidence: 0.3, applied: false };
    },
  };
  // Mock TTS
  services.tts = { synthesize: async () => null };
  // Mock STT
  services.stt = { transcribeAudio: async () => '' };

  const { createFlowExecutor } = await import('../src/flow-executor.js');
  const executor = createFlowExecutor({ services, config: {} });

  const result = await executor.executeChat({
    userText: 'oi',
    capabilities: { gestures: ['wave'] },
    voiceOff: false,
  });

  assert.equal(result.reply, 'Olá! Tudo bem?');
  assert.equal(result.gesture, 'wave');
  assert.ok(Array.isArray(result.actions));
  assert.equal(result.emotion.label, 'neutral');
  assert.equal(result.emotion.applied, false);
});

test('FlowExecutor com voz desligada não sintetiza', async () => {
  const services = makeServices();
  services.llm = { async chat() { return { reply: 'ok', gesture: 'neutral', actions: [] }; } };
  services.emotion = { async classifyAndApply() { return { label: 'neutral', intensity: 0, confidence: 0, applied: false }; } };
  services.tts = { synthesize: async () => { throw new Error('should not call'); } };

  const { createFlowExecutor } = await import('../src/flow-executor.js');
  const executor = createFlowExecutor({ services, config: {} });

  const result = await executor.executeChat({
    userText: 'oi',
    capabilities: {},
    voiceOff: true,
  });

  assert.equal(result.reply, 'ok');
  assert.equal(result.audioBuffer, null);
});

test('FlowExecutor aplica emoção quando confiança alta', async () => {
  const services = makeServices();
  services.llm = { async chat() { return { reply: 'Que felicidade!', gesture: 'neutral', actions: [] }; } };
  services.emotion = {
    async classifyAndApply({ reply }) {
      return { label: 'happy', intensity: 1, confidence: 0.8, applied: true };
    },
  };
  services.tts = { synthesize: async ({ text, styleId }) => Buffer.from('audio') };

  const { createFlowExecutor } = await import('../src/flow-executor.js');
  const executor = createFlowExecutor({ services, config: {} });

  const result = await executor.executeChat({
    userText: 'Que felicidade!',
    capabilities: {},
    voiceOff: false,
  });

  assert.equal(result.emotion.label, 'happy');
  assert.equal(result.emotion.applied, true);
  assert.ok(result.audioBuffer);
});

test('FlowExecutor sem capacidades usa defaults', async () => {
  const services = makeServices();
  services.llm = { async chat() { return { reply: 'sem caps', gesture: 'neutral', actions: [] }; } };
  services.emotion = { async classifyAndApply() { return { label: 'neutral', intensity: 0, confidence: 0, applied: false }; } };
  services.tts = { synthesize: async () => null };

  const { createFlowExecutor } = await import('../src/flow-executor.js');
  const executor = createFlowExecutor({ services, config: {} });

  const result = await executor.executeChat({ userText: 'oi' });
  assert.equal(result.reply, 'sem caps');
});