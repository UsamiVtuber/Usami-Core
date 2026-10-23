export const MESH_PREFS_PREFIX = 'usami:meshes:';

export function meshPrefsKey(modelId) {
  return MESH_PREFS_PREFIX + (modelId || '');
}

export function loadMeshPrefs(modelId, storage = globalThis.localStorage) {
  if (!modelId || !storage) return {};
  try {
    const raw = storage.getItem(meshPrefsKey(modelId));
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}

export function saveMeshPrefs(modelId, prefs, storage = globalThis.localStorage) {
  if (!modelId || !storage) return false;
  try {
    storage.setItem(meshPrefsKey(modelId), JSON.stringify(prefs || {}));
    return true;
  } catch {
    return false;
  }
}

export function clearMeshPrefs(modelId, storage = globalThis.localStorage) {
  if (!modelId || !storage) return false;
  try {
    storage.removeItem(meshPrefsKey(modelId));
    return true;
  } catch {
    return false;
  }
}
