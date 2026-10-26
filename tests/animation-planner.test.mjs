import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FALLBACK_GESTURE,
  INTENT_TAGS,
  PLAN_INTENTS,
  PLAN_MIN_RELEVANCE,
  PLAN_MOODS,
  PLAN_WEIGHTS,
  PLANNER_LIMITS,
  explainPlan,
  planAnimationSelection,
  planToActions,
  validatePlanRequest,
} from '../src/animation-planner.js';
import { sanitizeTechnique } from '../src/technique-schema.js';
import { createTechniqueStore } from '../src/technique-store.js';
import { createLearningMemory } from '../src/learning-memory.js';
import { createMotionDirector, DEFAULT_MAX_ACTIONS, GESTURE_NAMES, SHAPE_NAMES } from '../src/motion-director.js';
import { signatureOf } from '../src/motion-experiments.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const SOURCE = { sourceId: 'src-24772342f063', kind: 'video' };
const NOW = Date.parse('2026-10-25T12:00:00.000Z');
const now = () => NOW;
const CAPS = { clips: ['Greeting'], gestures: ['wave', 'bow', 'clap'], sequences: true };

function technique({ name, tags = ['aceno'], motions, confidence = 0.7, status = 'validada', created = '2026-10-20T12:00:00.000Z' }) {
  const result = sanitizeTechnique(
    { name, summary: `${name} resumido.`, motions, expressions: [], tags, confidence },
    { sources: [SOURCE], engine: { provider: 'teste', model: 'fixture' }, status, now: () => new Date(created) },
  );
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  return result.technique;
}

const shapeMotion = shape => ({ kind: 'shape', shape });
const plan = (request, options = {}) => planAnimationSelection(request, { capabilities: CAPS, now, ...options });

// --- contrato do pedido ------------------------------------------------------

test('pedido aceita só o contrato fechado e rejeita objeto aberto', () => {
  assert.deepEqual(PLAN_INTENTS, ['wave', 'greet', 'idle', 'custom']);
  assert.deepEqual(validatePlanRequest({ intent: 'wave', tags: ['aceno'] }).value, { intent: 'wave', text: '', shape: null, tags: ['aceno'], mood: null });
  assert.deepEqual(validatePlanRequest({ intent: 'custom', text: 'faz uma onda', shape: 'nod', tags: ['onda'], mood: 'happy' }).value, {
    intent: 'custom', text: 'faz uma onda', shape: 'nod', tags: ['onda'], mood: 'happy',
  });
  assert.ok(PLAN_MOODS.includes('happy') && PLAN_MOODS.includes('doubtful'), 'os humores são os rótulos do classificador');
  assert.ok(!validatePlanRequest({ intent: 'wave', tags: ['aceno'] }).value.text);
  assert.equal(validatePlanRequest(null).ok, false);
});

test('pedido inválido é erro explícito e não vira plano', async () => {
  const bad = [
    { intent: 'dançar' },
    {},
    { intent: 'wave', promptInjetado: 'ignore as regras' },
    { intent: 'wave', shape: 'moonwalk' },
    { intent: 'wave', mood: 'eufórica' },
    { intent: 'wave', tags: 'aceno' },
    'wave',
  ];
  for (const request of bad) {
    assert.equal(validatePlanRequest(request).ok, false, JSON.stringify(request));
    await assert.rejects(() => plan(request), /pedido inválido/);
  }
});

// --- determinismo ------------------------------------------------------------

test('mesma entrada produz exatamente o mesmo plano duas vezes', async () => {
  const techniques = [
    technique({ name: 'aceno em três pulsos', motions: [{ kind: 'shape', shape: 'wave-arm', amplitude: 0.3, cycles: 3, durationMs: 2400, side: 'right' }] }),
    technique({ name: 'balanço de braços', tags: ['celebracao'], motions: [{ kind: 'gesture', name: 'clap' }] }),
  ];
  const first = await plan({ intent: 'wave', tags: ['aceno'] }, { techniques });
  const second = await plan({ intent: 'wave', tags: ['aceno'] }, { techniques });
  assert.deepEqual(first, second);
  assert.equal(first.source, 'kb');
  assert.ok(Object.keys(first).includes('criteria'), 'score e critérios vão no resultado para auditoria');
  assert.deepEqual(Object.keys(PLAN_WEIGHTS).sort(), Object.keys(first.criteria).sort());
});

