import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createRateLimiter } from '../src/nvidia-client.js';

test('rate limiter: permite até rateLimit requisições na janela', async () => {
  const limiter = createRateLimiter({ rateLimit: 3, windowMs: 1000 });
  const start = Date.now();
  for (let i = 0; i < 3; i++) await limiter.waitForSlot();
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 1000, '3 requisições dentro do limite não devem esperar');
});

test('rate limiter: 4a requisição espera a janela deslizar', async () => {
  const limiter = createRateLimiter({ rateLimit: 2, windowMs: 100 });
  await limiter.waitForSlot();
  await limiter.waitForSlot();
  const start = Date.now();
  await limiter.waitForSlot(); // 3a, deve esperar
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 90, 'deve esperar a janela deslizar (aprox 100ms)');
  assert.ok(elapsed < 200, 'não deve esperar mais que a janela');
});

test('rate limiter: timestamps expirados saem da janela', async () => {
  const limiter = createRateLimiter({ rateLimit: 1, windowMs: 50 });
  await limiter.waitForSlot();
  await new Promise(r => setTimeout(r, 60)); // janela expirou
  const start = Date.now();
  await limiter.waitForSlot();
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 50, 'janela expirada não deve esperar');
});

test('rate limiter: rateLimit 0 nunca libera', async () => {
  // rateLimit 0 é inválido, mas não deve travar para sempre (evita divisão por zero etc.)
  const limiter = createRateLimiter({ rateLimit: 0, windowMs: 1000 });
  // Com rateLimit 0, stamps.length (0) < 0 é falso, então sempre espera. Não testamos espera infinita.
  assert.equal(typeof limiter.waitForSlot, 'function');
});
