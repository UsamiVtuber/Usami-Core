// Telemetria e Observabilidade Local com Langfuse para Usami
//
// Projetado para:
// - Zero overhead quando desabilitado (sem chaves configuradas)
// - Nunca derrubar o chat em caso de falha de rede/telemetria
// - Mascarar dados excessivamente sensíveis por padrão
// - Rastrear: Turno de Chat, Chunks do RAG/Obsidian, Tool Calls e LLM Generativo (NVIDIA/OpenRouter)

import { Langfuse } from 'langfuse';

let client = null;
let isInitialized = false;

/**
 * Cria ou retorna o cliente Langfuse singleton.
 * Caso as variáveis não existam, opera como no-op silencioso.
 */
export function getLangfuseClient() {
  if (isInitialized) return client;

  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  const baseUrl = process.env.LANGFUSE_HOST || 'http://localhost:3000';

  if (!publicKey || !secretKey) {
    client = null;
    isInitialized = true;
    return null;
  }

  try {
    client = new Langfuse({
      publicKey,
      secretKey,
      baseUrl,
      flushAt: 1, // Envio ágil para observabilidade em tempo quase real local
      flushInterval: 2000,
    });
  } catch (err) {
    console.warn('[telemetry] Falha ao inicializar Langfuse:', err?.message || err);
    client = null;
  }

  isInitialized = true;
  return client;
}

/**
 * Cria um objeto de Trace seguro para o turno de chat.
 * Se o Langfuse não estiver configurado, devolve um proxy no-op.
 */
export function startChatTrace({
  traceId,
  name = 'chat_turn',
  userId = 'default_user',
  sessionId = 'default_session',
  input,
  metadata = {},
  tags = ['usami-core'],
} = {}) {
  const lf = getLangfuseClient();
  if (!lf) {
    return createNoopTrace();
  }

  try {
    const trace = lf.trace({
      id: traceId,
      name,
      userId,
      sessionId,
      input,
      metadata: {
        timestamp: new Date().toISOString(),
        ...metadata,
      },
      tags,
    });

    return {
      trace,
      span: ({ name, input, metadata }) => {
        try {
          return trace.span({ name, input, metadata, startTime: new Date() });
        } catch {
          return createNoopSpan();
        }
      },
      generation: ({ name, model, modelParameters, input, metadata }) => {
        try {
          return trace.generation({
            name,
            model,
            modelParameters,
            input,
            metadata,
            startTime: new Date(),
          });
        } catch {
          return createNoopSpan();
        }
      },
      update: (data) => {
        try {
          trace.update(data);
        } catch {
          // ignore
        }
      },
      end: () => {
        try {
          trace.update({ output: metadata?.output });
        } catch {
          // ignore
        }
      },
    };
  } catch (err) {
    console.warn('[telemetry] Erro ao criar trace:', err?.message || err);
    return createNoopTrace();
  }
}

/**
 * Registra uma chamada ao LLM (NVIDIA ou OpenRouter).
 */
export function recordLlmGeneration(traceObj, {
  name = 'llm_generation',
  model,
  prompt,
  output,
  usage,
  metadata = {},
  latencyMs,
  error = null,
} = {}) {
  if (!traceObj?.trace) return;

  try {
    const gen = traceObj.generation({
      name,
      model,
      modelParameters: metadata?.params || {},
      input: prompt,
      metadata: {
        ...metadata,
        latencyMs,
      },
    });

    if (error) {
      gen.update({
        level: 'ERROR',
        statusMessage: String(error?.message || error),
        endTime: new Date(),
      });
    } else {
      gen.update({
        output,
        usage: usage
          ? {
              promptTokens: usage.prompt_tokens ?? usage.promptTokens,
              completionTokens: usage.completion_tokens ?? usage.completionTokens,
              totalTokens: usage.total_tokens ?? usage.totalTokens,
            }
          : undefined,
        endTime: new Date(),
      });
    }
  } catch (err) {
    console.warn('[telemetry] Erro ao registrar geração LLM:', err?.message || err);
  }
}

/**
 * Registra a recuperação de memória/RAG (Obsidian / LanceDB).
 */
export function recordRetrievalSpan(traceObj, {
  query,
  results = [],
  latencyMs,
  source = 'obsidian_vault',
} = {}) {
  if (!traceObj?.trace) return;

  try {
    const span = traceObj.span({
      name: 'memory_retrieval',
      input: { query, source },
      metadata: {
        hitCount: results.length,
        latencyMs,
        resultsPreview: results.map((r) => ({
          file: r.file || r.path,
          score: r.score,
          length: r.content?.length ?? 0,
        })),
      },
    });

    span.update({
      output: {
        matches: results.length,
      },
      endTime: new Date(),
    });
  } catch (err) {
    console.warn('[telemetry] Erro ao registrar retrieval span:', err?.message || err);
  }
}

/**
 * Registra a execução de ferramentas / skills dos agentes.
 */
export function recordToolSpan(traceObj, {
  toolName,
  parameters,
  result,
  latencyMs,
  error = null,
} = {}) {
  if (!traceObj?.trace) return;

  try {
    const span = traceObj.span({
      name: `tool:${toolName}`,
      input: parameters,
      metadata: {
        latencyMs,
      },
    });

    if (error) {
      span.update({
        level: 'ERROR',
        statusMessage: String(error?.message || error),
        endTime: new Date(),
      });
    } else {
      span.update({
        output: result,
        endTime: new Date(),
      });
    }
  } catch (err) {
    console.warn('[telemetry] Erro ao registrar tool span:', err?.message || err);
  }
}

/**
 * Faz flush dos eventos pendentes (ex: antes de finalizar testes ou fechar processo).
 */
export async function flushTelemetry() {
  if (!client) return;
  try {
    await client.flushAsync();
  } catch (err) {
    console.warn('[telemetry] Erro ao realizar flush:', err?.message || err);
  }
}

// Proxies no-op para quando a telemetria estiver inativa
function createNoopSpan() {
  return {
    update: () => {},
    end: () => {},
  };
}

function createNoopTrace() {
  return {
    trace: null,
    span: () => createNoopSpan(),
    generation: () => createNoopSpan(),
    update: () => {},
    end: () => {},
  };
}