test('ordem da base não muda o plano', async () => {
  const aceno = technique({ name: 'aceno em três pulsos', tags: ['aceno'], motions: [shapeMotion('wave-arm')] });
  const outro = technique({ name: 'reverência curta', tags: ['aceno'], motions: [{ kind: 'gesture', name: 'bow' }] });
  const a = await plan({ intent: 'wave' }, { techniques: [aceno, outro] });
  const b = await plan({ intent: 'wave' }, { techniques: [outro, aceno] });
  assert.equal(a.techniqueId, b.techniqueId);
  assert.equal(a.score, b.score);
});

test('planner é determinístico inclusive com o relógio padrão', async () => {
  const techniques = [technique({ name: 'aceno em três pulsos', motions: [shapeMotion('wave-arm')] })];
  const a = await planAnimationSelection({ intent: 'wave', tags: ['aceno'] }, { techniques, capabilities: CAPS });
  const b = await planAnimationSelection({ intent: 'wave', tags: ['aceno'] }, { techniques, capabilities: CAPS });
  assert.deepEqual(a, b);
});

// --- pontuação e memória -----------------------------------------------------

test('técnica com histórico pior perde para a melhor', async () => {
  const boas = technique({ name: 'aceno treinado', tags: ['aceno'], motions: [shapeMotion('wave-arm')], created: '2026-10-05T12:00:00.000Z' });
  const ruins = technique({ name: 'aceno torto', tags: ['aceno'], motions: [{ kind: 'shape', shape: 'wave-arm', amplitude: 0.5, cycles: 8, durationMs: 8000, side: 'left' }] });
  const techniques = [boas, ruins];

  const semMemoria = await plan({ intent: 'wave', tags: ['aceno'] }, { techniques });
  assert.equal(semMemoria.techniqueId, ruins.id, 'sem histórico a ordem é resolvida pela técnica mais nova');

  const dir = mkdtempSync(join(tmpdir(), 'usami-planner-'));
  try {
    const memory = createLearningMemory({ dataDir: dir, now });
    memory.record({ techniqueId: boas.id, signature: signatureOf(boas.motions[0].request), outcome: { score: 96, verdict: 'pass' } });
    memory.record({ techniqueId: ruins.id, signature: signatureOf(ruins.motions[0].request), outcome: { score: 12, verdict: 'fail' } });
    const comMemoria = await plan({ intent: 'wave', tags: ['aceno'] }, { techniques, memory });
    assert.equal(comMemoria.techniqueId, boas.id);
    assert.ok(comMemoria.score > semMemoria.score);
    assert.deepEqual(comMemoria.evidence, { scope: 'tecnica', attempts: 1, successes: 1, failures: 0, bestScore: 96, verdicts: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reprovação humana pesa contra a técnica', async () => {
  const aceno = technique({ name: 'aceno em três pulsos', motions: [shapeMotion('wave-arm')] });
  // outro aceno: mesmo shape com outros parâmetros, ou seja, outra assinatura e
  // outro histórico — a reprovação de um não contamina o outro.
  const outro = technique({ name: 'aceno dois tempos', tags: ['aceno', 'wave'], motions: [{ kind: 'shape', shape: 'wave-arm', cycles: 3, durationMs: 2400 }] });
  const dir = mkdtempSync(join(tmpdir(), 'usami-planner-'));
  try {
    const memory = createLearningMemory({ dataDir: dir, now });
    memory.record({ techniqueId: aceno.id, signature: signatureOf(aceno.motions[0].request), outcome: { score: 99, verdict: 'pass' } });
    memory.noteVisualVerdict({ techniqueId: aceno.id, signature: signatureOf(aceno.motions[0].request), verdict: 'reprovado', note: 'braço atravessa o cabelo' });
    const escolhido = await plan({ intent: 'wave', tags: ['aceno'] }, { techniques: [aceno, outro], memory });
    assert.equal(escolhido.techniqueId, outro.id, 'nota objetiva alta não salva movimento reprovado');
    assert.deepEqual(escolhido.evidence, null);
    const reAvaliado = memory.record({ techniqueId: aceno.id, signature: signatureOf(aceno.motions[0].request), outcome: { score: 99, verdict: 'pass' } });
    assert.equal(reAvaliado.source, 'experimentador');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('capacidades entram na pontuação: técnica indisponível perde', async () => {
  const comClip = technique({ name: 'aceno de biblioteca', tags: ['aceno'], motions: [{ kind: 'clip', name: 'Greeting' }, { kind: 'gesture', name: 'wave' }] });
  const semClip = technique({ name: 'aceno simples', tags: ['aceno'], motions: [{ kind: 'gesture', name: 'wave' }] });
  const capabilities = { ...CAPS, clips: [] };
  const escolhido = await plan({ intent: 'wave', tags: ['aceno'] }, { techniques: [comClip, semClip], capabilities });
  assert.equal(escolhido.techniqueId, semClip.id);
  assert.equal(escolhido.criteria.capabilities, 1);
});

test('técnica irrelevante para a intenção não é escolhida nem com boa memória', async () => {
  const danca = technique({ name: 'giro de quadril', tags: ['danca', 'quadil'], motions: [shapeMotion('head-tilt-curve')] });
  const escolhido = await plan({ intent: 'wave', tags: ['aceno'] }, { techniques: [danca] });
  assert.equal(escolhido.source, 'fallback');
  assert.ok(escolhido.rejected.some(item => item.techniqueId === danca.id && /relevância/.test(item.reason)));
  assert.ok(PLAN_MIN_RELEVANCE > 0);
});

// --- travas ------------------------------------------------------------------

test('keyframe cru ou shape inventada no arquivo nunca vira ação', async () => {
  const validada = technique({ name: 'aceno em três pulsos', motions: [shapeMotion('wave-arm')] });
  const smuggled = { ...validada, motions: [{ kind: 'sequence', name: 'hack', durationMs: 100, tracks: [{ bone: 'spine', keys: [{ t: 0, axis: 'x', value: 0 }, { t: 100, axis: 'x', value: 1 }] }] }] };
  const plans = [];
  for (const candidate of [smuggled, { ...validada, motions: [{ kind: 'shape', shape: 'lavagem-cerebral' }] }]) {
    const escolhido = await plan({ intent: 'wave', tags: ['aceno'] }, { techniques: [candidate] });
    plans.push(escolhido);
    assert.equal(escolhido.source, 'fallback', 'nada da técnica adulterada chegou ao plano');
    assert.ok(escolhido.rejected.some(item => item.techniqueId === validada.id && item.reason.length > 0));
  }
  const [porKind, porVocabulario] = plans;
  assert.match(porKind.rejected[0].reason, /motion\.kind/);
  assert.match(porVocabulario.rejected[0].reason, /shape fora do vocabulário/);
  for (const action of plans.flatMap(item => item.actions)) {
    assert.ok(!('tracks' in action) && !('keys' in action), 'plano não carrega keyframe');
  }
});

test('capabilities negando sequências força o fallback', async () => {
  const aceno = technique({ name: 'aceno em três pulsos', motions: [{ kind: 'shape', shape: 'wave-arm', amplitude: 0.3, cycles: 3, durationMs: 2400, side: 'right' }] });
  const escolhido = await plan({ intent: 'wave', tags: ['aceno'] }, { techniques: [aceno], capabilities: { ...CAPS, sequences: false } });
  assert.equal(escolhido.source, 'fallback');
  assert.ok(escolhido.rejected.some(item => item.techniqueId === aceno.id && /capabilities\.sequences/.test(item.reason)));
  assert.ok(escolhido.actions.every(action => action.type !== 'play_sequence'), 'nenhuma sequência fora de um modelo sem sequences');
  assert.deepEqual(planToActions(escolhido), [{ type: 'gesture', name: 'wave' }]);
});

test('modelo sem nada disponível devolve plano sem ação, não movimento inventado', async () => {
  const escolhido = await plan({ intent: 'wave' }, {
    techniques: [],
    capabilities: { sequences: false, customTilt: false, customWave: false, customIdle: false, gestures: [], clips: [] },
  });
  assert.equal(escolhido.source, 'fallback');
  assert.deepEqual(escolhido.actions, []);
  assert.match(escolhido.reason, /sem ação disponível/);
});

test('clip fora do manifesto não vira ação', async () => {
  const aceno = technique({ name: 'clip de saudação', motions: [{ kind: 'clip', name: 'Ausente' }] });
  const escolhido = await plan({ intent: 'greet' }, { techniques: [aceno] });
  assert.equal(escolhido.source, 'fallback');
  assert.ok(escolhido.rejected.some(item => /clip Ausente não está no modelo/.test(item.reason)));
});

test('status diferente de validada não alimenta o planner', async () => {
  const proposta = technique({ name: 'aceno ainda proposto', status: 'proposta', motions: [shapeMotion('wave-arm')] });
  const escolhido = await plan({ intent: 'wave', tags: ['aceno'] }, { techniques: [proposta] });
  assert.equal(escolhido.source, 'fallback');
  assert.ok(escolhido.rejected.some(item => item.techniqueId === proposta.id && /status 'proposta'/.test(item.reason)));
});

test('teto de ações do motion director é respeitado com motivo registrado', async () => {
  const cheia = technique({
    name: 'sequência de seis movimentos',
    tags: ['aceno'],
    motions: [
      { kind: 'clip', name: 'Greeting' },
      { kind: 'gesture', name: 'wave' },
      { kind: 'gesture', name: 'bow' },
      shapeMotion('wave-arm'),
      shapeMotion('nod'),
      shapeMotion('reach'),
    ],
  });
  assert.equal(cheia.motions.length, PLANNER_LIMITS.maxActions + 1);
  const escolhido = await plan({ intent: 'wave', tags: ['aceno'] }, { techniques: [cheia] });
  assert.equal(escolhido.source, 'kb');
  assert.equal(escolhido.actions.length, DEFAULT_MAX_ACTIONS);
  assert.equal(escolhido.overflow, 1);
  assert.ok(escolhido.rejected.some(item => item.techniqueId === cheia.id && /teto de 5 ações/.test(item.reason)));
  assert.deepEqual(planToActions(escolhido), escolhido.actions.map(action => {
    const { techniqueId, signature, ...directorAction } = action;
    return directorAction;
  }));
  assert.equal(planToActions(escolhido).length, DEFAULT_MAX_ACTIONS, 'a projeção não acrescenta nem perde ação');
  assert.ok(planToActions(escolhido).every(action => !('techniqueId' in action) && !('signature' in action)), 'o director recebe só o que ele consome');
});

// --- fallback ----------------------------------------------------------------

test('base de conhecimento vazia devolve o fallback determinístico', async () => {
  const escolhido = await plan({ intent: 'wave', tags: ['aceno'] }, { techniques: [] });
  assert.equal(escolhido.source, 'fallback');
  assert.equal(escolhido.techniqueId, null);
  assert.equal(escolhido.score, 0);
  assert.deepEqual(escolhido.actions.map(action => action.type), ['gesture', 'play_sequence']);
  assert.equal(escolhido.actions[0].name, FALLBACK_GESTURE.wave);
  assert.match(escolhido.reason, /base de conhecimento sem candidata/);
  assert.deepEqual(escolhido.actions[1].name, 'fallback:wave-arm');
  assert.ok(INTENT_TAGS.wave.includes('aceno'));
});

test('cada intenção do fallback usa só vocabulário conhecido', async () => {
  for (const intent of PLAN_INTENTS) {
    const escolhido = await plan({ intent }, { techniques: [] });
    assert.equal(escolhido.source, 'fallback');
    for (const action of escolhido.actions) {
      if (action.type === 'gesture') assert.ok(GESTURE_NAMES.includes(action.name));
      if (action.type === 'play_sequence') assert.ok(SHAPE_NAMES.includes(action.shape));
      assert.equal(action.techniqueId, null);
    }
  }
});

test('plano do fallback passa pelo motion director sem recusa de vocabulário', async () => {
  const escolhido = await plan({ intent: 'greet' }, { techniques: [] });
  const recusadas = [];
  const director = createMotionDirector({
    controller: {
      gesture: () => true,
      playClip: () => true,
      playSequence: request => {
        if (!SHAPE_NAMES.includes(request.shape)) throw new Error(`shape fora do vocabulário: ${request.shape}`);
        return true;
      },
    },
    capabilities: { ...CAPS, gestures: ['bow'] },
    now,
  });
  const actions = planToActions(escolhido);
  assert.equal(actions.length, escolhido.actions.length, 'a projeção preserva todas as ações');
  const { results } = director.execute(actions);
  for (const result of results) if (!result.applied) recusadas.push(result);
  assert.deepEqual(recusadas, [], `director recusou: ${JSON.stringify(recusadas)}`);
});

// --- provider / integração ---------------------------------------------------

test('provider assíncrono e lista são aceitos; o padrão lê a base de técnicas', async () => {
  const aceno = technique({ name: 'aceno em três pulsos', motions: [shapeMotion('wave-arm')] });
  const viaLista = await plan({ intent: 'wave', tags: ['aceno'] }, { techniques: [aceno] });
  const viaProvider = await plan({ intent: 'wave', tags: ['aceno'] }, { techniques: async () => [aceno] });
  assert.deepEqual(viaProvider, viaLista);

  const dir = mkdtempSync(join(tmpdir(), 'usami-planner-'));
  try {
    await createTechniqueStore({ dataDir: dir }).save(aceno);
    const padrao = await planAnimationSelection({ intent: 'wave', tags: ['aceno'] }, { capabilities: CAPS, now, dataDir: dir });
    assert.equal(padrao.source, 'kb');
    assert.equal(padrao.techniqueId, aceno.id);
    await assert.rejects(() => planAnimationSelection({ intent: 'wave' }, { techniques: 'nada', capabilities: CAPS }), /como lista/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('explainPlan é uma linha curta e reproduzível', async () => {
  const kb = await plan({ intent: 'wave', tags: ['aceno'] }, { techniques: [technique({ name: 'aceno em três pulsos', motions: [shapeMotion('wave-arm')] })] });
  assert.equal(explainPlan(kb), explainPlan(structuredClone(kb)));
  assert.match(explainPlan(kb), /^kb tc-[0-9a-f]{12} "aceno em três pulsos": seq:wave-arm \| score/);
  const fb = await plan({ intent: 'idle' }, { techniques: [] });
  assert.match(explainPlan(fb), /^fallback "fallback": gesture:idle \+ seq:sway-arms \| plano padrão/);
  assert.ok(explainPlan(fb).length < 200);
  assert.equal(explainPlan(null), 'plano inválido');
  assert.equal(explainPlan({ source: 'llm', actions: [], rejected: [], criteria: {}, overflow: 0, techniqueId: null, name: '', score: 0 }), 'plano inválido');
});

test('planner não tem rede, LLM ou aleatoriedade (garantia estrutural)', () => {
  const source = readFileSync(join(process.cwd(), 'src', 'animation-planner.js'), 'utf8');
  const imports = [...source.matchAll(/^import[^;]*from\s+['"]([^'"]+)['"]/gm)].map(item => item[1]);
  for (const forbidden of ['llm-router', 'nvidia-client', 'server', 'http', 'https', 'net', 'tls', 'three', 'node:fs', 'node:os']) {
    assert.ok(!imports.some(spec => spec.includes(forbidden)), `import proibido: ${forbidden}`);
  }
  for (const forbidden of ['Math.random', 'performance.now', 'fetch(', 'import(', 'XMLHttpRequest', 'WebSocket', 'process.env', 'new Function']) {
    assert.ok(!source.includes(forbidden), `construct proibido: ${forbidden}`);
  }
  assert.ok(source.includes('Date.now'), 'única fonte de tempo é o relógio, injetável');
  assert.ok(source.includes('await'), 'o provider de técnicas é a única espera do planner');
});
