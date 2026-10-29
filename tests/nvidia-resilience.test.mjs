import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  NvidiaClient,
  UpstreamError,
  UpstreamUnavailable,
  createCircuitBreaker,
  createRateLimiter,
  parseRetryAfter,
} from '../src/nvidia-client.js';

const MESSAGES = [{ role: 'user', content: 'oi' }];

function okBody() {
  return { choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] };
}

// fetch falso: devolve as respostas da lista, em ordem; a última se repete.
async function withFetch(responses, run) {
  const envKey = process.env.NVIDIA_API_KEY;
  process.env.NVIDIA_API_KEY = 'chave-de-teste';
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (_url, init) => {
    calls.push(init);
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (typeof next === 'function') return next(init);
    return next;
  };
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  try {
    return await run(calls);
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    globalThis.fetch = originalFetch;
    if (envKey === undefined) delete process.env.NVIDIA_API_KEY;
    else process.env.NVIDIA_API_KEY = envKey;
  }
}

const ok = () => ({ ok: true, status: 200, json: async () => okBody() });
const failure = (status, headers = {}) => ({
  ok: false,
  status,
  headers: { get: name => headers[name.toLowerCase()] ?? null },
  text: async () => 'erro',
});

const newClient = (options = {}) => new NvidiaClient({
  rateLimiter: createRateLimiter({ rateLimit: 100, windowMs: 1000 }),
  random: () => 0,
  ...options,
});

test('rate limiter: a fila é FIFO', async () => {
  const limiter = createRateLimiter({ rateLimit: 1, windowMs: 60 });
  await limiter.waitForSlot();
  const order = [];
  await Promise.all([1, 2, 3].map(n => limiter.waitForSlot().then(() => order.push(n))));
  assert.deepEqual(order, [1, 2, 3]);
});

test('rate limiter: fila cheia rejeita na hora com 503', async () => {
  const limiter = createRateLimiter({ rateLimit: 1, windowMs: 1000, maxQueue: 1 });
  await limiter.waitForSlot();
  const queued = limiter.waitForSlot().catch(() => {});
  await assert.rejects(limiter.waitForSlot(), error => error instanceof UpstreamUnavailable && error.status === 503);
  void queued;
});

test('rate limiter: espera tem teto (maxWaitMs) e rateLimit 0 não trava para sempre', async () => {
  const limiter = createRateLimiter({ rateLimit: 0, windowMs: 1000 });
  const startedAt = Date.now();
  await assert.rejects(limiter.waitForSlot({ maxWaitMs: 40 }), UpstreamUnavailable);
  assert.ok(Date.now() - startedAt < 500);
});

test('rate limiter: signal abortado tira o chamador da fila sem consumir slot', async () => {
  const limiter = createRateLimiter({ rateLimit: 1, windowMs: 60 });
  await limiter.waitForSlot();
  const controller = new AbortController();
  const waiting = limiter.waitForSlot({ signal: controller.signal });
  controller.abort();
  await assert.rejects(waiting);
  const startedAt = Date.now();
  await limiter.waitForSlot(); // o slot é do próximo da fila, não do cancelado
  assert.ok(Date.now() - startedAt < 200);
});

test('parseRetryAfter: segundos, data HTTP e lixo', () => {
  assert.equal(parseRetryAfter('2'), 2000);
  assert.equal(parseRetryAfter('0'), 0);
  assert.equal(parseRetryAfter('Wed, 21 Oct 2026 07:28:02 GMT', Date.parse('Wed, 21 Oct 2026 07:28:00 GMT')), 2000);
  assert.equal(parseRetryAfter('amanhã'), null);
  assert.equal(parseRetryAfter(null), null);
  assert.equal(parseRetryAfter('-5'), null);
});

test('429 com Retry-After: repete uma vez e devolve a resposta', async () => {
  await withFetch([failure(429, { 'retry-after': '0' }), ok()], async calls => {
    const data = await newClient().chatCompletions({ model: 'm', messages: MESSAGES });
    assert.equal(data.choices[0].finish_reason, 'stop');
    assert.equal(calls.length, 2);
  });
});

test('5xx repete com backoff; esgotadas as tentativas, o erro sobe com o status', async () => {
  await withFetch([failure(503)], async calls => {
    const client = newClient({ retries: 1 });
    await assert.rejects(
      client.chatCompletions({ model: 'm', messages: MESSAGES }),
      error => error instanceof UpstreamError && error.status === 503 && /HTTP 503/.test(error.message),
    );
    assert.equal(calls.length, 2, '1 tentativa + 1 retry');
  });
});

test('4xx (fora 408/429) não é repetido nem abre o circuito', async () => {
  await withFetch([failure(400)], async calls => {
    const breaker = createCircuitBreaker({ failureThreshold: 1 });
    const client = newClient({ breaker });
    await assert.rejects(client.chatCompletions({ model: 'm', messages: MESSAGES }), { status: 400 });
    assert.equal(calls.length, 1);
    assert.equal(breaker.state, 'closed');
  });
});

test('circuit breaker: abre após falhas seguidas e responde na hora, sem chamar o provedor', async () => {
  await withFetch([failure(500)], async calls => {
    const breaker = createCircuitBreaker({ failureThreshold: 2, cooldownMs: 60000 });
    const client = newClient({ breaker, retries: 0 });
    for (let i = 0; i < 2; i++) {
      await assert.rejects(client.chatCompletions({ model: 'm', messages: MESSAGES }), { status: 500 });
    }
    assert.equal(breaker.state, 'open');
    await assert.rejects(
      client.chatCompletions({ model: 'm', messages: MESSAGES }),
      error => error instanceof UpstreamUnavailable && error.retryAfterMs > 0,
    );
    assert.equal(calls.length, 2, 'com o circuito aberto não há terceira chamada');
  });
});

test('circuit breaker: passado o cooldown deixa passar uma prova; sucesso fecha', () => {
  let t = 0;
  const breaker = createCircuitBreaker({ failureThreshold: 1, cooldownMs: 100, now: () => t });
  breaker.failure();
  assert.ok(breaker.check() > 0);
  t = 150;
  assert.equal(breaker.check(), null, 'a prova passa');
  assert.ok(breaker.check() > 0, 'só uma prova por vez');
  breaker.success();
  assert.equal(breaker.state, 'closed');
  assert.equal(breaker.check(), null);
});

test('signal abortado cancela a chamada, não repete e não conta como falha do provedor', async () => {
  const controller = new AbortController();
  await withFetch([
    init => new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
      controller.abort(new Error('cliente desconectou'));
    }),
  ], async calls => {
    const breaker = createCircuitBreaker({ failureThreshold: 1 });
    const client = newClient({ breaker });
    await assert.rejects(
      client.chatCompletions({ model: 'm', messages: MESSAGES, signal: controller.signal }),
      /cliente desconectou/,
    );
    assert.equal(calls.length, 1);
    assert.equal(breaker.state, 'closed');
  });
});

test('signal já abortado nem chega ao provedor', async () => {
  await withFetch([ok()], async calls => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(newClient().chatCompletions({ model: 'm', messages: MESSAGES, signal: controller.signal }));
    assert.equal(calls.length, 0);
  });
});
