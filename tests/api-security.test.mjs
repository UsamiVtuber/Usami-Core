import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allowedHosts, checkApiToken, isAllowedRequest, readEnvValue, signWebhook } from '../src/api-security.js';

const ORIGINS = ['http://127.0.0.1:5173', 'http://localhost:5173'];

test('allowedHosts: API, origens do front e USAMI_ALLOWED_HOSTS', () => {
  process.env.USAMI_ALLOWED_HOSTS = 'terminal.local:5173, outro.local';
  try {
    const hosts = allowedHosts(ORIGINS);
    for (const host of ['127.0.0.1:8787', 'localhost:8787', '127.0.0.1:5173', 'localhost:5173', 'terminal.local:5173', 'outro.local']) {
      assert.ok(hosts.has(host), host);
    }
    assert.equal(hosts.has('evil.com'), false);
  } finally {
    delete process.env.USAMI_ALLOWED_HOSTS;
  }
});

test('isAllowedRequest: rebinding com Origin == Host é recusado', () => {
  assert.equal(isAllowedRequest('http://evil.com', 'evil.com', ORIGINS), false);
  assert.equal(isAllowedRequest(undefined, 'evil.com:8787', ORIGINS), false);
  assert.equal(isAllowedRequest(undefined, '127.0.0.1:8787', ORIGINS), true);
  assert.equal(isAllowedRequest('http://localhost:5173', 'LOCALHOST:5173', ORIGINS), true);
});

test('checkApiToken: fail-closed, compara em tempo constante e valida o conteúdo', () => {
  const req = token => ({ headers: token === undefined ? {} : { 'x-usami-token': token } });
  assert.equal(checkApiToken(req('abc'), 'abc'), null);
  assert.equal(checkApiToken(req('abd'), 'abc').status, 401);
  assert.equal(checkApiToken(req('abcd'), 'abc').status, 401);
  assert.equal(checkApiToken(req(undefined), 'abc').status, 401);
  assert.equal(checkApiToken(req('abc'), undefined).status, 503);
  assert.equal(checkApiToken(req('abc'), '').status, 503);
});

test('signWebhook: HMAC-SHA256 de "<timestamp>.<corpo>"', () => {
  const ts = '2026-10-28T12:00:00.000Z';
  const body = '{"event":"usami.response"}';
  const expected = 'sha256=' + createHmac('sha256', 's3').update(`${ts}.${body}`).digest('hex');
  assert.equal(signWebhook('s3', ts, body), expected);
  assert.notEqual(signWebhook('s4', ts, body), expected);
  assert.notEqual(signWebhook('s3', ts + 'x', body), expected);
});

test('readEnvValue: ambiente vence o arquivo; arquivo ausente vira null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'usami-env-'));
  try {
    const file = join(dir, '.env');
    writeFileSync(file, 'USAMI_TEST_KEY_A="valor-a"\nOUTRA=1\n');
    assert.equal(readEnvValue('USAMI_TEST_KEY_A', { filePath: file }), 'valor-a');
    process.env.USAMI_TEST_KEY_A = 'do-ambiente';
    assert.equal(readEnvValue('USAMI_TEST_KEY_A', { filePath: file }), 'do-ambiente');
    delete process.env.USAMI_TEST_KEY_A;
    assert.equal(readEnvValue('USAMI_TEST_KEY_B', { filePath: file }), null);
    assert.equal(readEnvValue('USAMI_TEST_KEY_B', { filePath: join(dir, 'nao-existe') }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
