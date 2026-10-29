import test from 'node:test';
import assert from 'node:assert/strict';
import { SemaphoreRejected, createSemaphore } from '../src/semaphore.js';

test('semáforo: uma por vez, em ordem de chegada', async () => {
  const gate = createSemaphore({ limit: 1, maxQueue: 5 });
  const order = [];
  let running = 0;
  let peak = 0;
  const job = async (n, ms) => {
    const release = await gate.acquire();
    running += 1;
    peak = Math.max(peak, running);
    await new Promise(resolve => setTimeout(resolve, ms));
    order.push(n);
    running -= 1;
    release();
  };
  await Promise.all([job(1, 20), job(2, 5), job(3, 5)]);
  assert.deepEqual(order, [1, 2, 3]);
  assert.equal(peak, 1);
  assert.equal(gate.active, 0);
});

test('semáforo: fila cheia e espera esgotada rejeitam com o motivo', async () => {
  const gate = createSemaphore({ limit: 1, maxQueue: 1 });
  const release = await gate.acquire();
  const waiting = gate.acquire({ timeoutMs: 30 });
  await assert.rejects(gate.acquire(), error => error instanceof SemaphoreRejected && error.reason === 'full');
  await assert.rejects(waiting, error => error.reason === 'timeout');
  release();
  assert.equal(gate.queued, 0);
  const again = await gate.acquire();
  again();
});

test('semáforo: signal abortado sai da fila e libera release idempotente', async () => {
  const gate = createSemaphore({ limit: 1, maxQueue: 2 });
  const release = await gate.acquire();
  const controller = new AbortController();
  const waiting = gate.acquire({ signal: controller.signal });
  controller.abort();
  await assert.rejects(waiting, error => error.reason === 'aborted');
  release();
  release(); // segunda chamada não libera uma vaga que não é dela
  assert.equal(gate.active, 0);
  const a = await gate.acquire();
  const b = gate.acquire({ timeoutMs: 20 });
  await assert.rejects(b, error => error.reason === 'timeout');
  a();
});
