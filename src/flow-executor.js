/**
 * FlowExecutor — runs the Usami chat graph with injected services.
 * Single entrypoint: executeChat({ userText, audioBuffer, capabilities, voiceOff })
 */

import { executeFlow } from './flow-nodes.js';
import { buildChatFlow } from './flow-domain.js';

export function createFlowExecutor({ services, config = {} } = {}) {
  if (!services) throw new Error('FlowExecutor needs services');

  const flow = buildChatFlow({ services, config });

  // Validate required services
  const required = ['llm', 'stt', 'emotion', 'tts', 'memory', 'affinity'];
  for (const svc of required) {
    if (!services[svc] && svc !== 'gestureLayer' && svc !== 'expressionDriver') {
      console.warn(`[FlowExecutor] Missing service: ${svc} (may be OK for tests)`);
    }
  }

  return {
    /** Execute the chat flow with given inputs */
    async executeChat(inputs = {}) {
      const externalInputs = {
        userText: inputs.userText || '',
        audioBuffer: inputs.audioBuffer || null,
        capabilities: inputs.capabilities || null,
        voiceOff: Boolean(inputs.voiceOff),
      };

      // Build context with services and helpers
      const now = () => new Date().toISOString();
      const context = {
        services,
        config: { voiceOff: inputs.voiceOff },
        now,
        summarizeCapabilities: services.summarizeCapabilities || services.filter?.summarizeCapabilities || (value => value),
        filterActionsByCatalog: services.filterActionsByCatalog || services.filter?.filterActionsByCatalog || (actions => actions),
      };

      const { result, nodeOutputs } = await executeFlow(flow, externalInputs, context);

      // Normalize response
      const llm = nodeOutputs.llm?.llmResult || nodeOutputs.llmResult || nodeOutputs.llm || {};
      const emotion = nodeOutputs.emotion?.emotionResult || nodeOutputs.emotionResult || nodeOutputs.emotion || {};
      const tts = nodeOutputs.tts || {};
      const filtered = nodeOutputs.filter?.filteredActions || nodeOutputs.filteredActions || [];

      return {
        reply: llm.reply || '',
        gesture: llm.gesture || 'neutral',
        actions: filtered.length ? filtered : (llm.actions || []),
        emotion: {
          label: emotion.label || 'neutral',
          intensity: emotion.intensity || 0,
          confidence: emotion.confidence || 0,
          applied: emotion.applied || false,
        },
        audioBuffer: tts.audioBuffer || null,
        debug: {
          nodesRun: Object.keys(nodeOutputs).length,
          emotionApplied: emotion.applied,
          ttsGenerated: Boolean(tts.audioBuffer),
        },
      };
    },

    /** Quick test: runs with minimal inputs */
    async test() {
      return this.executeChat({ userText: 'oi', capabilities: {} });
    },
  };
}
