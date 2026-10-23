// Motion director: deterministic filter between the LLM's suggested actions
// and the avatar controller. It enforces a whitelist of verbs, per-action
// cooldowns, capability checks from the manifest and sensible clamps, so a
// misbehaving model cannot move the avatar in arbitrary ways.
export const DEFAULT_MAX_ACTIONS = 5;

const GESTURE_NAMES = ['tilt', 'wave', 'idle'];
export const DIRECTOR_VERBS = ['play_clip', 'gesture', 'set_morph', 'set_mesh_visible'];
export const DEFAULT_COOLDOWNS = { play_clip: 1500, gesture: 2500, set_mesh_visible: 800 };
const MESH_COOLDOWN_PER_TARGET = 4000;

const cooldownVerbs = new Set(Object.keys(DEFAULT_COOLDOWNS));

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(1, Math.max(0, n));
}

export function createMotionDirector({ controller, capabilities, maxActions = DEFAULT_MAX_ACTIONS, cooldowns = DEFAULT_COOLDOWNS, now = () => Date.now() }) {
  const lastGlobal = {};
  const lastMesh = new Map();
  const manifest = capabilities || {};
  const allClips = [...(manifest.clips ?? []), ...(manifest.animations ?? [])];
  const clipNames = new Set(allClips.map(clip => clip?.name).filter(Boolean));
  const playableClips = new Set(allClips.filter(clip => clip?.boneTracks > 0 && !clip?.excludedTracks).map(clip => clip.name));
  const morphNames = new Set(manifest.morphs ?? []);
  const meshNames = new Set((manifest.meshes ?? []).map(mesh => mesh?.name).filter(Boolean));
  const accessoryNames = new Set((manifest.meshes ?? []).filter(mesh => mesh && mesh.skinned === false).map(mesh => mesh.name));
  const idleAvailable = manifest.customIdle !== false;
  const waveAvailable = manifest.customWave !== false;

  const verbs = new Set(DIRECTOR_VERBS);

  const perform = (action, at) => {
    const verb = action?.type;
    if (!verbs.has(verb)) return { type: verb, applied: false, reason: 'not in catalog' };
    const cooldown = cooldowns[verb];
    if (cooldownVerbs.has(verb) && cooldown > 0 && at - lastGlobal[verb] < cooldown) {
      return { type: verb, applied: false, reason: 'cooldown' };
    }

    let applied = false;
    let reason;
    if (verb === 'play_clip') {
      const name = typeof action?.name === 'string' ? action.name : '';
      if (!clipNames.has(name)) reason = 'not in catalog';
      else if (!playableClips.has(name)) reason = 'clip not playable (tracks)';
      else {
        controller.playClip?.(name);
        applied = true;
      }
    } else if (verb === 'gesture') {
      const name = GESTURE_NAMES.includes(action?.name) ? action.name : null;
      const available = name === 'idle' ? idleAvailable : name === 'wave' ? waveAvailable : true;
      if (!name || !available) reason = 'gesture unavailable on this model';
      else {
        applied = name === 'tilt' ? controller.gesture('tilt') === true : name === 'wave' ? controller.wave() === true : controller.idle() === true;
        if (!applied) reason = 'model refused';
      }
    } else if (verb === 'set_morph') {
      const name = typeof action?.name === 'string' ? action.name : '';
      const value = clamp01(action?.value);
      if (!morphNames.has(name)) reason = 'not in catalog';
      else if (value === null) reason = 'bad value';
      else {
        controller.setMorph?.(name, value);
        applied = true;
      }
    } else {
      const name = typeof action?.name === 'string' ? action.name : '';
      const nextVisible = action?.visible === false ? false : true;
      const lastAt = lastMesh.get(name) ?? -Infinity;
      if (!meshNames.has(name)) reason = 'not in catalog';
      else if (!accessoryNames.has(name)) reason = 'only accessory meshes can be toggled';
      else if (at - lastAt < MESH_COOLDOWN_PER_TARGET) reason = 'cooldown';
      else {
        controller.setMeshVisible?.(name, nextVisible);
        lastMesh.set(name, at);
        applied = true;
      }
    }
    if (applied && cooldownVerbs.has(verb)) lastGlobal[verb] = at;
    return { type: verb, applied, ...(reason ? { reason } : {}) };
  };

  return {
    execute(raw) {
      const actions = Array.isArray(raw) ? raw : raw && Array.isArray(raw.actions) ? raw.actions : [];
      const results = actions.slice(0, maxActions).map(action => perform(action && typeof action === 'object' ? action : null, now()));
      return { results, overflow: actions.length > maxActions ? actions.length - maxActions : 0 };
    },
  };
}
