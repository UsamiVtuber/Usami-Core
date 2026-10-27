import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createFileTtsCache, createTtsCacheKey } from './src/tts-cache.js';
import { GESTURE_NAMES, DIRECTOR_VERBS, SHAPE_NAMES } from './src/motion-director.js';
import { removeTempAudio, saveTempAudio, transcribeAudio } from './src/stt.js';
import { buildPersona, getAffinityStage } from './src/persona.js';
import { extractJsonCandidate } from './src/json-salvage.js';
import { createMemoryStore } from './src/memory-store.js';
import { calculateGain, applyGain, getStage, DAILY_CAP } from './src/affinity.js';
import { buildServices } from './src/flow-services.js';
import { createFlowExecutor } from './src/flow-executor.js';
import { classifyEmotion, DEFAULT_CONFIDENCE_THRESHOLD } from './src/emotion-classifier.js';
import { createEmotionEngine } from './src/emotion-engine.js';
import { createExpressionDriver } from './src/expression-driver.js';
import { createVrmGestureLayer } from './src/vrm-gesture-layer.js';
import { classifyUserMessage, describeFetchError, generateReplyWithActions, planAnimation, structureTechnique } from './src/llm-router.js';
import { readRagContext } from './src/rag.js';
import { createTechniqueStore, readIngestedFicha } from './src/technique-store.js';
import { createTechniqueIndex } from './src/technique-index.js';
import { writeTechniqueNote } from './src/technique-docs.js';
import { planAnimationSelection, planToActions, explainPlan, validatePlanRequest, intentFromText } from './src/animation-planner.js';
import { createLearningMemory } from './src/learning-memory.js';
import { TECHNIQUE_STATUSES, sanitizeTechnique, summarizeTechnique, techniqueUserPrompt } from './src/technique-schema.js';

export const DEFAULT_MODEL = process.env.OPENROUTER_MODEL || 'nvidia/nemotron-3-ultra-550b-a55b:free';
// USE_NVIDIA=false desliga a rota NVIDIA mesmo com chave presente (isolamento de testes);
// ausente/true: auto-detecção (env direto ou .env do projeto). Avaliado por chamada.
export function useNvidia() {
  if (process.env.USE_NVIDIA === 'false') return false;
  return (process.env.USE_NVIDIA === 'true') || Boolean(process.env.NVIDIA_API_KEY || nvidiaKeyConfigured());
}
const USE_NVIDIA = useNvidia();

// Verifica se a chave NVIDIA está configurada (env ou A:\.env), sem fazer chamada de API.
function nvidiaKeyConfigured() {
  if (process.env.NVIDIA_API_KEY) return true;
  try {
    const text = readFileSync('A:\\Usami Project\\.env', 'utf8');
    return /^NVIDIA_API_KEY\s*=/m.test(text);
  } catch {
    return false;
  }
}

// Exporta a chave NVIDIA para o ambiente do processo, para que o
// nvidia-client.js (que lê process.env.NVIDIA_API_KEY) a encontre.
if (USE_NVIDIA && !process.env.NVIDIA_API_KEY) {
  try {
    const text = readFileSync('A:\\Usami Project\\.env', 'utf8');
    const match = text.match(/^NVIDIA_API_KEY\s*=\s*(.+)$/m);
    if (match) process.env.NVIDIA_API_KEY = match[1].trim();
  } catch {
    // falha silenciosa — o nvidia-client já avisa no console
  }
}

const DEFAULT_SYSTEM = `Você é Usami, uma companion acolhedora, curiosa e natural. Responda em português de forma breve. Não incentive dependência emocional ou exclusividade. Responda SOMENTE JSON: {"reply":"resposta","gesture":"neutral" ou "tilt","actions":[{"type":"gesture","name":"um de: ${GESTURE_NAMES.join(', ')}"},{"type":"play_clip","name":"Nome do clip"},{"type":"set_morph","name":"Nome do morph","value":0 a 1},{"type":"set_mesh_visible","name":"Nome de mesh acessório","visible":true ou false},{"type":"play_sequence","shape":"um de: ${SHAPE_NAMES.join(', ')}","amplitude":0.02 a 0.5,"cycles":1 a 8,"durationMs":600 a 8000,"side":"left" ou "right"}]}. Actions é opcional e pode ser vazio; no máximo 5 ações. play_sequence compõe movimento novo a partir de uma shape; use apenas se capabilities.sequences for true.`.trim();

const DEFAULT_ALLOWED_ORIGINS = ['http://127.0.0.1:5173', 'http://localhost:5173'];

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
  'play_sequence', // sequência a partir de shape paramétrica
]);

function isValidN8nCommand(cmd) {
  if (!cmd || typeof cmd !== 'object' || Array.isArray(cmd)) return false;
  if (!VALID_COMMAND_TYPES.has(cmd.type)) return false;
  if (cmd.type === 'say' && typeof cmd.message !== 'string') return false;
  if (['gesture', 'set_expression', 'set_morph', 'set_mesh_visible'].includes(cmd.type) && typeof cmd.name !== 'string') return false;
  if (cmd.type === 'gesture' && !GESTURE_NAMES.includes(cmd.name)) return false;
  if (cmd.type === 'play_sequence' && !SHAPE_NAMES.includes(cmd.shape)) return false;
  return true;
}

// Único ponto de entrada da fila: valida, carimba id/timestamp e empurra.
// Usado pelo n8n (POST) e pelo refino de animação do próprio turno.
function queueAvatarCommand(cmd) {
  if (!isValidN8nCommand(cmd)) return null;
  const entry = {
    id: Math.random().toString(36).slice(2, 10),
    timestamp: new Date().toISOString(),
    ...cmd,
  };
  n8nCommandQueue.push(entry);

  // Mantém a fila limitada para não crescer indefinidamente.
  if (n8nCommandQueue.length > 100) n8nCommandQueue.shift();
  return entry;
}

