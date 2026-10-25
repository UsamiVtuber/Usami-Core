// Fase 1: contratos de produção de sequências — o vocabulário que o LLM usa
// para desenhar movimento novo, e as aspas que o servidor/director impõem.
//
// O espaço de ações é deliberadamente pequeno: um punhado de formas paramétricas
// (aceno, balanço, inclinação, curva de cabeça...) que o LLM compõe com
// amplitude/velocidade/suavidade, em vez de escrever 40 keyframes numéricos
// (alucinação fácil). O servidor expande a forma em keyframes determinísticos;
// o motor de experimentação (Fase 2) os avalia; o runner os executa.
//
// Nunca aceite keys numéricas vindas do LLM diretamente — só shapes+params.

import { SEQUENCE_LIMITS } from './motion-sequence.js';

export const SHAPE_NAMES = ['wave-arm', 'sway-arms', 'nod', 'head-tilt-curve', 'reach', 'shiver'];

const TAU = Math.PI * 2;

// easing de cosseno 0..1 (mesma curva do sampleTrack)
const easeInOut = t => (1 - Math.cos(Math.PI * Math.min(1, Math.max(0, t)))) / 2;

function sineTrack({ bone, axis, amplitude, cycles, durationMs, phase = 0, attack = 0.2, release = 0.2, steps = 8 }) {
  // amostra no mínimo 4 pontos por ciclo, respeitando o teto de keyframes
  const sampleSteps = Math.min(SEQUENCE_LIMITS.maxKeys - 1, Math.max(steps, cycles * 4));
  const keys = [];
  for (let i = 0; i <= sampleSteps; i++) {
    const progress = i / sampleSteps;
    // envelope senoidal suave: fade-in no primeiro `attack`, fade-out no último `release`
    let env = 1;
    if (progress < attack) env = easeInOut(progress / attack);
    else if (progress > 1 - release) env = easeInOut((1 - progress) / release);
    keys.push({
      t: Math.round(progress * durationMs),
      axis,
      value: Number((Math.sin(TAU * cycles * progress + phase) * amplitude * env).toFixed(4)),
    });
  }
  return { bone, keys };
}

// Expande um pedido de shape em sequência de keyframes validável. Cada shape é
// uma função pura (params → tracks); nada aqui toca o avatar.
const SHAPE_BUILDERS = {
  // Aceno clássico: braço levantado (offset estático) + mão oscilando.
  'wave-arm': ({ amplitude = 0.3, cycles = 3, durationMs = 2400, side = 'right' }) => {
    const arm = `${side}UpperArm`;
    const hand = `${side}Hand`;
    return [
      { bone: arm, keys: [{ t: 0, axis: 'z', value: 0 }, { t: Math.round(durationMs * 0.18), axis: 'z', value: -0.9 }, { t: Math.round(durationMs * 0.8), axis: 'z', value: -0.9 }, { t: durationMs, axis: 'z', value: 0 }] },
      sineTrack({ bone: hand, axis: 'z', amplitude, cycles, durationMs, attack: 0.2, release: 0.25 }),
    ];
  },
  // Os dois braços balançam (celebra contida, tremida de frio...).
  'sway-arms': ({ amplitude = 0.18, cycles = 4, durationMs = 2000 }) => [
    sineTrack({ bone: 'leftUpperArm', axis: 'z', amplitude, cycles, durationMs, phase: 0 }),
    sineTrack({ bone: 'rightUpperArm', axis: 'z', amplitude, cycles, durationMs, phase: Math.PI }),
  ],
  // Aceno de "sim": cabeça via layer (head não é controlável aqui) — o nod usa neck.x.
  'nod': ({ amplitude = 0.12, cycles = 2, durationMs = 1200 }) => [
    sineTrack({ bone: 'neck', axis: 'x', amplitude, cycles, durationMs }),
    sineTrack({ bone: 'spine', axis: 'x', amplitude: amplitude * 0.35, cycles, durationMs, phase: 0.4 }),
  ],
  // Curva lateral de quadril+ombros (insinuação/desconfiança corporal).
  'head-tilt-curve': ({ amplitude = 0.1, cycles = 1, durationMs = 1600 }) => [
    sineTrack({ bone: 'hips', axis: 'z', amplitude, cycles, durationMs }),
    sineTrack({ bone: 'leftShoulder', axis: 'z', amplitude: -amplitude * 0.6, cycles, durationMs }),
    sineTrack({ bone: 'rightShoulder', axis: 'z', amplitude: -amplitude * 0.6, cycles, durationMs }),
  ],
  // Estender a mão à frente (alcançar algo).
  'reach': ({ amplitude = 0.35, durationMs = 1600, side = 'right' }) => [
    { bone: `${side}UpperArm`, keys: [{ t: 0, axis: 'x', value: 0 }, { t: Math.round(durationMs * 0.45), axis: 'x', value: -amplitude }, { t: Math.round(durationMs * 0.7), axis: 'x', value: -amplitude }, { t: durationMs, axis: 'x', value: 0 }] },
    { bone: `${side}LowerArm`, keys: [{ t: 0, axis: 'x', value: 0 }, { t: Math.round(durationMs * 0.45), axis: 'x', value: -amplitude * 0.6 }, { t: Math.round(durationMs * 0.7), axis: 'x', value: -amplitude * 0.6 }, { t: durationMs, axis: 'x', value: 0 }] },
  ],
  // Tremor rápido e curto (frio/medo cômico).
  'shiver': ({ amplitude = 0.05, durationMs = 900 }) => [
    sineTrack({ bone: 'leftShoulder', axis: 'z', amplitude, cycles: 8, durationMs, release: 0.3, steps: 16 }),
    sineTrack({ bone: 'rightShoulder', axis: 'z', amplitude, cycles: 8, durationMs, release: 0.3, phase: 0.5, steps: 16 }),
  ],
};

