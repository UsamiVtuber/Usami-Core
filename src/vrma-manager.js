import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMAnimationLoaderPlugin, createVRMAnimationClip } from '@pixiv/three-vrm-animation';

export const VRMA_ANIMATIONS = Object.freeze({
  idle: '/animations/vrma/aidelle_Idle.vrma',
  idleOriginal: '/animations/vrma/Relax.vrma',
  relax: '/animations/vrma/Relax.vrma',
  talking: '/animations/vrma/aidelle_Talking.vrma',
  speech: '/animations/vrma/aidelle_Talking.vrma',
  nod: '/animations/vrma/aidelle_Head_Nod_Yes.vrma',
  sleeping: '/animations/vrma/Sleepy.vrma',
  scratchHead: '/animations/vrma/Sleepy.vrma',
  confused: '/animations/vrma/Sleepy.vrma',
  sleepy: '/animations/vrma/Sleepy.vrma',
  lookAround: '/animations/vrma/LookAround.vrma',
  thinking: '/animations/vrma/Thinking.vrma',
  wave: '/animations/vrma/Goodbye.vrma',
  goodbye: '/animations/vrma/Goodbye.vrma',
  clap: '/animations/vrma/Clapping.vrma',
  clapping: '/animations/vrma/Clapping.vrma',
  blush: '/animations/vrma/Blush.vrma',
  shy: '/animations/vrma/Blush.vrma',
  angry: '/animations/vrma/Angry.vrma',
  tsundere: '/animations/vrma/Angry.vrma',
  surprised: '/animations/vrma/Surprised.vrma',
  sad: '/animations/vrma/Sad.vrma',
  jump: '/animations/vrma/Jump.vrma',
  cheer: '/animations/vrma/Jump.vrma',
});

const FINGER_BONE_NAMES = [
  'Thumb', 'Index', 'Middle', 'Ring', 'Little'
];

/**
 * Gerenciador avançado de animações VRMA com calibração anatômica e proteção de malha.
 *
 * Inclui:
 * 1. Filtro de dedos (remove mocap humano que deforma mãos de anime em garras).
 * 2. Retargeting com arm clearance (afastamento lateral dos braços para evitar mangas de sino presas no tronco).
 * 3. Transições suaves (crossfade) e loop/once parametrizáveis.
 */