// Refino de animação fora do caminho crítico: quando a geração única devolve a
// fala sem ação nenhuma, o diretor de animação roda DEPOIS da resposta e empurra
// o gesto pela fila de comandos (o cliente consome em poll de 2 s). Troca ~4 s
// de latência por um gesto que chega no meio da frase — sem ação nenhuma era o
// resultado de antes quando o plano demorava.
// Decisão de timing: como o refino nunca está no caminho do balão, ele NÃO
// contribui para animationMs/totalMs do turno. Medimos a duração própria aqui,
// no log, para continuar visível sem o chat esperar por ele.
export async function refineAnimationInBackground(reply, capabilities, { planner = planAnimation } = {}) {
  const startedAt = Date.now();
  try {
    const { actions } = await planner(reply, capabilities, { temperature: 0.3 });
    const queued = filterActionsByCatalog(actions ?? [], capabilities)
      .map(action => queueAvatarCommand(action))
      .filter(Boolean).length;
    console.log('[animacao] refino em background: ' + queued + ' ação(ões) na fila, queuedMs='
      + (Date.now() - startedAt));
  } catch (error) {
    console.warn('[animacao] refino em background falhou, queuedMs=' + (Date.now() - startedAt)
      + ': ' + describeFetchError(error));
  }
}

// Memória local + afinidade (data/memory.json, escrita atômica tmp+rename).
// Falha aqui nunca derruba o chat: o handler isola as operações de memória.
// USAMI_DATA_DIR existe para os testes: sem ele, importar este módulo já bastava
// para criar e depois encher o memory.json real da companion.
const installMemoryStore = createMemoryStore({ dataDir: process.env.USAMI_DATA_DIR || 'data' });
try {
  installMemoryStore.load();
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
  memoryStore: installMemoryStore,
  classifyEmotion,
  emotionEngine,
  expressionDriver: createExpressionDriver({ setRaw: () => {}, now: () => Date.now() }),
  gestureLayer,
  transcribeAudio,
});
const flowExecutor = createFlowExecutor({ services, config: {} });

// --- Webhook de saída: Usami → n8n -----------------------------------------

// Endereço do webhook do n8n. Fire-and-forget: nunca derruba o chat se o n8n
// estiver indisponível. A resolução vem do environment OU do .env do projeto,
// porque nada popula process.env a partir dele — o mesmo caminho usado para a
// chave NVIDIA. Sem isso, o default `localhost:5678` sempre vence e o evento
// vai para lugar nenhum (a stack do Windows está desligada; o n8n real é o do
// Nyarch, e o `WEBHOOK_URL` do compose dele é http://10.42.0.1:5678).
function resolveN8nWebhookUrl() {
  if (process.env.N8N_WEBHOOK_URL) return process.env.N8N_WEBHOOK_URL;
  try {
    const text = readFileSync(process.env.USAMI_KEYS_FILE || 'A:/Usami Project/.env', 'utf8');
    const match = text.match(/^N8N_WEBHOOK_URL\s*=\s*(.+)$/m);
    if (match) return match[1].trim();
  } catch {
    // arquivo ausente ou ilegível → mantém o default local
  }
  return 'http://localhost:5678/webhook/usami-events';
}

const N8N_WEBHOOK_URL = resolveN8nWebhookUrl();

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
  return { ok: true, text: input.text.trim(), styleId, rate, pitch, stream: input.stream === true };
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
    gestures: names(input.gestures, 20, GESTURE_NAMES),
    sequences: input.sequences === true,
  };
}

export function sanitizeActions(raw) {
  const actions = Array.isArray(raw) ? raw : [];
  return actions.filter(action => action && typeof action === 'object' && !Array.isArray(action) && DIRECTOR_VERBS.includes(action.type)).slice(0, 5).map(action => {
    const base = { type: action.type, name: typeof action.name === 'string' ? action.name.slice(0, 60) : action.name };
    if (action.type === 'set_morph') base.value = action.value;
    if (action.type === 'set_mesh_visible') base.visible = action.visible;
    if (action.type === 'set_expression') base.weight = action.weight;
    // play_sequence: só o vocabulário (shape) e parâmetros numéricos limitados
    // passam; os keyframes são expandidos localmente pelo buildSequenceRequest.
    if (action.type === 'play_sequence') {
      if (!SHAPE_NAMES.includes(action.shape)) return null;
      base.shape = action.shape;
      if (action.side === 'left' || action.side === 'right') base.side = action.side;
      for (const key of ['amplitude', 'cycles', 'durationMs']) {
        if (Number.isFinite(action[key])) base[key] = action[key];
      }
    }
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
  }).filter(Boolean);
}

// O modelo inventa sinônimos para os verbos do diretor ("expression" em vez de
// "set_expression"); sem essa ponte a ação passa pelo filtro e morre no director.
const ACTION_TYPE_ALIASES = { expression: 'set_expression', emote: 'set_expression', morph: 'set_morph' };

export function filterActionsByCatalog(actions, capabilities) {
  const known = (list) => (!Array.isArray(list) ? null : new Set(list));
  const sets = capabilities ? {
    gesture: known(capabilities.gestures),
    play_clip: known(capabilities.clips),
    set_morph: known(capabilities.morphs),
    set_expression: known(capabilities.expressions),
  } : {};
  return (Array.isArray(actions) ? actions : [])
    .map(action => {
      const alias = ACTION_TYPE_ALIASES[action?.type];
      return alias ? { ...action, type: alias } : action;
    })
    .filter(action => {
      const set = sets[action?.type];
      return set ? set.has(action?.name) : true; // sem catálogo conhecido → mantém
    });
}

export function systemFor(capabilities) {
  return withCapabilities(DEFAULT_SYSTEM, capabilities);
}

// Anexa o catálogo de capacidades ao system prompt de quem precisa escolher
// ações. Sem ele o modelo inventa nomes de expressão/clip que não existem no
// avatar e toda ação morre em filterActionsByCatalog — era por isso que existia
// uma segunda chamada (planAnimation) só para ter o catálogo em mãos.
export function withCapabilities(system, capabilities) {
  if (!capabilities) return system;
  return system + ' Capabilidades disponíveis neste modelo: ' + JSON.stringify(capabilities) + '.';
}

// Fato "remember" do schema da persona: string curta e útil, ou null.
function normalizeRemember(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === 'null' || trimmed.toLowerCase() === 'undefined') return null;
  return trimmed.slice(0, 300);
}

// Teto do reply exibido no chat: falas viram balões curtos (decisão do
// usuário), então o servidor corta em fronteira de sentença — não só o prompt.
const REPLY_CHAR_LIMIT = 220;

function capReplyLength(reply, limit = REPLY_CHAR_LIMIT) {
  if (reply.length <= limit) return reply;
  const window = reply.slice(0, limit);
  for (let i = window.length - 1; i >= 0; i -= 1) {
    if ('.!?;:'.includes(window[i])) return window.slice(0, i + 1).trimEnd();
  }
  const space = window.lastIndexOf(' ');
  return (space > 0 ? window.slice(0, space) : window).trimEnd();
}

