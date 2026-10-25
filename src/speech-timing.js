// Agendador de ações do avatar sincronizado com a fala TTS.
//
// Permite que ações (gestos, clips, morphs, expressões) sejam disparadas
// em momentos específicos da reprodução de áudio: início, meio, fim, ou
// após um atraso fixo (delayMs). Útil para sincronizar gestos com ênfases
// da fala da Usami.
//
// O áudio TTS não traz duração prévia do servidor, então o scheduler lê
// `audio.duration` quando disponível (após loadedmetadata) e usa
// `audio.onended` para o gatilho 'end'.

export const SPEECH_TRIGGERS = ['start', 'middle', 'end'];

export function createSpeechScheduler({ now = () => performance.now() } = {}) {
  const timers = [];
  let endedHandler = null;
  let durationCheckTimer = null;
  let durationTimeout = null;

  function cancel() {
    timers.forEach(clearTimeout);
    timers.length = 0;
    if (durationCheckTimer) { clearInterval(durationCheckTimer); durationCheckTimer = null; }
    if (durationTimeout) { clearTimeout(durationTimeout); durationTimeout = null; }
    endedHandler = null;
  }

  function schedule({ actions, audio, onAction, onEnd }) {
    cancel();
    if (!actions?.length || !audio || typeof onAction !== 'function') return { cancel };

    let reportedDuration = null;

    // 'end' e 'middle' precisam do fim do áudio
    const needsEnd = actions.some(a => a.trigger === 'end' || a.trigger === 'middle');
    if (needsEnd) {
      endedHandler = () => {
        for (const action of actions) {
          if (action.trigger === 'end') onAction(action);
          if (typeof onEnd === 'function') onEnd(action);
        }
      };
      audio.addEventListener('ended', endedHandler, { once: true });

      // Para 'middle', precisamos da duração. Polling curto até loadedmetadata.
      if (actions.some(a => a.trigger === 'middle')) {
        const checkDuration = () => {
          if (audio.duration && audio.duration > 0) {
            reportedDuration = audio.duration;
            clearInterval(durationCheckTimer);
            durationCheckTimer = null;
            for (const action of actions) {
              if (action.trigger === 'middle') {
                const delayMs = Math.max(0, reportedDuration / 2);
                const timer = setTimeout(() => onAction(action), delayMs);
                timers.push(timer);
              }
            }
          }
        };
        checkDuration();
        durationCheckTimer = setInterval(checkDuration, 100);
        durationTimeout = setTimeout(() => { if (durationCheckTimer) { clearInterval(durationCheckTimer); durationCheckTimer = null; } }, 10000);
      }
    }

    for (const action of actions) {
      if (action.trigger === 'start' || (!action.trigger && !action.delayMs)) {
        // 'start' ou sem timing → executar agora
        onAction(action);
      } else if (action.delayMs && action.delayMs > 0) {
        const timer = setTimeout(() => onAction(action), action.delayMs);
        timers.push(timer);
      }
      // 'end' e 'middle' são tratados acima (ended / duration)
    }

    return { cancel };
  }

  return { schedule, cancel };
}
