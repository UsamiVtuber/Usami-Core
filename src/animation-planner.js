// Fase 5: planner de seleção — decide QUAL técnica executar, nunca move nada.
//
// O planner é a peça determinística entre a base de conhecimento (Fase 4) e o
// motion director. Ele não fala com o avatar, não abre conexão, não chama modelo:
// recebe a intenção já classificada pelo runtime, um provider de técnicas, o
// manifesto de capacidades e a memória de aprendizagem, e devolve um plano
// auditável. Toda criatividade fica na INGESTÃO (Fase 3); se o planner fosse
// aleatório, o histórico de aprendizagem deixaria de ser comparável.
//
// A trava de movimento é a mesma do resto do sistema: cada motion da técnica é
// reexpandida com buildSequenceRequest e revalidada com validateSequence antes de
// virar ação. Técnica que produza uma única ação inválida é descartada inteira,
// com motivo — "meio plano executável" não existe, porque motion que fere o
// contrato indica arquivo adulterado, não quase-certo.
//
// Capacidade manda: o plano só oferece o que o manifesto diz que este modelo faz
// (shapes pedem capabilities.sequences; gestos e clipes seguem a mesma regra do
// director). O teto de 5 ações por resposta é o do motion director, e o corte é
// registrado no plano, não silencioso.
//
// Sem candidata que bata com a intenção, o plano cai no padrão determinístico
// (gestos da allowlist e shapes do vocabulário) — o avatar não fica sem resposta
// e não inventa movimento.

import { buildSequenceRequest, SHAPE_NAMES } from './sequence-shapes.js';
import { validateSequence } from './motion-sequence.js';
import { DEFAULT_MAX_ACTIONS, GESTURE_NAMES } from './motion-director.js';
import { validateTechnique } from './technique-schema.js';
import { signatureOf } from './motion-experiments.js';
import { createTechniqueStore } from './technique-store.js';
import { EMOTION_LABELS } from './emotion-map.js';

export const PLAN_INTENTS = Object.freeze(['wave', 'greet', 'idle', 'custom']);
export const PLAN_MOODS = Object.freeze([...EMOTION_LABELS]);
export const PLAN_SOURCES = Object.freeze(['kb', 'fallback']);

export const PLANNER_LIMITS = Object.freeze({
  maxActions: DEFAULT_MAX_ACTIONS,
  maxTags: 8,
  maxTagChars: 24,
  maxTextChars: 300,
  maxAuditCandidates: 8,
  maxRejected: 20,
});

// Pesos somam 100 e são públicos: o painel mostra a contribuição de cada critério
// e qualquer mudança de política de seleção aparece como diff neste objeto.
export const PLAN_WEIGHTS = Object.freeze({
  tags: 30,
  shape: 20,
  memory: 25,
  capabilities: 15,
  recency: 6,
  confidence: 4,
});

// Relevância = o quanto a técnica tem a ver com a intenção (tags + shape), com
// teto 50. Abaixo do mínimo o planner não "escolhe a menos ruim": devolve o
// fallback, porque memória/capacidades/recência não compram aderência à intenção.
export const PLAN_MIN_RELEVANCE = 12;

const REQUEST_KEYS = Object.freeze(['intent', 'text', 'shape', 'tags', 'mood']);
const NEUTRAL = 0.5;
// O veredito humano é multiplicador, não mais uma média: nota objetiva perfeita
// não compra um movimento que uma pessoa reprovou.
const HUMAN_FACTOR = Object.freeze({ aprovado: 1, ajustar: 0.75, reprovado: 0.2 });

// Vocabulário por intenção (mesmo espírito do classificador determinístico):
// casar tag da técnica com a intenção é o que faz "aceno" virar aceno sem LLM.
export const INTENT_TAGS = Object.freeze({
  wave: ['aceno', 'wave', 'tchau', 'acenar', 'mover a mao'],
  greet: ['cumprimento', 'saudacao', 'ola', 'greet', 'hello', 'receber'],
  idle: ['idle', 'ocioso', 'repouso', 'calmo', 'respirar', 'breathing'],
  custom: [],
});

const INTENT_SHAPE = Object.freeze({ wave: 'wave-arm', greet: 'nod', idle: 'sway-arms', custom: 'nod' });

/**
 * Intenção a partir de texto livre, determinística (sem LLM): a KB só decide
 * QUAL técnica usar, quem diz O QUE o usuário pediu continua sendo o runtime.
 * Sem palavra de vocabulário reconhecida devolve `custom`, que cai no fallback.
 */