// Extrai o valor da chave "reply" de JSON truncado/inválido: lê até a próxima
// aspa não escapada OU o fim da string (payload cortado no max_tokens),
// decodificando os escapes mais comuns. Retorna null sem conteúdo recuperável.
// A aspa de abertura da chave é opcional: modelos truncados já emitiram
// `{reply":"...` e o texto livre jamais deve chegar ao balão.
function extractReplyFromBrokenJson(text) {
  const keyMatch = /"?reply"?\s*:\s*"/.exec(text);
  if (!keyMatch) return null;
  let out = '';
  for (let i = keyMatch.index + keyMatch[0].length; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') break;
    if (ch === '\\') {
      const next = text[i + 1];
      if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) {
        out += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16));
        i += 5;
        continue;
      }
      if (next === 'n') { out += '\n'; i += 1; continue; }
      if (next === 't') { out += '\t'; i += 1; continue; }
      if (next && '"\\/bfr'.includes(next)) {
        out += next === 'b' ? '\b' : next === 'f' ? '\f' : next === 'r' ? '\r' : next;
        i += 1;
        continue;
      }
      // escape desconhecido: mantém o caractere, descarta a barra
      if (next) { out += next; i += 1; }
      continue;
    }
    out += ch;
  }
  return out.trim() || null;
}

