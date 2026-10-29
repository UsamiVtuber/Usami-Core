// Semáforo FIFO com fila limitada. O provedor de TTS não tolera síntese
// concorrente (5 requisições em paralelo = 5×504); o servidor garante isso em vez
// de depender de o cliente se comportar.

export class SemaphoreRejected extends Error {
  constructor(reason, message) {
    super(message);
    this.name = 'SemaphoreRejected';
    this.reason = reason; // 'full' | 'timeout' | 'aborted'
  }
}

export function createSemaphore({ limit = 1, maxQueue = 4 } = {}) {
  let active = 0;
  const queue = [];

  function release() {
    active -= 1;
    const next = queue.shift();
    if (next) {
      active += 1;
      next.grant();
    }
  }

  // Resolve com a função `release` (idempotente). `signal` e `timeoutMs` tiram o
  // chamador da fila; fila cheia rejeita na hora.
  function acquire({ signal, timeoutMs = Infinity } = {}) {
    if (signal?.aborted) return Promise.reject(new SemaphoreRejected('aborted', 'Cancelado.'));
    const makeRelease = () => {
      let released = false;
      return () => {
        if (released) return;
        released = true;
        release();
      };
    };
    if (active < limit) {
      active += 1;
      return Promise.resolve(makeRelease());
    }
    if (queue.length >= maxQueue) {
      return Promise.reject(new SemaphoreRejected('full', 'Fila cheia.'));
    }
    return new Promise((resolve, reject) => {
      let timer = null;
      const waiter = {
        grant() {
          cleanup();
          resolve(makeRelease());
        },
      };
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      const leave = error => {
        const index = queue.indexOf(waiter);
        if (index >= 0) queue.splice(index, 1);
        cleanup();
        reject(error);
      };
      const onAbort = () => leave(new SemaphoreRejected('aborted', 'Cancelado.'));
      signal?.addEventListener('abort', onAbort, { once: true });
      if (Number.isFinite(timeoutMs)) {
        timer = setTimeout(() => leave(new SemaphoreRejected('timeout', 'Espera esgotada.')), timeoutMs);
        timer.unref?.();
      }
      queue.push(waiter);
    });
  }

  return { acquire, get active() { return active; }, get queued() { return queue.length; } };
}
