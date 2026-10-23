import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createCustomMotion } from '../src/custom-motion.js';

const rig = () => ['DEF-spine003', 'DEF-spine006', 'DEF-upper_armR', 'DEF-forearmR', 'DEF-handR'].map(name => { const bone = new THREE.Bone(); bone.name = name; return bone; });

test('idle altera ossos e restaura a pose ao parar, sem acumular rotação', () => {
  const bones = rig();
  const motion = createCustomMotion(bones);
  assert.equal(motion.startIdle(), true);
  motion.update(1);
  assert.notEqual(bones[0].quaternion.x, 0);
  motion.stop();
  assert.ok(bones.every(bone => bone.quaternion.equals(new THREE.Quaternion())));
});

test('aceno se encerra na pose inicial e modelos incompatíveis são recusados', () => {
  const bones = rig();
  const motion = createCustomMotion(bones);
  assert.equal(motion.wave(), true);
  motion.update(1);
  assert.notEqual(bones[2].quaternion.z, 0);
  motion.update(3);
  assert.ok(bones.every(bone => bone.quaternion.equals(new THREE.Quaternion())));
  const missing = createCustomMotion([]);
  assert.equal(missing.wave(), false);
  assert.equal(missing.startIdle(), false);
});
