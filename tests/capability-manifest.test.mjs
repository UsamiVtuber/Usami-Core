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

test('summarizeCapabilities cura expressões antes do corte de 20 (prefabs sobrevivem aos presets)', () => {
  // Ordem crua do shiro.vrm: 13 presets na frente, depois os prefabs 01..25.
  const raw = [
    'Neutral', 'aa', 'ih', 'ou', 'ee', 'oh', 'blink', 'lookup', 'lookdown',
    'lookleft', 'lookright', 'blink_l', 'blink_r',
    '01-prefab_happy01', '02-prefab_happy02', '03-prefab_happy03', '04-prefab_happy04',
    '05-prefab_happy05', '06-prefab_happy06', '07-prefab_angry01', '08-prefab_angry02',
    '09-prefab_angry03', '10-prefab_angry04', '11-prefab_angry05', '12-prefab_sad01',
    '13-prefab_sad02', '14-prefab_sad03', '15-prefab_awkward01', '16-prefab_awkward02',
    '17-prefab_awkward03', '18-prefab_awkward04', '19-prefab_doubt', '20-prefab_startled',
    '21-prefab_emoji', '22-prefab_clothes', '23-prefab_hat', '24-prefab_hairpin', '25-prefab_sleeve',
  ];
  const summary = summarizeCapabilities({ expressions: raw });
  assert.equal(summary.expressions.length, 20);
  // corte cru manteria só 01..07; as reações tsundere nunca chegavam ao servidor
  for (const name of ['01-prefab_happy01', '08-prefab_angry02', '13-prefab_sad02', '16-prefab_awkward02', '19-prefab_doubt', '20-prefab_startled']) {
    assert.ok(summary.expressions.includes(name), `${name} deve sobreviver ao corte de 20`);
  }
  // Visemas e piscar vão por último no corte, nunca encabeçam a lista
  assert.ok(!summary.expressions.includes('blink'));
  assert.ok(!summary.expressions.includes('aa'));
});

test('summarizeCapabilities omite tilt quando customTilt é false', () => {
  const summary = summarizeCapabilities({ customTilt: false, customIdle: true, customWave: true });
  assert.deepEqual(summary.gestures, ['idle', 'wave']);
});

test('summarizeCapabilities inclui tilt por padrão e quando customTilt é true', () => {
  assert.deepEqual(summarizeCapabilities({ customIdle: false, customWave: false }).gestures, ['tilt']);
  assert.deepEqual(summarizeCapabilities({ customTilt: true, customIdle: false, customWave: false }).gestures, ['tilt']);
});
