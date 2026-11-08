// Acesso seguro ao Web Storage (F24): `getItem`/`setItem`/`removeItem` podem
// lançar (quota cheia, storage bloqueado por política/privacidade, Safari em
// modo restrito). O app local-first não pode perder o turno por causa disso —
// a sessão continua em memória e o usuário é avisado UMA vez.
//
// O storage pode ser injetado (testes e módulos puros); sem ele, usa
// `globalThis.localStorage` quando disponível.

let warned = false;

const defaultStorage = () => {
  try {
    return globalThis.localStorage ?? null;
  } catch (error) {
    notify('access', error);
    return null;
  }
};

const resolveStorage = storage => (storage !== undefined ? storage : defaultStorage());

const notify = (operation, error, onError) => {
  const message = 'Armazenamento local indisponível; a conversa segue só nesta sessão.';
  try { onError?.(message, error); } catch {}
  if (warned) return;
  warned = true;
  try {
    console.warn(`[usami] ${message} (${operation}: ${error?.name || error?.message || error})`);
  } catch {}
};

export function isQuotaError(error) {
  const text = `${error?.name || ''} ${error?.message || ''}`;
  return /quota/i.test(text) || error?.code === 22 || error?.code === 1014 || error?.name === 'NS_ERROR_DOM_QUOTA_REACHED';
}

export function safeGetItem(key, storage, onError) {
  const target = resolveStorage(storage);
  if (!target) return null;
  try {
    return target.getItem(key);
  } catch (error) {
    notify('getItem', error, onError);
    return null;
  }
}

// Devolve `true` quando gravou. Falha de quota/segurança vira `false` — quem
// chama decide se pode podar e tentar de novo.
export function safeSetItem(key, value, storage, onError) {
  const target = resolveStorage(storage);
  if (!target) return false;
  try {
    target.setItem(key, String(value));
    return true;
  } catch (error) {
    notify('setItem', error, onError);
    return false;
  }
}

export function safeRemoveItem(key, storage, onError) {
  const target = resolveStorage(storage);
  if (!target) return false;
  try {
    target.removeItem(key);
    return true;
  } catch (error) {
    notify('removeItem', error, onError);
    return false;
  }
}

// Para testes/diagnóstico: permite avisar de novo depois de um reset manual.
export function resetStorageWarning() {
  warned = false;
}
