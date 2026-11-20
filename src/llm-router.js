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
import { extractAllJsonCandidates } from './json-salvage.js';
import { parseJsonLoosely, parseProviderRaw, parseXmlToolCalls, stripXmlToolCalls } from './provider-parse.js';
import { sharedClient, sharedRateLimiter } from './nvidia-client.js';
import { TECHNIQUE_SYSTEM_PROMPT } from './technique-schema.js';

const DEFAULT_CLASSIFICATION_MODEL = 'nvidia/nemotron-3-ultra-550b-a55b';
const DEFAULT_GENERATION_MODEL = 'nvidia/nemotron-3-ultra-550b-a55b';
const DEFAULT_ANIMATION_MODEL = 'nvidia/nemotron-3-ultra-550b-a55b';

// Modelos por papel (Etapa 1 do plano de roteamento multi-modelo):
//   FAST  — "boca"/chat rápido: saudações, perguntas simples, baixa latência.
//   BRAIN — "chefão": código, MCP, tool calling, raciocínio estruturado.
//   VISION — modelo VL, usado só quando a entrada contém imagem (base64).
//
// Defaults MEDIDOS nesta conta (2026-11-13): `GET /v1/models` lista 83
// modelos, mas a maioria responde 404 ("Function not found for account") —
// estar na lista não é estar disponível. Medidos com `response_format:
// json_object` e o prompt de persona real:
//   minimaxai/minimax-m3.1-flash  → 1,6 s / 2,0 s, JSON válido 3/3 (FAST)
//   nvidia/nemotron-3-ultra-550b → 1,9 s / 3,2 s, JSON válido 3/3 (BRAIN)
//   nvidia/nemotron-3.5-super-vl-120b-a12b → 1,4-2,3 s, JSON válido 3/3 (VISION)
// O plano original (mistral-nemo-12b como FAST, mistral-large-2 como BRAIN)
// responde 404 nesta conta — trocar exige que a "function" seja implantada.
const DEFAULT_FAST_MODEL = 'minimaxai/minimax-m3.1-flash';
const DEFAULT_BRAIN_MODEL = 'nvidia/nemotron-3-ultra-550b-a55b';
const DEFAULT_VISION_MODEL = 'nvidia/nemotron-3.5-super-vl-120b-a12b';

function envOr(name, fallback) {
  return process.env[name] || fallback;
}

const CLASSIFICATION_MODEL = envOr('NVIDIA_CLASSIFICATION_MODEL', DEFAULT_CLASSIFICATION_MODEL);
const GENERATION_MODEL = envOr('NVIDIA_GENERATION_MODEL', DEFAULT_GENERATION_MODEL);
const ANIMATION_MODEL = envOr('NVIDIA_ANIMATION_MODEL', DEFAULT_ANIMATION_MODEL);
export const FAST_MODEL = envOr('NVIDIA_FAST_MODEL', DEFAULT_FAST_MODEL);
export const BRAIN_MODEL = envOr('NVIDIA_BRAIN_MODEL', DEFAULT_BRAIN_MODEL);
export const VISION_MODEL = envOr('NVIDIA_VISION_MODEL', DEFAULT_VISION_MODEL);

// Seleciona o modelo pelo papel (Etapa 1). Papéis desconhecidos caem no FAST
// (chat rápido) para não quebrar o fluxo.
export function getRoleModel(role) {
  switch (role) {
    case 'brain': return BRAIN_MODEL;
    case 'vision': return VISION_MODEL;
    case 'fast':
    default: return FAST_MODEL;
  }
}

