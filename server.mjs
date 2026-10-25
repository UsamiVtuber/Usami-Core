import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createFileTtsCache, createTtsCacheKey } from './src/tts-cache.js';
import { removeTempAudio, saveTempAudio, transcribeAudio } from './src/stt.js';
import { buildPersona, getAffinityStage } from './src/persona.js';
import { createMemoryStore } from './src/memory-store.js';
import { calculateGain, applyGain, getStage, DAILY_CAP } from './src/affinity.js';
import { buildServices } from './src/flow-services.js';
import { createFlowExecutor } from './src/flow-executor.js';
import { classifyEmotion, DEFAULT_CONFIDENCE_THRESHOLD } from './src/emotion-classifier.js';
import { createEmotionEngine } from './src/emotion-engine.js';
import { createExpressionDriver } from './src/expression-driver.js';
import { createVrmGestureLayer } from './src/vrm-gesture-layer.js';
import { classifyUserMessage, generateReply, planAnimation } from './src/llm-router.js';

export const DEFAULT_MODEL = process.env.OPENROUTER_MODEL || 'nvidia/nemotron-3-ultra-550b-a55b:free';
export const USE_NVIDIA = process.env.USE_NVIDIA !== 'false' && Boolean(process.env.NVIDIA_API_KEY || nvidiaKeyConfigured());

// Verifica se a chave NVIDIA está configurada (env ou A:\.env), sem fazer chamada de API.
function nvidiaKeyConfigured() {
  if (process.env.NVIDIA_API_KEY) return true;
  try {
    const text = readFileSync('A:\\.env', 'utf8');
    return /^NVIDIA_API_KEY\s*=/m.test(text);
  } catch {
    return false;
  }
}

const DEFAULT_SYSTEM = 'Você é Usami, uma companion acolhedora, curiosa e natural. Responda em português de forma breve. Não incentive dependência emocional ou exclusividade. Responda SOMENTE JSON: {"reply":"resposta","gesture":"neutral" ou "tilt","actions":[{"type":"gesture","name":"tilt" ou "wave" ou "idle"},{"type":"play_clip","name":"Nome do clip"},{"type":"set_morph","name":"Nome do morph","value":0 a 1},{"type":"set_mesh_visible","name":"Nome de mesh acessório","visible":true ou false}]}. Actions é opcional e pode ser vazio; no máximo 5 ações.'.trim();

const DEFAULT_ALLOWED_ORIGINS = ['http://127.0.0.1:5173', 'http://localhost:5173'];

const DIRECTOR_VERBS = ['play_clip', 'gesture', 'set_morph', 'set_mesh_visible', 'set_expression'];
export const SPEECH_TRIGGERS = ['start', 'middle', 'end'];

// Heurística do "remember": sinais de fato duradouro → núcleo; o resto é recente.
const DURABLE_FACT = /\b(anivers[áa]rio|gosta|tem|nome)\b|\b\d{1,2}\/\d{1,2}\b/i;

// Fila de comandos vindos do n8n (n8n → Usami). O cliente (Usami.jsx) consome
// via GET /api/n8n/commands e aplica no avatar localmente (gesto, expressão,
// morph, visibilidade de mesh). O servidor não tem acesso direto ao avatar do
// navegador, então a fila é o ponto de integração.
const n8nCommandQueue = [];

// Comando válido para controle direto do avatar (executado pelo cliente).
const VALID_COMMAND_TYPES = new Set([
  'say',           // diz algo (usa /api/chat internamente)
  'gesture',       // gesture: tilt | wave | idle
  'set_expression',// expressão VRM com peso
  'set_morph',     // morph target com valor
  'set_mesh_visible',// mostra/esconde mesh acessório
]);

function isValidN8nCommand(cmd) {
  if (!cmd || typeof cmd !== 'object' || Array.isArray(cmd)) return false;
  if (!VALID_COMMAND_TYPES.has(cmd.type)) return false;
  if (cmd.type === 'say' && typeof cmd.message !== 'string') return false;
  if (['gesture', 'set_expression', 'set_morph', 'set_mesh_visible'].includes(cmd.type) && typeof cmd.name !== 'string') return false;
  return true;
}

// Memória local + afinidade (data/memory.json, escrita atômica tmp+rename).
// Falha aqui nunca derruba o chat: o handler isola as operações de memória.
const memoryStore = createMemoryStore({ dataDir: 'data' });
try {
  memoryStore.load();
} catch {
  console.error('Aviso: memória local indisponível — o chat segue sem contexto persistido.');
}

// Serviços de domínio + FlowExecutor (grafo de nós estilo n8n)
const emotionEngine = createEmotionEngine({
  driver: createExpressionDriver({ setRaw: () => {}, now: () => Date.now() }),
});
const gestureLayer = createVrmGestureLayer({ now: () => Date.now() });
const services = buildServices({
  fetchImpl: globalThis.fetch,
  getKey: async () => {
    const envPath = process.env.USAMI_KEYS_FILE || 'A:/Usami Project/.env';
    const parsed = parseEnv(await readFile(envPath, 'utf8'));
    return parsed.OPENROUTER_API_KEY || null;
  },
  model: DEFAULT_MODEL,
  memoryStore,
  classifyEmotion,
  emotionEngine,
  expressionDriver: createExpressionDriver({ setRaw: () => {}, now: () => Date.now() }),
  gestureLayer,
  transcribeAudio,
});
const flowExecutor = createFlowExecutor({ services, config: {} });