export function intentFromText(text) {
  const folded = fold(text);
  if (!folded) return 'custom';
  const words = new Set(folded.split(' ').filter(Boolean));
  for (const intent of PLAN_INTENTS) {
    if (intent === 'custom') continue;
    if (INTENT_TAGS[intent].some(tag => words.has(tag))) return intent;
  }
  return 'custom';
}

// Fallback determinístico: nomes que já existem na allowlist do director e no
// vocabulário de shapes. Não é invenção — é a escolha conservadora conhecida.
export const FALLBACK_GESTURE = Object.freeze({ wave: 'wave', greet: 'bow', idle: 'idle', custom: 'tilt' });
export const FALLBACK_REQUEST = Object.freeze({ amplitude: 0.2, cycles: 2, durationMs: 1600, side: 'right' });

const round = (value, digits = 3) => Number(Number(value).toFixed(digits));
const fold = value => String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const tokenSet = value => new Set(fold(value).split(' ').filter(Boolean));

/** Contrato fechado do pedido: só intent/text/shape/tags/mood. */
export function validatePlanRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    return { ok: false, errors: ['pedido deve ser um objeto'], value: null };
  }
  const errors = [];
  const unknown = Object.keys(request).filter(key => !REQUEST_KEYS.includes(key));
  if (unknown.length) errors.push(`campos desconhecidos no pedido: ${unknown.join(', ')}`);
  if (!PLAN_INTENTS.includes(request.intent)) {
    errors.push(`intent ${JSON.stringify(request.intent)} fora de ${PLAN_INTENTS.join('/')}`);
  }
  let text = '';
  if (request.text !== undefined && request.text !== null) {
    if (typeof request.text !== 'string') errors.push('text deve ser texto');
    else text = request.text.slice(0, PLANNER_LIMITS.maxTextChars);
  }
  if (request.shape !== undefined && request.shape !== null && !SHAPE_NAMES.includes(request.shape)) {
    errors.push(`shape ${JSON.stringify(request.shape)} fora do vocabulário ${SHAPE_NAMES.join('/')}`);
  }
  let tags = [];
  if (request.tags !== undefined && request.tags !== null) {
    if (!Array.isArray(request.tags) || request.tags.some(tag => typeof tag !== 'string')) {
      errors.push('tags deve ser lista de texto');
    } else {
      tags = request.tags.slice(0, PLANNER_LIMITS.maxTags).map(tag => tag.slice(0, PLANNER_LIMITS.maxTagChars));
    }
  }
  if (request.mood !== undefined && request.mood !== null && !PLAN_MOODS.includes(request.mood)) {
    errors.push(`mood ${JSON.stringify(request.mood)} fora de ${PLAN_MOODS.join('/')}`);
  }
  if (errors.length) return { ok: false, errors, value: null };
  return {
    ok: true,
    errors: [],
    value: { intent: request.intent, text, shape: request.shape ?? null, tags, mood: request.mood ?? null },
  };
}

// --- capacidades (espelho das regras do motion director) ---------------------

function allowedGestures(capabilities) {
  if (!capabilities) return new Set(['tilt', 'wave', 'idle']);
  const declared = [
    ...(capabilities.customTilt !== false ? ['tilt'] : []),
    ...(capabilities.customWave !== false ? ['wave'] : []),
    ...(capabilities.customIdle !== false ? ['idle'] : []),
    ...(Array.isArray(capabilities.gestures) ? capabilities.gestures : []),
  ];
  return new Set(declared.filter(name => GESTURE_NAMES.includes(name)));
}

function allowedClips(capabilities) {
  if (!capabilities) return null;
  const list = [...(capabilities.clips ?? []), ...(capabilities.animations ?? [])];
  return new Set(list.map(item => (typeof item === 'string' ? item : item?.name)).filter(Boolean));
}

// --- expansão com trava ------------------------------------------------------

