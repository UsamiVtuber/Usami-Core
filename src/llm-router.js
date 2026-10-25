// Roteador de LLMs NVIDIA por função.
//
// Três modelos configuráveis (via .env ou process.env):
//
//   NVIDIA_CLASSIFICATION_MODEL  — classifica frase do usuário (emoção/FACS)
//   NVIDIA_GENERATION_MODEL      — gera a resposta de texto da Usami
//   NVIDIA_ANIMATION_MODEL       — planeja ações de animação (gestos/clips)
//
// Todas compartilham o mesmo rate limiter global de 40 req/min
// (nvidia-client.sharedRateLimiter).
//
// Fallback: se a NVIDIA não estiver configurada ou falhar, a classificação
// cai para o classificador determinístico existente (emotion-classifier) e
// a geração cai para o fluxo OpenRouter atual do server.mjs.

import { classifyEmotion } from './emotion-classifier.js';
import { sharedClient, sharedRateLimiter } from './nvidia-client.js';

const DEFAULT_CLASSIFICATION_MODEL = 'nvidia/nemotron-3-ultra-550b-a55b';
const DEFAULT_GENERATION_MODEL = 'nvidia/nemotron-3-ultra-550b-a55b';
const DEFAULT_ANIMATION_MODEL = 'nvidia/nemotron-3-ultra-550b-a55b';

function envOr(name, fallback) {
  return process.env[name] || fallback;
}

const CLASSIFICATION_MODEL = envOr('NVIDIA_CLASSIFICATION_MODEL', DEFAULT_CLASSIFICATION_MODEL);
const GENERATION_MODEL = envOr('NVIDIA_GENERATION_MODEL', DEFAULT_GENERATION_MODEL);
const ANIMATION_MODEL = envOr('NVIDIA_ANIMATION_MODEL', DEFAULT_ANIMATION_MODEL);

// Prompt do classificador: devolve JSON com emoção + AUs FACS + confiança.
const CLASSIFICATION_SYSTEM = `Você é um classificador de emoção e expressão facial para um avatar virtual (VRM "Shiro").
Analise a frase do USUÁRIO e devolva SOMENTE JSON:
{"emotion":"neutral|happy|shy|sad|soft|angry|surprised|doubtful","confidence":0.0 a 1.0,"facs":["AU6","AU12",...],"intensity":0.0 a 1.0}

AUs FACS disponíveis: AU1(sobrancelha interna), AU2(sobrancelha externa), AU4(sobrancelha abaixada), AU5(olhos abertos), AU6(bochecha), AU9(nariz), AU12(sorriso), AU15(boca abaixada), AU20(boca esticada), AU24(lábios apertados), AU25(lábios separados), AU26(mandíbula aberta), AU43(olhos fechados), AU45(piscar).

Seja curto e determinístico. Não invente AUs que não estejam claros na frase.`;

// Prompt de geração de texto: a Usami responde em JSON (mesmo esquema do hoje).
const GENERATION_SYSTEM = `Você é Usami, uma companion acolhedora, curiosa e natural. Responda em português de forma breve. Não incentive dependência emocional ou exclusividade. Responda SOMENTE JSON: {"reply":"resposta","gesture":"neutral" ou "tilt"}`;

// Prompt de animação: dada a resposta da Usami e as capacidades do avatar, planeja ações.
const ANIMATION_SYSTEM = `Você é um diretor de animação para um avatar VRM (Shiro).
Dada a resposta de texto da Usami e a lista de capacidades do avatar, devolva SOMENTE JSON com ações para o avatar:
{"actions":[{"type":"gesture","name":"tilt" ou "wave" ou "idle" ou "clap" ou "hand-on-hip" ou "wave2" ou "point" ou "shrug" ou "head-scratch" ou "arms-crossed" ou "facepalm" ou "cheer" ou "blow-kiss" ou "hands-on-cheeks" ou "bow","delayMs":0},{"type":"play_clip","name":"Nome do clip","delayMs":0},{"type":"set_morph","name":"Nome do morph","value":0 a 1,"delayMs":0},{"type":"set_mesh_visible","name":"mesh","visible":true,"delayMs":0},{"type":"set_expression","name":"expressao","weight":0 a 1,"delayMs":0}]}

Gestos: clap=bater palmas, hand-on-hip=mão na cintura, wave2=aceno com as duas mãos, point=apontar, shrug=dar de ombros, head-scratch=coçar a cabeça, arms-crossed=braços cruzados, facepalm=mão no rosto, cheer=comemorar, blow-kiss=jogar beijo, hands-on-cheeks=mãos nas bochechas, bow=reverência. wave/tilt/idle são os discretos. Use o gesto que combina com o texto; prefira um só gesto por resposta.

Cada ação pode ter delayMs (ms após o início da fala) para sincronizar com o áudio. No máximo 5 ações. Se não houver ação adequada, actions: []`;