export function createVrmaManager({
  vrm,
  mixer,
  loader = null,
  crossfadeDuration = 0.45,
  defaultArmClearanceDeg = 30,
  stripFingers = true,
  onClipLoaded = null,
} = {}) {
  if (!vrm || !mixer) {
    return {
      isAvailable: () => false,
      isVrmaActive: () => false,
      play: () => false,
      playIdle: () => false,
      stop: () => {},
      getCurrentName: () => null,
      getLoadedNames: () => [],
      setArmClearanceDeg: () => {},
      applyPostCorrection: () => {},
      dispose: () => {},
    };
  }

  const animLoader = loader || new GLTFLoader();
  try {
    animLoader.register(parser => new VRMAnimationLoaderPlugin(parser));
  } catch {
    // Plugin já registrado
  }

  const clips = new Map();
  const rawAnimations = new Map();
  const loadingPromises = new Map();

  let currentAction = null;
  let currentClipName = null;
  let disposed = false;
  let isIdlePlaying = false;
  let armClearanceDeg = defaultArmClearanceDeg;
  let filterFingers = stripFingers;

  const normalizedNodes = {
    leftUpperArm: vrm.humanoid?.getNormalizedBoneNode?.('leftUpperArm') || null,
    rightUpperArm: vrm.humanoid?.getNormalizedBoneNode?.('rightUpperArm') || null,
    leftLowerArm: vrm.humanoid?.getNormalizedBoneNode?.('leftLowerArm') || null,
    rightLowerArm: vrm.humanoid?.getNormalizedBoneNode?.('rightLowerArm') || null,
  };

  async function loadVrma(url) {
    if (clips.has(url)) return clips.get(url);
    if (loadingPromises.has(url)) return loadingPromises.get(url);

    const promise = (async () => {
      try {
        const gltf = await animLoader.loadAsync(url);
        if (disposed) return null;
        const vrmAnimation = gltf.userData.vrmAnimations?.[0];
        if (!vrmAnimation) {
          console.warn(`[VRMA] Nenhum vrmAnimation encontrado em ${url}`);
          return null;
        }

        rawAnimations.set(url, vrmAnimation);

        // 1. Filtragem opcional de dedos (remove distorção de garras)
        if (filterFingers && vrmAnimation.humanoidTracks?.rotation) {
          for (const [boneName] of vrmAnimation.humanoidTracks.rotation) {
            if (FINGER_BONE_NAMES.some(f => boneName.includes(f))) {
              vrmAnimation.humanoidTracks.rotation.delete(boneName);
            }
          }
        }

        const clip = createVRMAnimationClip(vrmAnimation, vrm);
        clips.set(url, clip);
        if (typeof onClipLoaded === 'function') onClipLoaded(url, clip);
        return clip;
      } catch (err) {
        console.error(`[VRMA] Erro ao carregar ${url}:`, err);
        return null;
      } finally {
        loadingPromises.delete(url);
      }
    })();

    loadingPromises.set(url, promise);
    return promise;
  }

  function play(nameOrUrl, { loop = false, crossfade = crossfadeDuration, timeScale = 1.0 } = {}) {
    if (disposed) return false;
    const url = VRMA_ANIMATIONS[nameOrUrl] || nameOrUrl;
    if (!url) return false;

    const clip = clips.get(url);
    if (clip) {
      startAction(clip, nameOrUrl, { loop, crossfade, timeScale });
      return true;
    }

    loadVrma(url).then(loadedClip => {
      if (disposed || !loadedClip) return;
      startAction(loadedClip, nameOrUrl, { loop, crossfade, timeScale });
    });
    return true;
  }

  function startAction(clip, name, { loop = false, crossfade = crossfadeDuration, timeScale = 1.0 } = {}) {
    if (disposed) return;
    const action = mixer.clipAction(clip);
    action.reset();
    action.timeScale = timeScale;
    action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
    action.clampWhenFinished = !loop;

    if (currentAction && currentAction !== action) {
      currentAction.crossFadeTo(action, crossfade, true);
    }
    action.play();
    currentAction = action;
    currentClipName = name;
    isIdlePlaying = Boolean(loop && (name === 'idle' || name === 'relax'));
  }

  function playIdle({ crossfade = crossfadeDuration } = {}) {
    return play('idle', { loop: true, crossfade });
  }

  function stop({ crossfade = 0.3 } = {}) {
    if (currentAction) {
      if (crossfade > 0) {
        currentAction.fadeOut(crossfade);
      } else {
        currentAction.stop();
      }
      currentAction = null;
      currentClipName = null;
      isIdlePlaying = false;
    }
  }

  /**
   * Correção pós-mixer: executada entre mixer.update() e vrm.update().
   * Garante folga anatômica nas mangas largas tradicionais da Shiro.
   */
  function applyPostCorrection() {
    if (!currentAction || !currentAction.isRunning()) return;
    const rad = THREE.MathUtils.degToRad(armClearanceDeg);
    if (rad > 0) {
      if (normalizedNodes.leftUpperArm) {
        normalizedNodes.leftUpperArm.rotation.z -= rad;
        normalizedNodes.leftUpperArm.rotation.x += rad * 0.15;
      }
      if (normalizedNodes.rightUpperArm) {
        normalizedNodes.rightUpperArm.rotation.z += rad;
        normalizedNodes.rightUpperArm.rotation.x += rad * 0.15;
      }
    }
  }

  // Pré-carrega idle e thinking em background
  if (typeof window !== 'undefined') {
    setTimeout(() => {
      loadVrma(VRMA_ANIMATIONS.idle).catch(() => {});
      loadVrma(VRMA_ANIMATIONS.thinking).catch(() => {});
    }, 400);
  }

  return {
    isAvailable: () => true,
    isVrmaActive: () => Boolean(currentAction && currentAction.isRunning()),
    isIdleActive: () => isIdlePlaying,
    getCurrentName: () => currentClipName,
    getLoadedNames: () => Array.from(clips.keys()),
    play,
    playIdle,
    stop,
    setArmClearanceDeg: deg => { armClearanceDeg = Number(deg) || 0; },
    getArmClearanceDeg: () => armClearanceDeg,
    setFilterFingers: val => { filterFingers = Boolean(val); },
    applyPostCorrection,
    dispose() {
      disposed = true;
      stop({ crossfade: 0 });
      clips.clear();
      rawAnimations.clear();
    },
  };
}
