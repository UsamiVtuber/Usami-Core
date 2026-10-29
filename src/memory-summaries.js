/**
 * Resumos diários da memória (Fase 1).
 *
 * A conversa de hoje já entra inteira no prompt; o que falta é o dia que
 * passou. Este módulo fecha essa lacuna em background: escolhe dias com
 * histórico e sem resumo, pede um resumo curto ao LLM e, se ele não estiver
 * disponível ou falhar, grava um resumo determinístico a partir das falas do
 * usuário. Nunca roda no caminho crítico do chat.
 */

const MAX_TRANSCRIPT_MESSAGES = 24;
const MAX_TRANSCRIPT_CHARS = 400;
const MAX_FALLBACK_SNIPPETS = 5;
const FALLBACK_SNIPPET_CHARS = 80;
const DEFAULT_LIMIT = 2;

// Uma data só pode ter um resumo em voo: dois turnos seguidos não pagam a
// mesma chamada duas vezes.
const inFlight = new Set();

function collapse(text) {
  return typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
}

/** Dias anteriores a `today` com histórico e ainda sem resumo, do mais antigo. */
export function listPendingDays(memory, { today, limit = DEFAULT_LIMIT } = {}) {
  if (!today) throw new Error('listPendingDays: today é obrigatório.');
  const summarized = new Set((memory?.summaries ?? []).map((item) => item?.date).filter(Boolean));
  const history = memory?.dailyHistory ?? {};
  return Object.keys(history)
    .filter((day) => day < today && !summarized.has(day))
    .filter((day) => Array.isArray(history[day]) && history[day].length > 0)
    .sort()
    .slice(0, limit);
}

/** Transcrição compacta para o LLM (bounded em mensagens e caracteres). */
export function buildTranscript(messages) {
  return (Array.isArray(messages) ? messages : [])
    .slice(-MAX_TRANSCRIPT_MESSAGES)
    .filter((message) => message && typeof message.content === 'string')
    .map((message) => {
      const speaker = message.role === 'assistant' ? 'Usami' : 'Usuário';
      return `${speaker}: ${collapse(message.content).slice(0, MAX_TRANSCRIPT_CHARS)}`;
    })
    .filter((line) => !line.endsWith(': '))
    .join('\n');
}

/**
 * Resumo sem LLM: lista o que o usuário falou, sem inventar contexto.
 * É o piso de qualidade — melhor uma lista de assuntos do que perder o dia.
 */
export function buildFallbackSummary(messages) {
  const spoken = (Array.isArray(messages) ? messages : [])
    .filter((message) => message?.role === 'user')
    .map((message) => collapse(message.content))
    .filter(Boolean);
  if (!spoken.length) return '';
  const picked = spoken.slice(-MAX_FALLBACK_SNIPPETS).map((text) => (
    text.length > FALLBACK_SNIPPET_CHARS
      ? `${text.slice(0, FALLBACK_SNIPPET_CHARS - 1).trimEnd()}…`
      : text
  ));
  return `Conversamos sobre: ${picked.join('; ')}.`;
}

/**
 * Resume os dias pendentes e grava cada um no depósito.
 *
 * @param {object} options
 * @param {ReturnType<import('./memory-store.js').createMemoryStore>} options.store
 * @param {string} options.today  dia atual "YYYY-MM-DD" (só dias anteriores entram)
 * @param {(input: {date: string, transcript: string, messages: object[]}) => Promise<string>} [options.summarize]
 * @param {number} [options.limit]
 * @returns {Promise<Array<{date: string, source: 'llm'|'fallback'}>>}
 */
export async function summarizePendingDays({ store, today, summarize, limit = DEFAULT_LIMIT, logger = console } = {}) {
  if (!store || !today) throw new Error('summarizePendingDays: store e today são obrigatórios.');
  const results = [];
  for (const day of listPendingDays(store.getAll(), { today, limit })) {
    if (inFlight.has(day)) continue;
    inFlight.add(day);
    try {
      const messages = store.getAll().dailyHistory?.[day];
      const fallback = buildFallbackSummary(messages);
      if (!fallback) continue;
      let summary = fallback;
      let source = 'fallback';
      if (typeof summarize === 'function') {
        try {
          const generated = collapse(await summarize({
            date: day,
            messages,
            transcript: buildTranscript(messages),
          }));
          if (generated) {
            summary = generated;
            source = 'llm';
          }
        } catch (error) {
          logger?.warn?.(`[memoria] resumo de ${day} caiu no fallback: ${error?.message || error}`);
        }
      }
      // Exclusão durante a chamada (forget de um dia, "apagar tudo"): não
      // ressuscitar o resumo de algo que o usuário mandou esquecer.
      const current = store.getAll();
      const stillPending = Array.isArray(current.dailyHistory?.[day])
        && current.dailyHistory[day].length > 0
        && !current.summaries.some((item) => item.date === day);
      if (!stillPending) continue;
      store.upsertSummary(day, summary);
      results.push({ date: day, source });
    } finally {
      inFlight.delete(day);
    }
  }
  return results;
}
