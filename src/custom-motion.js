import * as THREE from 'three';

// This mapping is specific to the supplied Autumn rig, not a generic VRM rig.
export function createCustomMotion(bones) {
  const byName = new Map(bones.map(bone => [bone.name, bone]));
  const names = ['DEF-spine003', 'DEF-spine006', 'DEF-upper_armR', 'DEF-forearmR', 'DEF-handR'];
  const nodes = names.map(name => byName.get(name));
  const idleAvailable = nodes.slice(0, 2).every(Boolean);
  const waveAvailable = nodes.slice(2).every(Boolean);
  const base = nodes.map(node => node?.quaternion.clone());
  let idle = false, elapsed = 0, wave = null;
  const axisX = new THREE.Vector3(1, 0, 0);
  const axisZ = new THREE.Vector3(0, 0, 1);
  const restore = () => nodes.forEach((node, i) => { if (node) node.quaternion.copy(base[i]); });
  const rotate = (index, axis, angle) => { if (nodes[index]) nodes[index].rotateOnAxis(axis, angle); };
  return {
    idleAvailable, waveAvailable,
    startIdle() { if (!idleAvailable) return false; idle = true; return true; },
    wave() { if (!waveAvailable) return false; wave = 0; return true; },
    stop() { idle = false; wave = null; restore(); },
    update(delta) {
      if (!idle && wave === null) return;
      elapsed += delta;
      restore();
      if (idle) {
        rotate(0, axisX, Math.sin(elapsed * 1.3) * .025);
        rotate(1, axisZ, Math.sin(elapsed * .8) * .035);
      }
      if (wave !== null) {
        wave += delta;
        const duration = 3;
        const envelope = Math.min(1, wave / .6, Math.max(0, (duration - wave) / .6));
        rotate(2, axisZ, -.55 * envelope);
        rotate(3, axisZ, -1.45 * envelope);
        rotate(4, axisZ, Math.sin(wave * 7) * .25 * envelope);
        if (wave >= duration) { wave = null; if (!idle) restore(); }
      }
    },
  };
}
