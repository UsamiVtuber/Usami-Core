/**
 * Atividade ao vivo dos turnos de chat.
 *
 * Motivo (UI do desktop): o turno do `/api/chat` pode levar 10-20 s (ferramenta
 * + LLM). Sem um sinal intermediário, o cliente só descobre o que aconteceu
 * quando a resposta chega — e o usuário não sabe se a Usami está executando
 * uma ferramenta ou se já terminou e está só compondo a fala.
 *
 * O registro é em memória e por cliente (`x-usami-client`): a chave é o id
 * normalizado, o valor é o último estado conhecido do turno. Nada aqui é
 * histórico: se o turno acaba, o registro some.
 *
 * Um turno passa por estas fases:
 *   thinking  — o modelo está raciocinando / chamando o provedor
 *   tool      — uma ferramenta está EXECUTANDO agora (tool = nome real)
 *   responding— a resposta final está sendo montada
 */

const DEFAULT_TTL_MS = 120000;

function normalizePhase(phase) {
  return ['thinking', 'tool', 'responding'].includes(phase) ? phase : 'thinking';
}

export function createChatActivityRegistry(options = {}) {
  const now = options.now || (() => Date.now());
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const byClient = new Map();

  const prune = () => {
    const time = now();
    for (const [clientId, entry] of byClient) {
      if (time - entry.updatedAt > ttlMs) byClient.delete(clientId);
    }
  };

  return {
    /** Registra (ou atualiza) a atividade de um cliente. */
    set(clientId, activity = {}) {
      if (!clientId) return null;
      prune();
      const previous = byClient.get(clientId);
      const entry = {
        clientId,
        phase: normalizePhase(activity.phase),
        tool: typeof activity.tool === 'string' ? activity.tool : null,
        tools: Array.isArray(activity.tools) ? activity.tools.filter(t => typeof t === 'string') : [],
        startedAt: previous?.startedAt ?? now(),
        updatedAt: now(),
      };
      byClient.set(clientId, entry);
      return { ...entry };
    },

    /** Apaga a atividade do cliente (turno encerrado). */
    clear(clientId) {
      if (!clientId) return;
      byClient.delete(clientId);
    },

    /** Atividade de um cliente específico. */
    get(clientId) {
      prune();
      const found = byClient.get(clientId);
      return found ? { ...found } : null;
    },

    /**
     * Atividade mais recente entre todos os clientes. Usado quando o cliente
     * não manda `x-usami-client` (runtime de usuário único).
     */
    latest() {
      prune();
      let newest = null;
      for (const entry of byClient.values()) {
        if (!newest || entry.updatedAt > newest.updatedAt) newest = entry;
      }
      return newest ? { ...newest } : null;
    },

    count() {
      prune();
      return byClient.size;
    },
  };
}
