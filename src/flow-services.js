/**
 * Service adapters — wrap existing pure functions into the service interface
 * expected by FlowExecutor. Zero logic, pure wiring.
 */

import { createMemoryStore } from './memory-store.js';
import { calculateGain, applyGain, getStage, canGainMore, DAILY_CAP } from './affinity.js';
import { filterActionsByCatalog, sanitizeCapabilities, sanitizeActions, parseProviderRaw } from './provider-parse.js';
import { summarizeCapabilities } from './capability-manifest.js';
import { transcribeAudio } from './stt.js';
import { curateExpressions } from './expressions-catalog.js';

/** LLM service — wraps OpenRouter call */
export function createLlmService({ fetchImpl, getKey, model, systemBase, allowedOrigins }) {
  const DEFAULT_SYSTEM = 'Você é Usami, uma companion acolhedora, curiosa e natural. Responda em português de forma breve. Não incentive dependência emocional ou exclusividade. Responda SOMENTE JSON: {"reply":"resposta","gesture":"neutral" ou "tilt","actions":[{"type":"gesture","name":"tilt" ou "wave" ou "idle"},{"type":"play_clip","name":"Nome do clip"},{"type":"set_morph","name":"Nome do morph","value":0 a 1},{"type":"set_mesh_visible","name":"Nome de mesh acessório","visible":true ou false}]}. Actions é opcional e pode ser vazio; no máximo 5 ações.'.trim();

  return {
    async chat({ message, capabilities }) {
      const sanitizedCaps = capabilities ? sanitizeCapabilities(capabilities) : null;
      const system = sanitizedCaps ? DEFAULT_SYSTEM + '\n\nCapacidades: ' + JSON.stringify(sanitizedCaps) : DEFAULT_SYSTEM;

      const key = await getKey();
      if (!key) throw new Error('OpenRouter key missing');

      const response = await fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          max_tokens: 320,
          messages: [{ role: 'system', content: system }, { role: 'user', content: message }],
        }),
        signal: AbortSignal.timeout(45000),
      });

      if (!response || !response.ok) throw new Error('OpenRouter error: ' + response.status);
      const data = await response.json();
      const raw = data?.choices?.[0]?.message?.content;
      const parsed = parseProviderRaw(raw);
      if (!parsed.ok) throw new Error('Invalid provider response');
      return { reply: parsed.reply, gesture: parsed.gesture, actions: sanitizeActions(parsed.actions || []) };
    },
  };
}

/** Emotion service — classify + apply engine */
export function createEmotionService({ classifyEmotion, emotionEngine }) {
  return {
    async classifyAndApply({ reply }) {
      const emotion = classifyEmotion(reply) || { label: 'neutral', intensity: 0, confidence: 0 };
      const canApply = emotionEngine && typeof emotionEngine.apply === 'function' && emotion.confidence >= 0.6;
      if (!canApply) return { ...emotion, applied: false };
      emotionEngine.apply({ label: emotion.label, intensity: emotion.intensity, durationMs: 4500 });
      return { ...emotion, applied: true };
    },
  };
}

/** TTS service — wraps createTtsHandler internals */
export function createTtsService({ synthesize }) {
  return { synthesize: typeof synthesize === 'function' ? synthesize : async () => null };
}

/** STT service — wraps transcribeAudio */
export function createSttService({ transcribeAudio }) {
  return { transcribeAudio };
}

/** Memory service — wraps memoryStore */
export function createMemoryService({ memoryStore }) {
  return {
    load: () => memoryStore.load(),
    save: (data) => memoryStore.save(data),
    getSections: () => memoryStore.getSections(),
    getRecentFacts: (nowIso) => memoryStore.getRecentFacts(nowIso),
    getTodayHistory: (day) => memoryStore.getTodayHistory(day),
    getAffinity: () => memoryStore.getAffinity(),
    appendHistory: (role, content, timestamp) => memoryStore.appendHistory(role, content, timestamp),
    addCoreFact: (fact, section) => memoryStore.addCoreFact(fact, section),
    addRecentFact: (fact, ttlDays, section) => memoryStore.addRecentFact(fact, ttlDays, section),
    setAffinity: (score, day) => memoryStore.setAffinity(score, day),
    getAll: () => memoryStore.getAll(),
  };
}

/** Affinity service — pure functions */
export function createAffinityService() {
  return {
    calculateGain,
    applyGain,
    getStage,
    canGainMore,
    DAILY_CAP,
  };
}

/** Expression driver — if available (client-side) */
export function createExpressionDriverService({ expressionDriver }) {
  if (!expressionDriver) return null;
  return {
    set: (name, weight, options) => expressionDriver?.set(name, weight, options) ?? false,
  };
}

/** Gesture layer — if available */
export function createGestureLayerService({ gestureLayer }) {
  if (!gestureLayer) return null;
  return {
    trigger: (gesture, emotion) => gestureLayer?.trigger?.(gesture, emotion) ?? false,
  };
}

/** Filter & utility services — re-export from server */
export function createFilterService() {
  return {
    filterActionsByCatalog,
    sanitizeCapabilities,
    summarizeCapabilities,
    sanitizeActions,
    curateExpressions,
  };
}

/** Build all services from config */
export function buildServices({ fetchImpl, getKey, model, memoryStore, classifyEmotion, emotionEngine, expressionDriver, gestureLayer, synthesize, transcribeAudio }) {
  return {
    llm: createLlmService({ fetchImpl, getKey, model }),
    emotion: createEmotionService({ classifyEmotion: classifyEmotion || (() => ({ label: 'neutral', intensity: 0, confidence: 0 })), emotionEngine }),
    tts: createTtsService({ synthesize }),
    stt: createSttService({ transcribeAudio }),
    memory: createMemoryService({ memoryStore }),
    affinity: createAffinityService(),
    expressionDriver: createExpressionDriverService({ expressionDriver }),
    gestureLayer: createGestureLayerService({ gestureLayer }),
    filter: createFilterService(),
    classifyEmotion: classifyEmotion || (() => ({ label: 'neutral', intensity: 0, confidence: 0 })),
    emotionEngine,
  };
}
