/**
 * Humor contínuo da Usami — um JSON por instalação em `data/mood.json`.
 *
 * Diferente da emoção pontual de cada balão (que dura ~4–5s no VRM), o humor
 * evolui com inércia ao longo da conversa e do tempo sem falar:
 *   - `valence` (0–100): bom humor / leveza vs frustração / melancolia
 *   - `energy`  (0–100): animação vs sonolência / quietude
 *   - `warmth`  (0–100): carinho / abertura vs guarda tsundere levantada
 *
 * Escrita atômica (tmp + rename, padrão do `bond-store.js`) e relógio
 * injetável (`now`) para testes determinísticos.
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXPRESSION_LABELS } from './emotion-map.js';

const MOOD_FILE = 'mood.json';
const MOOD_VERSION = 1;
const TIMELINE_LIMIT = 20;
const DECAY_HALF_LIFE_MS = 90 * 60 * 1000;
const SLEEPY_IDLE_MS = 25 * 60 * 1000;

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const clamp = (value, min = 0, max = 100) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return min;
  return Math.max(min, Math.min(max, Math.round(numeric)));
};

export const MOOD_PROFILES = Object.freeze({
  happy: {
    id: 'happy',
    label: 'Animada',
    expression: '02-prefab_happy02',
    vrmEmotion: 'happy',
    defaultReason: 'Está empolgada e cheia de energia com você.',
  },
  soft: {
    id: 'soft',
    label: 'Carinhosa',
    expression: '03-prefab_happy03',
    vrmEmotion: 'soft',
    defaultReason: 'Está derretida e gostando da sua companhia.',
  },
  tsundere: {
    id: 'tsundere',
    label: 'Implicante',
    expression: '15-prefab_awkward01',
    vrmEmotion: 'tsundere',
    defaultReason: 'Fingindo que não liga, mas observando tudo de perto.',
  },
  shy: {
    id: 'shy',
    label: 'Envergonhada',
    expression: '16-prefab_awkward02',
    vrmEmotion: 'shy',
    defaultReason: 'Ficou corada com o último momento.',
  },
  curious: {
    id: 'curious',
    label: 'Curiosa',
    expression: '19-prefab_doubt',
    vrmEmotion: 'doubtful',
    defaultReason: 'Prestando atenção nos detalhes do que você disse.',
  },
  sleepy: {
    id: 'sleepy',
    label: 'Sonolenta',
    expression: '12-prefab_sad01',
    vrmEmotion: 'sleepy',
    defaultReason: 'Ficou quietinha esperando você aparecer.',
  },
  grumpy: {
    id: 'grumpy',
    label: 'Emburrada',
    expression: '08-prefab_angry02',
    vrmEmotion: 'angry',
    defaultReason: 'Fez bico e quer um pouco de atenção sua.',
  },
  sad: {
    id: 'sad',
    label: 'Sensível',
    expression: '13-prefab_sad02',
    vrmEmotion: 'sad',
    defaultReason: 'Ficou um pouco mais quieta e emotiva.',
  },
  neutral: {
    id: 'neutral',
    label: 'Tranquila',
    expression: '01-prefab_happy01',
    vrmEmotion: 'neutral',
    defaultReason: 'Em paz por aqui, acompanhando o seu ritmo.',
  },
});

function expressionLabelFor(name) {
  return EXPRESSION_LABELS[name] || 'Expressiva';
}

export function normalizeEmotionKey(raw) {
  const tag = String(raw || '').trim().toLowerCase();
  if (!tag) return 'neutral';
  if (tag.includes('happy') || tag.includes('joy') || tag.includes('playful') || tag.includes('smile') || tag.includes('clap') || tag.includes('jump')) {
    return 'happy';
  }
  if (tag.includes('caring') || tag.includes('whisper') || tag.includes('soft') || tag.includes('love') || tag.includes('blush_soft')) {
    return 'soft';
  }
  if (tag.includes('shy') || tag.includes('awkward') || tag.includes('blush')) {
    return 'shy';
  }
  if (tag.includes('tsundere') || tag.includes('jealous')) {
    return 'tsundere';
  }
  if (tag.includes('angry') || tag.includes('frustrated') || tag.includes('grump')) {
    return 'angry';
  }
  if (tag.includes('sad') || tag.includes('sorrow')) {
    return 'sad';
  }
  if (tag.includes('sleep') || tag.includes('tired')) {
    return 'sleepy';
  }
  if (tag.includes('doubt') || tag.includes('think') || tag.includes('scratch') || tag.includes('surpris') || tag.includes('curious') || tag.includes('tilt')) {
    return 'curious';
  }
  return 'neutral';
}

function expressionTagFromActions(actions = []) {
  for (const action of Array.isArray(actions) ? actions : []) {
    if (!action || typeof action !== 'object') continue;
    if (action.type === 'set_expression' && typeof action.name === 'string') {
      const n = action.name.toLowerCase();
      if (n.includes('happy01') || n.includes('happy03')) return 'soft';
      if (n.includes('happy')) return 'happy';
      if (n.includes('awkward')) return 'shy';
      if (n.includes('angry')) return 'angry';
      if (n.includes('sad')) return 'sad';
      if (n.includes('doubt') || n.includes('startled') || n.includes('emoji')) return 'curious';
    }
    if ((action.type === 'gesture' || action.type === 'play_vrma') && typeof action.name === 'string') {
      const normalized = normalizeEmotionKey(action.name);
      if (normalized !== 'neutral') return normalized;
    }
  }
  return null;
}

function expressionNameFromActions(actions = []) {
  for (const action of Array.isArray(actions) ? actions : []) {
    if (action?.type === 'set_expression' && typeof action.name === 'string' && action.name.trim()) {
      return action.name.trim();
    }
  }
  return null;
}

export function deriveMood({ valence = 64, energy = 58, warmth = 56, lastEmotion = 'neutral' } = {}) {
  const v = clamp(valence);
  const e = clamp(energy);
  const w = clamp(warmth);
  const emo = normalizeEmotionKey(lastEmotion);

  if (emo === 'shy' && v >= 45 && w >= 50) return MOOD_PROFILES.shy;
  if (emo === 'sleepy' || e <= 28) return MOOD_PROFILES.sleepy;
  if (v <= 32 && e >= 50) return MOOD_PROFILES.grumpy;
  if (v <= 36) return MOOD_PROFILES.sad;
  if (emo === 'tsundere' || (w >= 40 && w <= 62 && v >= 42 && v <= 70 && emo === 'angry')) {
    return MOOD_PROFILES.tsundere;
  }
  if (w >= 72 && v >= 62 && e < 76) return MOOD_PROFILES.soft;
  if (v >= 70 && e >= 64) return MOOD_PROFILES.happy;
  if (emo === 'soft' && w >= 54 && v >= 54) return MOOD_PROFILES.soft;
  if (emo === 'curious' && e >= 42) return MOOD_PROFILES.curious;
  if (w >= 64 && v >= 56) return MOOD_PROFILES.soft;
  if (emo === 'angry') return MOOD_PROFILES.tsundere;
  return MOOD_PROFILES.neutral;
}

function baselineForAffinity(affinity = 0) {
  const score = clamp(affinity);
  return {
    valence: clamp(58 + Math.round(score * 0.14)),
    energy: 56,
    warmth: clamp(46 + Math.round(score * 0.3)),
  };
}

function applyDecay(meters, updatedAtMs, currentMs, affinity = 0) {
  const base = baselineForAffinity(affinity);
  const elapsed = Math.max(0, currentMs - (Number(updatedAtMs) || currentMs));
  if (elapsed < 60_000) {
    return { ...meters };
  }
  const factor = Math.pow(0.5, elapsed / DECAY_HALF_LIFE_MS);
  let energy = Math.round(base.energy + (meters.energy - base.energy) * factor);
  if (elapsed >= SLEEPY_IDLE_MS) {
    // Silêncio prolongado reduz a energia aos poucos, puxando para "Sonolenta".
    const idleDrop = Math.min(42, Math.round(((elapsed - SLEEPY_IDLE_MS) / (45 * 60 * 1000)) * 30) + 12);
    energy = Math.max(18, energy - idleDrop);
  }
  return {
    valence: Math.round(base.valence + (meters.valence - base.valence) * factor),
    energy,
    warmth: Math.round(base.warmth + (meters.warmth - base.warmth) * factor),
  };
}

function sanitizeTimeline(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter(item => isPlainObject(item) && typeof item.id === 'string' && typeof item.label === 'string')
    .slice(0, TIMELINE_LIMIT)
    .map(item => ({
      id: item.id,
      label: item.label,
      emotion: typeof item.emotion === 'string' ? item.emotion : item.id,
      reason: typeof item.reason === 'string' ? item.reason : '',
      at: Number.isFinite(Number(item.at)) ? Number(item.at) : Date.now(),
    }));
}

export function createMoodStore({ dataDir, now = () => Date.now() } = {}) {
  if (!dataDir || typeof dataDir !== 'string') {
    throw new Error('createMoodStore: dataDir é obrigatório.');
  }
  const filePath = join(dataDir, MOOD_FILE);

  const defaultData = () => ({
    version: MOOD_VERSION,
    valence: 64,
    energy: 58,
    warmth: 58,
    lastEmotion: 'soft',
    lastExpression: MOOD_PROFILES.soft.expression,
    reason: MOOD_PROFILES.soft.defaultReason,
    timeline: [],
    updatedAt: now(),
  });

  function normalize(input) {
    const base = defaultData();
    if (!isPlainObject(input)) return base;
    return {
      version: MOOD_VERSION,
      valence: clamp(input.valence ?? base.valence),
      energy: clamp(input.energy ?? base.energy),
      warmth: clamp(input.warmth ?? base.warmth),
      lastEmotion: typeof input.lastEmotion === 'string' && input.lastEmotion.trim() ? input.lastEmotion.trim() : base.lastEmotion,
      lastExpression: typeof input.lastExpression === 'string' && input.lastExpression.trim() ? input.lastExpression.trim() : base.lastExpression,
      reason: typeof input.reason === 'string' && input.reason.trim() ? input.reason.trim() : base.reason,
      timeline: sanitizeTimeline(input.timeline),
      updatedAt: Number.isFinite(Number(input.updatedAt)) ? Number(input.updatedAt) : base.updatedAt,
    };
  }

  let data = defaultData();

  function persist() {
    mkdirSync(dataDir, { recursive: true });
    data.updatedAt = now();
    const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temporary, JSON.stringify(data, null, 2), 'utf8');
    try {
      renameSync(temporary, filePath);
    } catch (error) {
      try { unlinkSync(temporary); } catch {}
      if (error?.code !== 'EEXIST' && error?.code !== 'EPERM') throw error;
    }
    return data;
  }

  function snapshot(affinity = 0) {
    const currentMs = now();
    const elapsed = Math.max(0, currentMs - (Number(data.updatedAt) || currentMs));
    const meters = applyDecay(
      { valence: data.valence, energy: data.energy, warmth: data.warmth },
      data.updatedAt,
      currentMs,
      affinity,
    );
    const effectiveEmotion = elapsed >= SLEEPY_IDLE_MS && meters.energy <= 28
      ? 'sleepy'
      : data.lastEmotion;
    const profile = deriveMood({ ...meters, lastEmotion: effectiveEmotion });
    const expressionName = effectiveEmotion === 'sleepy' && data.lastEmotion !== 'sleepy'
      ? MOOD_PROFILES.sleepy.expression
      : (data.lastExpression || profile.expression);
    const reason = elapsed >= SLEEPY_IDLE_MS && profile.id === 'sleepy'
      ? MOOD_PROFILES.sleepy.defaultReason
      : (data.reason || profile.defaultReason);

    return {
      id: profile.id,
      label: profile.label,
      vrmEmotion: profile.vrmEmotion,
      reason,
      meters,
      expression: {
        name: expressionName,
        label: expressionLabelFor(expressionName),
      },
      timeline: data.timeline.map(item => ({ ...item })),
      updatedAt: new Date(data.updatedAt).toISOString(),
    };
  }

  function pushTimeline(profile, emotion, reason, at) {
    const prev = data.timeline[0];
    if (prev && prev.id === profile.id && prev.reason === reason && at - prev.at < 30_000) {
      return;
    }
    data.timeline = [
      { id: profile.id, label: profile.label, emotion, reason, at },
      ...data.timeline,
    ].slice(0, TIMELINE_LIMIT);
  }

  function applySignal({ signal, expressionName, reason, affinity = 0 }) {
    const currentMs = now();
    const decayed = applyDecay(
      { valence: data.valence, energy: data.energy, warmth: data.warmth },
      data.updatedAt,
      currentMs,
      affinity,
    );
    let { valence, energy, warmth } = decayed;

    const deltas = {
      happy: { valence: 10, energy: 12, warmth: 5 },
      soft: { valence: 8, energy: 3, warmth: 11 },
      shy: { valence: 5, energy: 6, warmth: 9 },
      tsundere: { valence: -3, energy: 8, warmth: -4 },
      angry: { valence: -14, energy: 10, warmth: -10 },
      sad: { valence: -14, energy: -10, warmth: 2 },
      sleepy: { valence: -2, energy: -16, warmth: 2 },
      curious: { valence: 3, energy: 7, warmth: 3 },
      neutral: { valence: 2, energy: 4, warmth: 2 },
    }[signal] || { valence: 2, energy: 4, warmth: 2 };

    valence = clamp(valence + deltas.valence);
    energy = clamp(energy + deltas.energy);
    warmth = clamp(warmth + deltas.warmth);

    const profile = deriveMood({ valence, energy, warmth, lastEmotion: signal });
    const resolvedReason = (typeof reason === 'string' && reason.trim())
      ? reason.trim()
      : profile.defaultReason;

    data.valence = valence;
    data.energy = energy;
    data.warmth = warmth;
    data.lastEmotion = signal;
    data.lastExpression = expressionName || profile.expression;
    data.reason = resolvedReason;
    pushTimeline(profile, signal, resolvedReason, currentMs);
    persist();
    return snapshot(affinity);
  }

  return {
    load() {
      mkdirSync(dataDir, { recursive: true });
      try {
        data = normalize(JSON.parse(readFileSync(filePath, 'utf8')));
      } catch (error) {
        data = defaultData();
        if (error?.code === 'ENOENT') persist();
      }
      return snapshot();
    },

    getAll(affinity = 0) {
      return snapshot(affinity);
    },

    recordChatTurn({ userMessage = '', reply = '', gesture = '', actions = [], speechTags = [], emotion = '', affinity = 0 } = {}) {
      const actionEmotion = expressionTagFromActions(actions);
      const speechEmotion = Array.isArray(speechTags) && speechTags.length
        ? normalizeEmotionKey(speechTags[0])
        : null;
      const gestureEmotion = normalizeEmotionKey(gesture);
      const userEmotion = normalizeEmotionKey(emotion);
      const replyLower = String(reply || '').toLowerCase();
      const userLower = String(userMessage || '').toLowerCase();

      let signal = actionEmotion
        || (speechEmotion && speechEmotion !== 'neutral' ? speechEmotion : null)
        || (gestureEmotion !== 'neutral' ? gestureEmotion : null);

      if (!signal) {
        if (/b-?baka|hmph|idiota|chato|n-não é/i.test(replyLower)) signal = 'tsundere';
        else if (/obrigad|ador|amo|carinh|fofo|saudade|feliz/i.test(`${replyLower} ${userLower}`)) signal = 'soft';
        else if (/haha|kkkk|eba|legal|demais|uau/i.test(replyLower)) signal = 'happy';
        else if (userEmotion !== 'neutral') signal = userEmotion;
        else signal = 'neutral';
      }

      const explicitExpr = expressionNameFromActions(actions);
      const reasonBySignal = {
        happy: 'Ficou animada com a conversa agora há pouco.',
        soft: 'Sentiu carinho e ficou mais à vontade com você.',
        shy: 'Ficou sem graça com o que vocês conversaram.',
        tsundere: 'Tentou manter a pose tsundere durante a conversa.',
        angry: 'Ficou meio brava e fazendo bico na resposta.',
        sad: 'Ficou mais sensível com o assunto da conversa.',
        sleepy: 'Respondeu com um toque de sonolência.',
        curious: 'Ficou curiosa tentando entender melhor o que você disse.',
        neutral: 'Conversando tranquila no ritmo de sempre.',
      };

      return applySignal({
        signal,
        expressionName: explicitExpr,
        reason: reasonBySignal[signal],
        affinity,
      });
    },

    recordEvent({ emotion = 'neutral', gesture = '', reason = '', affinity = 0 } = {}) {
      const normalized = normalizeEmotionKey(emotion || gesture);
      const signal = normalized === 'neutral' && gesture ? normalizeEmotionKey(gesture) : normalized;
      const profile = deriveMood({
        valence: data.valence,
        energy: data.energy,
        warmth: data.warmth,
        lastEmotion: signal,
      });
      return applySignal({
        signal,
        expressionName: profile.expression,
        reason,
        affinity,
      });
    },

    reset(affinity = 0) {
      data = defaultData();
      persist();
      return snapshot(affinity);
    },
  };
}
