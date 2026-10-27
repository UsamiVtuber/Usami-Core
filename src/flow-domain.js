/**
 * Domain nodes — wiring Usami's pieces into the flow graph.
 * Each node is pure-async, receives injected services via context.
 */

import { createFlow, createInputNode, createOutputNode, createNode, createAsyncNode, createTransformNode } from './flow-nodes.js';

/** Node: STT (faster-whisper) — receives audio buffer, returns text */
export function createSttNode({ id = 'stt', audioKey = 'audioBuffer', textKey = 'userText' } = {}) {
  return createAsyncNode({
    id, type: 'stt', inputKeys: [audioKey], outputKey: textKey,
    fn: async ({ audioBuffer }, { services }) => {
      if (!audioBuffer || !audioBuffer.length) return '';
      const { transcribeAudio } = services.stt;
      return await transcribeAudio({ audioBuffer });
    },
  });
}

/** Node: LLM chat — receives userText + capabilities, returns { reply, actions, gesture } */
export function createLlmNode({ id = 'llm', textKey = 'userText', textSource = 'external', capsKey = 'capabilities', outPrefix = 'llm' } = {}) {
  return createNode({
    id, type: 'llm', inputs: [
      { source: textSource, key: textKey },
      { source: 'external', key: capsKey },
    ], outputKey: 'llmResult',
    process: async ({ [textKey]: userText, [capsKey]: capabilities }, { services }) => {
      if (!userText?.trim()) return { llmResult: { reply: '', actions: [], gesture: 'neutral' } };
      const { chat } = services.llm;
      const result = await chat({ message: userText, capabilities });
      return {
        llmResult: {
          reply: result.reply || '',
          actions: result.actions || [],
          gesture: result.gesture || 'neutral',
        },
      };
    },
  });
}

/** Node: Emotion classifier + engine (client-side logic, but server can mirror for actions) */
export function createEmotionNode({ id = 'emotion', textKey = 'llmResult.reply', textSource = 'llm', outPrefix = 'emo' } = {}) {
  return createNode({
    id, type: 'emotion', inputs: [
      { source: textSource, key: textKey },
    ], outputKey: 'emotionResult',
    process: async ({ [textKey]: reply }, { services }) => {
      if (!reply?.trim()) return { emotionResult: { label: 'neutral', intensity: 0, confidence: 0, applied: false } };
      const { emotion } = services;
      return { emotionResult: await emotion.classifyAndApply({ reply }) };
    },
  });
}

/** Node: Memory load → injects sections, recentFacts, history, affinity into context for LLM */
export function createMemoryLoadNode({ id = 'memoryLoad' } = {}) {
  return createAsyncNode({
    id, type: 'memoryLoad', inputKeys: [], outputKey: 'memorySnapshot',
    fn: async (_, { services, now }) => {
      const { memory } = services;
      const data = memory.load();
      return {
        sections: memory.getSections(),
        recentFacts: memory.getRecentFacts(now()),
        history: memory.getTodayHistory(),
        affinity: memory.getAffinity(),
        user: data.user,
      };
    },
  });
}

/** Node: Build capabilities manifest for LLM (includes memory summary) */
export function createCapabilitiesNode({ id = 'capabilities', memKey = 'memorySnapshot', sourceNodeId = 'mem_load' } = {}) {
  return createNode({
    id, type: 'capabilities', inputs: [{ source: sourceNodeId, key: memKey }], outputs: ['capabilities'],
    process: async ({ [memKey]: mem }, { summarizeCapabilities }) => {
      if (!mem) return { expressions: [], gestures: [], clips: [], morphs: [] };
      const { sections, recentFacts, affinity, user } = mem;
      const manifest = {
        coreFacts: Object.values(sections || {}).flat().slice(-5),
        recentFacts: recentFacts?.slice(-3) || [],
        affinity: affinity?.score || 0,
        userName: user?.nickname || user?.name,
      };
      return { capabilities: summarizeCapabilities(manifest) };
    },
  });
}

/** Node: Memory update — persists user msg, assistant reply, new facts, affinity delta */
export function createMemoryUpdateNode({ id = 'memoryUpdate', replyKey = 'llmResult.reply', emoKey = 'emotionResult' } = {}) {
  return createNode({
    id, type: 'memoryUpdate',
    inputs: [
      { source: 'external', key: 'userText' },
      { source: 'llm', key: replyKey },
      { source: 'emotion', key: emoKey },
    ],
    outputs: ['memorySaved'],
    process: async ({ userText, [replyKey]: reply, [emoKey]: emotion }, { services, now }) => {
      const { memory, affinity: affinityModule } = services;
      // 1. append history
      memory.appendHistory('user', userText, now());
      if (reply) memory.appendHistory('assistant', reply, now());
      // 2. affinity
      const currentAff = memory.getAffinity();
      const gain = affinityModule.calculateGain({
        userMessage: userText,
        assistantReply: reply,
        rememberFact: emotion?.applied ? 'emotion_applied' : null,
        currentScore: currentAff.score,
        alreadyGainedToday: currentAff.totalDailyGainToday,
      });
      if (gain.delta !== 0) {
        const next = affinityModule.applyGain(currentAff.score, gain.delta, now().slice(0, 10), currentAff.lastDailyGainDate, currentAff.totalDailyGainToday);
        memory.setAffinity(next.score, next.lastDailyGainDate);
        // also update internal counters for consistency
      }
      // 3. facts extraction could be added here (future: fact-extraction node)
      return { memorySaved: true };
    },
  });
}