// O raciocínio do nemotron é o que domina o turno. No MESMO prompt de fala+ações:
// 23,0s/515 tokens, 9,0s/356 e 23,8s/527 com thinking; 1,35s/53, 5,5s/57 e
// 2,2s/72 com `enable_thinking: false` (JSON válido nos seis casos). No diretor de
// animação: 32,1s/428 -> 9,6s/21. Documentado na referência do modelo; a doc avisa
// que em alguns modelos hospedados a chave não tem efeito — aqui tem, medido.
// O cinto continua sendo o max_tokens de cada chamada (500/900/1100), então o
// padrão é o comportamento de sempre. NVIDIA_LLM_THINKING=off desliga o raciocínio
// para comparar latência e fala sem mexer em código — lido por chamada, então
// val = 'off' na API já vale para os turnos seguintes.
const NO_THINKING = { chat_template_kwargs: { enable_thinking: false } };
function llmExtra() {
  return process.env.NVIDIA_LLM_THINKING === 'off' ? NO_THINKING : null;
}

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
{"actions":[{"type":"gesture","name":"tilt" ou "wave" ou "idle" ou "clap" ou "hand-on-hip" ou "wave2" ou "point" ou "shrug" ou "head-scratch" ou "arms-crossed" ou "facepalm" ou "cheer" ou "blow-kiss" ou "hands-on-cheeks" ou "bow","delayMs":0},{"type":"play_clip","name":"Nome do clip","delayMs":0},{"type":"set_morph","name":"Nome do morph","value":0 a 1,"delayMs":0},{"type":"set_mesh_visible","name":"mesh","visible":true,"delayMs":0},{"type":"set_expression","name":"expressao","weight":0 a 1,"delayMs":0},{"type":"play_sequence","shape":"wave-arm" ou "sway-arms" ou "nod" ou "head-tilt-curve" ou "reach" ou "shiver","amplitude":0.02 a 0.5,"cycles":1 a 8,"durationMs":600 a 8000,"side":"left" ou "right","delayMs":0}]}

play_sequence: use quando nenhum gesto listado expressa o movimento pedido; só vale se capabilities.sequences for true.

Gestos: clap=bater palmas, hand-on-hip=mão na cintura, wave2=aceno com as duas mãos, point=apontar, shrug=dar de ombros, head-scratch=coçar a cabeça, arms-crossed=braços cruzados, facepalm=mão no rosto, cheer=comemorar, blow-kiss=jogar beijo, hands-on-cheeks=mãos nas bochechas, bow=reverência. wave/tilt/idle são os discretos. Use o gesto que combina com o texto; prefira um só gesto por resposta.