// motion da técnica → ação do director + assinatura, ou o motivo da recusa.
// Rebuild + validateSequence: o plano nunca carrega keyframe, só o pedido.
function motionToAction(motion, { technique, capabilities, gestures, clips }) {
  if (motion.kind === 'shape') {
    const request = { ...motion.request, name: `${technique.name}:${motion.shape}` };
    const built = buildSequenceRequest(request);
    if (!built.ok) return { error: `shape ${motion.shape}: ${built.errors.join('; ')}` };
    const validated = validateSequence(built.sequence);
    if (!validated.ok) return { error: `sequência de ${motion.shape} inválida: ${validated.errors.join('; ')}` };
    if (capabilities?.sequences !== true) return { unsupported: `shape ${motion.shape} exige capabilities.sequences` };
    const signature = signatureOf(motion.request);
    return {
      signature,
      action: {
        type: 'play_sequence',
        name: validated.sequence.name,
        shape: request.shape,
        side: request.side,
        amplitude: request.amplitude,
        cycles: request.cycles,
        durationMs: validated.sequence.durationMs,
        techniqueId: technique.id ?? null,
        signature,
      },
    };
  }
  if (motion.kind === 'gesture') {
    if (!gestures.has(motion.name)) return { unsupported: `gesto ${motion.name} indisponível neste modelo` };
    return { signature: null, action: { type: 'gesture', name: motion.name, techniqueId: technique.id ?? null, signature: null } };
  }
  if (motion.kind === 'clip') {
    if (clips && !clips.has(motion.name)) return { unsupported: `clip ${motion.name} não está no modelo` };
    return { signature: null, action: { type: 'play_clip', name: motion.name, techniqueId: technique.id ?? null, signature: null } };
  }
  return { error: `motion.kind ${JSON.stringify(motion.kind)} desconhecido` };
}

// --- critérios ---------------------------------------------------------------

function tagCriterion(technique, wantTags) {
  const techTags = new Set(technique.tags.map(tag => fold(tag)).filter(Boolean));
  if (!techTags.size) return 0;
  const hits = [...techTags].filter(tag => wantTags.has(tag)).length;
  return round(Math.min(1, hits / Math.min(2, techTags.size)));
}

function shapeCriterion(technique, wantedShape) {
  const shapes = technique.motions.filter(motion => motion.kind === 'shape').map(motion => motion.shape);
  if (wantedShape && shapes.includes(wantedShape)) return 1;
  return shapes.length ? 0.4 : 0;
}

// A memória entra com a história objetiva (taxa de sucesso + melhor nota) e o
// veredito humano como multiplicador. Sem histórico o valor é neutro (0.5):
// novidade nem é punida nem premiada. Primeiro a história da técnica; sem ela, a
// do movimento (assinatura), que é reutilizável entre técnicas.
function memoryCriterion(techniqueId, signatures, memory) {
  if (!memory || typeof memory.statsFor !== 'function') return { value: NEUTRAL, evidence: null };
  const own = memory.statsFor(techniqueId);
  const records = own ? [own] : signatures.map(signature => memory.statsFor(signature)).filter(Boolean);
  if (!records.length) return { value: NEUTRAL, evidence: null };
  const attempts = records.reduce((sum, item) => sum + item.attempts, 0);
  const successes = records.reduce((sum, item) => sum + item.successes, 0);
  const failures = records.reduce((sum, item) => sum + item.failures, 0);
  const bestScore = records.map(item => item.bestScore).filter(value => value !== null);
  const best = bestScore.length ? Math.max(...bestScore) : null;
  const verdicts = [...new Set(records.map(item => item.visual?.verdict).filter(Boolean))];
  const reliability = attempts ? round((1 + (successes - failures) / attempts) / 2) : NEUTRAL;
  const objective = best === null ? NEUTRAL : round(best / 100);
  const factor = verdicts.includes('reprovado')
    ? HUMAN_FACTOR.reprovado
    : verdicts.includes('ajustar')
      ? HUMAN_FACTOR.ajustar
      : HUMAN_FACTOR.aprovado;
  return {
    value: round(((reliability + objective) / 2) * factor),
    evidence: { scope: own ? 'tecnica' : 'assinatura', attempts, successes, failures, bestScore: best, verdicts },
  };
}

function recencyCriterion(technique, nowMs) {
  const created = Date.parse(technique.createdAt);
  if (!Number.isFinite(created) || !Number.isFinite(nowMs)) return 0;
  const ageDays = Math.max(0, (nowMs - created) / 86_400_000);
  // granularidade em dias: o relógio padrão não faz o plano variar entre duas
  // chamadas do mesmo instante de seleção
  return round(Math.max(0, 1 - Math.floor(ageDays) / 90));
}

function capabilitiesCriterion(built) {
  if (!built.length) return 0;
  return round(built.filter(item => item.action).length / built.length);
}

const relevanceOf = criteria => round(PLAN_WEIGHTS.tags * criteria.tags + PLAN_WEIGHTS.shape * criteria.shape, 2);
const scoreOf = criteria => round(Object.keys(PLAN_WEIGHTS).reduce((sum, key) => sum + PLAN_WEIGHTS[key] * criteria[key], 0), 2);

// --- planner -----------------------------------------------------------------

/**
 * Seleciona a técnica e monta o plano. Determinístico: mesma entrada, mesmo plano.
 * @param {{ intent: string, text?: string, shape?: string|null, tags?: string[], mood?: string|null }} request
 * @param {{ techniques?: Array|(() => Array|Promise<Array>), capabilities?: object|null,
 *           memory?: { statsFor: (key: string) => object|null, bestFor?: (keys: string[]) => object|null },
 *           now?: () => number, dataDir?: string }} options
 */
