// Política de decisão da etapa 3: liga o texto da resposta do chat ao
// emotion-engine. Determinística e pura — o engine e o classificador são
// injetáveis (stubs nos testes).
//
// Emoção confiável vence: `confidence >= threshold` aplica o engine e remove
// das `actions` o `set_expression` pedido pelo LLM (evita blend duplo no VRM —
// o motor de emoções passa a ser o dono da expressão daquele turno). Sem
// confiança suficiente (ou sem engine), as `actions` originais seguem para o
// director intactas — o comportamento anterior fica preservado.

import { classifyEmotion, DEFAULT_CONFIDENCE_THRESHOLD } from './emotion-classifier.js';

const EMOTION_DURATION_MS = 4500;

export function resolveReplyEmotion({ reply, actions = [], engine, classifier = classifyEmotion, threshold = DEFAULT_CONFIDENCE_THRESHOLD } = {}) {
  const emotion = classifier(reply) || { label: 'neutral', intensity: 0, confidence: 0 };
  const canApply = Boolean(engine) && typeof engine.apply === 'function' && emotion.confidence >= threshold;
  if (!canApply) return { actions, emotion, applied: false };
  engine.apply({ label: emotion.label, intensity: emotion.intensity, durationMs: EMOTION_DURATION_MS });
  const list = Array.isArray(actions) ? actions : [];
  const hasExpression = list.some(action => action?.type === 'set_expression');
  return { actions: hasExpression ? list.filter(action => action?.type !== 'set_expression') : list, emotion, applied: true };
}