export function parseProviderRaw(raw) {
  if (typeof raw !== 'string' || raw.length > 10000) {
    return { ok: false, status: 502, error: 'Resposta inválida do provedor.' };
  }
  let result;
  try {
    result = JSON.parse(raw.trim().replace(/^\`\`\`(?:json)?\s*/i, '').replace(/\s*\`\`\`$/, ''));
  } catch {
    const trimmed = raw.trim();
    // Preâmbulo de raciocínio antes do JSON: o primeiro objeto balanceado ainda
    // é a resposta. Sem isto o texto do "pensamento" inteiro viria no balão.
    const embedded = extractJsonCandidate(trimmed);
    if (embedded) {
      try {
        result = JSON.parse(embedded);
      } catch {
        result = null;
      }
    }
    if (!result) {
      // Se a resposta parece JSON de erro ({"error": ...}), tenta extrair a mensagem
      if (/^[{[]/.test(trimmed)) {
        try {
          const errorJson = JSON.parse(trimmed);
          if (errorJson?.error?.message) {
            return { ok: false, status: 502, error: errorJson.error.message };
          }
        } catch {}
      }
      if (trimmed.startsWith('{')) {
        // JSON truncado/inválido: recupera apenas o "reply". As actions de um
        // payload incompleto são descartadas (decisão do usuário) e o texto
        // bruto jamais vira reply — sem conteúdo recuperável, erro amigável.
        const salvaged = extractReplyFromBrokenJson(trimmed);
        if (!salvaged) {
          return { ok: false, status: 502, error: 'O modelo retornou uma resposta inválida.' };
        }
        return { ok: true, reply: capReplyLength(salvaged), gesture: 'neutral', actions: [], remember: null };
      }
      // Caso contrário, trata o texto bruto como resposta livre
      result = { reply: trimmed, gesture: 'neutral' };
    }
  }
  if (typeof result?.reply !== 'string' || !result.reply.trim() || result.reply.length > 2000) {
    return { ok: false, status: 502, error: 'O modelo retornou uma resposta inválida.' };
  }
  return { ok: true, reply: capReplyLength(result.reply.trim()), gesture: result.gesture === 'tilt' ? 'tilt' : 'neutral', actions: sanitizeActions(result.actions), remember: normalizeRemember(result.remember) };
}

export function createChatHandler(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const getKey = options.getKey || (async () => {
    // Tenta múltiplos arquivos .env candidatos para a chave OpenRouter.
    const candidates = [
      options.envPath,
      process.env.USAMI_KEYS_FILE,
      'A:/Usami Project/.env',
      'A:/Lira/LiraVtuber/.env',
    ].filter(Boolean);
    for (const envPath of candidates) {
      try {
        const parsed = parseEnv(await readFile(envPath, 'utf8'));
        if (parsed.OPENROUTER_API_KEY) return parsed.OPENROUTER_API_KEY;
      } catch {
        // arquivo ausente ou ilegível → tenta o próximo
      }
    }
    return null;
  });
  const allowedOrigins = options.allowedOrigins || DEFAULT_ALLOWED_ORIGINS;
  const model = options.model || process.env.OPENROUTER_MODEL || DEFAULT_MODEL;
  const systemBase = options.system || DEFAULT_SYSTEM;
  const now = options.now || (() => Date.now());
  // Testes injetam um depósito temporário; sem isso o handler do chat escreveria
  // em data/memory.json de verdade a cada npm test.
  const memoryStore = options.memoryStore || installMemoryStore;

  return async function handleChat(req, res) {
    const send = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify(data));
    };

    // Linha do tempo do turno (stageTimes logo abaixo)
    const chatStartedAt = now();

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
    let system = buildPersona({
      affinity: mem.affinity.score,
      coreFacts: mem.coreFacts,
      recentFacts: memoryStore.getRecentFacts(new Date().toISOString()),
      history: memoryStore.getTodayHistory(today),
      username: mem.user.nickname || 'você',
      date: today,
      timeOfDay,
    });

    // RAG: injeta contexto recente do vault Obsidian (respostas gravadas
    // pelo workflow n8n) no system prompt, se a Usami tiver permissão para
    // ler o vault.
    let ragContext = null;
    try {
      ragContext = await readRagContext();
    } catch {
      ragContext = null;
    }
    if (ragContext) {
      system += '\n\n--- Contexto recente do vault Obsidian (memória de longo prazo) ---\n' + ragContext + '\n--- Fim do contexto ---\n';
    }

    let parsed;
    let classification = null;
    let classificationPending = null;

    // Timeline da resposta: sem isto a latência é uma caixa-preta e qualquer
    // otimização vira chute. Um log por turno basta para ver quem manda.
    // As etapas SOMAM (+=): com o fallback NVIDIA→OpenRouter a tentativa do
    // NVIDIA (inclusive o tempo gasto até ela falhar) entra em llmMs junto da
    // chamada que produziu a resposta — o fallback fica visível, nunca escondido.
    const stageTimes = { context: 0, llm: 0, animation: 0, total: 0 };
    let stageAt = chatStartedAt;
    let nvidiaFailed = false;
    const mark = key => {
      const at = now();
      stageTimes[key] += at - stageAt;
      stageAt = at;
    };
    // Mede a chamada ao provedor diretamente (não o vão entre marks): o
    // `finally` conta também a tentativa que lança — é o custo do fallback.
    const timeStage = async (key, fn) => {
      const startedAt = now();
      try {
        return await fn();
      } finally {
        stageTimes[key] += now() - startedAt;
        stageAt = now();
      }
    };
    mark('context');

    if (useNvidia()) {
      // Fluxo NVIDIA: UMA chamada gera a fala junto das ações do avatar.
      try {
        // Classificação fora do caminho crítico: ela nunca participou da resposta
        // (o cliente deriva a emoção do texto localmente), só alimenta o webhook do
        // n8n. Esperá-la pagava o tempo da chamada mais lenta das duas e um slot
        // do rate limiter de 40 req/min.
        classificationPending = classifyUserMessage(parsedBody.message).catch(() => null);

        const rawReply = await timeStage('llm', () => generateReplyWithActions(
          withCapabilities(system, capabilities),
          parsedBody.message,
          { temperature: 0.7 },
        ));

        const parsedReply = parseProviderRaw(rawReply);
        if (!parsedReply.ok) throw new Error(parsedReply.error);

        // Sem ação nenhuma no JSON da geração: o diretor de animação roda em
        // background e o refino chega pela fila de comandos. Nunca bloqueia a
        // resposta — a fala já está na mão do cliente.
        if (!parsedReply.actions.length && capabilities) {
          void refineAnimationInBackground(parsedReply.reply, capabilities);
        }
        mark('animation');

        parsed = {
          ok: true,
          reply: parsedReply.reply,
          gesture: parsedReply.gesture,
          actions: parsedReply.actions,
          remember: parsedReply.remember,
          source: 'nvidia',
        };
      } catch (error) {
        nvidiaFailed = true;
        console.warn('NVIDIA falhou, tentando OpenRouter:', describeFetchError(error));
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
        // Sem nenhuma chave: resposta offline simples baseada no classificador local
        classification = await classifyUserMessage(parsedBody.message);
        const offlineReplies = {
          neutral: 'Oi! Estou aqui, mas ainda não configurei uma chave de LLM. Quer conversar mesmo assim?',
          happy: 'Oi! Estou bem feliz de te ver! 😊',
          sad: 'Oi... estou um pouco triste hoje. Você quer conversar sobre algo?',
          angry: 'Oi. Não estou no meu melhor momento, mas estou aqui.',
          shy: 'O-Oi... *corada*',
          soft: 'Oi, seja bem-vindo. Estou por aqui.',
          surprised: 'O-Oi! Não esperava você!',
          doubtful: 'Oi... você tem certeza que quer conversar comigo?',
        };
        const emotion = classification?.emotion || 'neutral';
        parsed = {
          ok: true,
          reply: offlineReplies[emotion] || offlineReplies.neutral,
          gesture: 'neutral',
          actions: [],
          remember: null,
          classification,
          source: 'offline',
        };
      } else {
        let response;
        try {
          response = await timeStage('llm', () => fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, max_tokens: 700, messages: [{ role: 'system', content: system }, { role: 'user', content: parsedBody.message }] }),
            signal: AbortSignal.timeout(45000),
          }));
        } catch (error) {
          console.warn('OpenRouter falhou:', describeFetchError(error));
          return send(502, { error: error?.name === 'TimeoutError' ? 'A solicitação expirou.' : 'Não foi possível acessar o provedor.' });
        }

        if (!response || !response.ok) {
          return send(502, { error: 'A OpenRouter recusou a solicitação ou está indisponível (HTTP ' + (response?.status ?? 0) + ').' });
        }

        let data;
        try {
          data = await timeStage('llm', () => response.json());
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
        // Contribuição da animação no caminho do balão: aqui só o pós-processamento
        // síncrono do provedor. O refino do diretor (quando há) é fire-and-forget
        // e é medido à parte em refineAnimationInBackground, fora do totalMs.
        mark('animation');
      }
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
    // offline. A classificação chega depois da resposta quando está em voo —
    // ela só alimenta este webhook, nunca o balão.
    const emitResponse = emotion => void sendToN8nWebhook('usami.response', {
      userMessage: parsedBody.message,
      reply: parsed.reply,
      gesture: parsed.gesture,
      actions,
      emotion,
      affinity: affinityPayload,
      source: parsed.source,
    });
    if (classificationPending) void classificationPending.then(emitResponse);
    else emitResponse(classification);

    const totalMs = now() - chatStartedAt;
    stageTimes.total = totalMs;
    console.log('[chat] inicio=' + chatStartedAt + ' fim=' + now()
      + ' llm=' + stageTimes.llm + 'ms animacao=' + stageTimes.animation
      + 'ms contexto=' + stageTimes.context + 'ms total=' + totalMs + 'ms fonte=' + parsed.source
      + (nvidiaFailed && parsed.source !== 'nvidia' ? ' (fallback: llmMs soma a tentativa NVIDIA + OpenRouter)' : ''));

    return send(200, {
      reply: parsed.reply, gesture: parsed.gesture, actions, source: parsed.source,
      // llmMs/animationMs/totalMs são lidos pelo navegador — não remover nem
      // renomear. contextMs é adição. animationMs é o que a animação custou
      // DENTRO do turno (pós-processamento síncrono); o refino do diretor é
      // fire-and-forget e aparece só no log [animacao], fora do totalMs.
      timing: { llmMs: stageTimes.llm, animationMs: stageTimes.animation, contextMs: stageTimes.context, totalMs },
      ...(affinityPayload || {}),
    });
  };
}

// --- Flow-based chat handler (n8n-style node graph) ---
export function createFlowChatHandler(options = {}) {
  const allowedOrigins = options.allowedOrigins || DEFAULT_ALLOWED_ORIGINS;

  return async function handleFlowChat(req, res) {
    const send = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
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
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
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

      const entry = queueAvatarCommand(cmd);
      if (!entry) {
        return send(400, { error: 'Comando inválido. Tipos válidos: say, gesture, set_expression, set_morph, set_mesh_visible, play_sequence.' });
      }

      return send(200, { ok: true, id: entry.id, queued: n8nCommandQueue.length });
    }

    return send(404, { error: 'Não encontrado.' });
  };
}

// --- RAG: contexto do vault Obsidian ---------------------------------------

export function createRagContextHandler(options = {}) {
  const allowedOrigins = options.allowedOrigins || DEFAULT_ALLOWED_ORIGINS;
  const vaultRelative = options.vaultRelative || process.env.USAMI_RAG_VAULT;

  return async function handleRagContext(req, res) {
    const send = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify(data));
    };

    const origin = req.headers.origin;
    const host = req.headers.host;
    if (!isAllowedOrigin(origin, host, allowedOrigins)) {
      return send(403, { error: 'Origem não autorizada.' });
    }

    if (req.method !== 'GET' || req.url !== '/api/rag/context') {
      return send(404, { error: 'Não encontrado.' });
    }

    const maxFiles = Number(req.headers['x-rag-max-files'] || 10);
    const maxCharsPerFile = Number(req.headers['x-rag-max-chars'] || 2000);
    const maxTotalChars = Number(req.headers['x-rag-max-total'] || 6000);

    let context;
    try {
      context = await readRagContext({
        vaultRelative,
        maxFiles,
        maxCharsPerFile,
        maxTotalChars,
      });
    } catch (error) {
      return send(500, { error: 'Erro ao ler contexto RAG: ' + error.message });
    }

    return send(200, {
      ok: true,
      context: context || '',
      hasContext: Boolean(context),
      source: 'vault-obsidian',
    });
  };
}

const DEFAULT_GEMINI_TTS_MODEL = 'gemini-2.5-flash-preview-tts';
const DEFAULT_GEMINI_TTS_VOICE = 'Kore';
// Direção de estilo em TAG entre colchetes, não em frase: transcrevendo o áudio
// com o whisper local, a instrução prosaica ("Leia em português do Brasil, com tom
// acolhedor e animado: ...") era FALADA pela modelo antes do texto — a Usami
// anunciava o próprio prompt. A tag entre colchetes muda a prosódia e nunca é lida.
const DEFAULT_GEMINI_TTS_INSTRUCTION = '[em português do Brasil, tom acolhedor e animado] ';
const DEFAULT_GEMINI_TTS_SAMPLE_RATE = 24000;
// Vozes desenhadas (Voice Design/Replication) têm id com prefixo voice_ e vão em
// voiceConfig.voice; pré-prontas (Kore, Puck...) permanecem em prebuiltVoiceConfig.
const CUSTOM_VOICE_PREFIX = 'voice_';
// Cláusulas de emoção por styleId, fundidas na tag; neutral e rótulos desconhecidos
// não têm cláusula — caem na tag base (determinístico).
const STYLE_INSTRUCTIONS = {
  happy: 'voz alegre e brilhante',
  sad: 'voz triste e suave',
  angry: 'voz firme e irritada',
  surprised: 'voz espantada',
  relaxed: 'voz calma e serena',
  soft: 'voz doce e meiga',
  shy: 'voz baixa e hesitante',
  doubtful: 'voz desconfiada',
};

// Monta a tag de estilo a partir da base configurada + cláusula da emoção. Uma base
// legada em prosa (GEMINI_TTS_INSTRUCTION do .env) é convertida para tag, senão
// voltaria a ser falada.
function buildGeminiInstruction(base, styleId) {
  const inner = String(base || '').trim()
    .replace(/:\s*$/, '')
    .replace(/^\[([\s\S]*)\]\s*$/, '$1')
    .trim();
  const clause = STYLE_INSTRUCTIONS[styleId];
  const tag = [inner, clause].filter(Boolean).join(', ');
  return tag ? `[${tag}] ` : '';
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

function geminiVoiceConfig(voice) {
  return String(voice || '').startsWith(CUSTOM_VOICE_PREFIX)
    ? { voice }
    : { prebuiltVoiceConfig: { voiceName: voice } };
}

function geminiSpeechBody({ text, voice }) {
  return {
    contents: [{ parts: [{ text }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: geminiVoiceConfig(voice) },
    },
  };
}

// Um evento SSE do provedor: `data: {...}`. Devolve o objeto ou null.
function parseSseEvent(event) {
  for (const line of event.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return null;
    try {
      return JSON.parse(payload);
    } catch {
      return null;
    }
  }
  return null;
}

// Voz em streaming: bombeia o PCM cru para a resposta na medida em que o provedor
// entrega. Nada é escrito em `res` antes do primeiro pedaço de áudio — enquanto
// não há áudio, o chamador ainda pode responder erro ou cair no caminho normal
// (que devolve o WAV inteiro). No fim devolve o PCM acumulado para o cache.
export async function streamGeminiPcm({
  fetchImpl = globalThis.fetch,
  geminiUrl,
  apiKey,
  model,
  voice,
  text,
  res,
  timeoutMs = 30000,
} = {}) {
  let response;
  try {
    response = await fetchImpl(geminiUrl + '/v1beta/models/' + encodeURIComponent(model) + ':streamGenerateContent?alt=sse', {
      method: 'POST',
      headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(geminiSpeechBody({ text, voice })),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { ok: false, reason: 'fetch-falhou' };
  }
  if (!response || !response.ok) {
    return { ok: false, reason: 'http-' + (response?.status ?? 0) };
  }
  const reader = response.body?.getReader?.();
  if (!reader) return { ok: false, reason: 'sem-corpo' };

  const segments = [];
  const decoder = new TextDecoder();
  let sampleRate = DEFAULT_GEMINI_TTS_SAMPLE_RATE;
  let buffer = '';
  let started = false;

  const feed = event => {
    const data = parseSseEvent(event);
    const inline = data?.candidates?.[0]?.content?.parts?.find(part => part?.inlineData?.data)?.inlineData;
    if (!inline) return;
    const segment = Buffer.from(inline.data, 'base64');
    if (!segment.length) return;
    if (!started) {
      sampleRate = parseGeminiSampleRate(inline.mimeType);
      // PCM cru little-endian, mono, no rate do provedor: o cliente monta o
      // AudioBuffer e toca. Sem header — o header só nasce no cache (WAV).
      res.writeHead(200, {
        'Content-Type': 'audio/l16; codec=pcm; rate=' + sampleRate,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-TTS-Stream': '1',
      });
      started = true;
    }
    segments.push(segment);
    res.write(segment);
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // O provedor separa eventos em CRLFCRLF; aceitar só LF deixaria o corpo
      // inteiro num único "evento" e a fala morria no primeiro pedaço de áudio.
      let split;
      while ((split = /\r?\n\r?\n/.exec(buffer)) !== null) {
        feed(buffer.slice(0, split.index));
        buffer = buffer.slice(split.index + split[0].length);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) feed(buffer);
  } catch (error) {
    // Canais quebrados no meio da fala: o que já saiu tocou. Não há como
    // voltar atrás na resposta iniciada, então fecha e registra.
    console.warn('tts: streaming interrompido:', error?.message || error);
    if (started) res.end();
    return { ok: false, reason: 'queda-no-meio' };
  }

  if (!started) return { ok: false, reason: 'sem-audio' };
  res.end();
  return { ok: true, pcm: Buffer.concat(segments), sampleRate };
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

  return async function handleTts(req, res) {
    const send = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
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
    // styleId conhecido ganha a cláusula da emoção; neutral/desconhecido fica na base.
    // Calculada antes da chave: mudar a direção de estilo muda a fala, e uma chave
    // que só vê o styleId serviria o áudio velho da cláusula anterior.
    const geminiInstruction = provider === 'gemini'
      ? buildGeminiInstruction(options.geminiInstruction || process.env.GEMINI_TTS_INSTRUCTION || DEFAULT_GEMINI_TTS_INSTRUCTION, parsedBody.styleId)
      : '';
    const cacheKey = cache ? createTtsCacheKey({
      provider,
      model: provider === 'gemini' ? geminiModel : model,
      voiceId: provider === 'gemini' ? geminiVoice : config.voiceId,
      styleId: parsedBody.styleId,
      instruction: geminiInstruction,
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
      // Voz em streaming (medido nesta máquina): o provedor entrega PCM em ~72 ms
      // por pedaço e a primeira amostra de áudio sai em ~1,0 s, contra ~5,3 s do
      // WAV completo. Falhou o stream (qualquer motivo antes do primeiro byte de
      // áudio)? Segue o caminho normal abaixo, que ainda responde.
      if (parsedBody.stream && provider === 'gemini') {
        const streamed = await streamGeminiPcm({
          fetchImpl,
          geminiUrl,
          apiKey: config.apiKey,
          model: geminiModel,
          voice: geminiVoice,
          text: geminiInstruction + parsedBody.text,
          res,
          timeoutMs,
        });
        if (streamed.ok) {
          if (cache && cacheKey) {
            try {
              await cache.put(cacheKey, pcmToWav(streamed.pcm, streamed.sampleRate));
            } catch {
              // Cache failures never make a successful synthesis fail.
            }
          }
          return;
        }
      }
      if (provider === 'gemini') {
        // a key vai apenas no header x-goog-api-key (nunca na URL); o prefixo de
        // instrução não conta no limite de 2000 chars, validado sobre o texto puro
        response = await fetchImpl(geminiUrl + '/v1beta/models/' + encodeURIComponent(geminiModel) + ':generateContent', {
          method: 'POST',
          headers: { 'x-goog-api-key': config.apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify(geminiSpeechBody({ text: geminiInstruction + parsedBody.text, voice: geminiVoice })),
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
        // O provedor já devolve um WAV completo (mimeType "audio/wav"), com chunk
        // `C2PA` de proveniência depois do `data`. Embrulhar isso num segundo
        // header declara os metadados como amostras: ~63 ms de ruído em fundo de
        // escala no fim de cada fala — o "estouro" que o Lucas ouviu. Passa
        // intacto; o parser de WAV do navegador anda pelos chunks e ignora o resto.
        const alreadyWav = pcm.length > 44
          && pcm.slice(0, 4).toString('ascii') === 'RIFF'
          && pcm.slice(8, 12).toString('ascii') === 'WAVE';
        audio = alreadyWav ? pcm : pcmToWav(pcm, parseGeminiSampleRate(inlineData.mimeType));
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
function withTimeout(promise, ms, message) {
  let timer;
  const wrapped = Promise.resolve(promise);
  wrapped.catch(() => {});
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(message);
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
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
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
      text = await withTimeout(transcribeImpl({ audioPath, modelName, language, beamSize, timeoutMs }), timeoutMs, 'Transcrição expirou.');
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

// --- POST /api/technique: ficha ingerida → técnica validada (Fase 3) --------

// A rota nunca inventa movimento: ela pega a ficha de ingestão (dado já validado
// pelo pipeline Python), pede ao modelo para estruturá-la e passa a saída pelo
// sanitize da técnica — que só conhece shapes da allowlist, gestos da biblioteca
// e clamps do próprio runtime. Técnica inválida não é gravada. Com `technique` no
// corpo, o operador pula o modelo: todo o resto do caminho (validação + gravação)
// é o mesmo, então a ferramenta funciona sem nenhum serviço externo.
const TECHNIQUE_BODY_LIMIT = 32 * 1024;
const TECHNIQUE_TIMEOUT_MS = Math.max(1000, Number(process.env.TECHNIQUE_TIMEOUT_MS) || 45000);

export function parseTechniqueRaw(raw) {
  const text = String(raw ?? '').trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '');
  if (!text || text.length > 20000) return { ok: false };
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false };
    return { ok: true, value };
  } catch {
    return { ok: false };
  }
}

export function parseTechniqueBody(raw) {
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return { ok: false, status: 400, error: 'JSON inválido.' };
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, status: 400, error: 'Corpo deve ser um objeto JSON.' };
  }
  const sourceId = typeof input.sourceId === 'string' ? input.sourceId.trim().slice(0, 64) : '';
  if (!sourceId) return { ok: false, status: 400, error: 'sourceId obrigatório (id da ficha de ingestão).' };
  if (input.technique !== undefined && input.technique !== null && typeof input.technique !== 'object') {
    return { ok: false, status: 400, error: 'technique deve ser um objeto.' };
  }
  return {
    ok: true,
    sourceId,
    technique: input.technique ?? null,
    dryRun: input.dryRun === true,
    status: typeof input.status === 'string' ? input.status : 'proposta',
  };
}

export function parseTechniqueNoteBody(raw) {
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return { ok: false, status: 400, error: 'JSON inválido.' };
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, status: 400, error: 'Corpo deve ser um objeto JSON.' };
  }
  const id = typeof input.id === 'string' ? input.id.trim() : '';
  if (!/^tc-[0-9a-f]{12}$/.test(id)) return { ok: false, status: 400, error: 'id de técnica inválido.' };
  const sourceId = typeof input.sourceId === 'string' ? input.sourceId.trim() : '';
  return { ok: true, id, sourceId: sourceId || null, vaultDir: typeof input.vaultDir === 'string' ? input.vaultDir : undefined };
}

export function createTechniqueHandler(options = {}) {
  const dataDir = options.dataDir || 'data';
  const store = options.store || createTechniqueStore({ dataDir });
  const readFicha = options.readFicha || (sourceId => readIngestedFicha(sourceId, { dataDir }));
  const llm = options.llm || (prompt => structureTechnique(prompt));
  const allowedOrigins = options.allowedOrigins || DEFAULT_ALLOWED_ORIGINS;
  const timeoutMs = options.timeoutMs || TECHNIQUE_TIMEOUT_MS;
  // O índice é derivado dos JSON: se ele falhar, a rota volta a ler a base
  // direto do disco. Nunca é fonte da verdade.
  const index = options.index || createTechniqueIndex({ dataDir });
  const writeNote = options.writeNote || writeTechniqueNote;

  return async function handleTechnique(req, res) {
    const send = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify(data));
    };

    const target = new URL(req.url || '/api/technique', 'http://127.0.0.1:8787');
    const route = target.pathname;
    if (!isAllowedOrigin(req.headers.origin, req.headers.host, allowedOrigins)) {
      return send(403, { error: 'Origem não autorizada.' });
    }

    // --- leitura (recuperação com proveniência) ---
    if (req.method === 'GET' && (route === '/api/technique' || route === '/api/techniques')) {
      if (route === '/api/techniques') {
        const statusFilter = target.searchParams.get('status');
        const wantsSearch = ['q', 'shape', 'tag', 'sourceId', 'limit'].some(key => target.searchParams.has(key));
        if (wantsSearch && index) {
          try {
            // O índice é derivado: re-indexar antes de buscar evita confiar em
            // estado de processo (a rota também serve um servidor de minutos).
            index.refresh();
            const results = index.search({
              query: target.searchParams.get('q') || '',
              shape: target.searchParams.get('shape') || undefined,
              tag: target.searchParams.get('tag') || undefined,
              status: statusFilter || undefined,
              sourceId: target.searchParams.get('sourceId') || undefined,
              limit: Number(target.searchParams.get('limit')) || undefined,
            });
            return send(200, { techniques: results, total: results.length, backend: 'index' });
          } catch (error) {
            // status inválido é erro de contrato do cliente, não motivo para
            // fingir que a busca não existe e devolver a lista inteira.
            if (/status de busca inválido/.test(String(error?.message))) {
              return send(400, { error: String(error.message) });
            }
            return send(500, { error: 'Índice de técnicas indisponível.' });
          }
        }
        const all = await store.list();
        const techniques = TECHNIQUE_STATUSES.includes(statusFilter)
          ? all.filter(technique => technique.status === statusFilter)
          : all;
        return send(200, { techniques: techniques.map(summarizeTechnique), total: techniques.length });
      }
      const id = target.searchParams.get('id') || '';
      const found = await store.get(id);
      if (!found.ok) return send(404, { error: found.errors.join('; ') });
      return send(200, { technique: found.technique });
    }

    if (req.method !== 'POST' || (route !== '/api/technique' && route !== '/api/technique/note')) {
      return send(404, { error: 'Não encontrado.' });
    }

    const contentType = (req.headers['content-type'] || '').split(';')[0].trim();
    if (contentType !== 'application/json') {
      return send(403, { error: 'Content-Type inválido.' });
    }

    let body = '';
    let tooLarge = false;
    for await (const chunk of req) {
      body += chunk;
      if (body.length > TECHNIQUE_BODY_LIMIT) {
        tooLarge = true;
        break;
      }
    }
    if (tooLarge) return send(413, { error: 'Corpo muito longo.' });

    // --- camada documental: JSON é a verdade, a nota é derivada e opcional ---
    if (route === '/api/technique/note') {
      const noteBody = parseTechniqueNoteBody(body);
      if (!noteBody.ok) return send(noteBody.status, { error: noteBody.error });
      const found = await store.get(noteBody.id);
      if (!found.ok) return send(404, { error: found.errors.join('; ') });
      const source = noteBody.sourceId ? await readFicha(noteBody.sourceId) : null;
      const written = await writeNote(found.technique, {
        vaultDir: noteBody.vaultDir,
        source: source?.ok ? source.ficha : undefined,
      });
      if (!written.ok) return send(422, { error: written.error });
      console.log(`[technique] nota ${written.path}`);
      return send(200, { path: written.path, techniqueId: noteBody.id });
    }

    const parsed = parseTechniqueBody(body);
    if (!parsed.ok) return send(parsed.status, { error: parsed.error });

    const loaded = await readFicha(parsed.sourceId);
    if (!loaded.ok) return send(404, { error: loaded.errors.join('; ') });
    const ficha = loaded.ficha;
    const sources = [{
      sourceId: ficha.id,
      kind: ficha?.source?.kind ?? null,
      title: ficha?.source?.title ?? null,
      schema: ficha?.schema ?? null,
    }];

    let engine;
    let candidate;
    if (parsed.technique) {
      engine = { provider: 'operador', model: 'manual' };
      candidate = parsed.technique;
    } else {
      let result;
      try {
        result = await withTimeout(llm(techniqueUserPrompt(ficha)), timeoutMs, 'Estruturação expirou.');
      } catch (error) {
        if (error?.message === 'no-llm-provider') {
          return send(503, { error: 'Nenhum provedor de LLM configurado — envie a técnica no campo `technique` ou configure a chave.' });
        }
        if (error?.name === 'TimeoutError') return send(504, { error: 'Estruturação expirou.' });
        return send(502, { error: `Falha no provedor de LLM: ${String(error?.message || error).slice(0, 200)}` });
      }
      const rawParsed = parseTechniqueRaw(result?.raw);
      if (!rawParsed.ok) return send(422, { error: 'Saída do modelo não é JSON de técnica.' });
      engine = { provider: result.provider, model: result.model };
      candidate = rawParsed.value;
    }

    const check = sanitizeTechnique(candidate, { sources, engine, status: parsed.status, now: options.now });
    if (!check.ok) return send(422, { error: 'Técnica rejeitada pela validação.', errors: check.errors, discarded: check.discarded });

    if (parsed.dryRun) return send(200, { technique: check.technique, stored: false, discarded: check.discarded });

    let saved;
    try {
      saved = await store.save(check.technique);
    } catch {
      return send(500, { error: 'Falha ao gravar a técnica.' });
    }
    if (!saved.ok) return send(422, { error: 'Técnica rejeitada ao gravar.', errors: saved.errors });
    console.log(`[technique] ${saved.technique.id} "${saved.technique.name}" <- ${parsed.sourceId} (${engine.provider}/${engine.model})`);
    return send(200, { technique: saved.technique, stored: true, discarded: check.discarded });
  };
}

// --- POST /api/plan: a base de conhecimento escolhe o movimento (Fase 5) ----

// Nada aqui fala com o avatar: o plano é devolvido ao cliente, que já tem o
// motion director e o manifesto de capacidades. O planner é determinístico e o
// histórico de aprendizagem entra na conta — por isso a rota não chama modelo.
const PLAN_BODY_LIMIT = 8 * 1024;

export function parsePlanBody(raw) {
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return { ok: false, status: 400, error: 'JSON inválido.' };
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, status: 400, error: 'Corpo deve ser um objeto JSON.' };
  }
  const request = {};
  for (const key of ['text', 'shape', 'tags', 'mood', 'intent']) {
    if (input[key] !== undefined) request[key] = input[key];
  }
  if (!request.intent) request.intent = intentFromText(request.text ?? '');
  const check = validatePlanRequest(request);
  if (!check.ok) return { ok: false, status: 400, error: check.errors.join('; ') };
  return { ok: true, request: check.value, capabilities: sanitizeCapabilities(input.capabilities) };
}

export function createPlannerHandler(options = {}) {
  const dataDir = options.dataDir || 'data';
  const techniques = options.techniques || (() => (options.store || createTechniqueStore({ dataDir })).list());
  const memory = options.memory || createLearningMemory({ dataDir });
  const allowedOrigins = options.allowedOrigins || DEFAULT_ALLOWED_ORIGINS;

  return async function handlePlan(req, res) {
    const send = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify(data));
    };
    if (!isAllowedOrigin(req.headers.origin, req.headers.host, allowedOrigins)) {
      return send(403, { error: 'Origem não autorizada.' });
    }
    const route = new URL(req.url || '/api/plan', 'http://127.0.0.1:8787').pathname;

    // A memória de aprendizagem é separada da conversacional: leitura para o
    // painel/auditoria e um único ponto de escrita (o veredito humano).
    if (req.method === 'GET' && route === '/api/learning') {
      try {
        return send(200, memory.export());
      } catch (error) {
        return send(500, { error: `Memória de aprendizagem ilegível: ${String(error?.message || error).slice(0, 200)}` });
      }
    }

    if (req.method !== 'POST') return send(404, { error: 'Não encontrado.' });
    const contentType = (req.headers['content-type'] || '').split(';')[0].trim();
    if (contentType !== 'application/json') return send(403, { error: 'Content-Type inválido.' });

    let body = '';
    let tooLarge = false;
    for await (const chunk of req) {
      body += chunk;
      if (body.length > PLAN_BODY_LIMIT) { tooLarge = true; break; }
    }
    if (tooLarge) return send(413, { error: 'Corpo muito longo.' });

    if (route === '/api/learning/verdict') {
      const verdict = parseLearningVerdict(body);
      if (!verdict.ok) return send(verdict.status, { error: verdict.error });
      try {
        const record = memory.noteVisualVerdict(verdict.value);
        return send(200, { record });
      } catch (error) {
        return send(422, { error: `Veredito rejeitado: ${String(error?.message || error).slice(0, 200)}` });
      }
    }

    if (route !== '/api/plan') return send(404, { error: 'Não encontrado.' });
    const parsed = parsePlanBody(body);
    if (!parsed.ok) return send(parsed.status, { error: parsed.error });

    let plan;
    try {
      plan = await planAnimationSelection(parsed.request, {
        techniques,
        capabilities: parsed.capabilities,
        memory,
        now: options.now,
      });
    } catch (error) {
      return send(422, { error: `Planner recusou o pedido: ${String(error?.message || error).slice(0, 200)}` });
    }
    console.log(`[plan] ${explainPlan(plan)}`);
    return send(200, { plan, actions: planToActions(plan), explanation: explainPlan(plan) });
  };
}

const VERDICT_NOTE_LIMIT = 500;

export function parseLearningVerdict(raw) {
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return { ok: false, status: 400, error: 'JSON inválido.' };
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, status: 400, error: 'Corpo deve ser um objeto JSON.' };
  }
  const note = input.note === undefined || input.note === null
    ? undefined
    : (typeof input.note === 'string' ? input.note.slice(0, VERDICT_NOTE_LIMIT) : null);
  if (note === null) return { ok: false, status: 400, error: 'note deve ser texto.' };
  return {
    ok: true,
    value: { techniqueId: input.techniqueId, signature: input.signature, verdict: input.verdict, note },
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
  const handleRagContext = createRagContextHandler();
  const handleTechnique = createTechniqueHandler();
  const handlePlan = createPlannerHandler();
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/chat') return handleChat(req, res);
    if (req.method === 'POST' && req.url === '/api/tts') return handleTts(req, res);
    if (req.method === 'POST' && req.url === '/api/stt') return handleStt(req, res);
    if (req.method === 'POST' && req.url === '/api/n8n/command') return handleN8nCommand(req, res);
    if (req.method === 'GET' && req.url === '/api/n8n/commands') return handleN8nCommand(req, res);
    if (req.method === 'DELETE' && req.url === '/api/n8n/commands') return handleN8nCommand(req, res);
    if (req.method === 'GET' && req.url === '/api/rag/context') return handleRagContext(req, res);
    if (req.url === '/api/technique' || req.url === '/api/techniques' || req.url === '/api/technique/note'
      || req.url.startsWith('/api/technique?') || req.url.startsWith('/api/techniques?')) return handleTechnique(req, res);
    if (req.url === '/api/plan' || req.url === '/api/learning' || req.url === '/api/learning/verdict'
      || req.url.startsWith('/api/learning?')) return handlePlan(req, res);
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify({ error: 'Não encontrado.' }));
  });
  server.listen(8787, '127.0.0.1', () => console.log('Usami API local em 127.0.0.1:8787'));
}