// --- Webhook de saída: Usami → n8n -----------------------------------------

// Endereço do webhook genérico do n8n local. Fire-and-forget: nunca derruba
// o chat se o n8n estiver indisponível.
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || 'http://localhost:5678/webhook/usami-events';

export async function sendToN8nWebhook(eventType, payload) {
  try {
    await fetch(N8N_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: eventType,
        timestamp: new Date().toISOString(),
        ...payload,
      }),
      // Não aguarda resposta; o n8n pode estar offline sem afetar o chat.
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    // Silencioso por design: automação é opcional.
  }
}

export function isAllowedOrigin(origin, host, allowedOrigins = DEFAULT_ALLOWED_ORIGINS) {
  if (!origin) return true;
  if (allowedOrigins.includes(origin)) return true;
  try {
    const url = new URL(origin);
    return Boolean(host) && url.host === host;
  } catch {
    return false;
  }
}

export function parseChatBody(body) {
  let input;
  try {
    input = JSON.parse(body);
  } catch {
    return { ok: false, status: 400, error: 'Corpo da requisição inválido (JSON esperado).' };
  }
  if (typeof input?.message !== 'string' || !input.message.trim() || input.message.length > 2000) {
    return { ok: false, status: 400, error: 'Informe uma mensagem de até 2000 caracteres.' };
  }
  return { ok: true, message: input.message.trim(), input: { ...input, message: undefined } };
}

export function parseTtsBody(body) {
  let input;
  try {
    input = JSON.parse(body);
  } catch {
    return { ok: false, status: 400, error: 'Corpo da requisição inválido (JSON esperado).' };
  }
  if (typeof input?.text !== 'string' || !input.text.trim() || input.text.length > 2000) {
    return { ok: false, status: 400, error: 'Informe um texto de até 2000 caracteres.' };
  }
  const styleId = typeof input.styleId === 'string' && input.styleId.trim() ? input.styleId.trim().slice(0, 80) : 'neutral';
  const rate = Number.isFinite(Number(input.rate)) ? Number(input.rate) : 1;
  const pitch = Number.isFinite(Number(input.pitch)) ? Number(input.pitch) : 1;
  return { ok: true, text: input.text.trim(), styleId, rate, pitch };
}

export function sanitizeCapabilities(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const names = (list, limit, allowed) => (Array.isArray(list) ? list.filter(value => typeof value === 'string' && value.length > 0).map(value => value.slice(0, 60)).filter(value => !allowed || allowed.includes(value)).slice(0, limit) : []);
  const meshes = Array.isArray(input.meshes) ? input.meshes.filter(mesh => typeof mesh?.name === 'string' && mesh.name.length > 0).map(mesh => ({ name: mesh.name.slice(0, 60), accessory: mesh.accessory === true })).slice(0, 100) : [];
  return {
    format: typeof input.format === 'string' ? input.format.slice(0, 40) : '',
    clips: names(input.clips, 40),
    morphs: names(input.morphs, 60),
    meshes,
    expressions: names(input.expressions, 20),
    gestures: names(input.gestures, 5, ['tilt', 'idle', 'wave']),
  };
}

export function sanitizeActions(raw) {
  const actions = Array.isArray(raw) ? raw : [];
  return actions.filter(action => action && typeof action === 'object' && !Array.isArray(action) && DIRECTOR_VERBS.includes(action.type)).slice(0, 5).map(action => {
    const base = { type: action.type, name: typeof action.name === 'string' ? action.name.slice(0, 60) : action.name };
    if (action.type === 'set_morph') base.value = action.value;
    if (action.type === 'set_mesh_visible') base.visible = action.visible;
    if (action.type === 'set_expression') base.weight = action.weight;
    // Timing por frase: delayMs (ms após o início da fala) e trigger
    // ('start' | 'middle' | 'end') são metadados do cliente, preservados
    // para agendamento sincronizado com o áudio TTS.
    if (typeof action.delayMs === 'number' && Number.isFinite(action.delayMs) && action.delayMs >= 0) {
      base.delayMs = Math.round(action.delayMs);
    }
    if (SPEECH_TRIGGERS.includes(action.trigger)) {
      base.trigger = action.trigger;
    }
    return base;
  });
}

export function filterActionsByCatalog(actions, capabilities) {
  const known = (list) => (!Array.isArray(list) ? null : new Set(list));
  const sets = capabilities ? {
    gesture: known(capabilities.gestures),
    play_clip: known(capabilities.clips),
    set_morph: known(capabilities.morphs),
    set_expression: known(capabilities.expressions),
  } : {};
  return (Array.isArray(actions) ? actions : []).filter(action => {
    const set = sets[action?.type];
    return set ? set.has(action?.name) : true; // sem catálogo conhecido → mantém
  });
}

export function systemFor(capabilities) {
  const base = DEFAULT_SYSTEM;
  if (!capabilities) return base;
  return base + ' Capabilidades disponíveis neste modelo: ' + JSON.stringify(capabilities) + '.';
}

