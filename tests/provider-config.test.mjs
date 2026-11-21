import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import {
  PROVIDER_SPECS,
  createProviderConfigStore,
  maskSecret,
} from '../src/provider-config-store.js';
import { createProviderSettingsHandler } from '../server.mjs';

function mockReq({ method = 'GET', url = '/', headers = {}, body = null } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = { host: '127.0.0.1:8787', ...headers };
  const payload = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
  req[Symbol.asyncIterator] = async function* () {
    if (payload) yield Buffer.from(payload, 'utf8');
  };
  process.nextTick(() => {
    if (payload) req.emit('data', Buffer.from(payload, 'utf8'));
    req.emit('end');
  });
  return req;
}

function mockRes() {
  let resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  const res = {
    statusCode: 200,
    headers: {},
    body: '',
    writeHead(status, headers = {}) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(chunk = '') {
      this.body += String(chunk || '');
      resolveDone(this);
    },
  };
  return { res, done };
}

test('maskSecret nunca ecoa o segredo inteiro', () => {
  assert.equal(maskSecret(''), null);
  assert.equal(maskSecret('short'), '****');
  const masked = maskSecret('nvapi-SUPER_SECRET_VALUE_9876');
  assert.equal(masked, 'nvapi-****...9876');
  assert.equal(masked.includes('SUPER_SECRET'), false);
});

test('provider-config-store: persiste atomicamente, mascara leitura e rejeita provedor fora da whitelist', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'usami-providers-store-'));
  try {
    const store = createProviderConfigStore({
      dataDir: tmpDir,
      envReader: () => null,
      syncProcessEnv: false,
    });

    assert.equal(store.listStatus().length, PROVIDER_SPECS.length);
    assert.equal(store.listStatus().every(p => p.configured === false), true);

    // Rejeita provedor fora da whitelist
    const bad = store.updateProvider({ providerId: 'arbitrary_env', apiKey: 'xyz' });
    assert.equal(bad.ok, false);
    assert.equal(bad.status, 400);

    // Salva chave NVIDIA + modelo
    const secret = 'nvapi-TEST_SECRET_DO_NOT_ECHO_4321';
    const saved = store.updateProvider({
      providerId: 'nvidia',
      apiKey: secret,
      model: 'nvidia/nemotron-3-ultra-550b-a55b',
    });
    assert.equal(saved.ok, true);
    assert.equal(saved.provider.configured, true);
    assert.equal(saved.provider.source, 'local_override');
    assert.equal(saved.provider.masked, 'nvapi-****...4321');
    assert.equal(JSON.stringify(saved).includes(secret), false);

    // Recarrega do disco em nova instancia
    const reloaded = createProviderConfigStore({
      dataDir: tmpDir,
      envReader: () => null,
      syncProcessEnv: false,
    });
    const nvidia = reloaded.listStatus().find(p => p.id === 'nvidia');
    assert.equal(nvidia.configured, true);
    assert.equal(nvidia.masked, 'nvapi-****...4321');
    assert.equal(JSON.stringify(reloaded.listStatus()).includes(secret), false);

    // Clear key
    const cleared = reloaded.updateProvider({ providerId: 'nvidia', clearKey: true });
    assert.equal(cleared.ok, true);
    assert.equal(cleared.provider.configured, false);
    assert.equal(cleared.provider.masked, null);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('HTTP /api/settings/providers exige token, mascara chaves e testa conectividade', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'usami-providers-http-'));
  try {
    const token = 'test-provider-token';
    const store = createProviderConfigStore({
      dataDir: tmpDir,
      envReader: () => null,
      syncProcessEnv: false,
    });

    let lastFetchAuth = null;
    const fakeFetch = async (url, opts) => {
      lastFetchAuth = opts?.headers?.Authorization || null;
      if (lastFetchAuth === 'Bearer nvapi-VALID_PROBE_KEY_1111') {
        return { ok: true, status: 200 };
      }
      return { ok: false, status: 401 };
    };

    const handler = createProviderSettingsHandler({
      providerConfigStore: store,
      apiToken: token,
      fetchImpl: fakeFetch,
    });

    // 1. Sem token -> 401
    {
      const req = mockReq({ method: 'GET', url: '/api/settings/providers' });
      const { res, done } = mockRes();
      await handler(req, res);
      await done;
      assert.equal(res.statusCode, 401);
    }

    // 2. POST salva chave valida
    const rawKey = 'nvapi-VALID_PROBE_KEY_1111';
    {
      const req = mockReq({
        method: 'POST',
        url: '/api/settings/providers',
        headers: { 'content-type': 'application/json', 'x-usami-token': token },
        body: { providerId: 'nvidia', apiKey: rawKey },
      });
      const { res, done } = mockRes();
      await handler(req, res);
      await done;
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.includes(rawKey), false, 'resposta HTTP nunca pode ecoar a chave');
      const body = JSON.parse(res.body);
      assert.equal(body.ok, true);
      assert.equal(body.provider.configured, true);
      assert.equal(body.provider.masked, 'nvapi-****...1111');
    }

    // 3. POST /api/settings/providers/test com chave valida -> 200 ok:true
    {
      const req = mockReq({
        method: 'POST',
        url: '/api/settings/providers/test',
        headers: { 'content-type': 'application/json', 'x-usami-token': token },
        body: { providerId: 'nvidia' },
      });
      const { res, done } = mockRes();
      await handler(req, res);
      await done;
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.includes(rawKey), false);
      const body = JSON.parse(res.body);
      assert.equal(body.ok, true);
      assert.equal(body.status, 200);
      assert.equal(lastFetchAuth, `Bearer ${rawKey}`);
    }

    // 4. POST /api/settings/providers/test para provedor nao configurado -> 200 com ok:false
    {
      const req = mockReq({
        method: 'POST',
        url: '/api/settings/providers/test',
        headers: { 'content-type': 'application/json', 'x-usami-token': token },
        body: { providerId: 'openrouter' },
      });
      const { res, done } = mockRes();
      await handler(req, res);
      await done;
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.ok, false);
      assert.match(body.message, /OPENROUTER_API_KEY/);
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
