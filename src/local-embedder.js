// Motor de embeddings local usando @xenova/transformers (ONNX).
//
// Projetado para:
// - 100% offline, zero chamadas externas
// - Rápido (<20ms por frase)
// - Cache do pipeline em memória
// - Fallback gracioso com vetor determinístico em modo de teste ou falha de modelo

let pipelineInstance = null;
let isLoading = false;

const DEFAULT_MODEL = 'Xenova/all-MiniLM-L6-v2';
export const EMBEDDING_DIMENSION = 384;

/**
 * Obtém a instância do pipeline de extração de embeddings.
 */
async function getPipeline(modelName = DEFAULT_MODEL) {
  if (pipelineInstance) return pipelineInstance;
  if (isLoading) {
    while (isLoading) {
      await new Promise((r) => setTimeout(r, 50));
    }
    return pipelineInstance;
  }

  isLoading = true;
  try {
    const { pipeline } = await import('@xenova/transformers');
    pipelineInstance = await pipeline('feature-extraction', modelName, {
      quantized: true,
    });
  } catch (err) {
    console.warn('[embedder] Falha ao carregar pipeline local ONNX:', err?.message || err);
    pipelineInstance = null;
  } finally {
    isLoading = false;
  }

  return pipelineInstance;
}

/**
 * Normaliza um vetor para norma unitária (L2 norm).
 */
function normalizeL2(vector) {
  let sum = 0;
  for (let i = 0; i < vector.length; i++) {
    sum += vector[i] * vector[i];
  }
  const norm = Math.sqrt(sum);
  if (norm === 0) return vector;
  return vector.map((v) => v / norm);
}

/**
 * Gera embedding para um texto.
 * Retorna Array de números (384 dimensões).
 */
export async function embedText(text, { allowFallback = true, modelName = DEFAULT_MODEL } = {}) {
  const clean = String(text ?? '').trim();
  if (!clean) {
    return new Array(EMBEDDING_DIMENSION).fill(0);
  }

  try {
    const extractor = await getPipeline(modelName);
    if (extractor) {
      const output = await extractor(clean, {
        pooling: 'mean',
        normalize: true,
      });
      return Array.from(output.data);
    }
  } catch (err) {
    console.warn('[embedder] Erro durante inferência ONNX:', err?.message || err);
  }

  if (allowFallback) {
    return createDeterministicFallbackEmbedding(clean);
  }

  throw new Error('[embedder] Pipeline indisponível e fallback desativado.');
}

/**
 * Gera embedding determinístico simples como fallback caso ONNX não esteja acessível.
 */
function createDeterministicFallbackEmbedding(text) {
  const vec = new Array(EMBEDDING_DIMENSION).fill(0);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const idx = (code * 31 + i) % EMBEDDING_DIMENSION;
    vec[idx] += 1 / (1 + (i % 7));
  }
  return normalizeL2(vec);
}

