import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { inspectAnimation } from '../src/animation-utils.js';

test('isola canais dos ossos sem mover a raiz nem alterar o clip original', () => {
  const root = new THREE.Group();
  root.name = 'rig_deform';
  const bone = new THREE.Bone();
  bone.name = 'Head';
  root.add(bone);
  const clip = new THREE.AnimationClip('test', 1, [
    new THREE.VectorKeyframeTrack('rig_deform.position', [0, 1], [0, 0, 0, 100, 0, 0]),
    new THREE.VectorKeyframeTrack('Head.position', [0, 1], [0, 0, 0, 0, 1, 0]),
  ]);
  const result = inspectAnimation(clip, root);
  assert.equal(result.boneTracks, 1);
  assert.equal(result.excludedTracks, 1);
  assert.equal(clip.tracks.length, 2);
  const mixer = new THREE.AnimationMixer(root);
  mixer.clipAction(result.clip).play();
  mixer.update(0.5);
  assert.equal(root.position.x, 0);
  assert.equal(bone.position.y, 0.5);
});

test('não oferece reprodução para clips sem canais de ossos', () => {
  const root = new THREE.Group();
  root.name = 'tree';
  const clip = new THREE.AnimationClip('scene', 1, [new THREE.VectorKeyframeTrack('tree.position', [0, 1], [0, 0, 0, 1, 0, 0])]);
  const result = inspectAnimation(clip, root);
  assert.equal(result.boneTracks, 0);
  assert.equal(result.clip, null);
});
