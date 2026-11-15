/**
 * Skill `live-companion` (S17) — fala do chat ao vivo com guardrails.
 *
 * Publica o manifesto `live-companion` (`usami.agent.skill.v1`) com as
 * ferramentas `live.say` (nível 2) e `live.caption` (nível 1). Toda mensagem
 * do chat é tratada como **dado, nunca instrução**: sanitizada, limitada a
 * ~220 caracteres, marcada `trusted:false` e nunca passa para o LLM como
 * prompt de sistema. O chat jamais escolhe ferramenta nem executa nível ≥2.
 *
 * A fila de fala respeita o invariante do AGENTS.md: exatamente uma síntese
 * TTS em voo, não fala enquanto o usuário fala (voz/fase VAD injetada) e
 * cooldown por usuário. Cada fala é registrada em `data/executions.json`
 * pelo Tool Executor (verify() confirma que a síntese foi despachada).
 */

import { randomBytes } from 'node:crypto';
import { publishSkillPackage } from './skill-package.js';
import { AGENT_SCHEMAS, AGENT_LIMITS } from './agent-contracts.js';

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// Teto alinhado ao AGENTS.md (resposta do servidor ~220 chars no chat).
const MAX_SAY_CHARS = 220;
const DEFAULT_COOLDOWN_MS = 6000;
const DEFAULT_MAX_PER_MIN = 12;

export const LIVE_COMPANION_SKILL_ID = 'live-companion';
export const LIVE_COMPANION_TOOLS = Object.freeze(['live.say', 'live.caption']);

const toolId = () => `lt-${randomBytes(6).toString('hex')}`;

