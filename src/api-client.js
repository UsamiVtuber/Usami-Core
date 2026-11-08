// Cliente HTTP do frontend. Toda chamada a /api passa por aqui para carregar o
// id da aba (`x-usami-client`), que a fila do n8n usa para entregar comandos ao
// cliente certo (B6). O id vive em sessionStorage: outra aba = outro cliente.
const CLIENT_KEY = 'usami.client.id';

let clientId = null;

function createId() {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  } catch {}
  return `usami-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function getClientId() {
  if (clientId) return clientId;
  try {
    const saved = globalThis.sessionStorage?.getItem(CLIENT_KEY);
    if (saved) {
      clientId = saved;
      return clientId;
    }
  } catch {
    // sessionStorage bloqueado: id só em memória nesta aba.
  }
  clientId = createId();
  try {
    globalThis.sessionStorage?.setItem(CLIENT_KEY, clientId);
  } catch {}
  return clientId;
}

export function apiFetch(input, init = {}) {
  const headers = new Headers(init.headers || {});
  if (!headers.has('x-usami-client')) headers.set('x-usami-client', getClientId());
  return fetch(input, { ...init, headers });
}
