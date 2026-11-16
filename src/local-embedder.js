// Motor de embeddings local usando @xenova/transformers (ONNX).
//
// Projetado para:
// - 100% offline, zero chamadas externas
// - Rápido (<20ms por frase)
// - Cache do pipeline em memória
// - Fallback gracioso com vetor determinístico em modo de teste ou falha de modelo

const DEFAULT_MODEL = 'Xenova/all-MiniLM-L6-v2';
export const EMBEDDING_DIMENSION = 384;

function getSharedCache() {
  if (!(globalThis.__SHARED_EMBEDDER_CACHE__ instanceof Map)) {
    globalThis.__SHARED_EMBEDDER_CACHE__ = new Map();
  }
  return globalThis.__SHARED_EMBEDDER_CACHE__;
}

export function getSharedEmbedderCacheStats() {
  const cache = getSharedCache();
  return {
    size: cache.size,
    models: Array.from(cache.keys()),
  };
}

export function clearSharedEmbedderCache() {
  getSharedCache().clear();
}

/**
 * Obtém a instância compartilhada do pipeline de extração de embeddings por modelo.
 * Múltiplos tenants reutilizam os pesos ONNX já carregados em memória RAM.
 */
async function getPipeline(modelName = DEFAULT_MODEL) {
  const cache = getSharedCache();
  let entry = cache.get(modelName);
  if (entry?.instance) return entry.instance;
  if (entry?.loadingPromise) return entry.loadingPromise;

  const loadingPromise = (async () => {
    try {
      const { pipeline } = await import('@xenova/transformers');
      const instance = await pipeline('feature-extraction', modelName, {
        quantized: true,
      });
      cache.set(modelName, { instance, loadingPromise: null });
      return instance;
    } catch (err) {
      console.warn('[embedder] Falha ao carregar pipeline local ONNX:', err?.message || err);
      cache.delete(modelName);
      return null;
    }
  })();

  cache.set(modelName, { instance: null, loadingPromise });
  return loadingPromise;
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