// --- Classificação (frase do usuário) -------------------------------------

export async function classifyUserMessage(text, { classifier = classifyEmotion } = {}) {
  // Se não houver chave NVIDIA configurada, usa o classificador determinístico local.
  if (!process.env.NVIDIA_API_KEY) {
    const result = classifier(text) || { label: 'neutral', intensity: 0, confidence: 0 };
    return {
      emotion: result.label,
      confidence: result.confidence,
      intensity: result.intensity,
      facs: emotionToFacs(result.label),
      source: 'local-deterministic',
    };
  }

  const messages = [
    { role: 'system', content: CLASSIFICATION_SYSTEM },
    { role: 'user', content: text },
  ];
  try {
    const raw = await sharedClient.chatText({
      model: CLASSIFICATION_MODEL,
      messages,
      temperature: 0.2,
      max_tokens: 200,
    });
    const parsed = parseJsonSafe(raw);
    return {
      emotion: parsed.emotion || 'neutral',
      confidence: Number.isFinite(parsed.confidence) ? Math.min(1, Math.max(0, parsed.confidence)) : 0,
      intensity: Number.isFinite(parsed.intensity) ? Math.min(1, Math.max(0, parsed.intensity)) : 0,
      facs: Array.isArray(parsed.facs) ? parsed.facs : emotionToFacs(parsed.emotion || 'neutral'),
      source: 'nvidia',
    };
  } catch (error) {
    console.warn('NVIDIA classification falhou, fallback local:', error.message);
    const result = classifier(text) || { label: 'neutral', intensity: 0, confidence: 0 };
    return {
      emotion: result.label,
      confidence: result.confidence,
      intensity: result.intensity,
      facs: emotionToFacs(result.label),
      source: 'local-deterministic-fallback',
    };
  }
}

// --- Geração de texto (resposta da Usami) ---------------------------------

export async function generateReply(systemPrompt, userMessage, { temperature = 0.7 } = {}) {
  if (!process.env.NVIDIA_API_KEY) throw new Error('NVIDIA_API_KEY não configurada');

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage },
  ];
  const raw = await sharedClient.chatText({
    model: GENERATION_MODEL,
    messages,
    temperature,
    max_tokens: 320,
  });
  return raw;
}

// --- Animação (planeja ações com base na resposta) -------------------------

export async function planAnimation(reply, capabilities, { temperature = 0.3 } = {}) {
  if (!process.env.NVIDIA_API_KEY) return { actions: [], source: 'no-nvidia-key' };

  const capsSummary = capabilities ? JSON.stringify(capabilities) : '{}';
  const messages = [
    { role: 'system', content: ANIMATION_SYSTEM },
    { role: 'user', content: `Resposta da Usami: "${reply}"\nCapacidades do avatar: ${capsSummary}` },
  ];
  try {
    const raw = await sharedClient.chatText({
      model: ANIMATION_MODEL,
      messages,
      temperature,
      max_tokens: 300,
    });
    const parsed = parseJsonSafe(raw);
    const actions = Array.isArray(parsed.actions) ? parsed.actions : [];
    return { actions, source: 'nvidia' };
  } catch (error) {
    console.warn('NVIDIA animation falhou:', error.message);
    return { actions: [], source: 'nvidia-fallback' };
  }
}

// --- Utilitários -----------------------------------------------------------

async function keyExists() {
  try {
    await sharedClient.chatText({ model: CLASSIFICATION_MODEL, messages: [{ role: 'user', content: 'test' }], max_tokens: 1 });
    return true;
  } catch {
    return false;
  }
}

function parseJsonSafe(raw) {
  try {
    const cleaned = String(raw ?? '').replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
    return JSON.parse(cleaned);
  } catch {
    return {};
  }
}

function emotionToFacs(label) {
  const map = {
    neutral: [],
    happy: ['AU6', 'AU12'],
    shy: ['AU1', 'AU15', 'AU25'],
    sad: ['AU1', 'AU4', 'AU15'],
    soft: ['AU6', 'AU12'],
    angry: ['AU4', 'AU24'],
    surprised: ['AU1', 'AU2', 'AU5', 'AU25', 'AU26'],
    doubtful: ['AU4', 'AU1', 'AU25'],
  };
  return map[label] || [];
}
