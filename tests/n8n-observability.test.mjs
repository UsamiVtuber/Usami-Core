import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  redactSecrets,
  resolveObservabilityWebhookUrl,
  shouldSkipRoutinePoll,
  sendObservabilityEvent,
  observeApiRequest,
} from '../src/n8n-observability.js';

test('redactSecrets mascara chaves, bearer tokens e parametros sensiveis', () => {
  const raw = 'Authorization: Bearer secret-jwt-123 nvapi-abcdefghijklmnop sk-1234567890abcd AIzaSyDummyKey123456 ?token=abc123&x=1';
  const redacted = redactSecrets(raw);

  assert.ok(!redacted.includes('secret-jwt-123'));
  assert.ok(!redacted.includes('nvapi-abcdefghijklmnop'));
  assert.ok(!redacted.includes('sk-1234567890abcd'));
  assert.ok(!redacted.includes('AIzaSyDummyKey123456'));
  assert.ok(!redacted.includes('token=abc123'));
  assert.ok(redacted.includes('[REDACTED]'));
  assert.ok(redacted.includes('[REDACTED_KEY]'));

  const longInput = 'a'.repeat(700);
  assert.equal(redactSecrets(longInput).length, 500);
});

test('resolveObservabilityWebhookUrl prioriza N8N_OBSERVABILITY_WEBHOOK_URL e deriva de N8N_WEBHOOK_URL', () => {
  assert.equal(
    resolveObservabilityWebhookUrl(key => (
      key === 'N8N_OBSERVABILITY_WEBHOOK_URL' ? 'http://10.42.0.1:5678/webhook/custom-obs' : null
    )),
    'http://10.42.0.1:5678/webhook/custom-obs',
  );

  assert.equal(
    resolveObservabilityWebhookUrl(key => (
      key === 'N8N_WEBHOOK_URL' ? 'http://10.42.0.1:5678/webhook/usami-events' : null
    )),
    'http://10.42.0.1:5678/webhook/usami-observability',
  );

  assert.equal(
    resolveObservabilityWebhookUrl(() => null),
    'http://localhost:5678/webhook/usami-observability',
  );
});

test('shouldSkipRoutinePoll ignora polls 200 mas registra erros >= 400 e /api/chat', () => {
  assert.equal(shouldSkipRoutinePoll('GET', '/api/n8n/commands?client=1', 200), true);
  assert.equal(shouldSkipRoutinePoll('GET', '/api/chat/activity', 200), true);
  assert.equal(shouldSkipRoutinePoll('GET', '/api/n8n/commands', 500), false);
  assert.equal(shouldSkipRoutinePoll('POST', '/api/n8n/command', 200), false);
  assert.equal(shouldSkipRoutinePoll('POST', '/api/chat', 200), false);
  assert.equal(shouldSkipRoutinePoll('GET', '/api/n8n/commands', 200, true), false);
});

test('sendObservabilityEvent assina payload com HMAC, remove texto privado e falha silenciosamente', async () => {
  const calls = [];
  const resOk = await sendObservabilityEvent(
    {
      kind: 'api_call',
      source: 'usami-api',
      method: 'POST',
      route: '/api/chat?token=leak123',
      statusCode: 200,
      durationMs: 142.4,
      metadata: {
        userMessage: 'segredo privado',
        reply: 'resposta privada',
        safeTag: 'ok',
        leak: 'nvapi-1234567890abcdef',
      },
    },
    {
      webhookUrl: 'http://10.42.0.1:5678/webhook/usami-observability',
      secret: 'meu-segredo',
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return { ok: true, status: 200 };
      },
    },
  );

  assert.deepEqual(resOk, { sent: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://10.42.0.1:5678/webhook/usami-observability');
  assert.ok(calls[0].init.headers['X-Usami-Timestamp']);
  assert.ok(calls[0].init.headers['X-Usami-Signature'].startsWith('sha256='));

  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.route, '/api/chat');
  assert.equal(body.durationMs, 142);
  assert.equal(body.metadata.userMessage, undefined);
  assert.equal(body.metadata.reply, undefined);
  assert.equal(body.metadata.safeTag, 'ok');
  assert.equal(body.metadata.leak, '[REDACTED_KEY]');

  // Falha de rede nunca propaga exceção
  const resFail = await sendObservabilityEvent(
    { kind: 'error', errorMessage: 'Bearer abcdef123456' },
    {
      webhookUrl: 'http://10.42.0.1:5678/webhook/usami-observability',
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
    },
  );
  assert.deepEqual(resFail, { sent: false });
});

test('observeApiRequest captura resposta HTTP /api/* sem duplicar no mesmo req', async () => {
  const sent = [];
  const req = {
    method: 'POST',
    url: '/api/chat?secret=xyz',
    headers: { 'x-usami-client': 'desktop-1' },
  };
  const res = new EventEmitter();
  res.statusCode = 502;

  const opts = {
    webhookUrl: 'http://10.42.0.1:5678/webhook/usami-observability',
    secret: null,
    fetchImpl: async (_url, init) => {
      sent.push(JSON.parse(init.body));
      return { ok: true, status: 200 };
    },
  };

  observeApiRequest(req, res, opts);
  observeApiRequest(req, res, opts);
  res.emit('finish');
  await new Promise(resolve => setTimeout(resolve, 10));

  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, 'error');
  assert.equal(sent[0].route, '/api/chat');
  assert.equal(sent[0].statusCode, 502);
  assert.equal(sent[0].isError, true);
  assert.equal(sent[0].clientId, 'desktop-1');
});
