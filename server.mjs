import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { pathToFileURL } from 'node:url';
import { resolve as pathResolve } from 'node:path';
import { createFileTtsCache, createTtsCacheKey } from './src/tts-cache.js';
import { STYLE_INSTRUCTIONS, resolveGeminiStyleClause } from './src/tts-prosody.js';
import { createStaticAssetHandler } from './src/avatar-cache.js';
import { GESTURE_NAMES, SHAPE_NAMES } from './src/motion-director.js';
import { removeTempAudio, saveTempAudio, transcribeAudio } from './src/stt.js';
import { buildPersona, getAffinityStage } from './src/persona.js';
import { createPersonalityStore, normalizePersonality, TRAITS, CUSTOM_PROMPT_MAX } from './src/personality-store.js';
import { extractSpeechTags } from './src/speech-tags.js';
import { createMemoryStore, MEMORY_SECTIONS } from './src/memory-store.js';
import { calculateGain, applyGain, getStage, DAILY_CAP } from './src/affinity.js';
import { createBondStore } from './src/bond-store.js';
import { createOperationalMemoryStore, OPERATIONAL_DEFAULT_LIMIT, OPERATIONAL_MAX_LIMIT } from './src/operational-memory-store.js';
import { EXECUTION_ORIGINS, OPERATIONAL_KINDS, OPERATIONAL_STATUSES, PLAN_ORIGINS } from './src/agent-contracts.js';
import { createToolRegistry } from './src/tool-registry.js';
import { createToolExecutor, EXECUTIONS_DEFAULT_LIST, EXECUTIONS_LIMIT } from './src/tool-executor.js';
import { createMemorySearchTool } from './src/memory-search-tool.js';
import { CONFIRMATION_WORD, createPermissionGate } from './src/permission-gate.js';
import { PLAN_LIST_DEFAULT_LIMIT, PLAN_LIST_MAX_LIMIT, createTaskPlanner, parseBriefingThreshold } from './src/task-planner.js';
import { createSkillCatalog } from './src/skill-catalog.js';
import { createSkillManager } from './src/skill-manager.js';
import { createPersonalPlannerTools, publishPersonalPlannerSkill } from './src/personal-planner-skill.js';
import { createAgentCore } from './src/agent-core.js';
import { createAchievementsStore } from './src/achievements-store.js';
import { buildServices } from './src/flow-services.js';
import { createFlowExecutor } from './src/flow-executor.js';
import { classifyEmotion, DEFAULT_CONFIDENCE_THRESHOLD } from './src/emotion-classifier.js';
import { createEmotionEngine } from './src/emotion-engine.js';
import { createExpressionDriver } from './src/expression-driver.js';
import { createVrmGestureLayer } from './src/vrm-gesture-layer.js';
import { classifyUserMessage, describeFetchError, generateReplyWithActions, planAnimation, structureTechnique, summarizeDay } from './src/llm-router.js';
import { summarizePendingDays } from './src/memory-summaries.js';
import { readRagContext, resolveVaultDir } from './src/rag.js';
import { createVaultIndex } from './src/vault-index.js';
import { createTechniqueStore, readIngestedFicha } from './src/technique-store.js';
import { checkApiToken, isAllowedRequest, keysFilePath, readApiToken, readEnvValue, signWebhook, withExtraOrigins } from './src/api-security.js';
import { SemaphoreRejected, createSemaphore } from './src/semaphore.js';
import { createTechniqueIndex } from './src/technique-index.js';
import { writeTechniqueNote } from './src/technique-docs.js';
import { planAnimationSelection, planToActions, explainPlan, validatePlanRequest, intentFromText } from './src/animation-planner.js';
import { createLearningMemory } from './src/learning-memory.js';
import { generateLocalSurfaceReflex } from './src/surface-reflex.js';
import { createProactiveEngine } from './src/proactive-engine.js';
import { createProactiveStore } from './src/proactive-events.js';
import { TECHNIQUE_STATUSES, sanitizeTechnique, summarizeTechnique, techniqueUserPrompt } from './src/technique-schema.js';
import { analyzeMedia } from './src/media-analyzer.js';
import { createN8nCommandQueue, normalizeClientId } from './src/n8n-queue.js';
import { dataDir as resolveDataDir, sttTmpDir, ttsCacheDir } from './src/data-paths.js';
import { filterActionsByCatalog, parseJsonLoosely, parseProviderRaw, sanitizeActions, sanitizeCapabilities, stripCodeFence, stripLeakedJson, stripStageDirections, SPEECH_TRIGGERS } from './src/provider-parse.js';

// Compatibilidade (B12): estes nomes viveram aqui e são importados por testes
// e chamadores antigos; a implementação agora é o módulo puro de src/.
export { filterActionsByCatalog, parseProviderRaw, sanitizeActions, sanitizeCapabilities, stripLeakedJson, stripStageDirections, SPEECH_TRIGGERS } from './src/provider-parse.js';

export const DEFAULT_MODEL = process.env.OPENROUTER_MODEL || 'nvidia/nemotron-3-ultra-550b-a55b:free';
// USE_NVIDIA=false desliga a rota NVIDIA mesmo com chave presente (isolamento de testes);
// ausente/true: auto-detecção (env direto ou .env do projeto). Avaliado por chamada.
export function useNvidia() {
  if (process.env.USE_NVIDIA === 'false') return false;
  return (process.env.USE_NVIDIA === 'true') || Boolean(process.env.NVIDIA_API_KEY || nvidiaKeyConfigured());
}
const USE_NVIDIA = useNvidia();

// Verifica se a chave NVIDIA está configurada (env ou .env do projeto), sem fazer chamada de API.
function nvidiaKeyConfigured() {
  return Boolean(readEnvValue('NVIDIA_API_KEY'));
}

// Exporta a chave NVIDIA para o ambiente do processo, para que o
// nvidia-client.js (que lê process.env.NVIDIA_API_KEY) a encontre.
if (USE_NVIDIA && !process.env.NVIDIA_API_KEY) {
  const nvidiaKey = readEnvValue('NVIDIA_API_KEY');
  if (nvidiaKey) process.env.NVIDIA_API_KEY = nvidiaKey;
}

const DEFAULT_SYSTEM = `Você é Usami, uma companion acolhedora, curiosa e natural. Responda em português de forma breve. Não incentive dependência emocional ou exclusividade. Responda SOMENTE JSON: {"reply":"resposta","gesture":"neutral" ou "tilt","actions":[{"type":"gesture","name":"um de: ${GESTURE_NAMES.join(', ')}"},{"type":"play_clip","name":"Nome do clip"},{"type":"set_morph","name":"Nome do morph","value":0 a 1},{"type":"set_mesh_visible","name":"Nome de mesh acessório","visible":true ou false},{"type":"play_sequence","shape":"um de: ${SHAPE_NAMES.join(', ')}","amplitude":0.02 a 0.5,"cycles":1 a 8,"durationMs":600 a 8000,"side":"left" ou "right"}]}. Actions é opcional e pode ser vazio; no máximo 5 ações. play_sequence compõe movimento novo a partir de uma shape; use apenas se capabilities.sequences for true. NUNCA coloque nomes de morphs, prefabs ou anotações técnicas dentro do campo "reply": "reply" contém APENAS o diálogo falado em português.`.trim();

// Orçamento de tempo do turno do chat. A NVIDIA recebe uma fatia (NVIDIA_BUDGET)
// e o OpenRouter fica com o que sobrar até o deadline (mínimo FALLBACK_MIN), em
// vez de somar 45 s + 45 s: o pior caso do turno é TURN_DEADLINE, não ~90 s.
const envMs = (name, fallback) => Math.max(1000, Number(process.env[name]) || fallback);
const TURN_DEADLINE_MS = envMs('USAMI_TURN_DEADLINE_MS', 40000);
const NVIDIA_BUDGET_MS = envMs('USAMI_NVIDIA_BUDGET_MS', 25000);
const FALLBACK_MIN_MS = 8000;
// Hedge: se a NVIDIA não responder neste tempo, o OpenRouter entra em paralelo
// e vence quem responder primeiro (o perdedor é abortado). 0 desliga a corrida
// e volta ao fallback sequencial. 7 s cobre os turnos normais (3–12 s) sem
// pagar uma segunda chamada em todo turno.
const HEDGE_AFTER_MS = (() => {
  const raw = process.env.USAMI_HEDGE_MS;
  if (raw === undefined || raw === '') return 7000;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : 7000;
})();

const DEFAULT_ALLOWED_ORIGINS = withExtraOrigins(['http://127.0.0.1:5173', 'http://localhost:5173']);

// Heurística do "remember": sinais de fato durável → núcleo; o resto é recente.
const DURABLE_FACT = /\b(anivers[áa]rio|gosta|tem|nome)\b|\b\d{1,2}\/\d{1,2}\b/i;

// Fila de comandos vindos do n8n (n8n → Usami) e do refino de animação do
// próprio turno. O cliente (Usami.jsx) consome via GET /api/n8n/commands com
// `x-usami-client` e aplica no avatar localmente (gesto, expressão, morph,
// visibilidade de mesh). A fila é por cliente (B6): duas abas não roubam mais
// comandos uma da outra; o GET marca entregue e o cliente confirma via
// POST /api/n8n/commands/ack. Sem redelivery: entregue e não confirmado é
// podado após 120 s com log.
const sharedN8nQueue = createN8nCommandQueue();

// Comando válido para controle direto do avatar (executado pelo cliente).
const VALID_COMMAND_TYPES = new Set([
  'say',           // diz algo (usa /api/chat internamente)
  'proactive_say', // fala proativa da Usami (balão + áudio direto no cliente)
  'gesture',       // gesture: tilt | wave | idle
  'set_expression',// expressão VRM com peso
  'set_morph',     // morph target com valor
  'set_mesh_visible',// mostra/esconde mesh acessório
  'play_sequence', // sequência a partir de shape paramétrica
]);

function isValidN8nCommand(cmd) {
  if (!cmd || typeof cmd !== 'object' || Array.isArray(cmd)) return false;
  if (!VALID_COMMAND_TYPES.has(cmd.type)) return false;
  if ((cmd.type === 'say' || cmd.type === 'proactive_say') && typeof cmd.message !== 'string') return false;
  if (['gesture', 'set_expression', 'set_morph', 'set_mesh_visible'].includes(cmd.type) && typeof cmd.name !== 'string') return false;
  if (cmd.type === 'gesture' && !GESTURE_NAMES.includes(cmd.name)) return false;
  if (cmd.type === 'play_sequence' && !SHAPE_NAMES.includes(cmd.shape)) return false;
  return true;
}

