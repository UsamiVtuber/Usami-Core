import test from 'node:test';
import assert from 'node:assert/strict';
import { loadMeshPrefs, saveMeshPrefs, clearMeshPrefs } from '../src/mesh-preferences.js';

const storage = () => {
  const map = new Map();
  return { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value), removeItem: key => map.delete(key) };
};

test('prefs são salvas, lidas e limpas por modelo', () => {
  const store = storage();
  assert.deepEqual(loadMeshPrefs('autumn.glb', store), {});
  assert.equal(saveMeshPrefs('autumn.glb', { Hat: true }, store), true);
  assert.deepEqual(loadMeshPrefs('autumn.glb', store), { Hat: true });
  assert.deepEqual(loadMeshPrefs('nao-existe.glb', store), {});
  assert.equal(clearMeshPrefs('autumn.glb', store), true);
  assert.deepEqual(loadMeshPrefs('autumn.glb', store), {});
});

test('armazenamento corrompido ou inválido não quebra a leitura', () => {
  const store = storage();
  store.setItem('usami:meshes:x', 'não é json');
  assert.deepEqual(loadMeshPrefs('x', store), {});
  assert.equal(saveMeshPrefs('', { a: 1 }, store), false);
  assert.deepEqual(loadMeshPrefs('', store), {});
});