/** Node: TTS — receives reply + styleId, returns audio buffer (or empty if muted) */
export function createTtsNode({ id = 'tts', replyKey = 'llmResult.reply', styleKey = 'emotionResult.label', audioKey = 'audioBuffer' } = {}) {
  return createNode({
    id, type: 'tts',
    inputs: [
      { source: 'llm', key: replyKey },
      { source: 'emotion', key: styleKey },
    ],
    outputs: [audioKey],
    process: async ({ [replyKey]: reply, [styleKey]: styleId }, { services, config }) => ({
      [audioKey]: !reply?.trim() || config?.voiceOff
        ? null
        : await services.tts.synthesize({ text: reply, styleId }),
    }),
  });
}

/** Node: Expression driver — applies emotion to VRM via driver (client), or returns action for server */
export function createExpressionNode({ id = 'expression', emoKey = 'emotionResult', source = 'emotion' } = {}) {
  return createNode({
    id, type: 'expression', inputs: [{ source, key: emoKey }], outputs: ['expressionAction'],
    process: async ({ [emoKey]: emotionResult }, { services }) => {
      if (!emotionResult?.applied || !services.expressionDriver) return { expressionAction: null };
      const { label, intensity } = emotionResult;
      services.expressionDriver.set(label, intensity, { ttlMs: 4500 });
      return { expressionAction: { type: 'set_expression', name: label, weight: intensity } };
    },
  });
}

/** Node: Gesture layer — maps emotion/gesture to procedural animations */
export function createGestureNode({ id = 'gesture', llmKey = 'llmResult.gesture', llmSource = 'llm', emoKey = 'emotionResult', emoSource = 'emotion' } = {}) {
  return createNode({
    id, type: 'gesture', inputs: [
      { source: llmSource, key: llmKey },
      { source: emoSource, key: emoKey },
    ], outputKey: 'gestureAction',
    process: async ({ [llmKey]: llmResult, [emoKey]: emotionResult }, { services }) => {
      const gesture = llmResult?.gesture || 'neutral';
      const emotion = emotionResult?.label || 'neutral';
      if (!services.gestureLayer) return { gesture };
      return { gesture, emotion, triggered: services.gestureLayer?.trigger?.(gesture, emotion) ?? false };
    },
  });
}

/** Node: Capability filter — filters actions by announced catalog (server-side) */
export function createFilterNode({ id = 'filter', actionsKey = 'llmResult.actions', source = 'llm', capsKey = 'capabilities' } = {}) {
  return createNode({
    id, type: 'filter', inputs: [
      { source: source, key: actionsKey },
      { source: 'external', key: capsKey },
    ], outputKey: 'filteredActions',
    process: async ({ [actionsKey]: actions, [capsKey]: capabilities }, { filterActionsByCatalog }) => {
      return filterActionsByCatalog(actions || [], capabilities);
    },
  });
}

/** Flow builder: assembles the standard chat pipeline */
export function buildChatFlow({ services, config = {} } = {}) {

  const nodes = [
    // External inputs: userText, audioBuffer, capabilities, voiceOff
    createInputNode({ id: 'input_userText', outputKey: 'userText' }),
    createInputNode({ id: 'input_audio', outputKey: 'audioBuffer' }),
    createInputNode({ id: 'input_caps', outputKey: 'capabilities' }),
    createInputNode({ id: 'input_voiceOff', outputKey: 'voiceOff' }),

    // Memory & capabilities
    createMemoryLoadNode({ id: 'mem_load' }),
    createCapabilitiesNode({ id: 'caps_build', memKey: 'memorySnapshot' }),

    // STT (optional, for voice calls)
    createSttNode({ id: 'stt', audioKey: 'audioBuffer', textKey: 'sttText' }),

    // Merge STT → userText (STT wins if present)
    createNode({
      id: 'merge_text', type: 'merge', inputs: [
        { source: 'external', key: 'userText' },
        { source: 'stt', key: 'sttText' },
      ], outputs: ['finalText'],
      process: async ({ userText, sttText }) => ({ finalText: sttText?.trim() || userText }),
    }),

    // LLM
    createLlmNode({ id: 'llm', textKey: 'finalText', textSource: 'merge_text', capsKey: 'capabilities', outPrefix: 'llm' }),

    // Emotion (client-side classification, server can mirror)
    createEmotionNode({ id: 'emotion', textKey: 'llmResult.reply', textSource: 'llm', outPrefix: 'emo' }),

    // Expression + Gesture (actions for director)
    createExpressionNode({ id: 'expr', emoKey: 'emotionResult', source: 'emotion' }),
    createGestureNode({ id: 'gest', llmKey: 'llmResult.gesture', emoKey: 'emotionResult' }),

    // Filter actions by catalog
    createFilterNode({ id: 'filter', actionsKey: 'llmResult.actions', capsKey: 'capabilities' }),

    // TTS
    createTtsNode({ id: 'tts', replyKey: 'llmResult.reply', styleKey: 'emotionResult.label', audioKey: 'audioBuffer' }),

    // Memory update
    createMemoryUpdateNode({ id: 'mem_update', replyKey: 'llmResult.reply', emoKey: 'emotionResult' }),

  ];

  return createFlow(nodes);
}