// Único ponto de entrada da fila: valida, carimba id/timestamp e empurra.
// Usado pelo n8n (POST), pelo refino de animação do turno e pela proatividade.
// O spread do corpo vem ANTES dos carimbos (B6): um POST com `id`/`timestamp`
// forjados não consegue sobrescrever o id/timestamp gerados no servidor.
// `clientId` ausente = fanout (comando do n8n sem cliente identificado).
export function queueAvatarCommand(cmd, { clientId = null, queue = sharedN8nQueue } = {}) {
  if (!isValidN8nCommand(cmd)) return null;
  const entry = {
    ...cmd,
    id: Math.random().toString(36).slice(2, 10),
    timestamp: new Date().toISOString(),
  };
  // null = comando sem dono (fanout/pendente); string = fila daquele cliente.
  queue.enqueue(entry, { clientId: clientId ? normalizeClientId(clientId) : null });
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
export async function refineAnimationInBackground(reply, capabilities, { planner = planAnimation, clientId = null, queue = sharedN8nQueue } = {}) {
  const startedAt = Date.now();
  try {
    const { actions } = await planner(reply, capabilities, { temperature: 0.3 });
    const queued = filterActionsByCatalog(actions ?? [], capabilities)
      .map(action => queueAvatarCommand(action, { clientId, queue }))
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
const installMemoryStore = createMemoryStore({ dataDir: resolveDataDir() });
try {
  installMemoryStore.load();
} catch {
  console.error('Aviso: memória local indisponível — o chat segue sem contexto persistido.');
}

// Ajustes de personalidade (data/personality.json). Mesmo diretório da memória,
// então os testes seguem isolados em USAMI_DATA_DIR.
const installPersonalityStore = createPersonalityStore({ dataDir: resolveDataDir() });
installPersonalityStore.load();

// Vínculo (data/bond.json): medidores do VN e histórico de momentos. Desde a
// frente D o core calcula o XP, então web e desktop leem o mesmo estado.
const installBondStore = createBondStore({ dataDir: resolveDataDir() });
try {
  installBondStore.load();
} catch {
  console.error('Aviso: vínculo local indisponível — os medidores do VN ficam zerados.');
}
// Espelho inicial em memory.json: instalações que já tinham medidores passam a
// mostrá-los na aba Memória sem esperar um novo evento de vínculo.
try {
  installMemoryStore.setBondMirror(installBondStore.getAll());
} catch (error) {
  console.error('Aviso: espelho do vínculo na memória indisponível:', error?.message || error);
}

// Conquistas (data/achievements.json): só os desbloqueios; o catálogo é puro
// (achievements.js) e as condições olham o estado real do vínculo acima.
const installAchievementsStore = createAchievementsStore({ dataDir: resolveDataDir() });
try {
  installAchievementsStore.load();
} catch {
  console.error('Aviso: conquistas locais indisponíveis — a lista volta vazia.');
}

// Memória operacional do domínio agêntico (data/operational-memory.json):
// projetos, tarefas e compromissos. Separada de memory.json; rotas em
// /api/agent/memory com a mesma borda Host/Origin + token.
const installOperationalStore = createOperationalMemoryStore({ dataDir: resolveDataDir() });
try {
  installOperationalStore.load();
} catch (error) {
  console.error('Aviso: memória operacional indisponível:', error?.message || error);
}

// Ferramentas do domínio agêntico: registry + gate de permissões + executor com
// histórico auditável (data/executions.json e data/permissions.json).
const toolRegistry = createToolRegistry();
const memorySearchRegistration = toolRegistry.register(createMemorySearchTool({ memoryStore: installMemoryStore }));
if (!memorySearchRegistration.ok) {
  console.error('Aviso: ferramenta memory.search não registrada:', memorySearchRegistration.errors.join('; '));
}
const installToolGate = createPermissionGate({ registry: toolRegistry, dataDir: resolveDataDir() });
try {
  installToolGate.load();
} catch {
  // load() já loga o aviso; o gate nega execuções até o arquivo ser corrigido.
}
const installToolExecutor = createToolExecutor({ registry: toolRegistry, gate: installToolGate, dataDir: resolveDataDir() });
installToolExecutor.load();

// Planner Engine de tarefas (data/plans/<pl-id>.json): objetivo vira plano com
// versões; distinto de /api/plan (animação). O limiar do briefing é ajustável
// por USAMI_PLAN_BRIEFING_THRESHOLD.
const installTaskPlanner = createTaskPlanner({
  dataDir: resolveDataDir(),
  briefingThreshold: parseBriefingThreshold(process.env.USAMI_PLAN_BRIEFING_THRESHOLD),
});
try {
  installTaskPlanner.load();
} catch (error) {
  console.error('Aviso: planner de tarefas indisponível:', error?.message || error);
}

// Skill Personal Planner (S10): publica manifesto versionado no diretório de
// skills do runtime (sem tocar data/ em testes) e registra suas ferramentas
// conectando S3 (memória operacional) e S6 (Task Planner) via S4/S5.
try {
  publishPersonalPlannerSkill({ dataDir: resolveDataDir() });
} catch (error) {
  console.error('Aviso: publicação do manifesto personal-planner falhou:', error?.message || error);
}
for (const plannerTool of createPersonalPlannerTools({
  operationalStore: installOperationalStore,
  taskPlanner: installTaskPlanner,
})) {
  const registered = toolRegistry.register(plannerTool);
  if (!registered.ok) {
    console.error(`Aviso: ferramenta ${plannerTool.name} não registrada:`, registered.errors.join('; '));
  }
}

// Catálogo de Skills (data/skills/<id>/skill.json): descoberta somente leitura.
// A ativação é derivada do estado do manifesto, do registry e das dependências;
// o código da skill nunca é importado.
const installSkillCatalog = createSkillCatalog({
  dataDir: resolveDataDir(),
  registry: toolRegistry,
});
const installSkillManager = createSkillManager({
  catalog: installSkillCatalog,
  gate: installToolGate,
  dataDir: resolveDataDir(),
});
try {
  installSkillManager.load();
} catch (error) {
  console.error('Aviso: gerenciador de skills indisponível:', error?.message || error);
}

const installAgentCore = createAgentCore({
  registry: toolRegistry,
  executor: installToolExecutor,
  planner: installTaskPlanner,
  skillCatalog: installSkillCatalog,
  turnDeadlineMs: TURN_DEADLINE_MS,
});

// Store persistente de eventos proativos da Usami (<proactive-events.json>).
const installProactiveStore = createProactiveStore({
  dataDir: resolveDataDir(),
  vaultDir: resolveVaultDir(process.env.USAMI_PROACTIVE_VAULT || process.env.USAMI_RAG_VAULT),
});

// Motor de proatividade da Usami (<开口> / idle triggers).
export const proactiveEngine = createProactiveEngine({
  affinityProvider: () => (installMemoryStore.getAll()?.affinity?.score ?? 0),
  usernameProvider: () => (installMemoryStore.getAll()?.user?.nickname || 'você'),
  onProactiveSay: (cmd) => {
    // A1: envia para o store persistente que o desktop consome
    installProactiveStore.addEvent({
      type: cmd.type === 'idle_nudge' ? 'idle_nudge' : 'greeting',
      source: 'api_scheduler',
      text: cmd.message,
      emotion: cmd.emotion,
      gesture: cmd.gesture,
      dedupeKey: `auto_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    });
    queueAvatarCommand({
      type: 'proactive_say',
      message: cmd.message,
      emotion: cmd.emotion,
      gesture: cmd.gesture,
    });
  },
});

// Índice FTS5 do vault (Inbox/Responses). Criado na primeira busca para não
// abrir SQLite só por importar o módulo; o diretório de dados é o mesmo da
// memória, então os testes continuam isolados em USAMI_DATA_DIR.
let sharedVaultIndex = null;
function getVaultIndex() {
  if (!sharedVaultIndex) {
    sharedVaultIndex = createVaultIndex({
      vaultDir: resolveVaultDir(process.env.USAMI_RAG_VAULT),
      dataDir: resolveDataDir(),
    });
  }
  return sharedVaultIndex;
}

// Serviços de domínio + FlowExecutor (grafo de nós estilo n8n)
const emotionEngine = createEmotionEngine({
  driver: createExpressionDriver({ setRaw: () => { }, now: () => Date.now() }),
});
const gestureLayer = createVrmGestureLayer({ now: () => Date.now() });
const services = buildServices({
  fetchImpl: globalThis.fetch,
  getKey: async () => {
    const parsed = parseEnv(await readFile(keysFilePath(), 'utf8'));
    return parsed.OPENROUTER_API_KEY || null;
  },
  model: DEFAULT_MODEL,
  memoryStore: installMemoryStore,
  classifyEmotion,
  emotionEngine,
  expressionDriver: createExpressionDriver({ setRaw: () => { }, now: () => Date.now() }),
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
  return readEnvValue('N8N_WEBHOOK_URL') || 'http://localhost:5678/webhook/usami-events';
}

const N8N_WEBHOOK_URL = resolveN8nWebhookUrl();

// Campos com texto da conversa; N8N_WEBHOOK_OMIT_TEXT=true os tira do webhook.
const N8N_TEXT_FIELDS = ['userMessage', 'reply'];

// Com N8N_WEBHOOK_SECRET o corpo sai assinado (X-Usami-Timestamp +
// X-Usami-Signature = HMAC-SHA256 de "<timestamp>.<corpo>"); o n8n deve
// recusar assinatura inválida e timestamp antigo. Sem segredo, sai sem assinatura.
export async function sendToN8nWebhook(eventType, payload) {
  try {
    const data = { ...payload };
    if (readEnvValue('N8N_WEBHOOK_OMIT_TEXT') === 'true') {
      for (const field of N8N_TEXT_FIELDS) delete data[field];
    }
    const timestamp = new Date().toISOString();
    const body = JSON.stringify({ event: eventType, timestamp, ...data });
    const headers = { 'Content-Type': 'application/json' };
    const secret = readEnvValue('N8N_WEBHOOK_SECRET');
    if (secret) {
      headers['X-Usami-Timestamp'] = timestamp;
      headers['X-Usami-Signature'] = signWebhook(secret, timestamp, body);
    }
    await fetch(N8N_WEBHOOK_URL, {
      method: 'POST',
      headers,
      body,
      // Não aguarda resposta; o n8n pode estar offline sem afetar o chat.
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    // Silencioso por design: automação é opcional.
  }
}

// Host e Origin precisam estar na allowlist fechada (src/api-security.js). A
// regra antiga "Origin == Host" aceitava DNS rebinding: o atacante controla os
// dois. Origens/hosts extras (LAN, terminal.local): USAMI_ALLOWED_ORIGINS e
// USAMI_ALLOWED_HOSTS.
export function isAllowedOrigin(origin, host, allowedOrigins = DEFAULT_ALLOWED_ORIGINS) {
  return isAllowedRequest(origin, host, allowedOrigins);
}

// Rotas sensíveis (memória, vault, fila do n8n) exigem também o token.
function denyWithoutToken(req, options, send) {
  const configuredToken = options && 'apiToken' in options ? options.apiToken : readApiToken();
  const denied = checkApiToken(req, configuredToken);
  if (!denied) return false;
  send(denied.status, { error: denied.error });
  return true;
}

// Leitor de body único das rotas /api. Acumula Buffers (`body += chunk`
// decodifica cada pedaço isolado e um multibyte partido na fronteira vira U+FFFD)
// e decodifica UMA vez no fim. Ao exceder o limite, drena o restante com
// req.resume() em vez de `break`: `break` num for-await fecha o IncomingMessage e
// o 413/queixa morre no socket, então o cliente nunca recebe a resposta.
export async function readBodyBuffer(req, { limit = 8192 } = {}) {
  const chunks = [];
  let total = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (tooLarge) continue;
    total += buffer.length;
    if (total > limit) {
      tooLarge = true;
      chunks.length = 0; // o excesso já decidiu; não guarda o corpo
      req.resume?.();
      continue;
    }
    chunks.push(buffer);
  }
  if (tooLarge) return { ok: false, status: 413 };
  return { ok: true, buffer: Buffer.concat(chunks) };
}

export async function readRequestBody(req, { limit = 8192 } = {}) {
  const result = await readBodyBuffer(req, { limit });
  if (!result.ok) return result;
  return { ok: true, body: result.buffer.toString('utf8') };
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

// Erro de provedor com status HTTP próprio: o handler devolve a mensagem ao
// cliente em vez de fingir que foi falha da NVIDIA.
function providerError(message, httpStatus = 502) {
  return Object.assign(new Error(message), { httpStatus });
}

// Corrida entre provedores. A NVIDIA começa na hora; se não tiver respondido em
// `hedgeMs`, o fallback entra em paralelo (se `hedgeMs` for 0, a corrida vira
// sequencial: o fallback só começa quando a NVIDIA falha). Vence o primeiro que
// trouxer resposta e o perdedor é abortado — sem isso o hedge só somaria custo.
// Falha de um lado não encerra a corrida enquanto o outro estiver pendente.
async function raceProviders({ hedgeMs, startPrimary, startFallback, abortPrimary, abortFallback, onHedge }) {
  const settled = {};
  let notify;
  let changed = new Promise(resolve => { notify = resolve; });
  const settle = (name, outcome) => {
    settled[name] = outcome;
    const resume = notify;
    changed = new Promise(resolve => { notify = resolve; });
    resume();
  };
  const launch = (name, start) => Promise.resolve().then(start).then(
    value => settle(name, { ok: true, value }),
    error => settle(name, { ok: false, error }),
  );

  launch('primary', startPrimary);
  let fallback = null;
  const startFallbackOnce = (hedged = false) => {
    if (!fallback) {
      if (hedged) onHedge?.();
      fallback = launch('fallback', startFallback);
    }
    return fallback;
  };
  const timer = hedgeMs > 0 ? setTimeout(() => startFallbackOnce(true), hedgeMs) : null;
  timer?.unref?.();

  for (; ;) {
    if (settled.primary?.ok) {
      clearTimeout(timer);
      abortFallback?.();
      return settled.primary.value;
    }
    if (settled.fallback?.ok) {
      clearTimeout(timer);
      abortPrimary?.();
      return settled.fallback.value;
    }
    // A NVIDIA falhou antes do hedge: não há por que esperar o cronômetro.
    if (settled.primary && !fallback) startFallbackOnce();
    if (settled.primary && settled.fallback && !settled.primary.ok && !settled.fallback.ok) {
      clearTimeout(timer);
      settled.fallback.error.fallbackAttempted = true;
      throw settled.fallback.error;
    }
    await changed;
  }
}

// O reflexo local (Surface Reflex) já foi falado antes da chamada ao provedor;
// o texto precisa continuar a conversa em vez de repetir a abertura.
function withSurfaceReconciliation(system, surface) {
  if (surface?.mode !== 'say+think' || !surface.reply) return system;
  return system + `\n\n=== RECONCILIAÇÃO DO REFLEXO IMEDIATO ===\nVocê acabou de soltar a seguinte reação espontânea em voz alta: "${surface.reply.trim()}"\nO usuário JÁ OUVIU essa frase.\n1. NÃO repita e NÃO parafraseie essa frase de abertura.\n2. No JSON de resposta, o campo "reply" deve conter APENAS a continuação da conversa.\n`;
}

export const VOICE_REPLY_NOTE = '=== MODO VOZ (RESPOSTA FALADA CONCISA) ===\nO usuário falou por voz. Responda em cerca de 2 a 4 frases curtas e conversacionais para soar natural na voz, a menos que ele peça uma história ou explicação longa.';

export function withSpokenConciseness(system, { spoken = false, message = '' } = {}) {
  if (!spoken) return system;
  if (/\b(hist[óo]ria|conta tudo|explica detalhad|passo a passo|longo|detalhes)\b/i.test(String(message || ''))) {
    return system;
  }
  return system + '\n\n' + VOICE_REPLY_NOTE + '\n';
}

export function createChatHandler(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const getKey = options.getKey || (async () => {
    // options.envPath (testes) substitui o .env do projeto.
    try {
      const parsed = parseEnv(await readFile(options.envPath || keysFilePath(), 'utf8'));
      return parsed.OPENROUTER_API_KEY || null;
    } catch {
      return null;
    }
  });
  const allowedOrigins = options.allowedOrigins || DEFAULT_ALLOWED_ORIGINS;
  const model = options.model || process.env.OPENROUTER_MODEL || DEFAULT_MODEL;
  const systemBase = options.system || DEFAULT_SYSTEM;
  const now = options.now || (() => Date.now());
  // Injetável para os testes exercitarem o hedge sem bater na NVIDIA.
  const generateReply = options.generateReply || generateReplyWithActions;
  const hedgeAfterMs = options.hedgeAfterMs ?? HEDGE_AFTER_MS;
  // Testes injetam um depósito temporário; sem isso o handler do chat escreveria
  // em data/memory.json de verdade a cada npm test.
  const memoryStore = options.memoryStore || installMemoryStore;
  const personalityStore = options.personalityStore || installPersonalityStore;
  const proactive = options.proactiveEngine || proactiveEngine;
  const agentCore = options.agentCore ?? null;
  // Fila de comandos do refino: o comando do chat vai para a MESMA aba que
  // pediu o turno (x-usami-client), não para a primeira que pollar.
  const n8nQueue = options.n8nQueue || sharedN8nQueue;
  // Contador atômico de turnos em andamento: com um booleano, dois turnos
  // sobrepostos (duas abas) liberavam o motor proativo quando o primeiro
  // terminava, mesmo com o segundo ainda rodando.
  let activeTurns = 0;
  // Injetável para os testes não varrerem o vault real: o padrão consulta o
  // índice FTS5 e, se ele falhar ou voltar vazio, mantém o leitor antigo.
  const searchVault = options.vaultSearch || (async (query) => {
    try {
      const context = getVaultIndex().search({ query });
      if (context) return context;
    } catch {
      // índice indisponível → leitura direta abaixo
    }
    try {
      return await readRagContext();
    } catch {
      return null;
    }
  });

  return async function handleChat(req, res) {
    const send = (status, data) => {
      if (res.headersSent) return;
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify(data));
    };

    // Linha do tempo do turno (stageTimes logo abaixo)
    const chatStartedAt = now();

    // Cliente que fecha a conexão antes da resposta cancela as chamadas ao
    // provedor: sem isso o turno seguia gastando tokens e slots para ninguém.
    const turn = new AbortController();
    res.on?.('close', () => {
      if (!res.writableEnded) turn.abort(new Error('cliente desconectou'));
    });

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

    const read = await readRequestBody(req, { limit: 8192 });
    if (!read.ok) {
      return send(413, { error: 'Mensagem muito longa.' });
    }

    const parsedBody = parseChatBody(read.body);
    if (!parsedBody.ok) {
      return send(parsedBody.status, { error: parsedBody.error });
    }

    proactive?.markUserActivity();
    activeTurns += 1;
    if (activeTurns === 1) proactive?.setBusy(true);
    try {
      const capabilities = sanitizeCapabilities(parsedBody.input?.capabilities);
      const mem = memoryStore.getAll();
      const today = new Date().toISOString().slice(0, 10);
      const hour = new Date().getHours();
      const timeOfDay = hour < 12 ? 'manhã' : hour < 18 ? 'tarde' : 'noite';
      let system = buildPersona({
        affinity: mem.affinity.score,
        sections: memoryStore.getSections(),
        recentFacts: memoryStore.getRecentFacts(new Date().toISOString()),
        history: memoryStore.getTodayHistory(today),
        summaries: memoryStore.getSummaries().slice(-3),
        username: mem.user.nickname || 'você',
        date: today,
        timeOfDay,
        personality: personalityStore.get(),
      });

      // RAG: busca no vault Obsidian pelo ASSUNTO da mensagem (FTS5) em vez de
      // ler só os arquivos mais recentes. O índice é derivado e se reconcilia
      // com o disco a cada busca; se ele falhar, o leitor antigo continua valendo.
      let ragContext = null;
      try {
        ragContext = await searchVault(parsedBody.message);
      } catch {
        ragContext = null;
      }
      if (ragContext) {
        system += '\n\n--- Contexto do vault Obsidian (memória de longo prazo) ---\n' + ragContext + '\n--- Fim do contexto ---\n';
      }

      if (parsedBody.input?.wakeUpJolt) {
        system += '\n\n=== REAÇÃO: ACORDANDO NO SUSTO ===\nVocê estava dormindo profundamente e o usuário te acordou de repente! Reaja com um sobressalto e susto tsundere bem vivo e engraçado no início da sua resposta (ex.: "Wah?! Ai, que susto! Você tava aí?! Eu já tava quase sonhando, baka!"). Use o gesto "surprised" ou "tilt" e emoção [casual_surprised].\n';
      } else if (parsedBody.input?.sleepCompanionActive) {
        system += '\n\n=== MODO COMPANION PARA DORMIR (INTERRUPÇÃO) ===\nVocê está no Modo Companion de 30 minutos para ajudar o usuário a dormir e ele ACABOU DE INTERROMPER tentando conversar em vez de descansar! Fique brava de forma protetora (tsundere clássica) e dê uma bronca afetuosa nele: mande ele parar de olhar pra tela, fechar os olhos e ir dormir imediatamente (ex.: "Ei! O que eu falei sobre fechar os olhos?! Vai dormir, baka! Não é pra ficar conversando, é pra descansar! Eu tô aqui do seu lado, então fecha esses olhos agora!"). Use gesto "angry" ou "tilt" e tom [casual_frustrated] ou [whisper_caring].\n';
      }
      system = withSpokenConciseness(system, {
        spoken: parsedBody.input?.spoken === true,
        message: parsedBody.message,
      });

      let parsed;
      let classification = null;

      // Surface Reflex: reação preliminar em < 50ms para presença instantânea
      const surfaceStartedAt = now();
      const surface = generateLocalSurfaceReflex(parsedBody.message, { username: mem.user.nickname || 'você' });
      const surfaceMs = now() - surfaceStartedAt;

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

      // Chave do OpenRouter resolvida uma vez por turno: o hedge só dispara se
      // houver para onde cair, e o fallback sequencial não relê o .env.
      let routerKey = null;
      let routerKeyError = null;
      let routerKeyResolved = false;
      const resolveRouterKey = async () => {
        if (!routerKeyResolved) {
          routerKeyResolved = true;
          try {
            routerKey = await getKey();
          } catch (error) {
            routerKeyError = error;
          }
        }
        return routerKey;
      };

      // Uma implementação só do OpenRouter: usada pelo hedge e pelo fallback
      // sequencial (NVIDIA desligada ou falha sem corrida).
      let routerUsed = false;
      const openRouterReply = (key, signal) => {
        routerUsed = true;
        return timeStage('llm', async () => {
          let response;
          try {
            response = await fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
              method: 'POST',
              headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
              body: JSON.stringify({ model, max_tokens: 700, messages: [{ role: 'system', content: withSurfaceReconciliation(system, surface) }, { role: 'user', content: parsedBody.message }] }),
              signal,
            });
          } catch (error) {
            // Aborto por perder a corrida ou por o cliente sair não é falha do
            // provedor: não vira log nem mensagem de erro.
            if (signal?.aborted && error?.name !== 'TimeoutError') throw error;
            if (turn.signal.aborted) throw error;
            console.warn('OpenRouter falhou:', describeFetchError(error));
            throw providerError(error?.name === 'TimeoutError' ? 'A solicitação expirou.' : 'Não foi possível acessar o provedor.');
          }
          if (!response || !response.ok) {
            throw providerError('A OpenRouter recusou a solicitação ou está indisponível (HTTP ' + (response?.status ?? 0) + ').');
          }
          let data;
          try {
            data = await response.json();
          } catch {
            throw providerError('Resposta inválida do provedor.');
          }
          const parsedRouter = parseProviderRaw(data?.choices?.[0]?.message?.content);
          if (!parsedRouter.ok) throw providerError(parsedRouter.error, parsedRouter.status);
          return { ...parsedRouter, classification, source: 'openrouter' };
        });
      };

      let hedged = false;
      if (useNvidia()) {
        // Fluxo NVIDIA: UMA chamada gera a fala junto das ações do avatar.
        try {
          // A classificação só alimenta o webhook do n8n (o cliente deriva a emoção
          // do texto localmente), então roda no classificador determinístico: não
          // gasta chamada nem um slot do rate limiter de 40 req/min por turno.
          const [classified] = await Promise.all([
            classifyUserMessage(parsedBody.message, { local: true }),
            resolveRouterKey(),
          ]);
          classification = classified;

          const nvidiaAbort = new AbortController();
          const routerAbort = new AbortController();
          const startNvidia = () => timeStage('llm', () => generateReply(
            withCapabilities(system, capabilities),
            parsedBody.message,
            {
              temperature: 0.7,
              signal: AbortSignal.any([turn.signal, nvidiaAbort.signal, AbortSignal.timeout(NVIDIA_BUDGET_MS)]),
              blurtReply: surface.mode === 'say+think' ? surface.reply : null,
            },
          )).then(rawReply => {
            const parsedReply = parseProviderRaw(rawReply);
            if (!parsedReply.ok) throw new Error(parsedReply.error);
            return { ...parsedReply, source: 'nvidia' };
          });

          // Sem chave do OpenRouter não há corrida: correr sozinho não acelera.
          parsed = routerKey
            ? await raceProviders({
              hedgeMs: hedgeAfterMs,
              startPrimary: startNvidia,
              startFallback: () => openRouterReply(routerKey, AbortSignal.any([
                turn.signal,
                routerAbort.signal,
                AbortSignal.timeout(Math.max(FALLBACK_MIN_MS, TURN_DEADLINE_MS - (now() - chatStartedAt))),
              ])),
              abortPrimary: () => nvidiaAbort.abort(),
              abortFallback: () => routerAbort.abort(),
              onHedge: () => { hedged = true; },
            })
            : await startNvidia();

          // Sem ação nenhuma no JSON da geração: o diretor de animação roda em
          // background e o refino chega pela fila de comandos. Nunca bloqueia a
          // resposta — a fala já está na mão do cliente.
          if (parsed.source === 'nvidia' && !parsed.actions.length && capabilities) {
            void refineAnimationInBackground(parsed.reply, capabilities, {
              clientId: normalizeClientId(req.headers['x-usami-client']),
              queue: n8nQueue,
            });
          }
          mark('animation');
        } catch (error) {
          nvidiaFailed = true;
          if (turn.signal.aborted) return;
          // O fallback já foi tentado (em paralelo ou depois da falha): repetir
          // a chamada ao mesmo provedor só gastaria tokens.
          if (error?.fallbackAttempted) return send(error.httpStatus || 502, { error: error.message });
          console.warn('NVIDIA falhou, tentando OpenRouter:', describeFetchError(error));
          // Fallback sequencial abaixo (offline quando não há chave).
        }
      }

      // Ninguém esperando a resposta: não há o que salvar nem fallback a pagar.
      if (turn.signal.aborted) return;

      if (!parsed || !parsed.ok) {
        // Fluxo OpenRouter (atual) — usado como fallback ou quando NVIDIA desligado
        const key = await resolveRouterKey();
        if (routerKeyError) {
          return send(502, { error: 'Não foi possível acessar a configuração.' });
        }
        if (!key) {
          // Sem nenhuma chave: resposta offline simples baseada no classificador local
          classification = await classifyUserMessage(parsedBody.message);
          const offlineReplies = {
            neutral: 'Oi! Estou aqui, mas ainda não configurei uma chave de LLM. Quer conversar mesmo assim?',
            happy: 'Oi! Estou bem feliz de te ver!',
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
          try {
            parsed = await openRouterReply(key, AbortSignal.any([
              turn.signal,
              AbortSignal.timeout(Math.max(FALLBACK_MIN_MS, TURN_DEADLINE_MS - (now() - chatStartedAt))),
            ]));
          } catch (error) {
            if (turn.signal.aborted) return;
            return send(error.httpStatus || 502, { error: error.message });
          }
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
          if (DURABLE_FACT.test(remember.fact)) memoryStore.addCoreFact(remember.fact, remember.section);
          else memoryStore.addRecentFact(remember.fact, 7, remember.section);
        }
        const turnTimestamp = new Date().toISOString();
        const historyReply = stripLeakedJson(parsed.reply)
          .replace(/\[[a-zA-Z0-9_\-\s]{2,40}\]/g, ' ')
          .replace(/【[^】]{1,30}】/g, ' ')
          .replace(/[ \t]{2,}/g, ' ')
          .trim() || parsed.reply;
        memoryStore.appendHistory('user', parsedBody.message, turnTimestamp);
        memoryStore.appendHistory('assistant', historyReply, turnTimestamp);
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

      // Continuidade entre dias: fecha os dias anteriores ainda sem resumo, em
      // background. Fora do caminho crítico — a próxima conversa já lê o
      // resultado no prompt. Sem NVIDIA, o resumo determinístico cumpre o papel.
      void summarizePendingDays({
        store: memoryStore,
        today,
        summarize: useNvidia() ? summarizeDay : undefined,
      }).catch(error => {
        // Fire-and-forget, mas falha silenciosa escondia resumo quebrado: loga
        // sem relançar para nunca derrubar o turno que já foi respondido.
        console.warn('[memoria] resumo de dias pendentes falhou: ' + (error?.message || error));
      });

      const actions = filterActionsByCatalog(parsed.actions ?? [], capabilities);

      // Dispara evento para o n8n (fire-and-forget): resposta, emoção,
      // ações de animação e afinidade. Não bloqueia o chat se o n8n estiver
      // offline. A classificação (local) alimenta só este webhook, nunca o balão.
      const emitResponse = emotion => void sendToN8nWebhook('usami.response', {
        userMessage: parsedBody.message,
        reply: parsed.reply,
        gesture: parsed.gesture,
        actions,
        emotion,
        affinity: affinityPayload,
        source: parsed.source,
      });
      emitResponse(classification);

      const totalMs = now() - chatStartedAt;
      stageTimes.total = totalMs;
      console.log('[chat] inicio=' + chatStartedAt + ' fim=' + now()
        + ' llm=' + stageTimes.llm + 'ms animacao=' + stageTimes.animation
        + 'ms contexto=' + stageTimes.context + 'ms total=' + totalMs + 'ms fonte=' + parsed.source
        + (hedged ? ' (hedge: OpenRouter entrou em paralelo)' : '')
        + (nvidiaFailed && routerUsed ? ' (fallback: llmMs soma a tentativa NVIDIA + OpenRouter)' : ''));

      const agentTurn = agentCore ? agentCore.dispatchAsync(parsedBody.message) : null;

      return send(200, {
        reply: parsed.reply, gesture: parsed.gesture, actions, source: parsed.source,
        surface,
        ...(parsed.speechTags ? { speechTags: parsed.speechTags } : {}),
        ...(agentTurn ? { agentTurn } : {}),
        // llmMs/animationMs/totalMs são lidos pelo navegador — não remover nem
        // renomear. contextMs é adição. animationMs é o que a animação custou
        // DENTRO do turno (pós-processamento síncrono); o refino do diretor é
        // fire-and-forget e aparece só no log [animacao], fora do totalMs.
        timing: { surfaceMs, llmMs: stageTimes.llm, animationMs: stageTimes.animation, contextMs: stageTimes.context, totalMs },
        ...(affinityPayload || {}),
      });
    } finally {
      activeTurns = Math.max(0, activeTurns - 1);
      if (activeTurns === 0) proactive?.setBusy(false);
    }
  };
}

// --- Flow-based chat handler (n8n-style node graph) ---
export function createFlowChatHandler(options = {}) {
  const allowedOrigins = options.allowedOrigins || DEFAULT_ALLOWED_ORIGINS;
  const proactive = options.proactiveEngine || proactiveEngine;

  return async function handleFlowChat(req, res) {
    const send = (status, data) => {
      if (res.headersSent) return;
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

    const read = await readRequestBody(req, { limit: 8192 });
    if (!read.ok) {
      return send(413, { error: 'Mensagem muito longa.' });
    }

    const parsedBody = parseChatBody(read.body);
    if (!parsedBody.ok) {
      return send(parsedBody.status, { error: parsedBody.error });
    }

    proactive?.markUserActivity();
    proactive?.setBusy(true);
    try {
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

        const spoken = extractSpeechTags(result.reply);
        return send(200, {
          reply: spoken.text,
          gesture: result.gesture,
          actions: result.actions,
          emotion: result.emotion,
          ...(spoken.tags.length ? { speechTags: spoken.tags } : {}),
          audioBuffer: result.audioBuffer ? 'base64_placeholder' : null, // actual audio via /api/tts
          debug: result.debug,
        });
      } catch (error) {
        return send(500, { error: 'Erro interno no flow: ' + error.message });
      }
    } finally {
      proactive?.setBusy(false);
    }
  };
}

// --- n8n → Usami: fila de comandos ------------------------------------------

export function createN8nCommandHandler(options = {}) {
  const allowedOrigins = options.allowedOrigins || DEFAULT_ALLOWED_ORIGINS;
  // Injetável para os testes: cada teste ganha uma fila isolada em vez de
  // disputar a fila compartilhada do processo.
  const queue = options.queue || sharedN8nQueue;

  return async function handleN8nCommand(req, res) {
    const send = (status, data) => {
      if (res.headersSent) return;
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify(data));
    };

    const origin = req.headers.origin;
    const host = req.headers.host;
    if (!isAllowedOrigin(origin, host, allowedOrigins)) {
      return send(403, { error: 'Origem não autorizada.' });
    }
    if (denyWithoutToken(req, options, send)) return;

    const url = new URL(req.url || '/', 'http://localhost');
    // Aba/dispositivo: header (frontend) com fallback de query (compat).
    const clientId = normalizeClientId(req.headers['x-usami-client'] || url.searchParams.get('client'));

    // GET — cliente consome a própria fila. Marca como entregue (não remove):
    // uma segunda leitura não duplica; o /ack é quem remove de fato.
    if (req.method === 'GET' && url.pathname === '/api/n8n/commands') {
      const { commands, count } = queue.poll(clientId);
      return send(200, { commands, count });
    }

    // DELETE — cliente desiste de aplicar (limpa a fila dele + pendentes sem dono)
    if (req.method === 'DELETE' && url.pathname === '/api/n8n/commands') {
      return send(200, { cleared: queue.clear(clientId) });
    }

    // POST — n8n envia um comando para ser aplicado pelo cliente
    if (req.method === 'POST' && url.pathname === '/api/n8n/command') {
      const contentType = (req.headers['content-type'] || '').split(';')[0].trim();
      if (contentType !== 'application/json') {
        return send(403, { error: 'Content-Type inválido.' });
      }

      const read = await readRequestBody(req, { limit: 8192 });
      if (!read.ok) {
        return send(413, { error: 'Comando muito longo.' });
      }

      let cmd;
      try {
        cmd = JSON.parse(read.body);
      } catch {
        return send(400, { error: 'Corpo da requisição inválido (JSON esperado).' });
      }

      // Sem header o comando é do n8n "sem dono": fanout/pendente na fila.
      const hasClient = Boolean(req.headers['x-usami-client'] || url.searchParams.get('client'));
      const entry = queueAvatarCommand(cmd, { clientId: hasClient ? clientId : null, queue });
      if (!entry) {
        return send(400, { error: 'Comando inválido. Tipos válidos: say, proactive_say, gesture, set_expression, set_morph, set_mesh_visible, play_sequence.' });
      }

      return send(200, { ok: true, id: entry.id, queued: queue.count() });
    }

    // POST /api/n8n/commands/ack — confirma o que foi aplicado. Escrita
    // sensível: exige token (denyWithoutToken acima). Remove só os ids do
    // cliente que pediu; ids desconhecidos são ignorados e a resposta é 200.
    if (req.method === 'POST' && url.pathname === '/api/n8n/commands/ack') {
      const contentType = (req.headers['content-type'] || '').split(';')[0].trim();
      if (contentType !== 'application/json') {
        return send(403, { error: 'Content-Type inválido.' });
      }

      const read = await readRequestBody(req, { limit: 8192 });
      if (!read.ok) {
        return send(413, { error: 'Confirmação muito longa.' });
      }

      let body;
      try {
        body = JSON.parse(read.body);
      } catch {
        return send(400, { error: 'Corpo da requisição inválido (JSON esperado).' });
      }
      if (!Array.isArray(body?.ids)) {
        return send(400, { error: 'Envie {ids:[...]} com os comandos aplicados.' });
      }

      queue.acknowledge(clientId, body.ids.slice(0, 500));
      return send(200, { ok: true });
    }

    return send(404, { error: 'Não encontrado.' });
  };
}

// --- RAG: contexto do vault Obsidian ---------------------------------------

// Headers de tuning do RAG (B18): `Number()` cru aceitava Infinity, negativo e
// 1e9 — o mesmo clamp do vault-index, com teto por grandeza.
export function clampRagNumber(value, fallback, max) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number) || number < 1) return fallback;
  return Math.min(number, max);
}

export function createRagContextHandler(options = {}) {
  const allowedOrigins = options.allowedOrigins || DEFAULT_ALLOWED_ORIGINS;
  const vaultRelative = options.vaultRelative || process.env.USAMI_RAG_VAULT;

  return async function handleRagContext(req, res) {
    const send = (status, data) => {
      if (res.headersSent) return;
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify(data));
    };

    const origin = req.headers.origin;
    const host = req.headers.host;
    if (!isAllowedOrigin(origin, host, allowedOrigins)) {
      return send(403, { error: 'Origem não autorizada.' });
    }
    if (denyWithoutToken(req, options, send)) return;

    if (req.method !== 'GET' || req.url !== '/api/rag/context') {
      return send(404, { error: 'Não encontrado.' });
    }

    const maxFiles = clampRagNumber(req.headers['x-rag-max-files'], 10, 50);
    const maxCharsPerFile = clampRagNumber(req.headers['x-rag-max-chars'], 2000, 20000);
    const maxTotalChars = clampRagNumber(req.headers['x-rag-max-total'], 6000, 60000);

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

// --- Memória: inspeção e exclusão granular ---------------------------------

// Snapshot para a UI: fatos por seção, recentes, resumos, dias de histórico e
// afinidade. O conteúdo das mensagens não sai daqui — a aba só precisa do que
// dá para apagar.
function memorySnapshot(store, nowIso = new Date().toISOString()) {
  const data = store.getAll();
  return {
    version: data.version,
    user: { name: data.user.name, nickname: data.user.nickname, createdAt: data.user.createdAt },
    sections: store.getSections(),
    recentFacts: data.recentFacts.map((item) => ({ ...item, expired: item.expiresAt <= nowIso })),
    summaries: store.getSummaries(),
    history: Object.entries(data.dailyHistory)
      .filter(([, messages]) => messages.length)
      .map(([date, messages]) => ({ date, count: messages.length }))
      .sort((a, b) => (a.date < b.date ? -1 : 1)),
    affinity: store.getAffinity(),
    // Cópia dos medidores do vínculo guardada no memory.json; a fonte segue
    // sendo o bond.json, exposta em /api/bond.
    bond: store.getBondMirror(),
  };
}

const FORGET_CONFIRMATION = 'APAGAR';
const FORGET_KINDS = new Set(['fact', 'recent', 'section', 'summary', 'history', 'all']);
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// GET devolve os ajustes e o catálogo de traços; POST grava (traços 0–100 e
// instruções extras) ou, com `reset: true`, volta ao padrão. Mesma borda da
// memória: origem allowlisted + X-Usami-Token (fail-closed sem token no servidor).
export function createPersonalityHandler(options = {}) {
  const allowedOrigins = options.allowedOrigins || DEFAULT_ALLOWED_ORIGINS;
  const store = options.personalityStore || installPersonalityStore;
  const traits = Object.entries(TRAITS).map(([key, value]) => ({ key, label: value.label }));

  return async function handlePersonality(req, res) {
    const send = (status, data) => {
      if (res.headersSent) return;
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify(data));
    };

    if (!isAllowedOrigin(req.headers.origin, req.headers.host, allowedOrigins)) {
      return send(403, { error: 'Origem não autorizada.' });
    }
    if (denyWithoutToken(req, options, send)) return;

    if (req.url !== '/api/personality') return send(404, { error: 'Não encontrado.' });
    if (req.method === 'GET') {
      return send(200, { ok: true, personality: store.get(), traits, customPromptMax: CUSTOM_PROMPT_MAX });
    }
    if (req.method !== 'POST') return send(404, { error: 'Não encontrado.' });

    const contentType = (req.headers['content-type'] || '').split(';')[0].trim();
    if (contentType !== 'application/json') return send(403, { error: 'Content-Type inválido.' });

    const read = await readRequestBody(req, { limit: 4096 });
    if (!read.ok) return send(413, { error: 'Pedido muito longo.' });
    let payload;
    try {
      payload = JSON.parse(read.body);
    } catch {
      return send(400, { error: 'Corpo da requisição inválido (JSON esperado).' });
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return send(400, { error: 'Corpo inválido.' });
    }

    try {
      const saved = payload.reset === true ? store.reset() : store.save(normalizePersonality(payload));
      return send(200, { ok: true, personality: saved });
    } catch {
      return send(500, { error: 'Não foi possível salvar a personalidade.' });
    }
  };
}

export function createMemoryHandler(options = {}) {
  const allowedOrigins = options.allowedOrigins || DEFAULT_ALLOWED_ORIGINS;
  const store = options.memoryStore || installMemoryStore;
  // Usado só depois do "apagar tudo": os medidores vivem no bond.json, então o
  // espelho volta em seguida em vez de sumir junto com os fatos.
  const bond = 'bondStore' in options ? options.bondStore : installBondStore;

  return async function handleMemory(req, res) {
    const send = (status, data) => {
      if (res.headersSent) return;
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify(data));
    };

    const origin = req.headers.origin;
    const host = req.headers.host;
    if (!isAllowedOrigin(origin, host, allowedOrigins)) {
      return send(403, { error: 'Origem não autorizada.' });
    }
    if (denyWithoutToken(req, options, send)) return;

    if (req.method === 'GET' && req.url === '/api/memory') {
      return send(200, { ok: true, memory: memorySnapshot(store) });
    }

    if (req.method !== 'POST' || req.url !== '/api/memory/forget') {
      return send(404, { error: 'Não encontrado.' });
    }

    const contentType = (req.headers['content-type'] || '').split(';')[0].trim();
    if (contentType !== 'application/json') {
      return send(403, { error: 'Content-Type inválido.' });
    }

    const read = await readRequestBody(req, { limit: 8192 });
    if (!read.ok) return send(413, { error: 'Pedido muito longo.' });

    let payload;
    try {
      payload = JSON.parse(read.body);
    } catch {
      return send(400, { error: 'Corpo da requisição inválido (JSON esperado).' });
    }

    const kind = payload?.kind;
    if (!FORGET_KINDS.has(kind)) {
      return send(400, { error: 'Tipo inválido. Use fact, recent, section, summary, history ou all.' });
    }
    // Confirmação escrita: nada é apagado sem o token exato no corpo.
    if (String(payload.confirm ?? '').trim().toUpperCase() !== FORGET_CONFIRMATION) {
      return send(403, { error: 'Confirmação escrita necessária: envie confirm: "APAGAR".' });
    }

    let removed = 0;
    switch (kind) {
      case 'fact': {
        if (!MEMORY_SECTIONS.includes(payload.section)) return send(400, { error: 'Seção inválida.' });
        if (typeof payload.fact !== 'string' || !payload.fact.trim()) return send(400, { error: 'Fato ausente.' });
        removed = store.deleteFact(payload.section, payload.fact) ? 1 : 0;
        break;
      }
      case 'recent': {
        if (typeof payload.fact !== 'string' || !payload.fact.trim()) return send(400, { error: 'Fato ausente.' });
        removed = store.deleteRecentFact(payload.fact) ? 1 : 0;
        break;
      }
      case 'section': {
        if (!MEMORY_SECTIONS.includes(payload.section)) return send(400, { error: 'Seção inválida.' });
        removed = store.clearSection(payload.section);
        break;
      }
      case 'summary': {
        if (!DATE_PATTERN.test(String(payload.date ?? ''))) return send(400, { error: 'Data inválida (YYYY-MM-DD).' });
        removed = store.deleteSummary(payload.date) ? 1 : 0;
        break;
      }
      case 'history': {
        if (payload.date !== undefined) {
          if (!DATE_PATTERN.test(String(payload.date))) return send(400, { error: 'Data inválida (YYYY-MM-DD).' });
          removed = (store.getAll().dailyHistory[payload.date] || []).length;
          store.clearTodayHistory(payload.date);
        } else {
          removed = store.clearAllHistory();
        }
        break;
      }
      case 'all': {
        store.reset();
        if (bond) {
          try {
            store.setBondMirror(bond.getAll());
          } catch (error) {
            console.error('Aviso: espelho do vínculo falhou após limpar a memória:', error?.message || error);
          }
        }
        break;
      }
    }

    return send(200, { ok: true, forgotten: kind, removed, memory: memorySnapshot(store) });
  };
}

// Vínculo do VN: leitura, ganho por resposta, importação única do
// localStorage antigo e reset. A regra do XP vive no core (bond-store.js),
// não no cliente — por isso web e desktop chegam ao mesmo número.
export function createBondHandler(options = {}) {
  const allowedOrigins = options.allowedOrigins || DEFAULT_ALLOWED_ORIGINS;
  const store = options.bondStore || installBondStore;
  // Espelho em memory.json: a aba Memória lê os mesmos medidores por
  // /api/memory, sem precisar consultar duas rotas. Falha aqui nunca derruba a
  // resposta do vínculo — o bond.json continua sendo a fonte.
  const memory = 'memoryStore' in options ? options.memoryStore : installMemoryStore;
  const mirrorBond = (snapshot) => {
    if (!memory || typeof memory.setBondMirror !== 'function') return;
    try {
      memory.setBondMirror(snapshot);
    } catch (error) {
      console.error('Aviso: espelho do vínculo na memória falhou:', error?.message || error);
    }
  };
  // Reavaliação pós-evento: o desbloqueio nasce da atividade do vínculo, mas
  // nunca derruba a resposta do bond se a gravação das conquistas falhar.
  const achievements = 'achievementsStore' in options ? options.achievementsStore : installAchievementsStore;
  const reevaluateAchievements = () => {
    if (!achievements) return;
    try {
      achievements.reevaluate(store.getAll());
    } catch (error) {
      console.error('Aviso: reavaliação de conquistas falhou:', error?.message || error);
    }
  };

  return async function handleBond(req, res) {
    const send = (status, data) => {
      if (res.headersSent) return;
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify(data));
    };

    const origin = req.headers.origin;
    const host = req.headers.host;
    if (!isAllowedOrigin(origin, host, allowedOrigins)) {
      return send(403, { error: 'Origem não autorizada.' });
    }
    if (denyWithoutToken(req, options, send)) return;

    const route = new URL(req.url || '/api/bond', 'http://127.0.0.1:8787').pathname;

    if (req.method === 'GET' && route === '/api/bond') {
      return send(200, { ok: true, bond: store.getAll() });
    }

    if (req.method !== 'POST') return send(404, { error: 'Não encontrado.' });

    const contentType = (req.headers['content-type'] || '').split(';')[0].trim();
    if (contentType !== 'application/json') {
      return send(403, { error: 'Content-Type inválido.' });
    }

    const read = await readRequestBody(req, { limit: 16384 });
    if (!read.ok) return send(413, { error: 'Pedido muito longo.' });

    let payload;
    try {
      payload = JSON.parse(read.body);
    } catch {
      return send(400, { error: 'Corpo da requisição inválido (JSON esperado).' });
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return send(400, { error: 'Corpo inválido.' });
    }

    if (route === '/api/bond/event') {
      // Fim de chamada de voz: companhia por minuto inteiro.
      if (payload.kind === 'call') {
        const minutes = Number(payload.minutes);
        if (!Number.isFinite(minutes) || minutes < 1) {
          return send(400, { error: 'Minutos inválidos.' });
        }
        const called = store.awardCall(minutes);
        if (called.changed) {
          reevaluateAchievements();
          mirrorBond(called);
        }
        return send(200, { ok: true, bond: called });
      }
      if (typeof payload.content !== 'string' || !payload.content.trim()) {
        return send(400, { error: 'Conteúdo ausente.' });
      }
      const spoken = payload.spoken === true;
      const awarded = store.awardChat(payload.content, { spoken });
      if (awarded.changed) {
        reevaluateAchievements();
        mirrorBond(awarded);
      }
      return send(200, { ok: true, bond: awarded });
    }

    if (route === '/api/bond/import') {
      const imported = store.importState({ intimacy: payload.intimacy, log: payload.log });
      if (imported.imported) {
        reevaluateAchievements();
        mirrorBond(imported);
      }
      return send(200, { ok: true, bond: imported });
    }

    if (route === '/api/bond/reset') {
      // Mesma confirmação escrita da memória: nada é apagado sem o token no corpo.
      if (String(payload.confirm ?? '').trim().toUpperCase() !== FORGET_CONFIRMATION) {
        return send(403, { error: 'Confirmação escrita necessária: envie confirm: "APAGAR".' });
      }
      const reset = store.reset();
      mirrorBond(reset);
      return send(200, { ok: true, bond: reset });
    }

    return send(404, { error: 'Não encontrado.' });
  };
}

// Memória operacional: projetos, tarefas e compromissos. É a camada que o
// Memory Engine não tinha; `/api/memory` continua sendo fatos semânticos.
// Consulta por status/projeto/tipo/janela de dueAt e trilha append-only.
const OPERATIONAL_RECORD_PATH_RE = /^\/api\/agent\/memory\/(op-[0-9a-f]{12})$/;

function parseOperationalQuery(searchParams, { forList }) {
  const limitValue = searchParams.get('limit');
  let limit = forList ? OPERATIONAL_DEFAULT_LIMIT : 100;
  if (limitValue !== null) {
    const parsed = Number(limitValue);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > OPERATIONAL_MAX_LIMIT) {
      return { ok: false, error: `limit inválido (inteiro entre 1 e ${OPERATIONAL_MAX_LIMIT}).` };
    }
    limit = parsed;
  }
  if (!forList) return { ok: true, limit };

  const filters = { limit };
  const status = searchParams.get('status');
  if (status !== null) {
    if (!OPERATIONAL_STATUSES.includes(status)) {
      return { ok: false, error: `status inválido (use ${OPERATIONAL_STATUSES.join('|')}).` };
    }
    filters.status = status;
  }
  const kind = searchParams.get('kind');
  if (kind !== null) {
    if (!OPERATIONAL_KINDS.includes(kind)) {
      return { ok: false, error: `kind inválido (use ${OPERATIONAL_KINDS.join('|')}).` };
    }
    filters.kind = kind;
  }
  const projectId = searchParams.get('projectId');
  if (projectId !== null) {
    if (!/^op-[0-9a-f]{12}$/.test(projectId)) return { ok: false, error: 'projectId inválido.' };
    filters.projectId = projectId;
  }
  for (const key of ['from', 'to']) {
    const value = searchParams.get(key);
    if (value === null) continue;
    if (Number.isNaN(Date.parse(value))) return { ok: false, error: `${key} inválido (data ISO-8601).` };
    filters[key] = value;
  }
  return { ok: true, filters };
}

export function createOperationalMemoryHandler(options = {}) {
  const allowedOrigins = options.allowedOrigins || DEFAULT_ALLOWED_ORIGINS;
  const store = options.operationalStore || installOperationalStore;

  return async function handleOperationalMemory(req, res) {
    const send = (status, data) => {
      if (res.headersSent) return;
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify(data));
    };

    if (!isAllowedOrigin(req.headers.origin, req.headers.host, allowedOrigins)) {
      return send(403, { error: 'Origem não autorizada.' });
    }
    if (denyWithoutToken(req, options, send)) return;

    const url = new URL(req.url || '/api/agent/memory', 'http://127.0.0.1:8787');
    const path = url.pathname;

    if (req.method === 'GET') {
      if (path === '/api/agent/memory/trail') {
        const query = parseOperationalQuery(url.searchParams, { forList: false });
        if (!query.ok) return send(400, { error: query.error });
        const trail = store.trail({ limit: query.limit });
        return send(200, { ok: true, trail, count: trail.length });
      }
      if (path === '/api/agent/memory') {
        const query = parseOperationalQuery(url.searchParams, { forList: true });
        if (!query.ok) return send(400, { error: query.error });
        const records = store.list(query.filters);
        return send(200, { ok: true, records, count: records.length });
      }
      const match = path.match(OPERATIONAL_RECORD_PATH_RE);
      if (!match) return send(404, { error: 'Não encontrado.' });
      const record = store.get(match[1]);
      if (!record) return send(404, { error: 'Registro não encontrado.' });
      return send(200, { ok: true, record });
    }

    if (req.method !== 'POST' && req.method !== 'PATCH') {
      return send(404, { error: 'Não encontrado.' });
    }

    const contentType = (req.headers['content-type'] || '').split(';')[0].trim();
    if (contentType !== 'application/json') return send(403, { error: 'Content-Type inválido.' });

    const read = await readRequestBody(req, { limit: 16384 });
    if (!read.ok) return send(413, { error: 'Pedido muito longo.' });

    let payload;
    try {
      payload = JSON.parse(read.body);
    } catch {
      return send(400, { error: 'Corpo da requisição inválido (JSON esperado).' });
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return send(400, { error: 'Corpo inválido.' });
    }

    if (req.method === 'POST') {
      if (path !== '/api/agent/memory') return send(404, { error: 'Não encontrado.' });
      let created;
      try {
        created = store.create({ ...payload, origin: payload.origin ?? 'user' });
      } catch {
        return send(500, { error: 'Não foi possível salvar o registro.' });
      }
      if (!created.ok) return send(400, { error: 'Registro inválido.', details: created.errors });
      return send(201, { ok: true, record: created.record });
    }

    const match = path.match(OPERATIONAL_RECORD_PATH_RE);
    if (!match) return send(404, { error: 'Não encontrado.' });
    let updated;
    try {
      updated = store.update(match[1], payload);
    } catch {
      return send(500, { error: 'Não foi possível atualizar o registro.' });
    }
    if (!updated.ok) {
      if (updated.notFound) return send(404, { error: 'Registro não encontrado.' });
      return send(400, { error: 'Atualização inválida.', details: updated.errors });
    }
    return send(200, { ok: true, record: updated.record, changed: updated.changed });
  };
}

// Ferramentas do domínio agêntico: execução verificada e histórico. O executor
// só grava no histórico quando a ferramenta rodou de fato; argumento inválido
// ou ferramenta desconhecida nem chegam a executar.
const AGENT_TOOL_EXECUTE_RE = /^\/api\/agent\/tools\/([a-z][a-z0-9]*(?:\.[a-z][a-z0-9_-]*)+)\/execute$/;

export function createToolHandler(options = {}) {
  const allowedOrigins = options.allowedOrigins || DEFAULT_ALLOWED_ORIGINS;
  const registry = options.registry || toolRegistry;
  const executor = options.executor || installToolExecutor;
  const gate = options.gate || null;
  const skillCatalog = options.skillCatalog || null;

  return async function handleTools(req, res) {
    const send = (status, data) => {
      if (res.headersSent) return;
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify(data));
    };

    if (!isAllowedOrigin(req.headers.origin, req.headers.host, allowedOrigins)) {
      return send(403, { error: 'Origem não autorizada.' });
    }
    if (denyWithoutToken(req, options, send)) return;

    // Devolve o payload ou null (resposta de erro já enviada).
    const readJsonPayload = async (limit) => {
      const contentType = (req.headers['content-type'] || '').split(';')[0].trim();
      if (contentType !== 'application/json') {
        send(403, { error: 'Content-Type inválido.' });
        return null;
      }
      const read = await readRequestBody(req, { limit });
      if (!read.ok) {
        send(413, { error: 'Pedido muito longo.' });
        return null;
      }
      let payload;
      try {
        payload = JSON.parse(read.body);
      } catch {
        send(400, { error: 'Corpo da requisição inválido (JSON esperado).' });
        return null;
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        send(400, { error: 'Corpo inválido.' });
        return null;
      }
      return payload;
    };

    const rejectUnknownKeys = (payload, allowed) => {
      const unknown = Object.keys(payload).filter(key => !allowed.includes(key));
      if (!unknown.length) return false;
      send(400, { error: 'Corpo inválido.', details: unknown.map(key => `payload.${key}: campo desconhecido`) });
      return true;
    };

    const url = new URL(req.url || '/api/agent/tools', 'http://127.0.0.1:8787');
    const path = url.pathname;

    if (req.method === 'GET') {
      if (path === '/api/agent/executions') {
        const limitValue = url.searchParams.get('limit');
        let limit = EXECUTIONS_DEFAULT_LIST;
        if (limitValue !== null) {
          const parsed = Number(limitValue);
          if (!Number.isInteger(parsed) || parsed < 1 || parsed > EXECUTIONS_LIMIT) {
            return send(400, { error: `limit inválido (inteiro entre 1 e ${EXECUTIONS_LIMIT}).` });
          }
          limit = parsed;
        }
        const executions = executor.list({ limit });
        return send(200, { ok: true, executions, count: executions.length });
      }
      if (path === '/api/agent/permissions') {
        if (!gate) return send(500, { error: 'Permissões indisponíveis.' });
        return send(200, { ok: true, ...gate.list() });
      }
      return send(404, { error: 'Não encontrado.' });
    }

    if (req.method !== 'POST') return send(404, { error: 'Não encontrado.' });

    if (path === '/api/agent/confirmations') {
      if (!gate) return send(500, { error: 'Permissões indisponíveis.' });
      const payload = await readJsonPayload(4096);
      if (!payload) return;
      if (rejectUnknownKeys(payload, ['tool', 'skill', 'confirm'])) return;
      // Confirmação escrita, como no forget da memória: o token de uso único só
      // nasce com a palavra exata no corpo.
      if (String(payload.confirm ?? '').trim().toUpperCase() !== CONFIRMATION_WORD) {
        return send(403, { error: `Confirmação escrita necessária: envie confirm: "${CONFIRMATION_WORD}".` });
      }
      const hasTool = payload.tool !== undefined;
      const hasSkill = payload.skill !== undefined;
      if (hasTool === hasSkill) return send(400, { error: 'Informe tool ou skill para confirmar.' });

      if (hasSkill) {
        if (typeof payload.skill !== 'string' || !payload.skill.trim()) return send(400, { error: 'Skill inválida.' });
        const skillId = payload.skill.trim();
        if (skillCatalog) {
          skillCatalog.load();
          const found = skillCatalog.get(skillId);
          if (!found.ok) return send(404, { error: 'Skill não encontrada.' });
          if (!found.skill.valid) return send(400, { error: 'Manifesto da skill inválido.' });
          if (found.skill.state !== 'pending') {
            return send(409, { error: 'Skill precisa estar no estado pending para confirmar instalação.' });
          }
        }
        const created = gate.createSkillConfirmation(skillId);
        if (created.invalid) return send(400, { error: created.errors[0] });
        if (created.denied) return send(403, { error: created.errors[0] });
        return send(201, { ok: true, confirmation: created.confirmation });
      }

      if (typeof payload.tool !== 'string' || !payload.tool.trim()) return send(400, { error: 'Ferramenta inválida.' });
      const created = gate.createConfirmation(payload.tool.trim());
      if (created.notFound) return send(404, { error: 'Ferramenta não encontrada.' });
      if (created.notRequired) return send(400, { error: created.errors[0] });
      if (created.denied) return send(403, { error: created.errors[0] });
      return send(201, { ok: true, confirmation: created.confirmation });
    }

    if (path === '/api/agent/permissions') {
      if (!gate) return send(500, { error: 'Permissões indisponíveis.' });
      const payload = await readJsonPayload(4096);
      if (!payload) return;
      if (rejectUnknownKeys(payload, ['tool', 'action', 'reason'])) return;
      if (typeof payload.tool !== 'string' || !payload.tool.trim()) return send(400, { error: 'Ferramenta inválida.' });
      if (payload.action !== 'revoke' && payload.action !== 'restore') {
        return send(400, { error: 'Ação inválida (use revoke ou restore).' });
      }
      let result;
      try {
        result = payload.action === 'revoke'
          ? gate.revoke(payload.tool.trim(), payload.reason)
          : gate.restore(payload.tool.trim());
      } catch (error) {
        console.error('Aviso: não foi possível gravar permissões:', error?.message || error);
        return send(500, { error: 'Arquivo de permissões indisponível.' });
      }
      if (!result.ok) return send(400, { error: 'Permissão inválida.', details: result.errors });
      return send(200, { ok: true, ...gate.list() });
    }

    const match = path.match(AGENT_TOOL_EXECUTE_RE);
    if (!match) return send(404, { error: 'Não encontrado.' });
    if (!registry.has(match[1])) return send(404, { error: 'Ferramenta não encontrada.' });

    const payload = await readJsonPayload(16384);
    if (!payload) return;
    if (rejectUnknownKeys(payload, ['arguments', 'origin', 'confirmation'])) return;
    const origin = payload.origin ?? 'agent';
    if (!EXECUTION_ORIGINS.includes(origin)) {
      return send(400, { error: `origin inválido (use ${EXECUTION_ORIGINS.join('|')}).` });
    }
    let confirmation;
    if (payload.confirmation !== undefined) {
      if (typeof payload.confirmation !== 'string' || payload.confirmation.length > 128) {
        return send(400, { error: 'confirmation: deve ser texto de até 128 caracteres.' });
      }
      confirmation = payload.confirmation;
    }

    let outcome;
    try {
      outcome = await executor.execute(match[1], payload.arguments ?? {}, { origin, confirmation });
    } catch (error) {
      console.error('Aviso: não foi possível registrar a execução:', error?.message || error);
      return send(500, { error: 'Não foi possível registrar a execução.' });
    }
    if (outcome.notFound) return send(404, { error: 'Ferramenta não encontrada.' });
    if (outcome.invalidOrigin) return send(400, { error: outcome.errors[0] });
    if (outcome.invalidArguments) return send(400, { error: 'Argumentos inválidos.', details: outcome.errors });
    if (outcome.denied) return send(403, { ok: false, error: outcome.record.reason, execution: outcome.record });
    return send(200, outcome.ok
      ? { ok: true, execution: outcome.record, result: outcome.result }
      : { ok: false, execution: outcome.record });
  };
}

// Planos de tarefas (/api/agent/plans): o planner é determinístico e um
// adapter de LLM entra por injeção, então o handler só cobre a borda HTTP e
// os estados do contrato — nada de planejar no caminho do chat.
const AGENT_PLAN_PATH_RE = /^\/api\/agent\/plans\/(pl-[0-9a-f]{12})$/;

export function createPlansHandler(options = {}) {
  const allowedOrigins = options.allowedOrigins || DEFAULT_ALLOWED_ORIGINS;
  const planner = options.planner || installTaskPlanner;

  return async function handlePlans(req, res) {
    const send = (status, data) => {
      if (res.headersSent) return;
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify(data));
    };

    if (!isAllowedOrigin(req.headers.origin, req.headers.host, allowedOrigins)) {
      return send(403, { error: 'Origem não autorizada.' });
    }
    if (denyWithoutToken(req, options, send)) return;

    const url = new URL(req.url || '/api/agent/plans', 'http://127.0.0.1:8787');
    const path = url.pathname;

    if (req.method === 'GET') {
      if (path === '/api/agent/plans') {
        const rawLimit = url.searchParams.get('limit');
        let limit = PLAN_LIST_DEFAULT_LIMIT;
        if (rawLimit !== null) {
          const parsed = Number(rawLimit);
          if (!Number.isInteger(parsed) || parsed < 1 || parsed > PLAN_LIST_MAX_LIMIT) {
            return send(400, { error: `limit inválido (inteiro entre 1 e ${PLAN_LIST_MAX_LIMIT}).` });
          }
          limit = parsed;
        }
        const plans = planner.list({ limit });
        return send(200, { ok: true, plans, count: plans.length, unavailable: planner.unavailable() });
      }
      const match = path.match(AGENT_PLAN_PATH_RE);
      if (!match) return send(404, { error: 'Não encontrado.' });
      const found = planner.get(match[1]);
      if (found.notFound) return send(404, { error: 'Plano não encontrado.' });
      if (found.unavailable) return send(500, { error: 'Plano indisponível (arquivo inválido).' });
      return send(200, { ok: true, plan: found.plan, versions: found.versions });
    }

    if (req.method !== 'POST' && req.method !== 'PATCH') return send(404, { error: 'Não encontrado.' });

    const contentType = (req.headers['content-type'] || '').split(';')[0].trim();
    if (contentType !== 'application/json') return send(403, { error: 'Content-Type inválido.' });
    const read = await readRequestBody(req, { limit: 16384 });
    if (!read.ok) return send(413, { error: 'Pedido muito longo.' });

    let payload;
    try {
      payload = JSON.parse(read.body);
    } catch {
      return send(400, { error: 'Corpo da requisição inválido (JSON esperado).' });
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return send(400, { error: 'Corpo inválido.' });
    }

    if (req.method === 'POST') {
      if (path !== '/api/agent/plans') return send(404, { error: 'Não encontrado.' });
      const unknown = Object.keys(payload).filter(key => !['goal', 'origin', 'replanOf'].includes(key));
      if (unknown.length) {
        return send(400, { error: 'Corpo inválido.', details: unknown.map(key => `payload.${key}: campo desconhecido`) });
      }
      if (payload.origin !== undefined && !PLAN_ORIGINS.includes(payload.origin)) {
        return send(400, { error: `origin inválido (use ${PLAN_ORIGINS.join('|')}).` });
      }
      if (payload.replanOf !== undefined && (typeof payload.replanOf !== 'string' || !/^pl-[0-9a-f]{12}$/.test(payload.replanOf))) {
        return send(400, { error: 'replanOf inválido (use um id de plano).' });
      }

      let created;
      try {
        created = planner.create({ goal: payload.goal, origin: payload.origin, replanOf: payload.replanOf });
      } catch (error) {
        console.error('Aviso: não foi possível salvar o plano:', error?.message || error);
        return send(500, { error: 'Não foi possível salvar o plano.' });
      }
      if (created.notFound) return send(404, { error: 'Plano não encontrado.' });
      if (created.unavailable) return send(500, { error: 'Plano indisponível (arquivo inválido).' });
      if (!created.ok) return send(400, { error: 'Plano inválido.', details: created.errors });
      return send(created.replanned ? 200 : 201, { ok: true, plan: created.plan, version: created.version });
    }

    const match = path.match(AGENT_PLAN_PATH_RE);
    if (!match) return send(404, { error: 'Não encontrado.' });
    const unknown = Object.keys(payload).filter(key => !['steps', 'status'].includes(key));
    if (unknown.length) {
      return send(400, { error: 'Corpo inválido.', details: unknown.map(key => `payload.${key}: campo desconhecido`) });
    }

    let updated;
    try {
      updated = planner.updateProgress(match[1], payload);
    } catch (error) {
      console.error('Aviso: não foi possível salvar o progresso do plano:', error?.message || error);
      return send(500, { error: 'Não foi possível salvar o progresso.' });
    }
    if (updated.notFound) return send(404, { error: 'Plano não encontrado.' });
    if (updated.unavailable) return send(500, { error: 'Plano indisponível (arquivo inválido).' });
    if (updated.locked) return send(409, { error: 'Plano concluído ou cancelado não aceita progresso.' });
    if (!updated.ok) return send(400, { error: 'Progresso inválido.', details: updated.errors });
    return send(200, { ok: true, plan: updated.plan, changed: updated.changed });
  };
}

// Catálogo e Ciclo de Vida de Skills (/api/agent/skills): descoberta somente
// leitura em S7 e fluxo de proposta, confirmação (S5), teste isolado e
// ativar/desativar em S8.
const AGENT_SKILL_PATH_RE = /^\/api\/agent\/skills\/([a-z][a-z0-9-]{2,39})$/;
const AGENT_SKILL_PROPOSAL_PATH_RE = /^\/api\/agent\/skills\/proposals\/(sp-[0-9a-f]{12})$/;
const AGENT_SKILL_ACTION_RE = /^\/api\/agent\/skills\/([a-z][a-z0-9-]{2,39})\/(install|enable|disable)$/;

export function createSkillsHandler(options = {}) {
  const allowedOrigins = options.allowedOrigins || DEFAULT_ALLOWED_ORIGINS;
  const catalog = options.catalog || installSkillCatalog;
  const manager = options.manager || (options.catalog ? null : installSkillManager);

  return async function handleSkills(req, res) {
    const send = (status, data) => {
      if (res.headersSent) return;
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify(data));
    };

    if (!isAllowedOrigin(req.headers.origin, req.headers.host, allowedOrigins)) {
      return send(403, { error: 'Origem não autorizada.' });
    }
    if (denyWithoutToken(req, options, send)) return;

    const path = new URL(req.url || '/api/agent/skills', 'http://127.0.0.1:8787').pathname;

    if (req.method === 'GET') {
      if (path === '/api/agent/skills/proposals') {
        if (!manager) return send(500, { error: 'Gerenciador de skills indisponível.' });
        const proposals = manager.listProposals();
        return send(200, { ok: true, proposals, count: proposals.length });
      }
      const proposalMatch = path.match(AGENT_SKILL_PROPOSAL_PATH_RE);
      if (proposalMatch) {
        if (!manager) return send(500, { error: 'Gerenciador de skills indisponível.' });
        const found = manager.getProposal(proposalMatch[1]);
        if (!found.ok) return send(404, { error: 'Proposta não encontrada.' });
        return send(200, { ok: true, proposal: found.proposal });
      }

      let snapshot;
      try {
        snapshot = catalog.load();
      } catch (error) {
        console.error('Aviso: não foi possível ler o catálogo de skills:', error?.message || error);
        return send(500, { error: 'Catálogo de skills indisponível.' });
      }

      if (path === '/api/agent/skills') {
        return send(200, { ok: true, skills: snapshot.skills, count: snapshot.skills.length });
      }
      const match = path.match(AGENT_SKILL_PATH_RE);
      if (!match) return send(404, { error: 'Não encontrado.' });
      const found = catalog.get(match[1]);
      if (!found.ok) return send(404, { error: 'Skill não encontrada.' });
      return send(200, { ok: true, skill: found.skill });
    }

    if (req.method !== 'POST') return send(404, { error: 'Não encontrado.' });
    const isProposalPost = path === '/api/agent/skills/proposals';
    const actionMatch = isProposalPost ? null : path.match(AGENT_SKILL_ACTION_RE);
    if (!isProposalPost && !actionMatch) return send(404, { error: 'Não encontrado.' });
    if (!manager) return send(500, { error: 'Gerenciador de skills indisponível.' });

    const contentType = (req.headers['content-type'] || '').split(';')[0].trim();
    if (contentType !== 'application/json') return send(403, { error: 'Content-Type inválido.' });
    const read = await readRequestBody(req, { limit: isProposalPost ? 16384 : 4096 });
    if (!read.ok) return send(413, { error: 'Pedido muito longo.' });

    let payload;
    try {
      payload = JSON.parse(read.body);
    } catch {
      return send(400, { error: 'Corpo da requisição inválido (JSON esperado).' });
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return send(400, { error: 'Corpo inválido.' });
    }

    const rejectUnknownKeys = (allowed) => {
      const unknown = Object.keys(payload).filter(key => !allowed.includes(key));
      if (!unknown.length) return false;
      send(400, { error: 'Corpo inválido.', details: unknown.map(key => `payload.${key}: campo desconhecido`) });
      return true;
    };

    if (isProposalPost) {
      if (rejectUnknownKeys(['skillId', 'benefit', 'risks', 'dependencies', 'permissions'])) return;
      let result;
      try {
        result = manager.propose(payload);
      } catch (error) {
        console.error('Aviso: não foi possível registrar proposta de skill:', error?.message || error);
        return send(500, { error: 'Não foi possível salvar a proposta.' });
      }
      if (result.notFound) return send(404, { error: 'Skill não encontrada.' });
      if (result.forbiddenOrigin) return send(403, { error: result.error });
      if (result.conflict) return send(409, { error: result.error });
      if (!result.ok) return send(400, { error: 'Proposta inválida.', details: result.errors });
      return send(201, { ok: true, proposal: result.proposal, skill: result.skill });
    }

    const [, skillId, action] = actionMatch;
    if (action === 'install') {
      if (rejectUnknownKeys(['confirmation'])) return;
      if (payload.confirmation !== undefined && (typeof payload.confirmation !== 'string' || payload.confirmation.length > 128)) {
        return send(400, { error: 'confirmation: deve ser texto de até 128 caracteres.' });
      }
    } else if (rejectUnknownKeys([])) {
      return;
    }

    let result;
    try {
      if (action === 'install') result = await manager.install(skillId, { confirmation: payload.confirmation });
      else if (action === 'enable') result = await manager.enable(skillId);
      else result = manager.disable(skillId);
    } catch (error) {
      console.error('Aviso: falha ao atualizar skill:', error?.message || error);
      return send(500, { error: 'Não foi possível atualizar a skill.' });
    }

    if (result.notFound) return send(404, { error: 'Skill não encontrada.' });
    if (result.invalidManifest) return send(400, { error: 'Manifesto da skill inválido.', details: result.errors });
    if (result.denied) return send(403, { ok: false, error: result.error });
    if (result.wrongState) return send(409, { error: result.error });
    if (result.testFailed) {
      return send(422, {
        ok: false,
        installed: false,
        error: result.error,
        skill: result.skill,
        testResult: result.testResult,
        ...(result.proposal ? { proposal: result.proposal } : {}),
      });
    }
    return send(200, {
      ok: true,
      ...(result.installed !== undefined ? { installed: result.installed } : {}),
      ...(result.unchanged !== undefined ? { unchanged: result.unchanged } : {}),
      skill: result.skill,
      ...(result.testResult ? { testResult: result.testResult } : {}),
      ...(result.proposal ? { proposal: result.proposal } : {}),
    });
  };
}

// Orquestração de turno do Usami Core (/api/agent/turn e /api/agent/turns):
// classifica a mensagem e roteia para conversa, Tool Registry ou Planner,
// mantendo a mesma borda Host/Origin + x-usami-token.
const AGENT_TURN_ID_RE = /^\/api\/agent\/turns\/(trn-[0-9a-f]{12})$/;

export function createAgentTurnHandler(options = {}) {
  const allowedOrigins = options.allowedOrigins || DEFAULT_ALLOWED_ORIGINS;
  const agentCore = options.agentCore || installAgentCore;

  return async function handleAgentTurn(req, res) {
    const send = (status, data) => {
      if (res.headersSent) return;
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify(data));
    };

    if (!isAllowedOrigin(req.headers.origin, req.headers.host, allowedOrigins)) {
      return send(403, { error: 'Origem não autorizada.' });
    }
    if (denyWithoutToken(req, options, send)) return;

    const url = new URL(req.url || '/api/agent/turn', 'http://127.0.0.1:8787');
    const path = url.pathname;

    if (req.method === 'GET') {
      if (path === '/api/agent/turns') {
        const rawLimit = url.searchParams.get('limit');
        let limit = 20;
        if (rawLimit !== null) {
          const parsed = Number(rawLimit);
          if (!Number.isInteger(parsed) || parsed < 1 || parsed > 50) {
            return send(400, { error: 'limit inválido (inteiro entre 1 e 50).' });
          }
          limit = parsed;
        }
        const turns = agentCore.listTurns({ limit });
        return send(200, { ok: true, turns, count: turns.length });
      }
      const match = path.match(AGENT_TURN_ID_RE);
      if (!match) return send(404, { error: 'Não encontrado.' });
      const found = agentCore.getTurn(match[1]);
      if (!found.ok) return send(404, { error: 'Turno não encontrado.' });
      return send(200, { ok: true, turn: found.turn });
    }

    if (req.method !== 'POST' || path !== '/api/agent/turn') {
      return send(404, { error: 'Não encontrado.' });
    }

    const contentType = (req.headers['content-type'] || '').split(';')[0].trim();
    if (contentType !== 'application/json') return send(403, { error: 'Content-Type inválido.' });
    const read = await readRequestBody(req, { limit: 16384 });
    if (!read.ok) return send(413, { error: 'Pedido muito longo.' });

    let payload;
    try {
      payload = JSON.parse(read.body);
    } catch {
      return send(400, { error: 'Corpo da requisição inválido (JSON esperado).' });
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return send(400, { error: 'Corpo inválido.' });
    }
    const unknown = Object.keys(payload).filter(key => !['message', 'confirmation', 'origin'].includes(key));
    if (unknown.length) {
      return send(400, { error: 'Corpo inválido.', details: unknown.map(key => `payload.${key}: campo desconhecido`) });
    }
    if (typeof payload.message !== 'string') {
      return send(400, { error: 'message: deve ser texto.' });
    }
    const origin = payload.origin ?? 'agent';
    if (!EXECUTION_ORIGINS.includes(origin)) {
      return send(400, { error: `origin inválido (use ${EXECUTION_ORIGINS.join('|')}).` });
    }
    if (payload.confirmation !== undefined && (typeof payload.confirmation !== 'string' || payload.confirmation.length > 128)) {
      return send(400, { error: 'confirmation: deve ser texto de até 128 caracteres.' });
    }

    let result;
    try {
      result = await agentCore.processTurn(payload.message, {
        confirmation: payload.confirmation,
        origin,
      });
    } catch (error) {
      console.error('Aviso: falha ao processar turno agêntico:', error?.message || error);
      return send(500, { error: 'Não foi possível processar o turno.' });
    }
    if (result.invalidInput) return send(400, { error: result.error });
    return send(200, { ok: true, turn: result.turn });
  };
}

// Conquistas (data/achievements.json): leitura para a aba "Conquistas" do
// desktop. Mesma borda das rotas do vínculo (origem + token) e mesmo estilo de
// erro; antes de responder, reavalia o catálogo contra o vínculo para recuperar
// desbloqueios que um crash entre gravações possa ter perdido.
export function createAchievementsHandler(options = {}) {
  const allowedOrigins = options.allowedOrigins || DEFAULT_ALLOWED_ORIGINS;
  const store = options.achievementsStore || installAchievementsStore;
  const bondStore = options.bondStore || installBondStore;

  return async function handleAchievements(req, res) {
    const send = (status, data) => {
      if (res.headersSent) return;
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify(data));
    };

    const origin = req.headers.origin;
    const host = req.headers.host;
    if (!isAllowedOrigin(origin, host, allowedOrigins)) {
      return send(403, { error: 'Origem não autorizada.' });
    }
    if (denyWithoutToken(req, options, send)) return;

    const route = new URL(req.url || '/api/achievements', 'http://127.0.0.1:8787').pathname;

    if (req.method === 'GET' && route === '/api/achievements') {
      try {
        store.reevaluate(bondStore.getAll());
      } catch (error) {
        console.error('Aviso: reavaliação de conquistas falhou:', error?.message || error);
      }
      return send(200, { ok: true, achievements: store.list() });
    }

    return send(404, { error: 'Não encontrado.' });
  };
}
const DEFAULT_GEMINI_TTS_MODEL = 'gemini-2.5-flash-preview-tts';
const DEFAULT_GEMINI_TTS_VOICE = 'Kore';
// Direção de estilo em TAG entre colchetes, não em frase: transcrevendo o áudio
// com o whisper local, a instrução prosaica ("Leia em português do Brasil, com tom
// acolhedor e animado: ...") era FALADA pela modelo antes do texto — a Usami
// anunciava o próprio prompt. A tag entre colchetes muda a prosódia e nunca é lida.
// A base abaixo acompanha a voz desenhada `voice_ess199w2ioks` (take "d"): o
// timbre adulto da Kore/da voz anterior vinha de ressonância, não só de pitch.
const DEFAULT_GEMINI_TTS_INSTRUCTION = '[em português do Brasil, voz de personagem de anime, muito aguda e brilhante, timbre leve e expressivo, dicção rápida e nítida] ';
const DEFAULT_GEMINI_TTS_SAMPLE_RATE = 24000;
// Vozes desenhadas (Voice Design/Replication) têm id com prefixo voice_ e vão em
// voiceConfig.voice; pré-prontas (Kore, Puck...) permanecem em prebuiltVoiceConfig.
const CUSTOM_VOICE_PREFIX = 'voice_';
// Cláusulas de emoção por styleId (12 legadas + 69 V2 `<registro>_<emoção>`),
// fundidas na tag; neutral, casual_neutral e rótulos desconhecidos não têm cláusula
// e caem deterministicamente na tag base.
export { STYLE_INSTRUCTIONS, resolveGeminiStyleClause };

// Monta a tag de estilo a partir da base configurada + cláusula da emoção. Uma base
// legada em prosa (GEMINI_TTS_INSTRUCTION do .env) é convertida para tag, senão
// voltaria a ser falada.
export function buildGeminiInstruction(base, styleId) {
  let inner = String(base || '').trim()
    .replace(/:\s*$/, '')
    .replace(/^\[([\s\S]*)\]\s*$/, '$1')
    .trim();
  const clause = resolveGeminiStyleClause(styleId);
  const lowerStyle = String(styleId || '').toLowerCase();
  // Se o estilo for tímido, envergonhado, bravo ou triste, suprime menções a sorriso/travessa
  // da instrução base para evitar que o modelo de áudio Gemini alucine risos incontroláveis
  if (/(shy|blush|embarrassed|tsundere|angry|pout|sad|crying|serious|mumbling|frustrated)/i.test(lowerStyle)) {
    inner = inner
      .replace(/sorriso na voz/gi, '')
      .replace(/travessa/gi, '')
      .replace(/saltitante/gi, '')
      .replace(/,\s*,/g, ',')
      .replace(/[,\s]+$/, '')
      .trim();
  }
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

// Um único signal para o provedor: o do cliente (closed.signal, disparado quando
// a aba fecha) e o timeout de parede — aborta o que vier primeiro. Abortar o
// fetch encerra o corpo do provedor, o reader.read() rejeita e o slot do
// semáforo é liberado no finally (B10).
export function ttsAbortSignal(clientSignal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return clientSignal ? AbortSignal.any([clientSignal, timeout]) : timeout;
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
  signal = null,
  timeoutMs = 30000,
} = {}) {
  let response;
  try {
    response = await fetchImpl(geminiUrl + '/v1beta/models/' + encodeURIComponent(model) + ':streamGenerateContent?alt=sse', {
      method: 'POST',
      headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(geminiSpeechBody({ text, voice })),
      signal: ttsAbortSignal(signal, timeoutMs),
    });
  } catch {
    return { ok: false, reason: signal?.aborted ? 'abortado' : 'fetch-falhou' };
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

  const onAbort = () => {
    try { reader.cancel().catch(() => {}); } catch {}
  };
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });

  try {
    for (; ;) {
      // Cliente foi embora: sai do loop sem esperar o próximo pedaço (o fetch
      // também foi abortado; o reader pode ficar pendurado até o abort chegar).
      if (signal?.aborted) {
        onAbort();
        if (started) {
          try { res.end(); } catch { }
        }
        return { ok: false, reason: 'abortado' };
      }
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
    if (signal?.aborted) {
      if (started) {
        try { res.end(); } catch { }
      }
      return { ok: false, reason: 'abortado' };
    }
    // Canais quebrados no meio da fala: o que já saiu tocou. Não há como
    // voltar atrás na resposta iniciada, então fecha e registra.
    console.warn('tts: streaming interrompido:', error?.message || error);
    if (started) res.end();
    return { ok: false, reason: 'queda-no-meio' };
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }

  if (!started) return { ok: false, reason: 'sem-audio' };
  res.end();
  return { ok: true, pcm: Buffer.concat(segments), sampleRate };
}

export function createTtsHandler(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const getConfig = options.getConfig || (async () => {
    // options.envPath (testes) substitui o .env do projeto; no arquivo, gemini
    // tem prioridade sobre elevenlabs.
    const candidates = [options.envPath || keysFilePath()];
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
  const gate = options.gate || createSemaphore({ limit: 1, maxQueue: 4 });
  const cache = options.cache ? (options.cacheStore || createFileTtsCache({ directory: options.cacheDir || ttsCacheDir() })) : null;

  return async function handleTts(req, res) {
    const send = (status, data) => {
      if (res.headersSent) return;
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

    const read = await readRequestBody(req, { limit: 8192 });
    if (!read.ok) {
      return send(413, { error: 'Texto muito longo.' });
    }

    const parsedBody = parseTtsBody(read.body);
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

    // O provedor de TTS não tolera síntese concorrente: uma por vez, no servidor.
    // Fila curta; quem não cabe (ou espera demais) recebe 429/503 e o cliente cai
    // no fallback dele. Cliente que desconecta sai da fila.
    const closed = new AbortController();
    res.on?.('close', () => {
      if (!res.writableEnded) closed.abort();
    });
    let release;
    try {
      release = await gate.acquire({ signal: closed.signal, timeoutMs });
    } catch (error) {
      if (!(error instanceof SemaphoreRejected) || error.reason === 'aborted') return;
      return send(error.reason === 'full' ? 429 : 503, { error: 'TTS ocupado, tente novamente.' });
    }
    try {
      // Quem esperou na fila pode ter achado o áudio pronto (mesma frase pedida
      // duas vezes): confere o cache de novo antes de gastar o provedor.
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
            // Cliente que fecha a aba aborta o stream e libera o slot do semáforo.
            signal: closed.signal,
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
          if (res.headersSent || res.writableEnded) return;
        }
        if (provider === 'gemini') {
          // a key vai apenas no header x-goog-api-key (nunca na URL); o prefixo de
          // instrução não conta no limite de 2000 chars, validado sobre o texto puro
          response = await fetchImpl(geminiUrl + '/v1beta/models/' + encodeURIComponent(geminiModel) + ':generateContent', {
            method: 'POST',
            headers: { 'x-goog-api-key': config.apiKey, 'Content-Type': 'application/json' },
            body: JSON.stringify(geminiSpeechBody({ text: geminiInstruction + parsedBody.text, voice: geminiVoice })),
            signal: ttsAbortSignal(closed.signal, timeoutMs),
          });
        } else {
          response = await fetchImpl(ttsUrl + '/v1/text-to-speech/' + encodeURIComponent(config.voiceId) + '?output_format=mp3_44100_128', {
            method: 'POST',
            headers: { 'xi-api-key': config.apiKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: parsedBody.text, model_id: model, output_format: 'mp3_44100_128' }),
            signal: ttsAbortSignal(closed.signal, timeoutMs),
          });
        }
      } catch {
        // Cliente desconectou: nada a responder e o provedor já foi abortado.
        if (closed.signal.aborted) return;
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
        if (!res.headersSent) send(502, { error: 'TTS falhou no provedor.' });
        return;
      }

      if (!res.headersSent) {
        res.writeHead(200, { 'Content-Type': audioFormat, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        if (cache && cacheKey) {
          try { await cache.put(cacheKey, audio); } catch {
            // Cache failures never make a successful synthesis fail.
          }
        }
        res.end(audio);
      }
    } finally {
      release();
    }
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
  wrapped.catch(() => { });
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
  const tmpDir = options.tmpDir || sttTmpDir();
  const maxBodyBytes = options.maxBodyBytes || 8 * 1024 * 1024;
  // Whisper carrega um modelo por processo (CPU/RAM): uma transcrição por vez,
  // fila de 2. Sem o gate, N POSTs simultâneos spawnavam N pythons.
  const gate = options.gate || createSemaphore({ limit: 1, maxQueue: 2 });
  const queueTimeoutMs = options.queueTimeoutMs || 60000;

  return async function handleStt(req, res) {
    const send = (status, data) => {
      if (res.headersSent) return;
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
    // Escrita sensível (D2): áudio do microfone só entra com token.
    if (denyWithoutToken(req, options, send)) return;

    const contentType = req.headers['content-type'] || '';
    const mime = contentType.split(';')[0].trim().toLowerCase();
    if (mime !== 'multipart/form-data') {
      return send(403, { error: 'Content-Type inválido.' });
    }

    // Limite por bytes lidos (chunks binários), não por tamanho de string.
    const read = await readBodyBuffer(req, { limit: maxBodyBytes });
    if (!read.ok) {
      return send(413, { error: 'Áudio muito grande.' });
    }

    const parsed = parseMultipartAudio(read.buffer, contentType);
    if (!parsed.ok) {
      return send(parsed.status, { error: parsed.error });
    }

    let release;
    try {
      release = await gate.acquire({ timeoutMs: queueTimeoutMs });
    } catch (error) {
      if (!(error instanceof SemaphoreRejected)) throw error;
      return send(error.reason === 'full' ? 429 : 503, { error: 'STT ocupado, tente novamente.' });
    }
    try {
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
    } finally {
      release();
    }
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
  // Mesma cerca/parse tolerante dos outros parsers (B14): o modelo às vezes
  // devolve ```json e às vezes prosa antes do objeto.
  const text = stripCodeFence(raw);
  if (!text || text.length > 20000) return { ok: false };
  const parsed = parseJsonLoosely(text);
  if (!parsed.ok) return { ok: false };
  const value = parsed.value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false };
  return { ok: true, value };
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
  const dataDir = options.dataDir || resolveDataDir();
  const store = options.store || createTechniqueStore({ dataDir });
  const readFicha = options.readFicha || (sourceId => readIngestedFicha(sourceId, { dataDir }));
  const llm = options.llm || (prompt => structureTechnique(prompt));
  const allowedOrigins = options.allowedOrigins || DEFAULT_ALLOWED_ORIGINS;
  const timeoutMs = options.timeoutMs || TECHNIQUE_TIMEOUT_MS;
  // O índice é derivado dos JSON: se ele falhar, a rota volta a ler a base
  // direto do disco. Nunca é fonte da verdade.
  const index = options.index || createTechniqueIndex({ dataDir });
  const writeNote = options.writeNote || writeTechniqueNote;
  // Base da subárvore de automação do vault (descendência validada em
  // technique-docs.js). Injetável para os testes usarem um vault falso.
  const vaultRoot = options.vaultRoot;

  return async function handleTechnique(req, res) {
    const send = (status, data) => {
      if (res.headersSent) return;
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

    const read = await readRequestBody(req, { limit: TECHNIQUE_BODY_LIMIT });
    if (!read.ok) return send(413, { error: 'Corpo muito longo.' });
    // O corpo vira `body` para os parsers da rota (nome preservado)
    const body = read.body;

    // --- camada documental: JSON é a verdade, a nota é derivada e opcional ---
    if (route === '/api/technique/note') {
      // Escreve no vault: escrita sensível, token obrigatório (D2).
      if (denyWithoutToken(req, options, send)) return;
      const noteBody = parseTechniqueNoteBody(body);
      if (!noteBody.ok) return send(noteBody.status, { error: noteBody.error });
      const found = await store.get(noteBody.id);
      if (!found.ok) return send(404, { error: found.errors.join('; ') });
      const source = noteBody.sourceId ? await readFicha(noteBody.sourceId) : null;
      const written = await writeNote(found.technique, {
        vaultDir: noteBody.vaultDir,
        vaultRoot,
        source: source?.ok ? source.ficha : undefined,
      });
      if (!written.ok) return send(422, { error: written.error });
      console.log(`[technique] nota ${written.path}`);
      return send(200, { path: written.path, techniqueId: noteBody.id });
    }

    const parsed = parseTechniqueBody(body);
    if (!parsed.ok) return send(parsed.status, { error: parsed.error });
    // Gate de aprovação humana (B4): `proposta` é rascunho revisável; qualquer
    // outro status (validada/rejeitada/...) alimenta ou bloqueia o planner e só
    // o operador com token pode gravá-lo. A checagem fica no SERVIDOR — antes
    // ela era só convenção do cliente.
    if (parsed.status !== 'proposta') {
      if (denyWithoutToken(req, options, send)) return;
    }

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
  const dataDir = options.dataDir || resolveDataDir();
  const techniques = options.techniques || (() => (options.store || createTechniqueStore({ dataDir })).list());
  const memory = options.memory || createLearningMemory({ dataDir });
  const allowedOrigins = options.allowedOrigins || DEFAULT_ALLOWED_ORIGINS;

  return async function handlePlan(req, res) {
    const send = (status, data) => {
      if (res.headersSent) return;
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
    // Escritas sensíveis (D2): planejar e registrar veredito exigem token; a
    // leitura (GET /api/learning) fica só com a borda de origem.
    if (denyWithoutToken(req, options, send)) return;

    const read = await readRequestBody(req, { limit: PLAN_BODY_LIMIT });
    if (!read.ok) return send(413, { error: 'Corpo muito longo.' });
    const body = read.body;

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

export function createMediaAnalyzeHandler(options = {}) {
  const allowedOrigins = options.allowedOrigins || DEFAULT_ALLOWED_ORIGINS;
  const getKey = options.getKey || (async () => readEnvValue('GEMINI_API_KEY'));
  const memoryStore = options.memoryStore || installMemoryStore;
  const personalityStore = options.personalityStore || installPersonalityStore;
  // Base64 + JSON.parse + frames multiplicam o payload em RAM: uma análise por
  // vez, fila curta. O limite é por BYTES lidos (48 MB de corpo JSON), não pelo
  // tamanho da string — a mensagem antiga dizia 45MB com limite real de 60MB.
  const maxBodyBytes = options.maxBodyBytes || 48 * 1024 * 1024;
  const maxPayloadLabel = options.maxPayloadLabel || '48MB';
  const gate = options.gate || createSemaphore({ limit: 1, maxQueue: 1 });
  const queueTimeoutMs = options.queueTimeoutMs || 90000;

  return async function handleMediaAnalyze(req, res) {
    const send = (status, data) => {
      if (res.headersSent) return;
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify(data));
    };

    if (req.method !== 'POST' || req.url !== '/api/media/analyze') {
      return send(404, { error: 'Não encontrado.' });
    }

    const origin = req.headers.origin;
    const host = req.headers.host;
    if (!isAllowedOrigin(origin, host, allowedOrigins)) {
      return send(403, { error: 'Origem não autorizada.' });
    }
    // Escrita sensível (D2): o corpo carrega mídia e a rota gasta a chave de visão.
    if (denyWithoutToken(req, options, send)) return;

    // Leitura em Buffers: soma bytes reais e decodifica UTF-8 uma única vez.
    const read = await readBodyBuffer(req, { limit: maxBodyBytes });
    if (!read.ok) {
      return send(413, { error: 'Mídia muito grande (máximo ' + maxPayloadLabel + ').' });
    }

    let parsed;
    try {
      parsed = JSON.parse(read.buffer.toString('utf8'));
    } catch {
      return send(400, { error: 'Corpo da requisição deve ser JSON válido.' });
    }

    const { mimeType, data, filename, prompt } = parsed;
    if (!data || typeof data !== 'string') {
      return send(400, { error: 'Campo "data" (base64) é obrigatório.' });
    }
    // Catálogo opcional no corpo (mesmo formato do /api/chat). O frontend atual
    // não envia, então sem catálogo o filtro mantém as ações válidas.
    const capabilities = sanitizeCapabilities(parsed.capabilities);

    const apiKey = await getKey();

    let personaPrompt = '';
    try {
      const mem = memoryStore.getAll?.() || {};
      const today = new Date().toISOString().slice(0, 10);
      const hour = new Date().getHours();
      const timeOfDay = hour < 12 ? 'manhã' : hour < 18 ? 'tarde' : 'noite';
      personaPrompt = buildPersona({
        affinity: mem.affinity?.score || 0,
        sections: memoryStore.getSections?.() || {},
        recentFacts: memoryStore.getRecentFacts?.(new Date().toISOString()) || [],
        history: memoryStore.getTodayHistory?.(today) || [],
        summaries: memoryStore.getSummaries?.().slice(-3) || [],
        username: mem.user?.nickname || 'você',
        date: today,
        timeOfDay,
        personality: personalityStore?.get?.(),
      });
    } catch {
      // continua sem persona detalhada se falhar
    }

    let release;
    try {
      release = await gate.acquire({ timeoutMs: queueTimeoutMs });
    } catch (error) {
      if (!(error instanceof SemaphoreRejected)) throw error;
      return send(error.reason === 'full' ? 429 : 503, { error: 'Análise de mídia ocupada, tente novamente.' });
    }
    let result;
    try {
      result = await analyzeMedia({
        mimeType,
        dataBase64: data,
        filename,
        userPrompt: prompt,
        personaSystemPrompt: personaPrompt,
        apiKey,
        fetchImpl: options.fetchImpl || globalThis.fetch,
        extractMedia: options.extractMedia,
        timeoutMs: 90000,
      });
    } finally {
      release();
    }

    if (result.ok) {
      // B15: as ações da mídia passam pelo MESMO filtro de catálogo do chat —
      // o que o avatar não tem (expressão/gesto/clip) não chega ao cliente.
      result = { ...result, actions: filterActionsByCatalog(result.actions ?? [], capabilities) };
      try {
        const turnTimestamp = new Date().toISOString();
        const mediaTypeLabel = mimeType?.startsWith('video/') ? 'Vídeo' : 'Imagem';
        const visualSummary = result.crossReference || result.summary || (result.ocr?.length ? `Texto lido: ${result.ocr.join(', ')}` : 'mídia compartilhada');
        const audioSummary = result.transcript ? ` [Áudio: ${result.transcript}]` : '';

        const userTurnContent = `[${mediaTypeLabel}: ${filename || 'arquivo'}] ${prompt ? `"${prompt}" ` : ''}(Conteúdo visto/ouvido: ${visualSummary}${audioSummary})`.trim();
        const assistantTurnContent = result.reply;

        memoryStore.appendHistory?.('user', userTurnContent, turnTimestamp);
        memoryStore.appendHistory?.('assistant', assistantTurnContent, turnTimestamp);

        const factText = `Compartilhou ${mediaTypeLabel.toLowerCase()} "${filename || 'mídia'}": ${visualSummary.slice(0, 180)}`;
        memoryStore.addRecentFact?.(factText, 7, 'other');
      } catch (err) {
        console.warn('[media-analyzer] Falha ao persistir na memória:', err.message);
      }
    }

    return send(result.ok ? 200 : 500, result);
  };
}

// --- Proatividade: trigger e estado ----------------------------------------

// Eram as únicas rotas despachadas inline, fora de isAllowedRequest e sem token
// (B5). O gatilho gera fala proativa e o estado expõe o humor do runtime: os dois
// passam a exigir a mesma borda das demais escritas (D2).
export function createProactiveHandler(options = {}) {
  const allowedOrigins = options.allowedOrigins || DEFAULT_ALLOWED_ORIGINS;
  const engine = options.proactiveEngine || proactiveEngine;
  const store = options.proactiveStore || installProactiveStore;

  return async function handleProactive(req, res) {
    const send = (status, data) => {
      if (res.headersSent) return;
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify(data));
    };

    if (!isAllowedOrigin(req.headers.origin, req.headers.host, allowedOrigins)) {
      return send(403, { error: 'Origem não autorizada.' });
    }
    if (denyWithoutToken(req, options, send)) return;

    const url = new URL(req.url, 'http://127.0.0.1:8787');
    const path = url.pathname;

    if (req.method === 'GET' && path === '/api/proactive/events') {
      const activityHeader = req.headers['x-usami-activity'];
      if (activityHeader === 'active' && typeof engine.markUserActivity === 'function') {
        engine.markUserActivity();
      }

      if (typeof store.ingestVaultReminders === 'function') {
        store.ingestVaultReminders();
      }

      const events = typeof store.getPendingEvents === 'function' ? store.getPendingEvents() : [];
      return send(200, {
        events,
        serverTime: new Date().toISOString(),
      });
    }

    if (req.method === 'POST' && path === '/api/proactive/events/ack') {
      const read = await readRequestBody(req, { limit: 8 * 1024 });
      if (!read.ok) return send(413, { error: 'Corpo muito longo.' });
      let body;
      try {
        body = JSON.parse(read.body);
      } catch {
        return send(400, { error: 'JSON inválido.' });
      }
      if (!body || !Array.isArray(body.acks)) {
        return send(400, { error: 'Formato esperado: { acks: [...] }' });
      }
      const ackResult = typeof store.ackEvents === 'function' ? store.ackEvents(body.acks) : { acked: 0 };
      return send(200, { ok: true, acked: ackResult.acked });
    }

    if (req.method === 'POST' && path === '/api/proactive/events') {
      const read = await readRequestBody(req, { limit: 8 * 1024 });
      if (!read.ok) return send(413, { error: 'Corpo muito longo.' });
      let body;
      try {
        body = JSON.parse(read.body);
      } catch {
        return send(400, { error: 'JSON inválido.' });
      }
      const addResult = typeof store.addEvent === 'function' ? store.addEvent(body) : { ok: false, error: 'Store indisponível' };
      if (!addResult.ok) {
        return send(addResult.status || 400, { error: addResult.error });
      }
      return send(201, addResult);
    }

    if (req.method === 'POST' && path === '/api/proactive/trigger') {
      try {
        return send(200, await engine.checkAndTrigger());
      } catch {
        return send(500, { error: 'Falha ao disparar a proatividade.' });
      }
    }
    if (req.method === 'GET' && path === '/api/proactive/state') {
      try {
        const engineState = typeof engine.getState === 'function' ? engine.getState() : {};
        const storeState = typeof store.getState === 'function' ? store.getState() : {};
        return send(200, { engine: engineState, store: storeState });
      } catch {
        return send(500, { error: 'Falha ao ler o estado da proatividade.' });
      }
    }
    return send(404, { error: 'Não encontrado.' });
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  // O handler consolidado preserva a persona, memória e afinidade no prompt.
  // O FlowExecutor segue coberto por testes enquanto essa paridade completa é
  // finalizada, sem trocar comportamento real por um pipeline parcial.
  const handleChat = createChatHandler({ agentCore: installAgentCore });
  const handleAgentTurn = createAgentTurnHandler();
  const handleTts = createTtsHandler({ cache: true });
  const handleStt = createSttHandler();
  const handleMediaAnalyze = createMediaAnalyzeHandler();
  const handleN8nCommand = createN8nCommandHandler();
  const handleRagContext = createRagContextHandler();
  const handleMemory = createMemoryHandler();
  const handleBond = createBondHandler();
  const handleOperationalMemory = createOperationalMemoryHandler();
  const handleTools = createToolHandler({ gate: installToolGate, skillCatalog: installSkillCatalog });
  const handlePlans = createPlansHandler();
  const handleSkills = createSkillsHandler();
  const handleAchievements = createAchievementsHandler();
  const handlePersonality = createPersonalityHandler();
  const handleTechnique = createTechniqueHandler();
  const handlePlan = createPlannerHandler();
  const handleProactive = createProactiveHandler();
    const handleAvatarStatic = createStaticAssetHandler({ rootDir: pathResolve('public') });
    const server = createServer(async (req, res) => {
      // Assets estáticos de avatar e animações (VRM, VRMA, Live2D) com ETag/304 inteligente (OpenAmika avatar_cache)
      if ((req.method === 'GET' || req.method === 'HEAD') && (
        req.url.startsWith('/models/') || req.url.startsWith('/animations/') || req.url.startsWith('/live2d/')
      )) {
        const served = await handleAvatarStatic(req, res);
        if (served) return;
      }
      if (req.method === 'POST' && req.url === '/api/chat') return handleChat(req, res);
      if (req.method === 'POST' && req.url === '/api/media/analyze') return handleMediaAnalyze(req, res);
      if (req.method === 'POST' && req.url === '/api/tts') return handleTts(req, res);
      if (req.method === 'POST' && req.url === '/api/stt') return handleStt(req, res);
      if (req.method === 'POST' && req.url === '/api/n8n/command') return handleN8nCommand(req, res);
      if (req.method === 'GET' && (req.url === '/api/n8n/commands' || req.url.startsWith('/api/n8n/commands?'))) return handleN8nCommand(req, res);
      if (req.method === 'DELETE' && (req.url === '/api/n8n/commands' || req.url.startsWith('/api/n8n/commands?'))) return handleN8nCommand(req, res);
      if (req.method === 'POST' && req.url === '/api/n8n/commands/ack') return handleN8nCommand(req, res);
      if (req.method === 'GET' && req.url === '/api/rag/context') return handleRagContext(req, res);
      if (req.url === '/api/memory' || req.url === '/api/memory/forget') return handleMemory(req, res);
      if (req.url === '/api/bond' || req.url === '/api/bond/event' || req.url === '/api/bond/import' || req.url === '/api/bond/reset') return handleBond(req, res);
      if (req.method === 'GET' && req.url === '/api/achievements') return handleAchievements(req, res);
      if (req.url === '/api/personality') return handlePersonality(req, res);
      if (req.url === '/api/technique' || req.url === '/api/techniques' || req.url === '/api/technique/note'
        || req.url.startsWith('/api/technique?') || req.url.startsWith('/api/techniques?')) return handleTechnique(req, res);
      if (req.url === '/api/plan' || req.url === '/api/learning' || req.url === '/api/learning/verdict'
        || req.url.startsWith('/api/learning?')) return handlePlan(req, res);
      if (req.url === '/api/agent/memory' || req.url.startsWith('/api/agent/memory/') || req.url.startsWith('/api/agent/memory?')) return handleOperationalMemory(req, res);
      if (req.url === '/api/agent/executions' || req.url.startsWith('/api/agent/executions?')
        || req.url === '/api/agent/confirmations' || req.url.startsWith('/api/agent/confirmations?')
        || req.url === '/api/agent/permissions' || req.url.startsWith('/api/agent/permissions?')
        || req.url.startsWith('/api/agent/tools/')) return handleTools(req, res);
      if (req.url === '/api/agent/plans' || req.url.startsWith('/api/agent/plans/') || req.url.startsWith('/api/agent/plans?')) return handlePlans(req, res);
      if (req.url === '/api/agent/skills' || req.url.startsWith('/api/agent/skills/') || req.url.startsWith('/api/agent/skills?')) return handleSkills(req, res);
      if (req.url === '/api/agent/turn' || req.url === '/api/agent/turns'
        || req.url.startsWith('/api/agent/turns/') || req.url.startsWith('/api/agent/turns?')) return handleAgentTurn(req, res);
      if (req.url.startsWith('/api/proactive/')) return handleProactive(req, res);
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify({ error: 'Não encontrado.' }));
    });
    proactiveEngine.start(60000);
    server.listen(8787, '127.0.0.1', () => console.log('Usami API local em 127.0.0.1:8787'));
  }
