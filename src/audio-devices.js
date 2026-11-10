// Gerenciamento e persistência de dispositivos de áudio (microfone e alto-falante)
// Inspirado em OpenAmika `ui/common.js` (devices).
// Módulo puro: roda no browser (com localStorage) e no Node (com storage fallback para testes).

const STORAGE_KEYS = Object.freeze({
  mic: 'usami-mic-device',
  speaker: 'usami-speaker-device',
});

function getStorage() {
  if (typeof window !== 'undefined' && window.localStorage) {
    return window.localStorage;
  }
  return null;
}

export const canPickSpeaker = typeof HTMLMediaElement !== 'undefined'
  && 'setSinkId' in HTMLMediaElement.prototype;

export function getAudioDeviceId(kind) {
  const store = getStorage();
  const key = STORAGE_KEYS[kind];
  if (!store || !key) return '';
  try {
    return store.getItem(key) || '';
  } catch {
    return '';
  }
}

export function setAudioDeviceId(kind, id) {
  const store = getStorage();
  const key = STORAGE_KEYS[kind];
  if (!store || !key) return;
  try {
    if (id) {
      store.setItem(key, String(id));
    } else {
      store.removeItem(key);
    }
  } catch {}
}

/**
 * Aplica o sinkId (dispositivo de saída) em um elemento <audio> ou AudioContext se suportado.
 * @param {HTMLMediaElement | AudioContext} target
 * @param {string} [customSinkId]
 * @returns {Promise<boolean>}
 */
export async function applyAudioSink(target, customSinkId = null) {
  if (!target || typeof target.setSinkId !== 'function') {
    return false;
  }
  const sinkId = customSinkId !== null ? customSinkId : getAudioDeviceId('speaker');
  try {
    await target.setSinkId(sinkId || '');
    return true;
  } catch {
    return false;
  }
}

/**
 * Enumera dispositivos de entrada (áudio) e saída (áudio) com rótulos amigáveis.
 * @returns {Promise<{ mics: Array<{ id: string, label: string }>, speakers: Array<{ id: string, label: string }> }>}
 */
export async function listAudioDevices({ mediaDevices = null } = {}) {
  const md = mediaDevices || (typeof navigator !== 'undefined' ? navigator.mediaDevices : null);
  if (!md || typeof md.enumerateDevices !== 'function') {
    return { mics: [], speakers: [] };
  }
  try {
    const devices = await md.enumerateDevices();
    const mics = [];
    const speakers = [];

    devices.forEach(device => {
      if (device.kind === 'audioinput') {
        mics.push({
          id: device.deviceId,
          label: device.label || `Microfone (${mics.length + 1})`,
        });
      } else if (device.kind === 'audiooutput') {
        speakers.push({
          id: device.deviceId,
          label: device.label || `Alto-falante (${speakers.length + 1})`,
        });
      }
    });

    return { mics, speakers };
  } catch {
    return { mics: [], speakers: [] };
  }
}