// Fato "remember" do schema da persona: string curta e útil, ou null.
function normalizeRemember(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === 'null' || trimmed.toLowerCase() === 'undefined') return null;
  return trimmed.slice(0, 300);
}

export function parseProviderRaw(raw) {
  if (typeof raw !== 'string' || raw.length > 10000) {
    return { ok: false, status: 502, error: 'Resposta inválida do provedor.' };
  }
  let result;
  try {
    result = JSON.parse(raw.trim().replace(/^\`\`\`(?:json)?\s*/i, '').replace(/\s*\`\`\`$/, ''));
  } catch {
    if (/^[\[{]/.test(raw.trim()) || raw.length > 2000) {
      return { ok: false, status: 502, error: 'O modelo retornou um formato inválido. Tente novamente.' };
    }
    result = { reply: raw.trim(), gesture: 'neutral' };
  }
  if (typeof result?.reply !== 'string' || !result.reply.trim() || result.reply.length > 2000) {
    return { ok: false, status: 502, error: 'O modelo retornou uma resposta inválida.' };
  }
  return { ok: true, reply: result.reply.trim(), gesture: result.gesture === 'tilt' ? 'tilt' : 'neutral', actions: sanitizeActions(result.actions), remember: normalizeRemember(result.remember) };
}

export function createChatHandler(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const getKey = options.getKey || (async () => {
    const envPath = options.envPath || process.env.USAMI_KEYS_FILE || 'A:/Lira/LiraVtuber/.env';
    const parsed = parseEnv(await readFile(envPath, 'utf8'));
    return parsed.OPENROUTER_API_KEY || null;
  });
  const allowedOrigins = options.allowedOrigins || DEFAULT_ALLOWED_ORIGINS;
  const model = options.model || process.env.OPENROUTER_MODEL || DEFAULT_MODEL;
  const systemBase = options.system || DEFAULT_SYSTEM;
  const now = options.now || (() => Date.now());

  return async function handleChat(req, res) {
    const send = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify(data));
    };

    if (req.method !== 'POST' || req.url !== '/api/chat') {
      return send(404, { error: 'Não encontrado.' });
    }

    const origin = req.headers.origin;
    const host = req.headers.host;
    if (!isAllowedOrigin(origin, host, allowedOrigins)) {
      return send(403, { error: 'Origem não autorizada.' });
    }

    const contentType = (req.headers['content-type'] || '').split(';')[0].trim();
    if (contentType !== 'application/json') {
      return send(403, { error: 'Content-Type inválido.' });
    }

    let body = '';
    let tooLarge = false;
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 8192) {
        tooLarge = true;
        break;
      }
    }
    if (tooLarge) {
      return send(413, { error: 'Mensagem muito longa.' });
    }

    const parsedBody = parseChatBody(body);
    if (!parsedBody.ok) {
      return send(parsedBody.status, { error: parsedBody.error });
    }

    const capabilities = sanitizeCapabilities(parsedBody.input?.capabilities);
    const mem = memoryStore.getAll();
    const today = new Date().toISOString().slice(0, 10);
    const hour = new Date().getHours();
    const timeOfDay = hour < 12 ? 'manhã' : hour < 18 ? 'tarde' : 'noite';
    const system = buildPersona({
      affinity: mem.affinity.score,
      coreFacts: mem.coreFacts,
      recentFacts: memoryStore.getRecentFacts(new Date().toISOString()),
      history: memoryStore.getTodayHistory(today),
      username: mem.user.nickname || 'você',
      date: today,
      timeOfDay,
    });
    let parsed;
    let classification = null;

    if (USE_NVIDIA) {
      // Fluxo NVIDIA: 3 modelos com rate limit global de 40 req/min
      try {
        // 1) Classificação da frase do usuário (modelo leve)
        classification = await classifyUserMessage(parsedBody.message);

        // 2) Geração de texto da Usami (modelo de geração)
        const rawReply = await generateReply(system, parsedBody.message, { temperature: 0.7 });
        const parsedReply = parseProviderRaw(rawReply);
        if (!parsedReply.ok) throw new Error(parsedReply.error);

        // 3) Planejamento de animação (modelo de animação)
        const animation = await planAnimation(parsedReply.reply, capabilities, { temperature: 0.3 });

        parsed = {
          ok: true,
          reply: parsedReply.reply,
          gesture: parsedReply.gesture,
          actions: animation.actions,
          remember: parsedReply.remember,
          classification,
          source: 'nvidia',
        };
      } catch (error) {
        console.warn('NVIDIA falhou, tentando OpenRouter:', error.message);
        // Fallback para OpenRouter abaixo
      }
    }

    if (!parsed || !parsed.ok) {
      // Fluxo OpenRouter (atual) — usado como fallback ou quando NVIDIA desligado
      let key;
      try {
        key = await getKey();
      } catch {
        return send(502, { error: 'Não foi possível acessar a configuração.' });
      }
      if (!key) {
        return send(503, { error: 'Chave OpenRouter não configurada.' });
      }

      let response;
      try {
        response = await fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, max_tokens: 320, messages: [{ role: 'system', content: system }, { role: 'user', content: parsedBody.message }] }),
          signal: AbortSignal.timeout(45000),
        });
      } catch (error) {
        return send(502, { error: error?.name === 'TimeoutError' ? 'A solicitação expirou.' : 'Não foi possível acessar o provedor.' });
      }

      if (!response || !response.ok) {
        return send(502, { error: 'A OpenRouter recusou a solicitação ou está indisponível (HTTP ' + (response?.status ?? 0) + ').' });
      }

      let data;
      try {
        data = await response.json();
      } catch {
        return send(502, { error: 'Resposta inválida do provedor.' });
      }

      const raw = data?.choices?.[0]?.message?.content;
      const parsedRouter = parseProviderRaw(raw);
      if (!parsedRouter.ok) {
        return send(parsedRouter.status, { error: parsedRouter.error });
      }

      parsed = {
        ...parsedRouter,
        classification,
        source: 'openrouter',
      };
    }

    // Memória + afinidade: extrai o "remember", persiste o turno e move o score.
    // Isolado de propósito — falha de disco nunca derruba a resposta do chat.
    let affinityPayload = null;
    try {
      const remember = parsed.remember;
      if (remember) {
        if (DURABLE_FACT.test(remember)) memoryStore.addCoreFact(remember);
        else memoryStore.addRecentFact(remember);
      }
      const turnTimestamp = new Date().toISOString();
      memoryStore.appendHistory('user', parsedBody.message, turnTimestamp);
      memoryStore.appendHistory('assistant', parsed.reply, turnTimestamp);
      const current = memoryStore.getAll();
      const gain = calculateGain({
        userMessage: parsedBody.message,
        assistantReply: parsed.reply,
        rememberFact: remember,
        currentScore: current.affinity.score,
        stage: getStage(current.affinity.score),
        alreadyGainedToday: current.affinity.totalDailyGainToday,
      });
      const newAff = applyGain(current.affinity.score, gain.delta, today, current.affinity.lastDailyGainDate, current.affinity.totalDailyGainToday);
      // applyGain já devolve o objeto completo (score + contador diário); grava direto.
      memoryStore.save({ ...current, affinity: newAff });
      affinityPayload = { affinity: newAff.score, stage: getStage(newAff.score) };
    } catch {
      // sem memória o chat segue stateless; nada a fazer aqui
    }

    const actions = filterActionsByCatalog(parsed.actions ?? [], capabilities);

    // Dispara evento para o n8n (fire-and-forget): resposta, emoção,
    // ações de animação e afinidade. Não bloqueia o chat se o n8n estiver
    // offline.
    void sendToN8nWebhook('usami.response', {
      userMessage: parsedBody.message,
      reply: parsed.reply,
      gesture: parsed.gesture,
      actions,
      emotion: classification,
      affinity: affinityPayload,
      source: parsed.source,
    });

    return send(200, { reply: parsed.reply, gesture: parsed.gesture, actions, ...(affinityPayload || {}) });
  };
}

// --- Flow-based chat handler (n8n-style node graph) ---
export function createFlowChatHandler(options = {}) {
  const allowedOrigins = options.allowedOrigins || DEFAULT_ALLOWED_ORIGINS;

  return async function handleFlowChat(req, res) {
    const send = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify(data));
    };

    if (req.method !== 'POST' || req.url !== '/api/chat') {
      return send(404, { error: 'Não encontrado.' });
    }

    const origin = req.headers.origin;
    const host = req.headers.host;
    if (!isAllowedOrigin(origin, host, allowedOrigins)) {
      return send(403, { error: 'Origem não autorizada.' });
    }

    const contentType = (req.headers['content-type'] || '').split(';')[0].trim();
    if (contentType !== 'application/json') {
      return send(403, { error: 'Content-Type inválido.' });
    }

    let body = '';
    let tooLarge = false;
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 8192) {
        tooLarge = true;
        break;
      }
    }
    if (tooLarge) {
      return send(413, { error: 'Mensagem muito longa.' });
    }

    const parsedBody = parseChatBody(body);
    if (!parsedBody.ok) {
      return send(parsedBody.status, { error: parsedBody.error });
    }

    const capabilities = sanitizeCapabilities(parsedBody.input?.capabilities);

    try {
      const result = await flowExecutor.executeChat({
        userText: parsedBody.message,
        audioBuffer: null, // STT handled separately via /api/stt
        capabilities,
        // O navegador toca o TTS por /api/tts e é quem faz o lip-sync. Evita
        // uma segunda síntese invisível e mantém uma única fonte de áudio.
        voiceOff: true,
      });

      return send(200, {
        reply: result.reply,
        gesture: result.gesture,
        actions: result.actions,
        emotion: result.emotion,
        audioBuffer: result.audioBuffer ? 'base64_placeholder' : null, // actual audio via /api/tts
        debug: result.debug,
      });
    } catch (error) {
      return send(500, { error: 'Erro interno no flow: ' + error.message });
    }
  };
}

// --- n8n → Usami: fila de comandos ------------------------------------------

export function createN8nCommandHandler(options = {}) {
  const allowedOrigins = options.allowedOrigins || DEFAULT_ALLOWED_ORIGINS;

  return async function handleN8nCommand(req, res) {
    const send = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify(data));
    };

    const origin = req.headers.origin;
    const host = req.headers.host;
    if (!isAllowedOrigin(origin, host, allowedOrigins)) {
      return send(403, { error: 'Origem não autorizada.' });
    }

    // GET — cliente consome e limpa a fila de comandos pendentes
    if (req.method === 'GET' && req.url === '/api/n8n/commands') {
      const pending = [...n8nCommandQueue];
      n8nCommandQueue.length = 0;
      return send(200, { commands: pending, count: pending.length });
    }

    // DELETE — limpa a fila (ex.: cliente desistiu de aplicar)
    if (req.method === 'DELETE' && req.url === '/api/n8n/commands') {
      const cleared = n8nCommandQueue.length;
      n8nCommandQueue.length = 0;
      return send(200, { cleared });
    }

    // POST — n8n envia um comando para ser aplicado pelo cliente
    if (req.method === 'POST' && req.url === '/api/n8n/command') {
      const contentType = (req.headers['content-type'] || '').split(';')[0].trim();
      if (contentType !== 'application/json') {
        return send(403, { error: 'Content-Type inválido.' });
      }

      let body = '';
      let tooLarge = false;
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 8192) {
          tooLarge = true;
          break;
        }
      }
      if (tooLarge) {
        return send(413, { error: 'Comando muito longo.' });
      }

      let cmd;
      try {
        cmd = JSON.parse(body);
      } catch {
        return send(400, { error: 'Corpo da requisição inválido (JSON esperado).' });
      }

      if (!isValidN8nCommand(cmd)) {
        return send(400, { error: 'Comando inválido. Tipos válidos: say, gesture, set_expression, set_morph, set_mesh_visible.' });
      }

      const entry = {
        id: Math.random().toString(36).slice(2, 10),
        timestamp: new Date().toISOString(),
        ...cmd,
      };
      n8nCommandQueue.push(entry);

      // Mantém a fila limitada para não crescer indefinidamente.
      if (n8nCommandQueue.length > 100) n8nCommandQueue.shift();

      return send(200, { ok: true, id: entry.id, queued: n8nCommandQueue.length });
    }

    return send(404, { error: 'Não encontrado.' });
  };
}

const DEFAULT_GEMINI_TTS_MODEL = 'gemini-2.5-flash-preview-tts';
const DEFAULT_GEMINI_TTS_VOICE = 'Kore';
const DEFAULT_GEMINI_TTS_INSTRUCTION = 'Leia em português do Brasil, com tom acolhedor e animado: ';
const DEFAULT_GEMINI_TTS_SAMPLE_RATE = 24000;
// Cláusulas de emoção por styleId, inseridas na instrução do gemini; neutral e
// rótulos desconhecidos não têm cláusula — caem na instrução base (determinístico).
const STYLE_INSTRUCTIONS = {
  happy: 'com voz alegre e brilhante',
  sad: 'com voz triste e suave',
  angry: 'com voz firme e irritada',
  surprised: 'com voz espantada',
  relaxed: 'com voz calma e serena',
  soft: 'com voz doce e meiga',
  shy: 'com voz tímida e envergonhada',
  doubtful: 'com voz desconfiada',
};

// Insere a cláusula da emoção antes do ": " final da instrução base; base sem
// o delimitador recebe a cláusula anexada — sem cláusula conhecida, base intacta.
function buildGeminiInstruction(base, styleId) {
  const clause = STYLE_INSTRUCTIONS[styleId];
  if (!clause) return base;
  const trimmed = base.replace(/:\s*$/, '');
  return trimmed + (trimmed === base ? ' ' : ', ') + clause + ': ';
}

function normalizeTtsProvider(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return normalized === 'gemini' || normalized === 'elevenlabs' ? normalized : null;
}

function parseGeminiSampleRate(mimeType) {
  const match = /rate=(\d+)/.exec(typeof mimeType === 'string' ? mimeType : '');
  const rate = match ? Number(match[1]) : DEFAULT_GEMINI_TTS_SAMPLE_RATE;
  return Number.isFinite(rate) && rate > 0 ? rate : DEFAULT_GEMINI_TTS_SAMPLE_RATE;
}

// Envelopa PCM mono 16-bit little-endian num WAV RIFF de 44 bytes, sem deps.
function pcmToWav(pcm, sampleRate) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // tamanho do subchunk fmt
  header.writeUInt16LE(1, 20); // audioFormat: PCM
  header.writeUInt16LE(1, 22); // canais: mono
  header.writeUInt32LE(sampleRate, 24); // sampleRate
  header.writeUInt32LE(sampleRate * 2, 28); // byteRate = rate * canais * 16/8
  header.writeUInt16LE(2, 32); // blockAlign
  header.writeUInt16LE(16, 34); // bitsPerSample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export function createTtsHandler(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const getConfig = options.getConfig || (async () => {
    // options.envPath (testes) substitui a cadeia inteira; sem ele, tenta o .env
    // do projeto e depois o fallback — o primeiro arquivo com um provedor
    // completo vence; no mesmo arquivo, gemini tem prioridade.
    const candidates = options.envPath
      ? [options.envPath]
      : [process.env.USAMI_KEYS_FILE || 'A:/Usami Project/.env', 'A:/Lira/LiraVtuber/.env'];
    for (const candidate of candidates) {
      let parsed;
      try {
        parsed = parseEnv(await readFile(candidate, 'utf8'));
      } catch {
        // arquivo ausente ou ilegível → tenta o próximo candidato
        continue;
      }
      const providerOverride = normalizeTtsProvider(options.provider || process.env.USAMI_TTS_PROVIDER);
      const hasGemini = Boolean(parsed.GEMINI_API_KEY);
      const hasElevenlabs = Boolean(parsed.ELEVENLABS_API_KEY && parsed.ELEVENLABS_VOICE_ID);
      // override explícito restringe o provedor; sem override, gemini vem primeiro
      if (hasGemini && (!providerOverride || providerOverride === 'gemini')) {
        return { provider: 'gemini', apiKey: parsed.GEMINI_API_KEY, geminiModel: parsed.GEMINI_TTS_MODEL, geminiVoice: parsed.GEMINI_TTS_VOICE };
      }
      if (hasElevenlabs && (!providerOverride || providerOverride === 'elevenlabs')) {
        return { provider: 'elevenlabs', apiKey: parsed.ELEVENLABS_API_KEY, voiceId: parsed.ELEVENLABS_VOICE_ID };
      }
    }
    return { provider: null, apiKey: null, voiceId: null };
  });
  const allowedOrigins = options.allowedOrigins || DEFAULT_ALLOWED_ORIGINS;
  const model = options.model || process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2';
  const ttsUrl = (options.ttsUrl || 'https://api.elevenlabs.io').replace(/\/+$/, '');
  const geminiUrl = (options.geminiUrl || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs || 30000;
  const cache = options.cache ? (options.cacheStore || createFileTtsCache({ directory: options.cacheDir || process.env.USAMI_TTS_CACHE_DIR || 'data/tts-cache' })) : null;
  // vozes desenhadas (Voice Design/Replication) no gemini usam ids com prefixo voice_
  const CUSTOM_VOICE_PREFIX = 'voice_';

  return async function handleTts(req, res) {
    const send = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify(data));
    };

    if (req.method !== 'POST' || req.url !== '/api/tts') {
      return send(404, { error: 'Não encontrado.' });
    }

    const origin = req.headers.origin;
    const host = req.headers.host;
    if (!isAllowedOrigin(origin, host, allowedOrigins)) {
      return send(403, { error: 'Origem não autorizada.' });
    }

    const contentType = (req.headers['content-type'] || '').split(';')[0].trim();
    if (contentType !== 'application/json') {
      return send(403, { error: 'Content-Type inválido.' });
    }

    let body = '';
    let tooLarge = false;
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 8192) {
        tooLarge = true;
        break;
      }
    }
    if (tooLarge) {
      return send(413, { error: 'Texto muito longo.' });
    }

    const parsedBody = parseTtsBody(body);
    if (!parsedBody.ok) {
      return send(parsedBody.status, { error: parsedBody.error });
    }

    let config;
    try {
      config = await getConfig();
    } catch {
      return send(503, { error: 'TTS indisponível: configuração ausente.' });
    }
    // provider explícito (options/env) vence; sem ele, o config decide — um
    // config legado { apiKey, voiceId } sem provider continua significando elevenlabs
    const provider = normalizeTtsProvider(options.provider || process.env.USAMI_TTS_PROVIDER)
      || (config?.provider === 'gemini' ? 'gemini' : 'elevenlabs');
    if (!config?.apiKey || (provider === 'elevenlabs' && !config?.voiceId)) {
      return send(503, { error: 'TTS indisponível: configuração ausente.' });
    }

    const geminiModel = provider === 'gemini'
      ? (options.geminiModel || process.env.GEMINI_TTS_MODEL || config.geminiModel || DEFAULT_GEMINI_TTS_MODEL)
      : null;
    const geminiVoice = provider === 'gemini'
      ? (options.geminiVoice || process.env.GEMINI_TTS_VOICE || config.geminiVoice || DEFAULT_GEMINI_TTS_VOICE)
      : null;
    const audioFormat = provider === 'gemini' ? 'audio/wav' : 'audio/mpeg';
    const cacheKey = cache ? createTtsCacheKey({
      provider,
      model: provider === 'gemini' ? geminiModel : model,
      voiceId: provider === 'gemini' ? geminiVoice : config.voiceId,
      styleId: parsedBody.styleId,
      rate: parsedBody.rate,
      pitch: parsedBody.pitch,
      format: audioFormat,
      text: parsedBody.text,
    }) : null;
    if (cache && cacheKey) {
      try {
        const cached = await cache.get(cacheKey);
        if (cached) {
          res.writeHead(200, { 'Content-Type': audioFormat, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-TTS-Cache': 'HIT' });
          return res.end(cached);
        }
      } catch {
        // Cache failures never make TTS unavailable.
      }
    }

    let response;
    try {
      if (provider === 'gemini') {
        const baseInstruction = options.geminiInstruction || process.env.GEMINI_TTS_INSTRUCTION || DEFAULT_GEMINI_TTS_INSTRUCTION;
        // styleId conhecido ganha a cláusula da emoção; neutral/desconhecido fica na base
        const instruction = buildGeminiInstruction(baseInstruction, parsedBody.styleId);
        // a key vai apenas no header x-goog-api-key (nunca na URL); o prefixo de
        // instrução não conta no limite de 2000 chars, validado sobre o texto puro
        response = await fetchImpl(geminiUrl + '/v1beta/models/' + encodeURIComponent(geminiModel) + ':generateContent', {
          method: 'POST',
          headers: { 'x-goog-api-key': config.apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: instruction + parsedBody.text }] }],
            generationConfig: {
              responseModalities: ['AUDIO'],
              // voz desenhada (voice_*) vai em voiceConfig.voice; pré-pronta permanece em prebuiltVoiceConfig
              speechConfig: {
                voiceConfig: geminiVoice.startsWith(CUSTOM_VOICE_PREFIX)
                  ? { voice: geminiVoice }
                  : { prebuiltVoiceConfig: { voiceName: geminiVoice } },
              },
            },
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } else {
        response = await fetchImpl(ttsUrl + '/v1/text-to-speech/' + encodeURIComponent(config.voiceId) + '?output_format=mp3_44100_128', {
          method: 'POST',
          headers: { 'xi-api-key': config.apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: parsedBody.text, model_id: model, output_format: 'mp3_44100_128' }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      }
    } catch {
      // timeout ou falha de rede; a apiKey nunca é exposta em resposta ou log
      return send(504, { error: 'TTS expirou.' });
    }

    if (!response || !response.ok) {
      // não repassa o corpo do provedor; preserva apenas o status 400/422/429
      const providerStatus = response?.status ?? 0;
      const status = providerStatus === 400 || providerStatus === 422 || providerStatus === 429 ? providerStatus : 502;
      return send(status, { error: 'TTS falhou no provedor.' });
    }

    let audio;
    try {
      if (provider === 'gemini') {
        const data = await response.json();
        const inlineData = data?.candidates?.[0]?.content?.parts?.find(part => part?.inlineData)?.inlineData;
        if (!inlineData || typeof inlineData.data !== 'string') {
          return send(502, { error: 'TTS falhou no provedor.' });
        }
        const pcm = Buffer.from(inlineData.data, 'base64');
        if (!pcm.length) {
          return send(502, { error: 'TTS falhou no provedor.' });
        }
        // o provedor devolve PCM mono 16-bit; envelopa num WAV RIFF de 44 bytes
        audio = pcmToWav(pcm, parseGeminiSampleRate(inlineData.mimeType));
      } else {
        audio = Buffer.from(await response.arrayBuffer());
      }
    } catch {
      return send(502, { error: 'TTS falhou no provedor.' });
    }

    res.writeHead(200, { 'Content-Type': audioFormat, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    if (cache && cacheKey) {
      try { await cache.put(cacheKey, audio); } catch {
        // Cache failures never make a successful synthesis fail.
      }
    }
    res.end(audio);
  };
}

// ---- STT (speech-to-text local via faster-whisper) ----

// Parser multipart/form-data minimalista (sem deps): extrai apenas o campo
// `audio` (arquivo) e ignora campos de texto. Browsers emitem CRLF.
export function parseMultipartAudio(buffer, contentType) {
  const header = typeof contentType === 'string' ? contentType : '';
  const match = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(header);
  if (!match || !(match[1] ?? match[2])) {
    return { ok: false, status: 400, error: 'Requisição multipart inválida (boundary ausente).' };
  }
  const boundary = Buffer.from('--' + (match[1] ?? match[2]).trim());
  let index = buffer.indexOf(boundary);
  while (index !== -1) {
    const next = buffer.indexOf(boundary, index + boundary.length);
    if (next === -1) break;
    // trecho entre dois boundaries: começa após o CRLF da linha do boundary e
    // termina antes do CRLF que precede o próximo boundary
    const raw = buffer.subarray(index + boundary.length, next);
    const start = raw.length >= 2 && raw[0] === 0x0d && raw[1] === 0x0a ? 2 : 0;
    const end = raw.length >= 2 && raw[raw.length - 2] === 0x0d && raw[raw.length - 1] === 0x0a ? raw.length - 2 : raw.length;
    const part = raw.subarray(start, end);
    let headEnd = part.indexOf('\r\n\r\n');
    let sep = 4;
    if (headEnd === -1) {
      headEnd = part.indexOf('\n\n');
      sep = 2;
    }
    if (headEnd === -1) {
      index = next;
      continue;
    }
    const head = part.subarray(0, headEnd).toString('utf8');
    const data = part.subarray(headEnd + sep);
    // `filename="..."` também contém "name=" — exige delimitador antes do nome
    const nameMatch = /(?:^|[;\s])name=(?:"([^"]*)"|([^;\s]+))/i.exec(head);
    const name = nameMatch ? (nameMatch[1] ?? nameMatch[2]) : null;
    if (name === 'audio') {
      if (!data.length) {
        return { ok: false, status: 400, error: 'Arquivo de áudio vazio.' };
      }
      const fileMatch = /filename="([^"]*)"/i.exec(head);
      const extMatch = fileMatch ? /\.([A-Za-z0-9]{1,8})$/.exec(fileMatch[1]) : null;
      return { ok: true, audio: Buffer.from(data), extension: extMatch ? extMatch[1].toLowerCase() : null };
    }
    index = next;
  }
  return { ok: false, status: 400, error: 'Campo "audio" ausente.' };
}

// Corre a transcrição contra um timeout de parede; rejeições tardias de um impl
// que estourou o relógio são engolidas para não virarem unhandled rejection.
function withTranscribeTimeout(promise, ms) {
  let timer;
  const wrapped = Promise.resolve(promise);
  wrapped.catch(() => {});
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error('Transcrição expirou.');
      error.name = 'TimeoutError';
      reject(error);
    }, ms);
  });
  return Promise.race([wrapped, timeout]).finally(() => clearTimeout(timer));
}

export function createSttHandler(options = {}) {
  // fetchImpl é aceito por paridade de assinatura com chat/tts, mas
  // deliberadamente não usado: a transcrição roda via python local, não HTTP.
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const transcribeImpl = options.transcribeImpl || transcribeAudio;
  const getConfig = options.getConfig || (async () => ({ whisperModel: process.env.WHISPER_MODEL || null }));
  const allowedOrigins = options.allowedOrigins || DEFAULT_ALLOWED_ORIGINS;
  const model = options.model;
  const timeoutMs = options.timeoutMs || 60000;
  const language = options.language || 'pt';
  const beamSize = Number.isFinite(Number(options.beamSize)) ? Number(options.beamSize) : 1;
  const tmpDir = options.tmpDir || process.env.USAMI_STT_TMP_DIR || 'tmp';
  const maxBodyBytes = options.maxBodyBytes || 8 * 1024 * 1024;

  return async function handleStt(req, res) {
    const send = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify(data));
    };

    if (req.method !== 'POST' || req.url !== '/api/stt') {
      return send(404, { error: 'Não encontrado.' });
    }

    const origin = req.headers.origin;
    const host = req.headers.host;
    if (!isAllowedOrigin(origin, host, allowedOrigins)) {
      return send(403, { error: 'Origem não autorizada.' });
    }

    const contentType = req.headers['content-type'] || '';
    const mime = contentType.split(';')[0].trim().toLowerCase();
    if (mime !== 'multipart/form-data') {
      return send(403, { error: 'Content-Type inválido.' });
    }

    const chunks = [];
    let total = 0;
    let tooLarge = false;
    for await (const chunk of req) {
      chunks.push(chunk);
      total += chunk.length;
      if (total > maxBodyBytes) {
        tooLarge = true;
        break;
      }
    }
    if (tooLarge) {
      return send(413, { error: 'Áudio muito grande.' });
    }

    const parsed = parseMultipartAudio(Buffer.concat(chunks), contentType);
    if (!parsed.ok) {
      return send(parsed.status, { error: parsed.error });
    }

    // config falhando não derruba o STT: o nome do modelo tem default funcional
    let config = null;
    try {
      config = await getConfig();
    } catch {
      config = null;
    }
    const modelName = model
      || (typeof config === 'string' && config ? config : null)
      || config?.whisperModel
      || config?.WHISPER_MODEL
      || process.env.WHISPER_MODEL
      || 'base';

    let audioPath;
    try {
      audioPath = await saveTempAudio(parsed.audio, { dir: tmpDir, extension: parsed.extension || 'webm' });
    } catch {
      return send(500, { error: 'Falha ao preparar o áudio.' });
    }

    let text;
    try {
      text = await withTranscribeTimeout(transcribeImpl({ audioPath, modelName, language, beamSize, timeoutMs }), timeoutMs);
    } catch (error) {
      const timedOut = error?.name === 'TimeoutError';
      return send(timedOut ? 504 : 500, { error: timedOut ? 'Transcrição expirou.' : 'Falha na transcrição.' });
    } finally {
      await removeTempAudio(audioPath);
    }

    if (typeof text !== 'string') {
      return send(500, { error: 'Falha na transcrição.' });
    }
    return send(200, { text: text.trim() });
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  // O handler consolidado preserva a persona, memória e afinidade no prompt.
  // O FlowExecutor segue coberto por testes enquanto essa paridade completa é
  // finalizada, sem trocar comportamento real por um pipeline parcial.
  const handleChat = createChatHandler();
  const handleTts = createTtsHandler({ cache: true });
  const handleStt = createSttHandler();
  const handleN8nCommand = createN8nCommandHandler();
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/chat') return handleChat(req, res);
    if (req.method === 'POST' && req.url === '/api/tts') return handleTts(req, res);
    if (req.method === 'POST' && req.url === '/api/stt') return handleStt(req, res);
    if (req.method === 'POST' && req.url === '/api/n8n/command') return handleN8nCommand(req, res);
    if (req.method === 'GET' && req.url === '/api/n8n/commands') return handleN8nCommand(req, res);
    if (req.method === 'DELETE' && req.url === '/api/n8n/commands') return handleN8nCommand(req, res);
    res.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify({ error: 'Não encontrado.' }));
  });
  server.listen(8787, '127.0.0.1', () => console.log('Usami API local em 127.0.0.1:8787'));
}