Cada ação pode ter delayMs (ms após o início da fala) para sincronizar com o áudio. No máximo 5 ações. Se não houver ação adequada, actions: []`;

// --- Classificação (frase do usuário) -------------------------------------

export async function classifyUserMessage(text, { classifier = classifyEmotion, local = false } = {}) {
  // Sem chave NVIDIA, ou com `local`, usa o classificador determinístico (sem
  // gastar chamada nem slot do rate limiter).
  if (local || !process.env.NVIDIA_API_KEY) {
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
    const answer = await sharedClient.chatJson({
      model: CLASSIFICATION_MODEL,
      messages,
      temperature: 0.2,
      // Orçamento p/ o preâmbulo de raciocínio do modelo; 200 morria antes do JSON.
      max_tokens: 500,
      extra: llmExtra(),
    });
    const parsed = parseJsonSafe(jsonText(answer, 'emotion'), { label: 'de classificação', answer });
    return {
      emotion: parsed.emotion || 'neutral',
      confidence: Number.isFinite(parsed.confidence) ? Math.min(1, Math.max(0, parsed.confidence)) : 0,
      intensity: Number.isFinite(parsed.intensity) ? Math.min(1, Math.max(0, parsed.intensity)) : 0,
      facs: Array.isArray(parsed.facs) ? parsed.facs : emotionToFacs(parsed.emotion || 'neutral'),
      source: 'nvidia',
    };
  } catch (error) {
    console.warn('NVIDIA classification falhou, fallback local:', describeFetchError(error));
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

// --- Geração (resposta + ações numa só chamada) ---------------------------
//
// O prompt de persona (src/persona.js) já pede {"reply","gesture","actions",
// "remember"} e o chamador anexa as capacidades do avatar a ele; é dessa lista
// que o modelo pega os verbos — ANIMATION_SYSTEM fica como está, porque
// planAnimation continua sendo o refinamento em background.
//
// maxTokens 1800: o preâmbulo de raciocínio + reply (≤180 chars) + até 5
// actions + remember precisam de folga para não bater finish=length em
// modelos com reasoning quando há contexto de skill.
export async function generateReplyWithActions(
  systemPrompt,
  userMessage,
  { temperature = 0.7, maxTokens = 1800, client = sharedClient, signal, blurtReply, model } = {},
) {
  if (!process.env.NVIDIA_API_KEY) throw new Error('NVIDIA_API_KEY não configurada');

  let finalSystem = systemPrompt;
  if (blurtReply && typeof blurtReply === 'string' && blurtReply.trim()) {
    finalSystem += `\n\n=== RECONCILIAÇÃO DO REFLEXO IMEDIATO ===\nVocê acabou de soltar a seguinte reação espontânea em voz alta: "${blurtReply.trim()}"\nO usuário JÁ OUVIU essa frase.\nREGRAS CRÍTICAS:\n1. NÃO repita e NÃO parafraseie essa frase de abertura.\n2. No JSON de resposta, o campo "reply" deve conter APENAS a continuação da conversa.\n`;
  }

  const messages = [
    { role: 'system', content: finalSystem },
    { role: 'user', content: userMessage },
  ];
  const answer = await client.chatJson({
    model: (model || GENERATION_MODEL),
    messages,
    temperature,
    max_tokens: maxTokens,
    extra: llmExtra(),
    // deadline do turno / cliente desconectado cancelam a chamada ao provedor
    ...(signal ? { signal } : {}),
  });
  // Texto cru, como generateReply: parse e fallback OpenRouter são do chamador.
  return jsonText(answer, 'reply');
}

// Converte chamadas escritas em texto para o formato OpenAI `tool_calls`.
// Só aceita ferramentas oferecidas no turno (nome com ponto ou sublinhado).
export function textToolCallsToOpenAi(content, tools = [], iteration = 0) {
  const offered = new Set((tools || []).map(t => t?.function?.name).filter(Boolean));
  return parseXmlToolCalls(content)
    .map((call, index) => {
      const fnName = [call.name, call.name.replace(/\./g, '_')].find(n => offered.has(n));
      if (!fnName) return null;
      return {
        id: `text_call_${iteration}_${index}`,
        type: 'function',
        function: { name: fnName, arguments: JSON.stringify(call.args || {}) },
      };
    })
    .filter(Boolean);
}

function formatToolResultContent(result, maxChars = 3500) {
  let str = '';
  try {
    str = JSON.stringify(result ?? {});
  } catch {
    str = String(result ?? '');
  }
  if (str.length <= maxChars) return str;
  return str.slice(0, maxChars) + '... [truncado por tamanho]';
}

// --- Tool calling nativo & Multi-Tool Chaining (Etapa 4b) --------------------
// Chama o provedor com `tools` no formato OpenAI function-calling. Se o modelo
// devolver tool_calls, executa cada uma via `executeTool` e faz chamadas de
// follow-up permitindo encadeamento autônomo (multi-step ReAct).
export async function generateReplyWithTools(
  systemPrompt,
  userMessage,
  {
    model,
    tools = [],
    executeTool = async () => ({ ok: false, error: 'executor ausente' }),
    maxIterations = 4,
    temperature = 0.7,
    maxTokens = 1800,
    client = sharedClient,
    signal,
    blurtReply,
  } = {},
) {
  if (!process.env.NVIDIA_API_KEY) throw new Error('NVIDIA_API_KEY não configurada');

  let finalSystem = systemPrompt;
  if (blurtReply && typeof blurtReply === 'string' && blurtReply.trim()) {
    finalSystem += `\n\n=== RECONCILIAÇÃO DO REFLEXO IMEDIATO ===\nVocê acabou de soltar a seguinte reação espontânea em voz alta: "${blurtReply.trim()}"\nO usuário JÁ OUVIU essa frase.\nREGRAS CRÍTICAS:\n1. NÃO repita e NÃO parafraseie essa frase de abertura.\n2. No JSON de resposta, o campo "reply" deve conter APENAS a continuação da conversa.\n`;
  }

  if (tools && tools.length > 0) {
    finalSystem += `\n\n=== DIRETRIZES DE USO DE FERRAMENTAS MULTI-PASSO (CHAINING) ===\n1. Você tem permissão e incentivo para encadear ferramentas em sequência caso a tarefa do usuário envolva mais de uma etapa ou dependa do resultado de uma ferramenta anterior.\n2. Analise os resultados recebidos antes de decidir a próxima chamada ou concluir.\n3. Quando obtiver todos os dados necessários, encerre as chamadas e formule a resposta final estritamente em JSON com "reply", "gesture" e "actions".\n`;
  }

  const messages = [
    { role: 'system', content: finalSystem },
    { role: 'user', content: userMessage },
  ];

  const executedTools = [];

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const isLastIteration = iteration === maxIterations - 1;
    const extra = tools && tools.length
      ? { tools, tool_choice: isLastIteration ? 'none' : 'auto' }
      : null;

    let answer;
    try {
      answer = await client.chatCompletions({
        model: model || GENERATION_MODEL,
        messages,
        temperature,
        max_tokens: maxTokens,
        extra: { ...(extra || {}), ...(llmExtra() || {}) },
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      throw error;
    }

    const msg = answer?.choices?.[0]?.message;
    if (!msg) throw new Error('resposta inválida do provedor (sem message)');

    let toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    let assistantContent = msg.content || null;
    // Modelo escreveu a chamada como texto (<tool_call>...) em vez do canal
    // nativo: converte para tool_calls e executa, em vez de mandar o XML
    // para o chat como se fosse a fala.
    if (toolCalls.length === 0 && !isLastIteration && tools?.length && typeof msg.content === 'string') {
      toolCalls = textToolCallsToOpenAi(msg.content, tools, iteration);
      if (toolCalls.length) assistantContent = stripXmlToolCalls(msg.content) || null;
    }
    if (toolCalls.length > 0 && !isLastIteration) {
      messages.push({ role: 'assistant', content: assistantContent, tool_calls: toolCalls });
      for (const tc of toolCalls) {
        const name = tc?.function?.name;
        let args = {};
        try { args = JSON.parse(tc?.function?.arguments || '{}'); } catch { args = {}; }
        let result;
        try {
          result = await executeTool(name, args);
        } catch (error) {
          result = { ok: false, error: String(error?.message || error) };
        }
        executedTools.push({ name, args, result, id: tc.id });
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: formatToolResultContent(result),
        });
      }
      continue;
    }

    // Resposta final (texto). Parseia como JSON de reply.
    const text = typeof msg.content === 'string' ? msg.content : '';
    const parsed = parseProviderRaw(text);
    if (parsed.ok) {
      return { ...parsed, source: 'nvidia', executedTools };
    }
    const loose = parseJsonLoosely(text);
    if (loose.ok && loose.value && typeof loose.value === 'object' && loose.value.reply) {
      return { ...loose.value, source: 'nvidia', executedTools };
    }
    // Sem JSON recuperável: devolve o texto como reply, sem tool call em texto.
    const plain = stripXmlToolCalls(text);
    if (!plain) {
      return { ok: false, error: 'O modelo retornou só uma chamada de ferramenta, sem fala.', reply: '', gesture: 'neutral', actions: [], executedTools, source: 'nvidia' };
    }
    return { ok: true, reply: plain.slice(0, 300), gesture: 'neutral', actions: [], executedTools, source: 'nvidia' };
  }

  // Esgotou iterações sem resposta final.
  return { ok: false, reply: 'Não consegui concluir a tarefa (muitas chamadas de ferramenta).', gesture: 'neutral', actions: [], executedTools, source: 'nvidia' };
}

// --- Classificador Semântico de Intenção (FAST_MODEL) -----------------------
// Analisa a mensagem do usuário para categorizar em conversation, operational
// ou complex e identificar a ferramenta candidata sem depender de regexes.
export async function classifyIntentWithLlm({
  message,
  tools = [],
  signal,
  model = FAST_MODEL,
  client = sharedClient,
} = {}) {
  if (!process.env.NVIDIA_API_KEY) return null;
  const toolNames = Array.isArray(tools)
    ? tools.map(t => (typeof t === 'string' ? t : t?.name)).filter(Boolean)
    : [];

  const toolsSummary = toolNames.length > 0
    ? ` Ferramentas disponíveis: ${toolNames.slice(0, 30).join(', ')}.`
    : '';

  const prompt = `Classifique a intenção do usuário estritamente em JSON.
