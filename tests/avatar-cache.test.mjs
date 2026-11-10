import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStaticAssetHandler, isNotModified } from '../src/avatar-cache.js';

test('isNotModified: valida If-None-Match e If-Modified-Since corretamente', () => {
  const etag = '"abc123hash"';
  const lastMod = new Date('2026-11-10T12:00:00Z').toUTCString();

  // If-None-Match direto
  assert.equal(isNotModified({ 'if-none-match': '"abc123hash"' }, etag, lastMod), true);
  assert.equal(isNotModified({ 'if-none-match': 'W/"abc123hash"' }, etag, lastMod), true);
  assert.equal(isNotModified({ 'if-none-match': '*' }, etag, lastMod), true);
  assert.equal(isNotModified({ 'if-none-match': '"outro"' }, etag, lastMod), false);

  // If-Modified-Since
  assert.equal(isNotModified({ 'if-modified-since': lastMod }, etag, lastMod), true);
  const future = new Date('2026-11-10T13:00:00Z').toUTCString();
  assert.equal(isNotModified({ 'if-modified-since': future }, etag, lastMod), true);
  const past = new Date('2026-11-10T11:00:00Z').toUTCString();
  assert.equal(isNotModified({ 'if-modified-since': past }, etag, lastMod), false);
});

test('createStaticAssetHandler: responde 200 no 1º acesso e 304 Not Modified no re-acesso', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'usami-asset-cache-'));
  try {
    const vrmFile = join(tempDir, 'model.vrm');
    const mockBytes = Buffer.from('VRM_MODEL_BINARY_MOCK_DATA');
    await writeFile(vrmFile, mockBytes);

    const handler = createStaticAssetHandler({ rootDir: tempDir });

    // 1º request: deve responder 200 com ETag e Last-Modified
    let status1 = null;
    let headers1 = {};
    let body1 = null;
    const res1 = {
      writeHead: (st, hdrs) => { status1 = st; headers1 = hdrs; },
      end: (data) => { body1 = data; },
    };

    const handled1 = await handler({ method: 'GET', url: '/model.vrm', headers: {} }, res1);
    assert.equal(handled1, true);
    assert.equal(status1, 200);
    assert.ok(headers1['ETag']);
    assert.equal(headers1['Content-Type'], 'model/gltf-binary');
    assert.equal(headers1['Content-Length'], mockBytes.length);
    assert.ok(body1);

    // 2º request com If-None-Match: deve responder 304 Not Modified
    let status2 = null;
    let headers2 = {};
    let body2 = null;
    const res2 = {
      writeHead: (st, hdrs) => { status2 = st; headers2 = hdrs; },
      end: (data) => { body2 = data; },
    };

    const handled2 = await handler({
      method: 'GET',
      url: '/model.vrm',
      headers: { 'if-none-match': headers1['ETag'] },
    }, res2);

    assert.equal(handled2, true);
    assert.equal(status2, 304);
    assert.equal(body2, undefined);

    // HEAD request
    let status3 = null;
    const res3 = {
      writeHead: (st) => { status3 = st; },
      end: () => { },
    };
    const handled3 = await handler({ method: 'HEAD', url: '/model.vrm', headers: {} }, res3);
    assert.equal(handled3, true);
    assert.equal(status3, 200);

    // Path traversal deve retornar false (não interceptado)
    const resTraversal = { writeHead: () => { }, end: () => { } };
    const handledTraversal = await handler({ method: 'GET', url: '/../../etc/passwd', headers: {} }, resTraversal);
    assert.equal(handledTraversal, false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});