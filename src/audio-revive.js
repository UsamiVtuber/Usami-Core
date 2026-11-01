// Audio revive: devolve o AudioContext à vida quando o navegador o suspende.
//
// A política de autoplay cria o contexto `suspended` se ele nasce fora de um
// gesto do usuário, e o Chrome/Safari também o suspendem (ou o põem em
// `interrupted`) ao trocar de aba ou apagar a tela. O lip-sync já tentava
// `resume()` a cada frame de fala, mas só depois do áudio começar — tarde
// demais para o primeiro PCM, que tocaria mudo. Aqui o contexto é preparado
// no primeiro gesto e retomado em todo evento que costuma desbloqueá-lo.
//
// Puro: o alvo de eventos e o contexto entram injetados, então tudo roda em
// `node --test`. Nada aqui lança; falha de resume é silenciosa e tentada de
// novo no próximo gesto.

export const REVIVE_EVENTS = ['pointerdown', 'keydown', 'touchstart'];
const NEEDS_RESUME = new Set(['suspended', 'interrupted']);

export function createAudioRevive({
  // () => AudioContext | null — pode devolver null até o contexto nascer.
  getContext = () => null,
  // () => void — cria o contexto sob demanda dentro do gesto (lip-sync.prime).
  prime = null,
  target = typeof window !== 'undefined' ? window : null,
  doc = typeof document !== 'undefined' ? document : null,
  onState = null,
} = {}) {
  let attached = false;
  let watched = null;
  let lastState = null;
  let resumes = 0;

  const report = state => {
    if (state === lastState) return;
    lastState = state;
    try { if (typeof onState === 'function') onState(state); } catch {}
  };

  // Tenta deixar o contexto `running`. Devolve o estado final observado.
  const revive = () => {
    try { if (typeof prime === 'function') prime(); } catch {}
    const context = getContext();
    if (!context) { report('none'); return 'none'; }
    watch(context);
    if (NEEDS_RESUME.has(context.state) && typeof context.resume === 'function') {
      resumes += 1;
      try {
        const pending = context.resume();
        if (pending && typeof pending.then === 'function') pending.then(() => report(context.state), () => {});
      } catch {}
    }
    report(context.state);
    return context.state;
  };

  // Um contexto novo (reset do avatar) precisa do próprio listener.
  const watch = context => {
    if (watched === context || typeof context.addEventListener !== 'function') return;
    if (watched && typeof watched.removeEventListener === 'function') {
      try { watched.removeEventListener('statechange', onStateChange); } catch {}
    }
    watched = context;
    context.addEventListener('statechange', onStateChange);
  };

  // O navegador suspendeu no meio da sessão: retoma de imediato, sem esperar
  // pelo próximo gesto (o gesto só é exigido se o resume for recusado).
  function onStateChange() {
    const context = watched;
    if (!context) return;
    report(context.state);
    if (NEEDS_RESUME.has(context.state) && typeof context.resume === 'function') {
      try {
        const pending = context.resume();
        if (pending && typeof pending.catch === 'function') pending.catch(() => {});
      } catch {}
    }
  }

  const onVisibility = () => { if (!doc || doc.visibilityState !== 'hidden') revive(); };

  const attach = () => {
    if (attached) return;
    attached = true;
    if (target && typeof target.addEventListener === 'function') {
      for (const name of REVIVE_EVENTS) target.addEventListener(name, revive, { passive: true });
      target.addEventListener('focus', revive);
    }
    if (doc && typeof doc.addEventListener === 'function') doc.addEventListener('visibilitychange', onVisibility);
  };

  const detach = () => {
    if (!attached) return;
    attached = false;
    if (target && typeof target.removeEventListener === 'function') {
      for (const name of REVIVE_EVENTS) target.removeEventListener(name, revive);
      target.removeEventListener('focus', revive);
    }
    if (doc && typeof doc.removeEventListener === 'function') doc.removeEventListener('visibilitychange', onVisibility);
    if (watched && typeof watched.removeEventListener === 'function') {
      try { watched.removeEventListener('statechange', onStateChange); } catch {}
    }
    watched = null;
  };

  return {
    attach,
    detach,
    revive,
    get state() { return lastState; },
    get resumes() { return resumes; },
  };
}