export async function planAnimationSelection(request, options = {}) {
  const check = validatePlanRequest(request);
  if (!check.ok) throw new Error(`planner: pedido inválido — ${check.errors.join('; ')}`);
  const wanted = check.value;
  const capabilities = options.capabilities ?? null;
  const memory = options.memory ?? null;
  const nowMs = Number((options.now ?? (() => Date.now()))());
  const provider = options.techniques ?? (() => createTechniqueStore({ dataDir: options.dataDir ?? 'data' }).list());
  const injected = typeof provider === 'function' ? await provider() : provider;
  if (!Array.isArray(injected)) throw new Error('planner: técnicas devem chegar como lista (array ou provider)');

  const context = { capabilities, gestures: allowedGestures(capabilities), clips: allowedClips(capabilities) };
  const wantTags = new Set([
    ...tokenSet(wanted.text),
    ...wanted.tags.map(tag => fold(tag)),
    ...INTENT_TAGS[wanted.intent].map(tag => fold(tag)),
    ...tokenSet(wanted.mood ?? ''),
  ].filter(Boolean));
  const wantedShape = wanted.shape ?? INTENT_SHAPE[wanted.intent];

  const rejected = [];
  const scored = [];
  for (const candidate of injected) {
    const validated = validateTechnique(candidate);
    const claimedId = typeof candidate?.id === 'string' ? candidate.id : null;
    if (!validated.ok) {
      rejected.push({ techniqueId: claimedId, reason: `técnica inválida: ${validated.errors.join('; ')}` });
      continue;
    }
    const technique = validated.technique;
    if (technique.status !== 'validada') {
      rejected.push({ techniqueId: technique.id, reason: `status '${technique.status}' não alimenta o planner` });
      continue;
    }
    if (!technique.motions.length) {
      rejected.push({ techniqueId: technique.id, reason: 'técnica sem motions' });
      continue;
    }
    // TRAVA: uma motion que não expanda/valide derruba a técnica inteira.
    const built = technique.motions.map(motion => motionToAction(motion, { ...context, technique }));
    const broken = built.find(item => item.error);
    if (broken) {
      rejected.push({ techniqueId: technique.id, reason: broken.error });
      continue;
    }
    const actions = built.filter(item => item.action).map(item => item.action);
    if (!actions.length) {
      const reason = built.map(item => item.unsupported).filter(Boolean).join('; ') || 'nenhuma ação compatível com o modelo';
      rejected.push({ techniqueId: technique.id, reason });
      continue;
    }
    const signal = memoryCriterion(technique.id, built.map(item => item.signature).filter(Boolean), memory);
    const criteria = {
      tags: tagCriterion(technique, wantTags),
      shape: shapeCriterion(technique, wantedShape),
      memory: signal.value,
      capabilities: capabilitiesCriterion(built),
      recency: recencyCriterion(technique, nowMs),
      confidence: round(technique.confidence),
    };
    const relevance = relevanceOf(criteria);
    if (relevance < PLAN_MIN_RELEVANCE) {
      rejected.push({ techniqueId: technique.id, reason: `relevância ${relevance} abaixo do mínimo ${PLAN_MIN_RELEVANCE} para '${wanted.intent}'` });
      continue;
    }
    scored.push({
      techniqueId: technique.id,
      name: technique.name,
      createdAt: technique.createdAt,
      criteria,
      evidence: signal.evidence,
      actions,
      score: scoreOf(criteria),
      relevance,
    });
  }

  // Empate resolvido por data e depois por id: duas chamadas dão a mesma ordem.
  scored.sort((a, b) => b.score - a.score
    || String(b.createdAt).localeCompare(String(a.createdAt))
    || a.techniqueId.localeCompare(b.techniqueId));

  const auditTrail = rejected.slice(0, PLANNER_LIMITS.maxRejected);
  const audit = scored.slice(0, PLANNER_LIMITS.maxAuditCandidates).map(item => ({
    techniqueId: item.techniqueId,
    name: item.name,
    score: item.score,
    relevance: item.relevance,
    criteria: item.criteria,
  }));

  const winner = scored[0] ?? null;
  if (winner) {
    const actions = winner.actions.slice(0, PLANNER_LIMITS.maxActions);
    const overflow = winner.actions.length - actions.length;
    const trail = overflow
      ? [...auditTrail, { techniqueId: winner.techniqueId, reason: `teto de ${PLANNER_LIMITS.maxActions} ações por resposta: ${overflow} descartada(s)` }]
      : auditTrail;
    return {
      techniqueId: winner.techniqueId,
      name: winner.name,
      actions,
      rejected: trail,
      reason: `${scored.length} candidata(s) relevante(s); melhor é ${winner.techniqueId} (relevância ${winner.relevance}, memória ${winner.criteria.memory}, capacidades ${winner.criteria.capabilities})`,
      source: 'kb',
      score: winner.score,
      criteria: winner.criteria,
      evidence: winner.evidence,
      candidates: audit,
      overflow,
    };
  }

  const fallback = buildFallback({ wanted, context, memory, auditTrail });
  return {
    techniqueId: null,
    name: 'fallback',
    actions: fallback.actions,
    rejected: fallback.rejected,
    reason: fallback.reason,
    source: 'fallback',
    score: 0,
    criteria: fallback.criteria,
    evidence: fallback.evidence,
    candidates: [],
    overflow: 0,
  };
}