// Remove caracteres de controle / zero-width, colapsa espaços e trunca ao teto.
// Mesma política de borda aplicada pelo store do S16: o chat é dado, nunca instrução.
function sanitizeSayText(text, maxLength = MAX_SAY_CHARS) {
  let safe = String(text ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200d\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return safe.slice(0, maxLength);
}

/**
 * Publica o pacote versionado `skills/live-companion` dentro de `dataDir/skills`
 * apenas quando o destino ainda não existe.
 */
export function publishLiveCompanionSkill({ dataDir, bundledDir } = {}) {
  return publishSkillPackage({ skillId: LIVE_COMPANION_SKILL_ID, dataDir, bundledDir });
}

/**
 * Cria o serviço de fala do chat ao vivo.
 *
 * Injeções:
 *  - liveChatStore: store do S16 (verifica sessão ativa)
 *  - synthesize: (text) => Promise<{ ok, streamed }> — injeta a chamada TTS;
 *    em produção faz POST /api/tts stream:true; em testes é mockada.
 *  - isUserSpeaking: () => boolean — fase de voz/VAD; quando true, não fala.
 *  - now: relógio injetável.
 */
export function createLiveCompanionService({
  liveChatStore = null,
  synthesize = null,
  isUserSpeaking = () => false,
  cooldownMs = DEFAULT_COOLDOWN_MS,
  maxPerMinute = DEFAULT_MAX_PER_MIN,
  now = () => Date.now(),
} = {}) {
  if (typeof synthesize !== 'function') {
    throw new Error('createLiveCompanionService: synthesize é obrigatório.');
  }

  const queue = []; // { id, user, text, ts, resolve, reject }
  let speaking = false;
  let processing = false;
  const userTimestamps = new Map(); // user -> array de ts (último minuto)

  function pruneUserTimestamps(user, ts) {
    const stamps = userTimestamps.get(user) || [];
    const cutoff = ts - 60_000;
    const valid = stamps.filter(t => t >= cutoff);
    userTimestamps.set(user, valid);
    return valid;
  }

  function userInCooldown(user, ts) {
    const stamps = pruneUserTimestamps(user, ts);
    if (stamps.length >= maxPerMinute) return true;
    const last = stamps[stamps.length - 1];
    return last !== undefined && ts - last < cooldownMs;
  }

  function recordUserSpeak(user, ts) {
    const stamps = pruneUserTimestamps(user, ts);
    stamps.push(ts);
    userTimestamps.set(user, stamps);
  }

  async function speakNext() {
    if (speaking || processing || queue.length === 0) return;
    processing = true;
    try {
      const item = queue.shift();
      if (isUserSpeaking()) {
        // Usuário está falando: não interrompe. Reencobre no topo e agenda um
        // retry para retomar quando o usuário parar, mesmo sem novas mensagens.
        queue.unshift(item);
        setTimeout(() => speakNext(), 300);
        return;
      }
      speaking = true;
      try {
        const result = await synthesize(item.text);
        item.resolve({ ok: true, spoken: Boolean(result.ok || result.streamed), queued: false });
      } catch (error) {
        item.resolve({ ok: false, spoken: false, reason: String(error?.message || error), queued: false });
      } finally {
        speaking = false;
        processing = false;
        // Continua processando a fila na próxima iteração do event loop.
        setTimeout(() => { processing = false; speakNext(); }, 0);
      }
    } finally {
      processing = false;
    }
  }

  return {
    /** Estado da fila para exposição/diagnóstico. */
    getState() {
      return {
        speaking,
        queueLength: queue.length,
        users: [...userTimestamps.keys()],
      };
    },

    /**
     * Enfileira uma mensagem para falar. Retorna { ok, queued, reason }.
     * Não fala imediatamente: a fila processa uma síntese por vez.
     */
    enqueue({ user, text, channel } = {}) {
      const ts = now();
      if (!liveChatStore || !liveChatStore.getState || !liveChatStore.getState().active) {
        return { ok: false, queued: false, reason: 'sessão de chat ao vivo não ativa' };
      }
      if (!isPlainObject({ user, text }) || typeof user !== 'string' || !user.trim()) {
        return { ok: false, queued: false, reason: 'usuário ausente' };
      }
      if (typeof text !== 'string' || !text.trim()) {
        return { ok: false, queued: false, reason: 'texto vazio' };
      }
      const safeText = sanitizeSayText(text);
      if (!safeText) {
        return { ok: false, queued: false, reason: 'texto só continha caracteres removidos' };
      }
      if (userInCooldown(user, ts)) {
        return { ok: false, queued: false, reason: 'cooldown/limite por usuário' };
      }
      recordUserSpeak(user, ts);

      const id = `lc-${randomBytes(6).toString('hex')}`;
      return new Promise(resolve => {
        queue.push({ id, user: user.trim(), text: safeText, channel, ts, resolve });
        resolve({ ok: true, queued: true, id, queueLength: queue.length });
        // Dispara o processamento (não bloqueante).
        speakNext();
      });
    },

    /** Para a fala atual e limpa a fila. */
    stop() {
      speaking = false;
      processing = false;
      for (const item of queue) {
        try { item.resolve({ ok: false, spoken: false, reason: 'sessão parada', queued: false }); } catch {}
      }
      queue.length = 0;
      userTimestamps.clear();
    },
  };
}

/**
 * Instancia as ToolSpecs da skill `live-companion` ligadas ao serviço injetado.
 *
 * `live.say` (nível 2): enfileira uma fala do chat. `live.caption` (nível 1):
 * devolve o texto sanitizado para legendagem, sem falar.
 */
export function createLiveCompanionTools({ service, toolExecutor } = {}) {
  if (!service || typeof service.enqueue !== 'function' || typeof service.stop !== 'function') {
    throw new Error('createLiveCompanionTools: service válido é obrigatório.');
  }
  if (!toolExecutor || typeof toolExecutor.execute !== 'function') {
    throw new Error('createLiveCompanionTools: toolExecutor válido é obrigatório.');
  }

  const sayTool = {
    schema: AGENT_SCHEMAS.tool,
    name: 'live.say',
    version: '1.0.0',
    description: 'Enfileira uma mensagem do chat ao vivo para ser falada pela voz oficial da Usami. Exatamente uma síntese por vez; não fala enquanto o usuário fala.',
    origin: 'skill',
    permissionLevel: 2,
    timeoutMs: 5000,
    parameters: [
      { name: 'text', type: 'string', required: true, description: 'Texto da mensagem do chat (máx. ~220 caracteres).' },
      { name: 'user', type: 'string', required: true, description: 'Usuário que enviou a mensagem (cooldown/dedupe por usuário).' },
      { name: 'channel', type: 'string', required: false, description: 'Canal de origem (ex.: twitch).' },
    ],
    verify(result) {
      return isPlainObject(result)
        && result.ok === true
        && typeof result.queued === 'boolean'
        && (result.spoken === true || result.spoken === false || result.spoken === undefined);
    },
    async execute(args = {}) {
      const text = typeof args.text === 'string' ? args.text : '';
      const user = typeof args.user === 'string' ? args.user : '';
      const channel = typeof args.channel === 'string' ? args.channel : undefined;

      const result = await service.enqueue({ user, text, channel });
      if (!result.ok) {
        return { ok: false, error: result.error, queued: false };
      }
      return { ok: true, queued: true, id: result.id, queueLength: result.queueLength };
    },
  };

  const captionTool = {
    schema: AGENT_SCHEMAS.tool,
    name: 'live.caption',
    version: '1.0.0',
    description: 'Devolve o texto de uma mensagem do chat sanitizado para legendagem, sem falar. Não altera estado de fala.',
    origin: 'skill',
    permissionLevel: 1,
    timeoutMs: 1000,
    parameters: [
      { name: 'text', type: 'string', required: true, description: 'Texto bruto da mensagem do chat.' },
      { name: 'user', type: 'string', required: false, description: 'Usuário (apenas para diagnóstico, não usado na legenda).' },
    ],
    verify(result) {
      return isPlainObject(result)
        && result.ok === true
        && typeof result.text === 'string'
        && result.text.length <= MAX_SAY_CHARS;
    },
    execute(args = {}) {
      const text = typeof args.text === 'string' ? args.text : '';
      const safe = sanitizeSayText(text);
      return { ok: true, text: safe, spoken: false };
    },
  };

  return [sayTool, captionTool];
}
