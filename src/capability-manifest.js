import * as THREE from 'three';

// A capability manifest describes what a loaded model can do, in a stable,
// serializable shape: meshes (with skeleton info), bones, morph targets,
// animation clips and VRM expressions. It feeds the rig panel, mesh
// visibility preferences and, later, the motion director / LLM tools.
export function buildCapabilityManifest(avatar, animations = [], expressions = []) {
  const meshes = [];
  const bones = [];
  const morphs = [];
  const list = Array.isArray(animations) ? animations : [];

  avatar?.traverse?.(object => {
    if (object.isBone) {
      bones.push({ name: object.name || 'Sem nome' });
    }
    if (object.isMesh) {
      const triangles = (object.geometry?.index?.count || object.geometry?.attributes?.position?.count || 0) / 3;
      const materials = (Array.isArray(object.material) ? object.material : [object.material]).filter(Boolean).map(material => material.name || 'Sem nome');
      const meshMorphs = Object.keys(object.morphTargetDictionary || {});
      meshes.push({
        name: object.name || 'Sem nome',
        skinned: Boolean(object.isSkinnedMesh),
        triangles: Math.round(triangles),
        materials,
        morphs: meshMorphs,
      });
      meshMorphs.forEach(name => { if (!morphs.includes(name)) morphs.push(name); });
    }
  });

  const clips = list.map(clip => ({
    name: clip.name || 'Sem nome',
    boneTracks: clip.boneTracks ?? 0,
    excludedTracks: clip.excludedTracks ?? 0,
  })).filter(clip => clip.name !== 'Sem nome' || true);

  const box = new THREE.Box3();
  if (avatar) box.setFromObject(avatar);
  const size = box.getSize(new THREE.Vector3());

  return {
    meshes,
    bones: bones.map((bone, index) => ({ ...bone, index })),
    morphs,
    clips,
    expressions: [...expressions],
    bounds: size.toArray().map(value => Number(value.toFixed(2))),
  };
}

// Default policy: show skinned meshes, hide the rest. The user can veto any
// mesh; those choices are remembered per model (see mesh-preferences.js).
export function defaultMeshVisibility(manifest) {
  return manifest.meshes.map(mesh => mesh.skinned);
}

// Compact, per-request summary for the backend prompt. Keeps names short and
// lists bounded, so chat bodies (which are validated at 8 KiB) stay cheap.
export function summarizeCapabilities(manifest) {
  return {
    format: manifest.format ?? '',
    clips: (manifest.clips ?? []).slice(0, 40).map(clip => clip?.name).filter(Boolean),
    morphs: (manifest.morphs ?? []).slice(0, 60).filter(name => typeof name === 'string' && name.length > 0),
    expressions: (manifest.expressions ?? []).slice(0, 20).filter(name => typeof name === 'string' && name.length > 0),
    meshes: (manifest.meshes ?? []).slice(0, 100).map(mesh => ({ name: mesh?.name, accessory: mesh?.skinned === false })).filter(mesh => typeof mesh.name === 'string' && mesh.name.length > 0),
    gestures: [...(manifest.customTilt !== false ? ['tilt'] : []), ...(manifest.customIdle ? ['idle'] : []), ...(manifest.customWave ? ['wave'] : [])],
  };
}

export function resolveMeshVisibility(manifest, preferences = {}) {
  const names = manifest.meshes.map(mesh => mesh.name);
  const resolved = defaultMeshVisibility(manifest);
  for (const [name, visible] of Object.entries(preferences || {})) {
    const index = names.indexOf(name);
    if (index >= 0) resolved[index] = Boolean(visible);
  }
  return resolved;
}