// Normaliza e limita parâmetros antes de expandir (defesa contra números
// absurdos vindos do LLM; os clamps daqui são a política, não sugestão).
export function buildSequenceRequest(request) {
  const shape = typeof request?.shape === 'string' ? request.shape : '';
  if (!SHAPE_BUILDERS[shape]) return { ok: false, errors: [`shape desconhecida: ${JSON.stringify(shape)}`] };
  const durationMs = Math.min(8000, Math.max(600, Math.round(Number(request?.durationMs) || 2000)));
  const amplitude = Math.min(0.5, Math.max(0.02, Number(request?.amplitude) || 0.2));
  const cycles = Math.min(8, Math.max(1, Math.round(Number(request?.cycles) || 2)));
  const side = request?.side === 'left' ? 'left' : 'right';
  try {
    const tracks = SHAPE_BUILDERS[shape]({ durationMs, amplitude, cycles, side });
    const name = typeof request?.name === 'string' ? request.name.slice(0, 60) : `${shape}`;
    return { ok: true, sequence: { name, durationMs, tracks } };
  } catch (error) {
    return { ok: false, errors: [`falha ao expandir shape: ${error.message}`] };
  }
}

// Parâmetros que cada shape aceita (nomes e resumo para o prompt). O motor de
// experimentação usa `names` para varrer grade sem duplicar o conhecimento.
export const SHAPE_PARAMS = Object.freeze({
  'wave-arm': { names: ['amplitude', 'cycles', 'durationMs', 'side'], hint: 'amplitude 0.02-0.5, cycles 1-8, durationMs 600-8000, side left|right' },
  'sway-arms': { names: ['amplitude', 'cycles', 'durationMs'], hint: 'amplitude, cycles, durationMs' },
  nod: { names: ['amplitude', 'cycles', 'durationMs'], hint: 'amplitude, cycles, durationMs' },
  'head-tilt-curve': { names: ['amplitude', 'cycles', 'durationMs'], hint: 'amplitude, cycles, durationMs' },
  reach: { names: ['amplitude', 'durationMs', 'side'], hint: 'amplitude, durationMs, side' },
  shiver: { names: ['amplitude', 'durationMs'], hint: 'amplitude, durationMs' },
});

// Vocabulário compacto para o prompt do sistema (o LLM nunca precisa saber os
// limites internos; buildSequenceRequest impõe).
export const SHAPE_CATALOG = SHAPE_NAMES.map(shape => `${shape} (${SHAPE_PARAMS[shape].hint})`).join('; ');
