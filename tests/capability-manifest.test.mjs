import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { buildCapabilityManifest, defaultMeshVisibility, resolveMeshVisibility, summarizeCapabilities } from '../src/capability-manifest.js';
import { inspectAnimation } from '../src/animation-utils.js';

const rig = () => {
  const root = new THREE.Group();
  root.name = 'scene';
  const bone = new THREE.Bone();
  bone.name = 'Head';
  const skinned = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  skinned.name = 'Body';
  skinned.isSkinnedMesh = true;
  skinned.morphTargetDictionary = { 'smile': 0 };
  const accessory = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  accessory.name = 'Hat';
  root.add(bone, skinned, accessory);
  return root;
};

test('manifest descreve meshes, bones, morphs e bounds', () => {
  const clip = new THREE.AnimationClip('idle', 1, [new THREE.VectorKeyframeTrack('Head.rotation', [0, 1], [0, 0, 0, 0, .1, 0, 0])]);
  const inspected = inspectAnimation(clip, rig());
  const manifest = buildCapabilityManifest(rig(), [inspected], ['happy']);
  assert.deepEqual(manifest.meshes.map(m => m.name), ['Body', 'Hat']);
  assert.equal(manifest.meshes.find(m => m.name === 'Body').skinned, true);
  assert.equal(manifest.meshes.find(m => m.name === 'Hat').skinned, false);
  assert.deepEqual(manifest.morphs, ['smile']);
  assert.equal(manifest.bones[0].name, 'Head');
  assert.equal(manifest.expressions[0], 'happy');
  assert.equal(manifest.clips[0].boneTracks, 1);
  assert.ok(manifest.bounds.every(Number.isFinite));
});

test('default: skinned visível, resto oculto; prefs por nome vencem', () => {
  const manifest = buildCapabilityManifest(rig(), [], []);
  assert.deepEqual(defaultMeshVisibility(manifest), [true, false]);
  assert.deepEqual(resolveMeshVisibility(manifest, { Hat: true }), [true, true]);
  assert.deepEqual(resolveMeshVisibility(manifest, { Body: false }), [false, false]);
  assert.deepEqual(resolveMeshVisibility(manifest, { Desconhecida: true }), [true, false]);
});

test('summarizeCapabilities filters expression names', () => {
  assert.deepEqual(summarizeCapabilities({ expressions: ['happy', '', 42] }).expressions, ['happy']);
});
