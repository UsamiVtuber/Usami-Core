import * as THREE from 'three';

// Only bone tracks are safe to play as avatar motion: scene/root tracks may
// move the entire imported scene away from the camera.
export function inspectAnimation(clip, root) {
  const tracks = clip.tracks.filter(track => {
    try {
      const binding = THREE.PropertyBinding.parseTrackName(track.name);
      return Boolean(THREE.PropertyBinding.findNode(root, binding.nodeName)?.isBone);
    } catch {
      return false;
    }
  });
  return {
    name: clip.name || 'Sem nome',
    boneTracks: tracks.length,
    excludedTracks: clip.tracks.length - tracks.length,
    clip: tracks.length ? new THREE.AnimationClip(clip.name, clip.duration, tracks.map(track => track.clone())) : null,
  };
}