kind:
- "conversation": conversa normal, saudações, piadas, desabafos, opiniões ou perguntas gerais sem necessidade de ferramentas.
- "operational": pedido para executar uma ação direta ou consultar dados de uma ferramenta (agenda, spotify, git, tarefas, email, finanças, pesquisa, etc.).
- "complex": solicitação de planejamento detalhado, múltiplos passos, cronograma ou roadmap.
tool: nome exato da ferramenta em caso operacional (ex: spotify.now_playing, calendar.list), ou null caso não seja aplicável.${toolsSummary}

Responda ESTRITAMENTE o JSON no formato:
{"kind":"conversation"|"operational"|"complex","goal":"descrição concisa","tool":null,"confidence":0.9}`;

  try {
    const answer = await client.chatJson({
      model: model || FAST_MODEL,
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: String(message || '') },
      ],
      temperature: 0.1,
      max_tokens: 300,
      extra: llmExtra(),
      ...(signal ? { signal } : {}),
    });
    const parsed = parseJsonSafe(jsonText(answer, 'kind'), { label: 'de intenção', answer });
    if (parsed && typeof parsed === 'object') {
      const kind = ['conversation', 'operational', 'complex'].includes(parsed.kind) ? parsed.kind : 'conversation';
      return {
        kind,
        goal: typeof parsed.goal === 'string' && parsed.goal.trim() ? parsed.goal.trim() : String(message || '').trim(),
        tool: typeof parsed.tool === 'string' && parsed.tool.trim() ? parsed.tool.trim() : null,
        confidence: typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence)
          ? Math.min(1, Math.max(0, parsed.confidence))
          : 0.85,
      };
    }
  } catch (error) {
    console.warn('classifyIntentWithLlm falhou:', describeFetchError(error));
  }
  return null;
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
    const answer = await sharedClient.chatJson({
      model: ANIMATION_MODEL,
      messages,
      temperature,
      // O diretor de animação raciocina antes de devolver o JSON: com 300
      // tokens o texto morria no raciocínio e as actions voltavam vazias.
      max_tokens: 900,
      extra: llmExtra(),
    });
    const parsed = parseJsonSafe(jsonText(answer, 'actions'), { label: 'de animação', answer });
    const actions = Array.isArray(parsed.actions) ? parsed.actions : [];
    return { actions, source: 'nvidia' };
  } catch (error) {
    console.warn('NVIDIA animation falhou:', describeFetchError(error));
    return { actions: [], source: 'nvidia-fallback' };
  }
}

// --- Resumo diário (memória de longo prazo, roda em background) ------------

const SUMMARY_SYSTEM = `Você resume, para a memória de longo prazo da Usami, um dia de conversa entre ela e o usuário.
Escreva em português do Brasil, em 2 a 4 frases, em terceira pessoa ("o usuário" / "a Usami"), sem diálogo e sem opinião.
Priorize fatos duráveis (quem ele é, gostos, planos, datas) e o clima da conversa. Se o dia tiver pouco conteúdo, resuma o pouco que houver. Não invente.`;

export async function summarizeDay({ date, transcript }, { client = sharedClient } = {}) {
  if (!process.env.NVIDIA_API_KEY) throw new Error('NVIDIA_API_KEY não configurada');
  const answer = await client.chatText({
    model: GENERATION_MODEL,
    messages: [
      { role: 'system', content: SUMMARY_SYSTEM },
      { role: 'user', content: `Data: ${date}\n\n${transcript}` },
    ],
    temperature: 0.3,
    // O raciocínio do nemotron consome orçamento antes do texto; se sobrar
    // pouco, o content volta vazio e o chamador usa o resumo determinístico.
    max_tokens: 700,
  });
  return String(answer ?? '').trim();
}

// --- Estruturação de técnica (Fase 3: ficha ingerida → técnica validável) ---

export async function structureTechnique(userPrompt, { temperature = 0.2 } = {}) {
  if (!process.env.NVIDIA_API_KEY) throw new Error('no-llm-provider');
  const messages = [
    { role: 'system', content: TECHNIQUE_SYSTEM_PROMPT },
    { role: 'user', content: userPrompt },
  ];
  const raw = await sharedClient.chatText({
    model: GENERATION_MODEL,
    messages,
    temperature,
    max_tokens: 900,
  });
  return { raw, provider: 'nvidia', model: GENERATION_MODEL };
}

// --- Utilitários -----------------------------------------------------------

// fetch() do undici rejeita com a mensagem genérica "fetch failed" e esconde o
// motivo real em error.cause (ENOTFOUND, ECONNRESET, UND_ERR_*). Sem isso o 502
// do chat ficava indecifrável no log.
export function describeFetchError(error) {
  const message = error?.message || String(error);
  const cause = error?.cause;
  if (!cause) return message;
  const detail = cause.code || cause.message || String(cause);
  return `${message} (causa: ${detail})`;
}

async function keyExists() {
  try {
    await sharedClient.chatText({ model: CLASSIFICATION_MODEL, messages: [{ role: 'user', content: 'test' }], max_tokens: 1 });
    return true;
  } catch {
    return false;
  }
}

// O JSON pedido pode estar em `content` ou, quando o raciocínio transborda,
// escondido no fim de `reasoning_content`. Só trocamos para o raciocínio quando
// ele contém um objeto JSON com a chave esperada — o raciocínio do modelo
// reescreve o system prompt, e devolvê-lo como texto faria a Usami "falar o
// próprio prompt" em vez de responder.
const REPLY_ALIASES = ['reply', 'resposta', 'response', 'answer', 'fala', 'message', 'text'];

export function jsonText({ content = '', reasoning = '' } = {}, requiredKey = null) {
  const texts = [String(content ?? ''), String(reasoning ?? '')];
  for (let sourceIdx = 0; sourceIdx < texts.length; sourceIdx += 1) {
    const text = texts[sourceIdx];
    if (!text.includes('{')) continue;
    if (!requiredKey) return text;
    const candidates = extractAllJsonCandidates(text);
    // Em reasoning o modelo pode citar JSONs de exemplo/skill antes da resposta final:
    // prefira o último candidato válido quando vier de reasoning.
    const ordered = sourceIdx === 1 ? [...candidates].reverse() : candidates;
    const keysToCheck = requiredKey === 'reply' ? REPLY_ALIASES : [requiredKey];
    for (const candidate of ordered) {
      try {
        const parsed = JSON.parse(candidate);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
        for (const key of keysToCheck) {
          const val = parsed[key];
          if (val !== undefined && (typeof val !== 'string' || val.trim().length > 0)) {
            return text;
          }
        }
      } catch {}
    }
  }
  return texts[0] || texts[1] || '';
}

function parseJsonSafe(raw, { label = '', answer = null } = {}) {
  const text = String(raw ?? '');
  // Cerca + primeiro objeto balanceado: mesma limpeza do parser do servidor
  // (B14) em vez de uma regex de fence própria por módulo.
  const parsed = parseJsonLoosely(text);
  if (parsed.ok) return parsed.value;
  // Sem isso a chamada falhava muda — `actions: []` no chat sem nenhum rastro.
  const finish = answer?.finishReason ? ` finish=${answer.finishReason}` : '';
  console.warn(`llm-router: saída ${label || 'do modelo'} não é JSON recuperável (${finish}; ${text.slice(0, 80)}...)`);
  return {};
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
