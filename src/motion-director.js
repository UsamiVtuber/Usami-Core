// Motion director: deterministic filter between the LLM's suggested actions
// and the avatar controller. It enforces a whitelist of verbs, per-action
// cooldowns, capability checks from the manifest and sensible clamps, so a
// misbehaving model cannot move the avatar in arbitrary ways.
export const DEFAULT_MAX_ACTIONS = 5;

// Os três primeiros são da camada de gestos legado/pose; o resto vem da
// biblioteca de gestos procedurais (vrm-gesture-library) e é roteado por
// controller.gesture(name).
import { SHAPE_NAMES } from './sequence-shapes.js';

export { SHAPE_NAMES };

// Fase 1: play_sequence — shapes paramétricos expandidos pelo controller; o
// director só valida o vocabulário e roteia.
export const GESTURE_NAMES = [
  'tilt', 'wave', 'idle',
  'clap', 'hand-on-hip', 'wave2', 'point', 'shrug', 'head-scratch',
  'arms-crossed', 'facepalm', 'cheer', 'blow-kiss', 'hands-on-cheeks', 'bow',
  'nod', 'thinking', 'scratchHead', 'blush', 'angry', 'surprised', 'sad', 'jump', 'lookAround', 'talking',
  // Clipes VRMA reais nos dois clientes (web e desktop); sem eles o catálogo
  // filtrava a ação em silêncio no /api/chat.
  'sleepy', 'clapping', 'goodbye',
];
export const DIRECTOR_VERBS = ['play_clip', 'gesture', 'set_morph', 'set_mesh_visible', 'set_expression', 'play_sequence', 'play_vrma'];
export const DEFAULT_COOLDOWNS = { play_clip: 1500, gesture: 2500, play_sequence: 4000, set_mesh_visible: 800, set_expression: 3000 };
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
  const expressionNames = new Set((manifest.expressions ?? []).filter(name => typeof name === 'string'));
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
      const name = typeof action?.name === 'string' ? action.name : '';
      // O manifesto diz o que este modelo consegue; sem lista de gestos, vale o legado.
      const known = new Set([
        ...(manifest.customTilt !== false ? ['tilt'] : []),
        ...(manifest.customWave !== false && waveAvailable ? ['wave'] : []),
        ...(idleAvailable ? ['idle'] : []),
        ...(Array.isArray(manifest.gestures) ? manifest.gestures : []),
      ]);
      if (!name || !known.has(name)) reason = 'gesture unavailable on this model';
      else {
        // idle e wave têm métodos próprios no controller; os demais nomes vão
        // para o dispatcher (camada legado + biblioteca de gestos).
        const run = name === 'wave' ? controller.wave
          : name === 'idle' ? controller.idle
          : () => controller.gesture?.(name);
        applied = run?.() === true;
        if (!applied) reason = 'model refused';
      }
    } else if (verb === 'play_sequence') {
      const shape = SHAPE_NAMES.includes(action?.shape) ? action.shape : null;
      if (!shape) reason = 'shape unknown';
      else if (manifest.sequences !== true) reason = 'sequences unavailable on this model';
      else {
        applied = controller.playSequence?.({
          name: action?.name,
          shape,
          side: action?.side,
          amplitude: action?.amplitude,
          cycles: action?.cycles,
          durationMs: action?.durationMs,
        }) === true;
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
    } else if (verb === 'set_expression') {
      const name = typeof action?.name === 'string' ? action.name : '';
      const rawWeight = action?.weight;
      const weight = rawWeight === undefined ? 1 : clamp01(rawWeight);
      if (!expressionNames.has(name)) reason = 'not in catalog';
      else if (weight === null) reason = 'bad value';
      else if (!controller || typeof controller.setExpression !== 'function') reason = 'model refused';
      else { controller.setExpression(name, weight); applied = true; }
    } else if (verb === 'set_mesh_visible') {
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
    } else if (verb === 'play_vrma') {
      const name = typeof action?.name === 'string' ? action.name : '';
      if (!name) reason = 'bad name';
      else if (!controller || typeof controller.playVrma !== 'function') reason = 'vrma unavailable';
      else {
        applied = controller.playVrma(name, { loop: Boolean(action?.loop), crossfade: action?.crossfade || 0.35 }) !== false;
        if (!applied) reason = 'vrma refused';
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