function buildFallback({ wanted, context, memory, auditTrail }) {
  const technique = { name: 'fallback', id: null };
  const shape = wanted.shape ?? INTENT_SHAPE[wanted.intent];
  const built = [
    motionToAction({ kind: 'gesture', name: FALLBACK_GESTURE[wanted.intent] }, { ...context, technique }),
    motionToAction({ kind: 'shape', shape, request: { shape, ...FALLBACK_REQUEST } }, { ...context, technique }),
  ];
  const actions = built.filter(item => item.action).map(item => item.action);
  // O fallback não tem score de KB: o único critério que faz sentido é o quanto
  // do padrão este modelo realmente executa.
  const criteria = { tags: 0, shape: 0, memory: 0, capabilities: capabilitiesCriterion(built), recency: 0, confidence: 0 };
  if (!actions.length) {
    const detail = built.map(item => item.error ?? item.unsupported).filter(Boolean).join('; ');
    return {
      actions: [],
      rejected: [...auditTrail, { techniqueId: null, reason: `nenhuma ação do padrão está disponível neste modelo: ${detail}` }],
      reason: `fallback '${wanted.intent}' sem ação disponível neste modelo`,
      criteria: { ...criteria, capabilities: 0 },
      evidence: null,
    };
  }
  const signatures = built.map(item => item.signature).filter(Boolean);
  const best = memory && typeof memory.bestFor === 'function' ? memory.bestFor(signatures) : null;
  const evidence = best ? { fallbackSignature: best.signature, bestScore: best.bestScore, attempts: best.attempts } : null;
  const why = auditTrail.length ? 'nenhuma técnica viável para esta intenção' : 'base de conhecimento sem candidata';
  return {
    actions,
    rejected: auditTrail,
    reason: `${why}; padrão determinístico '${wanted.intent}' (${actions.map(action => action.shape ?? action.name).join(' + ')})`,
    criteria,
    evidence,
  };
}

/** Uma linha para log/painel: origem, técnica, ações e score. */
export function explainPlan(plan) {
  if (!plan || typeof plan !== 'object' || !PLAN_SOURCES.includes(plan.source)) return 'plano inválido';
  const actions = plan.actions.length
    ? plan.actions.map(action => (action.type === 'play_sequence' ? `seq:${action.shape}` : `${action.type}:${action.name}`)).join(' + ')
    : 'nenhuma ação';
  const origin = plan.source === 'kb' ? `kb ${plan.techniqueId} "${plan.name}"` : `fallback "${plan.name}"`;
  const score = plan.source === 'kb'
    ? `score ${plan.score} (${Object.entries(plan.criteria).map(([key, value]) => `${key} ${value}`).join(', ')})`
    : 'plano padrão';
  const rejected = plan.rejected.length ? ` | ${plan.rejected.length} rejeitada(s)` : '';
  const cut = plan.overflow ? ` | ${plan.overflow} cortada(s) pelo teto` : '';
  return `${origin}: ${actions} | ${score}${rejected}${cut}`;
}

/** Projeção para o motion director: só os campos que ele já consome. */
export function planToActions(plan) {
  const actions = Array.isArray(plan?.actions) ? plan.actions : [];
  return actions.map(action => {
    if (action?.type === 'play_sequence') {
      return {
        type: 'play_sequence',
        name: action.name,
        shape: action.shape,
        side: action.side,
        amplitude: action.amplitude,
        cycles: action.cycles,
        durationMs: action.durationMs,
      };
    }
    if (action?.type === 'gesture') return { type: 'gesture', name: action.name };
    if (action?.type === 'play_clip') return { type: 'play_clip', name: action.name };
    return null;
  }).filter(Boolean);
}
