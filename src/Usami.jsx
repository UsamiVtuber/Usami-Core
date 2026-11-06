import { useCallback, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { Keyboard, Phone, PhoneOff, Send, Moon, X, Volume2, VolumeX, ImagePlus, MessagesSquare, Settings, Upload, Download, Trash2 } from 'lucide-react';
import { inspectAnimation } from './animation-utils';
import { createCustomMotion } from './custom-motion';
import { buildCapabilityManifest, resolveMeshVisibility, summarizeCapabilities } from './capability-manifest';
import { createMotionDirector, SHAPE_NAMES } from './motion-director';
import { createAutoMotion } from './auto-motion';
import { createExpressionDriver } from './expression-driver';
import { buildExpressionGains } from './expression-gains';
import { createSpeechPace } from './speech-pace';
import { createEmotionEngine } from './emotion-engine';
import { resolveReplyEmotion } from './reply-emotion';
import { loadMeshPrefs, saveMeshPrefs, clearMeshPrefs } from './mesh-preferences';
import { createVrmIdleSway } from './vrm-idle-sway';
import { createNaturalIdle } from './natural-idle';
import { createEyeSaccades } from './eye-saccades';
import { createVrmGestureLayer } from './vrm-gesture-layer';
import { calibrateArmAxes } from './vrm-bone-calibration';
import { createAudioLipSync } from './audio-lipsync';
import { playPcmStream } from './stream-audio-player';
import { splitReplyParts } from './reply-parts';
import { parseReplyBalloons } from './streaming-parser';
import { applyVrmEmotion, getVrmEmotionConfig } from './vrm-emotion-map';
import { stripSpeechTags } from './speech-tags';
import { loadConversation, saveConversation, clearStoredConversation, latestTurnId, MAX_STORED_TURNS } from './conversation-storage';
import { curateExpressions, labelExpression } from './expressions-catalog';
import { createSpeechScheduler } from './speech-timing';
import { createAudioRevive } from './audio-revive';
import { deriveVoicePhase } from './voice-phase';
import { MicBadge, VoiceBeacon } from './voice-ui';
import { PersonalityPanel } from './PersonalityPanel';
import { classifyFacs } from './facs-classifier.js';
import { applyFacsToDriver } from './facs-apply.js';
import './usami.css';

// Viseme morph names exposed by the VRM avatar (capital I).
const VISEME_NAMES = ['a', 'I', 'u', 'e', 'o'];

// Visemas como expressões no three-vrm 3.x: os presets VRM 0.x a/i/u/e/o são
// renomeados para aa/ih/ou/ee/oh no expressionManager. A boca precisa ir por
// esse canal — escrita bruta no morph é zerada todo frame pelo manager.
const VISEME_EXPRESSION_NAMES = ['aa', 'ih', 'ou', 'ee', 'oh'];

// Toca uma parte do TTS e resolve no 'ended'. Navegador/codecs sem 'ended'
// são cobertos por um timeout de segurança: conservador até `loadedmetadata`
// trazer a duração real, rearmada junto do playbackRate.
function playAudioPart(audio, url) {
  return new Promise(resolve => {
    let settled = false;
    let timer = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      // Só desliga o handler se ele ainda for o nosso: uma fila superseded
      // não pode matar o 'ended' da fila nova no mesmo elemento.
      if (audio.onended === finish) audio.onended = null;
      try { audio.removeEventListener?.('loadedmetadata', onMeta); } catch {}
      if (timer) clearTimeout(timer);
      resolve();
    };
    const arm = ms => { if (timer) clearTimeout(timer); timer = setTimeout(finish, ms); };
    const onMeta = () => {
      const duration = Number(audio.duration);
      const rate = Number(audio.playbackRate) || 1;
      arm(((duration > 0 && Number.isFinite(duration) ? duration : 20) / rate) * 1000 + 2000);
    };
    audio.onended = finish;
    try { audio.addEventListener?.('loadedmetadata', onMeta, { once: true }); } catch {}
    arm(25000);
    audio.src = url;
    const playing = audio.play();
    if (playing && typeof playing.catch === 'function') playing.catch(finish);
  });
}

// Intimacy meters (visual-novel style bond): XP per interaction, cumulative level thresholds, localStorage persistence.
const INTIMACY_KEY = 'usami.intimidade.v1';
const METER_KEYS = ['carinho', 'humor', 'companhia'];
const LEVELS = [0, 25, 60, 110, 180];
const LAUGHTER_PATTERN = /kkk|haha|rsrs|😂|🤣|risada/i;
const levelFor = xp => LEVELS.reduce((level, threshold, index) => xp >= threshold ? index + 1 : level, 1);
const meterProgress = xp => {
  const level = levelFor(xp);
  if (level >= LEVELS.length) return 1;
  const base = LEVELS[level - 1];
  return Math.min(1, Math.max(0, (xp - base) / (LEVELS[level] - base)));
};
const loadIntimacy = () => {
  try {
    const saved = JSON.parse(localStorage.getItem(INTIMACY_KEY) || 'null') || {};
    const clamp = value => Math.min(999, Math.max(0, Math.floor(Number(value) || 0)));
    return { carinho: clamp(saved.carinho), humor: clamp(saved.humor), companhia: clamp(saved.companhia) };
  } catch { return { carinho: 0, humor: 0, companhia: 0 }; }
};
const formatCallTime = seconds => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;

// Rótulos dos gestos procedurais no painel de rig (os nomes crus são os que o LLM e a fila n8n usam).
const GESTURE_LABELS = {
  clap: 'Palmas', 'hand-on-hip': 'Mão na cintura', wave2: 'Aceno 2 mãos', point: 'Apontar',
  shrug: 'De ombros', 'head-scratch': 'Coçar a cabeça', 'arms-crossed': 'Braços cruzados',
  facepalm: 'Mão no rosto', cheer: 'Comemorar', 'blow-kiss': 'Jogar beijo',
  'hands-on-cheeks': 'Mãos nas bochechas', bow: 'Reverência',
};

function Live2DAvatar({ controller, onReport }) {
  const host = useRef(null);

  useEffect(() => {
    let cancelled = false;
    const script = document.createElement('script');
    script.src = '/live2d/Core/live2dcubismcore.js';
    script.async = true;
    script.onload = async () => {
      if (cancelled) return;
      try {
        const { LAppDelegate, setCanvasHost } = await import('./live2d-demo/lappdelegate.ts');
        if (cancelled) return;
        setCanvasHost(host.current);
        const app = LAppDelegate.getInstance();
        app.initialize();
        app.run();
        controller.current = { gesture: () => false, stop: () => false, reset: () => false, setExpression: () => false };
        onReport({ format: 'Live2D Cubism 3', meshes: '—', bones: 'Parâmetros 2D', triangles: '—', animations: [{ name: 'daiji (idle)', boneTracks: 0, excludedTracks: 0 }], morphs: [], expressions: Array.from({ length: 11 }, (_, index) => `expression${index + 1}`), live2d: true, customIdle: true, customWave: false, meshList: [] });
      } catch (error) {
        onReport({ error: `Não foi possível inicializar o Cubism: ${error.message}` });
      }
    };
    script.onerror = () => onReport({ error: 'Não foi possível carregar o Live2D Cubism Core.' });
    document.head.appendChild(script);
    return () => {
      cancelled = true;
      script.remove();
      import('./live2d-demo/lappdelegate.ts').then(({ LAppDelegate, setCanvasHost }) => {
        setCanvasHost(null);
        LAppDelegate.releaseInstance();
      }).catch(() => {});
    };
  }, [controller, onReport]);

  return <div className="avatar live2d-avatar" ref={host} aria-label="Visualização Live2D da Usami" />;
}

function Avatar({ source, sourceType, sourceName, onReport, controller, auto, blinkMode, blinkName, lastIdleActive, audioLipSync, ttsAudio, emotionEngine, vrmGestures, expressionDriverRef }) {
  const host = useRef(null);
  useEffect(() => {
    const element = host.current;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(30, 1, .01, 100);
    camera.position.set(0, 1.2, 4.4);
    camera.lookAt(0, 1.2, 0);
    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    const canvas = renderer.domElement;
    element.appendChild(canvas);
    // Look-at (VRM): three-vrm aims the eye/head rig at vrm.lookAt.target on
    // every vrm.update(delta) call of the render loop. The pointer feeds a
    // desired position; the loop eases toward it so the gaze is never robotic.
    const lookDesired = new THREE.Vector3(0, 1.45, 2.5);
    let lookTarget = null;
    let hasPointerActivity = false;
    let pointerIdleTimer = null;
    const onPointerMove = event => {
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      hasPointerActivity = true;
      if (pointerIdleTimer) clearTimeout(pointerIdleTimer);
      pointerIdleTimer = setTimeout(() => { hasPointerActivity = false; }, 3000);
      const nx = ((event.clientX - rect.left) / rect.width) * 2 - 1; // -1 left .. +1 right
      const ny = 1 - ((event.clientY - rect.top) / rect.height) * 2; // -1 bottom .. +1 top
      // Coefficients below are visual fine-tuning, in meters in front of the
      // model: ±1.2 m of horizontal sweep and 1.1–1.8 m of height at z = 2.5
      // keep the gaze subtle (~±20° of rotation at the screen edges).
      lookDesired.set(nx * 1.2, 1.45 + ny * 0.35, 2.5);
    };
    scene.add(new THREE.HemisphereLight(0xffffff, 0x766485, 2.2));
    const light = new THREE.DirectionalLight(0xffebd8, 2);
    light.position.set(2, 4, 4);
    scene.add(light);
    let mixer, vrm, customMotion, expressionDriver = null, disposed = false, gesture = null, sway = null, swayBase = null, idlePose = null;
    const eyeSaccades = createEyeSaccades();
    const naturalIdle = createNaturalIdle();
    let naturalBones = null;
    const localTextures = [];
    // O loop de renderização também usa esta lista para blink e lip sync.
    // Ela precisa viver no escopo do effect, não apenas dentro do callback do loader.
    const morphList = [];
    const loader = sourceType === 'fbx' ? new FBXLoader() : new GLTFLoader();
    if (sourceType !== 'fbx') loader.register(parser => new VRMLoaderPlugin(parser));
    loader.load(source, loaded => {
      if (disposed) return;
      vrm = sourceType === 'fbx' ? null : loaded.userData.vrm;
      const avatar = sourceType === 'fbx' ? loaded : vrm?.scene || loaded.scene;
      if (sourceType === 'fbx' && sourceName.toLowerCase() === 'felis.fbx') {
        const textureLoader = new THREE.TextureLoader();
        const maps = Object.fromEntries(['Body', 'Hair', 'Cloth'].map(name => {
          const texture = textureLoader.load(`/models/felis/${name}_Base.png`);
          localTextures.push(texture);
          texture.colorSpace = THREE.SRGBColorSpace;
          return [name, texture];
        }));
        avatar.traverse(object => {
          if (!object.isMesh) return;
          for (const material of (Array.isArray(object.material) ? object.material : [object.material])) {
            if (!maps[material.name]) continue;
            material.map = maps[material.name];
            material.color?.set(0xffffff);
            if (material.specular) material.specular.set(0x111111);
            material.needsUpdate = true;
          }
        });
      }
      if (vrm) VRMUtils.rotateVRM0(vrm);
      scene.add(avatar);
      avatar.updateMatrixWorld(true);
      const skinned = [];
      avatar.traverse(object => { if (object.isSkinnedMesh) skinned.push(object); });
      const box = new THREE.Box3();
      if (skinned.length) {
        skinned.forEach(object => box.expandByObject(object));
      } else box.setFromObject(avatar);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const scale = 2.25 / Math.max(size.y, .001);
      avatar.scale.setScalar(scale);
      avatar.position.set(-center.x * scale, -box.min.y * scale, -center.z * scale);
      if (vrm?.humanoid) {
        const setArm = (name, sign) => {
          const node = vrm.humanoid.getNormalizedBoneNode?.(name);
          if (node) node.rotation.z += sign * THREE.MathUtils.degToRad(65);
        };
        setArm('leftUpperArm', 1);
        setArm('rightUpperArm', -1);
        // Postura natural de repouso: leve flexão e rotação de cotovelos (elimina o aspecto de tábua)
        const setForearm = (name, sign) => {
          const node = vrm.humanoid.getNormalizedBoneNode?.(name);
          if (node) {
            node.rotation.z += sign * THREE.MathUtils.degToRad(-14);
            node.rotation.x += THREE.MathUtils.degToRad(8);
          }
        };
        setForearm('leftLowerArm', 1);
        setForearm('rightLowerArm', -1);
        vrm.humanoid.update?.();
        // Pose de repouso em pé (braços para baixo). É o alvo do retorno ao idle
        // quando um clipe termina; o sway é somado por cima todo frame.
        idlePose = new Map();
        for (const name of Object.keys(vrm.humanoid.humanBones ?? {})) {
          const node = vrm.humanoid.getNormalizedBoneNode?.(name);
          if (node) idlePose.set(node, { rotation: node.quaternion.clone(), position: node.position.clone(), scale: node.scale.clone() });
        }
      }
      if (vrm?.humanoid) {
        // Subtle idle sway (breath + lateral) driven through normalized nodes;
        // raw-bone motions (customMotion, director bone()) live in the other tree.
        sway = createVrmIdleSway();
        swayBase = ['spine', 'chest', 'neck'].map(part => {
          const node = vrm.humanoid.getNormalizedBoneNode?.(part);
          return node ? { part, node, x: node.rotation.x, z: node.rotation.z } : null;
        }).filter(Boolean);

        // Nós capturados para respiração corporal completa, troca de peso e head-bobbing
        const getNode = name => vrm.humanoid.getNormalizedBoneNode?.(name) || null;
        naturalBones = {
          chest: getNode('chest') ? { node: getNode('chest'), base: { x: getNode('chest').rotation.x, z: getNode('chest').rotation.z } } : null,
          spine: getNode('spine') ? { node: getNode('spine'), base: { x: getNode('spine').rotation.x, z: getNode('spine').rotation.z } } : null,
          neck: getNode('neck') ? { node: getNode('neck'), base: { x: getNode('neck').rotation.x, z: getNode('neck').rotation.z } } : null,
          head: getNode('head') ? { node: getNode('head'), base: { x: getNode('head').rotation.x, y: getNode('head').rotation.y, z: getNode('head').rotation.z } } : null,
          leftShoulder: getNode('leftShoulder') ? { node: getNode('leftShoulder'), base: { z: getNode('leftShoulder').rotation.z } } : null,
          rightShoulder: getNode('rightShoulder') ? { node: getNode('rightShoulder'), base: { z: getNode('rightShoulder').rotation.z } } : null,
          hips: getNode('hips') ? { node: getNode('hips'), base: { rotZ: getNode('hips').rotation.z, posX: getNode('hips').position.x } } : null,
        };
      }
      if (vrm?.humanoid) {
        // Etapa 4: gestos procedurais (wave/tilt) + pose de corpo por emoção em
        // nós normalizados que nenhuma outra camada toca (braço direito + head).
        // A tabela de eixos semânticos vem da sonda geométrica no modelo real
        // (rigs espelhados trocam o sinal de raise/flex entre L e R); a sonda é
        // somente-leitura e roda depois da pose de repouso ficar estável.
        avatar.updateMatrixWorld(true);
        const safeNode = name => { try { return vrm.humanoid.getNormalizedBoneNode?.(name) ?? null; } catch { return null; } };
        const probeVec = new THREE.Vector3();
        const probeQuat = new THREE.Quaternion();
        const axisTable = calibrateArmAxes({
          probe: {
            worldPosition: name => { const n = safeNode(name); if (!n) return null; n.getWorldPosition(probeVec); return [probeVec.x, probeVec.y, probeVec.z]; },
            worldQuaternion: name => { const n = safeNode(name); if (!n) return null; n.getWorldQuaternion(probeQuat); return [probeQuat.x, probeQuat.y, probeQuat.z, probeQuat.w]; },
          },
        });
        vrmGestures.current = createVrmGestureLayer({ humanoid: vrm.humanoid, axisTable });
      }

      if (vrm?.lookAt) {
        // three-vrm 3.x: assigning an Object3D to vrm.lookAt.target makes
        // vrm.update(delta) aim the gaze rig at its world position.
        lookTarget = new THREE.Object3D();
        lookTarget.position.copy(lookDesired);
        scene.add(lookTarget);
        vrm.lookAt.target = lookTarget;
        canvas.addEventListener('pointermove', onPointerMove);
      }
      let meshes = 0, bones = 0, triangles = 0;
      const morphs = new Set();
      const boneList = [];
      avatar.traverse(object => {
        if (object.isBone) { bones++; boneList.push(object); }
        if (object.isMesh) {
          meshes++;
          triangles += (object.geometry.index?.count || object.geometry.attributes.position?.count || 0) / 3;
          Object.keys(object.morphTargetDictionary || {}).forEach(name => morphs.add(name));
          if (object.morphTargetInfluences) Object.entries(object.morphTargetDictionary || {}).forEach(([name,index]) => morphList.push({ object, name, index }));
        }
      });
      mixer = new THREE.AnimationMixer(avatar);
      // Clipe de uma ação só: ao terminar, devolve o rig à pose de repouso para
      // o sway procedural assumir de novo (sem pose presa no último frame).
      mixer.addEventListener('finished', event => {
        if (disposed) return;
        event.action?.stop();
        if (idlePose) {
          for (const [node, pose] of idlePose) {
            node.quaternion.copy(pose.rotation);
            node.position.copy(pose.position);
            node.scale.copy(pose.scale);
          }
        }
        vrm?.humanoid?.update?.();
      });
      const animations = (loaded.animations || []).map(clip => inspectAnimation(clip, avatar));
      const expressionNames = vrm?.expressionManager?.expressions?.map(e => e.expressionName) || [];
      const detectedBlink = detectBlinkName(expressionNames, morphs);
      const manifest = buildCapabilityManifest(avatar, animations, expressionNames);
      const preferences = loadMeshPrefs(sourceName);
      const visibility = resolveMeshVisibility(manifest, sourceType === 'fbx' ? Object.fromEntries(manifest.meshes.map(mesh => [mesh.name, true])) : preferences).slice();
      manifest.meshes.forEach((mesh, index) => { const meshObject = findMesh(avatar, mesh, manifest.meshes); if (meshObject) meshObject.visible = visibility[index]; });
      const initialRotations = boneList.map(bone => bone.quaternion.clone());
      customMotion = createCustomMotion(boneList);
      // O driver é o dono único dos pesos de expressão: rampa + TTL evitam que
      // as expressões aplicadas pelo chat/painel fiquem "vazadas" no VRM.
      expressionDriver = createExpressionDriver({
        setRaw: (name, weight) => vrm?.expressionManager?.setValue(name, weight),
        blinkName: detectedBlink,
        // O peso que o LLM escolhe é intenção, não milímetro: a régua medida no
        // shiro equaliza a visibilidade entre as 20 expressões do rosto.
        gains: buildExpressionGains(expressionNames),
      });
      if (expressionDriverRef) expressionDriverRef.current = expressionDriver;
      // Etapa 3: o engine de emoções só existe para VRMs com expressionManager
      // (Live2D/GLB ficam sem — o chat cai no fallback das actions do LLM).
      if (vrm?.expressionManager) emotionEngine.current = createEmotionEngine({ driver: expressionDriver });
      // Etapa 5: lip-sync dirigido pelo áudio real. O layer nasce sem elemento —
      // speakReply faz o attach do HTMLAudioElement reutilizado e o grafo Web Audio
      // (AudioContext + AnalyserNode) só é criado de forma preguiçosa, no primeiro
      // update com áudio pronto. Sem Web Audio o layer se desativa sozinho.
      // Em VRM a boca vai pelo expressionManager (o manager zera escrita bruta
      // de morph no vrm.update de todo frame); GLB/FBX seguem no morph fallback.
      const visemeExpressionNames = VISEME_EXPRESSION_NAMES.filter(name => expressionNames.includes(name));
      audioLipSync.current = createAudioLipSync({
        morphTargets: morphList.filter(m => VISEME_NAMES.includes(m.name)),
        setWeight: vrm?.expressionManager ? (name, value) => vrm.expressionManager.setValue(name, value) : null,
        visemeNames: visemeExpressionNames.length ? visemeExpressionNames : null,
      });
      controller.current = {
        gesture(name) {
          // Etapa 4: layer do humanoid (VRM) primeiro — wave/tilt/idle em nós
          // normalizados; o caminho Autumn (DEF-*) segue como fallback.
          if (vrmGestures.current?.gesture(name)) return true;
          if (name === 'wave') { gesture = null; mixer.stopAllAction(); return customMotion.wave(); }
          if (name === 'idle') { gesture = null; mixer.stopAllAction(); return customMotion.startIdle(); }
          if (name !== 'tilt') return false;
          const index = boneList.findIndex(bone => bone.name === 'DEF-spine006');
          if (index < 0) return false;
          customMotion.stop();
          mixer.stopAllAction();
          gesture = { bone: boneList[index], base: boneList[index].quaternion.clone(), elapsed: 0 };
          return true;
        },
        // Fase 1: sequências de keyframes (shapes do buildSequenceRequest). Só o
        // layer VRM executa; GLB/FBX não têm o rig humanoid normalizado e recusam.
        playSequence(request) {
          if (!vrmGestures.current) return false;
          return vrmGestures.current.playSequence(request) === true;
        },
        play(index) { const animation = animations[index]; if (!animation?.clip || animation.excludedTracks) return; gesture = null; customMotion.stop(); mixer.stopAllAction(); const action = mixer.clipAction(animation.clip); action.reset().setLoop(THREE.LoopOnce, 1); action.clampWhenFinished = false; action.play(); },
        stop() { mixer.stopAllAction(); gesture = null; customMotion.stop(); vrmGestures.current?.stopGesture(); },
        idle() { if (vrmGestures.current?.gesture('idle')) return true; gesture = null; mixer.stopAllAction(); return customMotion.startIdle(); },
        wave() { if (vrmGestures.current?.gesture('wave')) return true; gesture = null; mixer.stopAllAction(); return customMotion.wave(); },
        playClip(name) { const index = animations.findIndex(animation => animation.name === name); if (index >= 0) play(index); },
        setMorph(name, value) { this.morph(name, value); },
        setExpression(name, weight = 1) { if (!vrm?.expressionManager?.setValue) return false; return expressionDriver?.set(name, weight, { ttlMs: 4000 }) ?? false; },
        morph(name, value) { morphList.filter(item => item.name === name).forEach(item => { item.object.morphTargetInfluences[item.index] = value; }); },
        bone(index, axis, value) {
          const bone = boneList[index]; if (!bone) return;
          customMotion.stop(); gesture = null;
          mixer.stopAllAction();
          bone.quaternion.copy(initialRotations[index]);
          bone.rotateOnAxis(new THREE.Vector3(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0), THREE.MathUtils.degToRad(value));
        },
        setMeshVisible(name, visible) { avatar.traverse(object => { if (object.isMesh && object.name === name) object.visible = Boolean(visible); }); },
        applyDefaultVisibility() { resolveMeshVisibility(manifest, sourceType === 'fbx' ? Object.fromEntries(manifest.meshes.map(mesh => [mesh.name, true])) : {}).forEach((visible, index) => { const meshObject = findMesh(avatar, manifest.meshes[index], manifest.meshes); if (meshObject) meshObject.visible = visible; }); },
        reset() { mixer.stopAllAction(); gesture = null; customMotion.stop(); boneList.forEach((bone, i) => bone.quaternion.copy(initialRotations[i])); morphList.forEach(item => { item.object.morphTargetInfluences[item.index] = 0; }); expressionDriver?.clear(); vrmGestures.current?.clear(); audioLipSync.current?.clear(); }
      };
      manifest.customIdle = customMotion.idleAvailable || Boolean(vrmGestures.current?.available.idle);
      manifest.customWave = customMotion.waveAvailable || Boolean(vrmGestures.current?.available.wave);
      manifest.customTilt = boneList.some(bone => bone.name === 'DEF-spine006') || Boolean(vrmGestures.current?.available.tilt);
      manifest.sequences = Boolean(vrmGestures.current?.available.sequences);
      manifest.gestures = vrmGestures.current?.gestureNames ?? [];
      const reportPayload = { format: sourceType === 'fbx' ? 'FBX' : vrm ? 'VRM' : 'GLB / glTF', meshes, bones, customIdle: manifest.customIdle, customWave: manifest.customWave, customTilt: manifest.customTilt, sequences: manifest.sequences, boneNames: boneList.map((bone, index) => ({ name: bone.name || 'Sem nome', index })), triangles: Math.round(triangles), morphs: [...morphs], bounds: size.toArray().map(n => n.toFixed(2)).join(' × '), animations: animations.map(({ name, boneTracks, excludedTracks }) => ({ name, boneTracks, excludedTracks })), expressions: expressionNames, blink: detectedBlink !== null, blinkName: detectedBlink, gestures: manifest.gestures, meshList: manifest.meshes, manifest };
      onReport(reportPayload);
    }, undefined, () => { if (!disposed) onReport({ error: 'Não foi possível carregar o modelo. Verifique se é um GLB, VRM ou FBX válido.' }); });
    const resize = () => {
      camera.aspect = element.clientWidth / element.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(element.clientWidth, element.clientHeight);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    resize();
    const timer = new (THREE.Timer || THREE.Clock)();
    let frame;
    const draw = (timestamp) => {
      frame = requestAnimationFrame(draw);
      timer.update?.(timestamp);
      const delta = Math.min(timer.getDelta(), .1);
      const state = auto?.current?.update?.();
      if (state?.blink !== undefined && blinkMode?.current && blinkName?.current) {
        // Etapa 3: emoções de olhos fechados suprimem o blink (gate do emotion-engine).
        const blinkGate = emotionEngine?.current?.blinkMultiplier() ?? 1;
        if (blinkMode.current === 'expression') vrm?.expressionManager?.setValue(blinkName.current, state.blink * blinkGate);
        else morphList.filter(item => item.name === blinkName.current).forEach(item => { item.object.morphTargetInfluences[item.index] = state.blink * blinkGate; });
      }
      expressionDriver?.update();
      if (state && state.idleActive !== lastIdleActive?.current) {
        lastIdleActive.current = state.idleActive;
        if (state.idleActive) controller.current?.idle?.();
        else controller.current?.stop?.();
      }
      // Respiração corporal completa, ombros e weight shift (estilo Neuro-sama)
      if (naturalIdle && naturalBones) {
        const speechLevel = audioLipSync.current?.getLevel() || 0;
        const pose = naturalIdle.update(timestamp, {
          speechLevel,
          deltaSeconds: delta,
          isThinking: busyRef.current,
        });
        if (naturalBones.chest) naturalBones.chest.node.rotation.x = naturalBones.chest.base.x + pose.chest.rotX;
        if (naturalBones.leftShoulder) naturalBones.leftShoulder.node.rotation.z = naturalBones.leftShoulder.base.z + pose.shoulders.leftRotZ;
        if (naturalBones.rightShoulder) naturalBones.rightShoulder.node.rotation.z = naturalBones.rightShoulder.base.z + pose.shoulders.rightRotZ;
        if (naturalBones.hips) {
          naturalBones.hips.node.rotation.z = naturalBones.hips.base.rotZ + pose.hips.rotZ;
          naturalBones.hips.node.position.x = naturalBones.hips.base.posX + pose.hips.posX;
        }
        if (naturalBones.spine) naturalBones.spine.node.rotation.z = naturalBones.spine.base.z + pose.spine.rotZ;
        if (naturalBones.neck) {
          naturalBones.neck.node.rotation.x = naturalBones.neck.base.x + pose.neck.rotX;
          naturalBones.neck.node.rotation.z = naturalBones.neck.base.z + pose.neck.rotZ;
        }
      } else if (sway && swayBase?.length) {
        const pose = sway.update();
        for (const base of swayBase) {
          if (base.part === 'chest') base.node.rotation.x = base.x + (pose.breath - .5) * .05;
          else if (base.part === 'spine') base.node.rotation.z = base.z + pose.swayX * .04;
          else if (base.part === 'neck') base.node.rotation.z = base.z + pose.swayZ * .03;
        }
      }
      // Etapa 4: gestos + pose emocional do humanoid, junto do sway e antes do vrm.update.
      vrmGestures.current?.update();

      // Speech-reactive head bobbing e micro-inclinação (aditivo na cabeça)
      if (naturalIdle && naturalBones?.head) {
        const speechLevel = audioLipSync.current?.getLevel() || 0;
        if (speechLevel > 0.04 || busyRef.current) {
          const pose = naturalIdle.update(timestamp, { speechLevel, deltaSeconds: delta, isThinking: busyRef.current });
          naturalBones.head.node.rotation.x += pose.head.rotX;
          naturalBones.head.node.rotation.y += pose.head.rotY;
          naturalBones.head.node.rotation.z += pose.head.rotZ;
        }
      }

      // Micro-sacadas e olhar vivo autônomo (estilo Neuro-sama)
      if (lookTarget) {
        const saccade = eyeSaccades ? eyeSaccades.update(delta, {
          isThinking: busyRef.current,
          hasPointer: hasPointerActivity,
        }) : { x: 0, y: 0 };
        const currentLook = hasPointerActivity ? lookDesired : new THREE.Vector3(0, 1.45, 2.5);
        const targetPos = new THREE.Vector3(
          currentLook.x + saccade.x,
          currentLook.y + saccade.y,
          currentLook.z
        );
        lookTarget.position.lerp(targetPos, 1 - Math.exp(-delta * 10));
      }
      // Etapa 5: a boca segue o áudio real — RMS contínuo do AnalyserNode com a
      // rampa 30/80 ms, sem timeline textual. Fallback gracioso embutido no layer.
      audioLipSync.current?.update();
      mixer?.update(delta); vrm?.update(delta); customMotion?.update(delta); if (gesture) { gesture.elapsed += delta; const progress = Math.min(gesture.elapsed / 2, 1); gesture.bone.quaternion.copy(gesture.base); gesture.bone.rotateZ(Math.sin(Math.PI * progress) * .12); if (progress === 1) gesture = null; } renderer.render(scene, camera);
    };
    draw();
    return () => {
      disposed = true;
      controller.current = null;
      emotionEngine.current = null;
      if (vrmGestures) vrmGestures.current = null;
      // Fecha o AudioContext e descarta o layer. O HTMLAudioElement do TTS foi
      // consumido pelo MediaElementSource deste contexto (um elemento só pode
      // ser roteado uma vez na vida), então a referência cai também — a próxima
      // fala cria um elemento novo em speakReply e o áudio continua audível.
      audioLipSync.current?.reset();
      audioLipSync.current = null;
      if (ttsAudio?.current) { try { ttsAudio.current.pause(); } catch {} ttsAudio.current = null; }
      cancelAnimationFrame(frame);
      observer.disconnect();
      canvas.removeEventListener('pointermove', onPointerMove);
      if (vrm?.lookAt) vrm.lookAt.target = null;
      localTextures.forEach(texture => texture.dispose());
      scene.traverse(object => {
        if (object.geometry) object.geometry.dispose();
        if (object.material) (Array.isArray(object.material) ? object.material : [object.material]).forEach(material => material.dispose());
      });
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [source, sourceType, sourceName, onReport, controller]);
  return <div className="avatar" ref={host} aria-label="Visualização 3D do avatar" />;
}

function findMesh(avatar, target, meshes) {
  const ordinal = meshes.slice(0, meshes.indexOf(target)).filter(mesh => mesh.name === target.name).length;
  let seen = 0;
  let result = null;
  avatar.traverse(object => {
    if (!object.isMesh || object.name !== target.name) return;
    if (seen === ordinal) result = object;
    seen++;
  });
  return result;
}

function detectBlinkName(expressions, morphs) {
  if (expressions.includes('blink')) return 'blink';
  for (const candidate of ['blink', 'blinking', 'blinking_l', 'blinking_r', 'eye_close', 'closed_eye']) {
    const morph = [...morphs].find(name => name.toLowerCase() === candidate);
    if (morph) return morph;
  }
  return null;
}

function BondMeters({ intimacy, values }) {
  return <div className="bond-meters">
    {METER_KEYS.map(key => {
      const xp = Math.min(999, Math.max(0, intimacy[key] || 0));
      const level = levelFor(xp);
      return <div className="bond-meter" key={key}>
        <span className="bond-head"><span>{key}</span><span className="bond-hearts" aria-hidden="true"><b>{'♥'.repeat(level)}</b>{'♡'.repeat(LEVELS.length - level)}</span></span>
        <span className="bond-track"><i style={{ width: `${Math.round(meterProgress(xp) * 100)}%` }} /></span>
        {values ? <span className="bond-value">{xp} XP · nível {level}</span> : null}
      </div>;
    })}
  </div>;
}

// Rótulos da memória v2 (as chaves são as mesmas do memory.json e do prompt).
const MEMORY_SECTION_LABELS = {
  user: 'Quem ele é',
  preferences: 'Gostos e preferências',
  hobbies: 'Hobbies',
  relationship: 'Entre nós',
  dates: 'Datas importantes',
  other: 'Outros',
};

const FORGET_CONFIRMATION = 'APAGAR';

function MemoryPanel() {
  const [memory, setMemory] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState('');
  const [confirmText, setConfirmText] = useState('');
  const [busy, setBusy] = useState(false);
  const unlocked = confirmText.trim().toUpperCase() === FORGET_CONFIRMATION;

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/memory');
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Falha ao ler a memória.');
      setMemory(data.memory);
      setError(null);
    } catch (cause) {
      setError(cause?.message || 'Falha ao ler a memória.');
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const forget = useCallback(async (payload, label) => {
    if (!unlocked || busy) return;
    setBusy(true);
    setNotice('');
    try {
      const response = await fetch('/api/memory/forget', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, confirm: confirmText.trim() }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Falha ao apagar.');
      setMemory(data.memory);
      setError(null);
      setNotice(label + ' apagado.');
    } catch (cause) {
      setError(cause?.message || 'Falha ao apagar.');
    } finally {
      setBusy(false);
    }
  }, [busy, confirmText, unlocked]);

  if (!memory) {
    return error
      ? <p className="memory-error">{error}</p>
      : <p className="settings-hint">Lendo a memória da Usami…</p>;
  }

  const totalFacts = Object.values(memory.sections).reduce((count, facts) => count + facts.length, 0);
  const deleteButton = (onClick, label) => (
    <button
      disabled={!unlocked || busy}
      onClick={onClick}
      aria-label={label}
      title={unlocked ? label : 'Digite APAGAR para liberar as exclusões'}
    >×</button>
  );

  return <div>
    <h3>O que ela guardou</h3>
    <p className="settings-hint">
      {totalFacts} fato(s) durável(is) · {memory.recentFacts.length} recente(s) · {memory.summaries.length} resumo(s) · afinidade {memory.affinity.score}/100.
      Tudo fica no <code>memory.json</code> do servidor local.
    </p>

    <label className="settings-label">Digite APAGAR para liberar as exclusões
      <input
        value={confirmText}
        onChange={(event) => setConfirmText(event.target.value)}
        placeholder={FORGET_CONFIRMATION}
        autoComplete="off"
        spellCheck={false}
      />
    </label>
    <p className="settings-hint">Sem a palavra, nenhum botão apaga. As exclusões são imediatas e não têm desfazer.</p>

    {Object.entries(MEMORY_SECTION_LABELS).map(([section, label]) => {
      const facts = memory.sections[section] || [];
      if (!facts.length) return null;
      return <div className="memory-section" key={section}>
        <h3>{label}</h3>
        <ul className="memory-list">
          {facts.map((fact) => <li key={fact}>
            <span>{fact}</span>
            {deleteButton(() => forget({ kind: 'fact', section, fact }, 'Fato'), 'Apagar fato: ' + fact)}
          </li>)}
        </ul>
      </div>;
    })}
    {!totalFacts ? <p className="memory-empty">Nenhum fato duradouro ainda.</p> : null}

    {memory.recentFacts.length ? <div className="memory-section">
      <h3>Recentes (7 dias)</h3>
      <ul className="memory-list">
        {memory.recentFacts.map((item) => <li key={item.fact}>
          <span>{item.fact}<small>{MEMORY_SECTION_LABELS[item.section]} · até {item.expiresAt}{item.expired ? ' (expirado)' : ''}</small></span>
          {deleteButton(() => forget({ kind: 'recent', fact: item.fact }, 'Fato recente'), 'Apagar fato recente: ' + item.fact)}
        </li>)}
      </ul>
    </div> : null}

    {memory.summaries.length ? <div className="memory-section">
      <h3>Resumos diários</h3>
      <ul className="memory-list">
        {memory.summaries.map((item) => <li key={item.date}>
          <span>{item.summary}<small>{item.date}</small></span>
          {deleteButton(() => forget({ kind: 'summary', date: item.date }, 'Resumo de ' + item.date), 'Apagar resumo de ' + item.date)}
        </li>)}
      </ul>
    </div> : null}

    {memory.history.length ? <div className="memory-section">
      <h3>Histórico de conversa</h3>
      <ul className="memory-list">
        {memory.history.map((item) => <li key={item.date}>
          <span>{item.date}<small>{item.count} mensagem(ns) guardada(s)</small></span>
          {deleteButton(() => forget({ kind: 'history', date: item.date }, 'Histórico de ' + item.date), 'Apagar histórico de ' + item.date)}
        </li>)}
      </ul>
    </div> : null}

    {notice ? <p className="memory-notice">{notice}</p> : null}
    {error ? <p className="memory-error">{error}</p> : null}

    <div className="rig-actions memory-actions">
      <button
        className="memory-danger"
        disabled={!unlocked || busy}
        onClick={() => forget({ kind: 'all' }, 'Toda a memória')}
      >Apagar tudo</button>
    </div>
    <p className="settings-hint">O histórico do navegador (aba Conversa) é separado disso.</p>
  </div>;
}

export function Usami() {
  const [source, setSource] = useState('/models/shiro.vrm');
  const [sourceType, setSourceType] = useState('gltf');
  const [sourceName, setSourceName] = useState('shiro.vrm');
  const [modelPath, setModelPath] = useState('');
  const [report, setReport] = useState(null);
  const [meshPrefs, setMeshPrefs] = useState({});
  const [chat, setChat] = useState(true);
  const [text, setText] = useState('');
  const [message, setMessage] = useState('');
  const [conversation, setConversation] = useState(loadConversation);
  const [quiet, setQuiet] = useState(false);
  const [voiceOff, setVoiceOff] = useState(false);
  const [boneIndex, setBoneIndex] = useState(0);
  const [axis, setAxis] = useState('x');
  const [angle, setAngle] = useState(0);
  const [morphValues, setMorphValues] = useState({});
  const [selectedClip, setSelectedClip] = useState('0');
  const [busy, setBusy] = useState(false);
  const [call, setCall] = useState(false);
  const [callSeconds, setCallSeconds] = useState(0);
  const [micListening, setMicListening] = useState(false);
  const [micHearing, setMicHearing] = useState(false);
  const [micError, setMicError] = useState(false);
  const [voiceSpeaking, setVoiceSpeaking] = useState(false);
  const [intimacy, setIntimacy] = useState(loadIntimacy);
  const [bondOpen, setBondOpen] = useState(false);
  const [panel, setPanel] = useState(false);
  const [settingsTab, setSettingsTab] = useState('chat');
  const fileInput = useRef(null);
  const controller = useRef(null);
  const director = useRef(null);
  const emotionEngine = useRef(null);
  const vrmGestures = useRef(null);
  const auto = useRef(null);
  const blinkMode = useRef(null);
  const blinkName = useRef(null);
  const lastIdleActive = useRef(false);
  const audioLipSync = useRef(null);
  const ttsAudio = useRef(null);
  // Token da fila de TTS em reprodução: uma fala nova (ou mudo) invalida a
  // fila anterior, que para de tocar partes ainda pendentes.
  const ttsQueue = useRef(0);
  const expressionDriverRef = useRef(null);
  const speechPaceRef = useRef(null);
  const speechScheduler = useRef(null);
  if (!speechScheduler.current) speechScheduler.current = createSpeechScheduler();
  const voiceOffRef = useRef(false);
  const recognitionRef = useRef(null);
  const hearingTimer = useRef(0);
  const callActiveRef = useRef(false);
  const callStartRef = useRef(0);
  const ptVoiceRef = useRef(null);
  const speakingRef = useRef(false);
  const busyRef = useRef(false);
  const submitRef = useRef(null);
  const turnId = useRef(latestTurnId(conversation));
  const recognitionSupported = typeof window.SpeechRecognition === 'function' || typeof window.webkitSpeechRecognition === 'function';
  const synthesisSupported = typeof window.speechSynthesis === 'object' && typeof window.SpeechSynthesisUtterance === 'function';
  const poke = () => auto.current?.notifyActivity();
  const voicePhase = deriveVoicePhase({ call, micError, listening: micListening, hearing: micHearing, busy, speaking: voiceSpeaking });
  const getVoiceLevel = useCallback(() => audioLipSync.current?.getLevel?.() ?? 0, []);
  // Audio revive: prepara e retoma o AudioContext no primeiro gesto, ao voltar
  // para a aba e quando o navegador o suspende no meio da sessão.
  useEffect(() => {
    const revive = createAudioRevive({
      getContext: () => audioLipSync.current?.getContext?.() ?? null,
      prime: () => audioLipSync.current?.prime?.(),
    });
    revive.attach();
    return () => revive.detach();
  }, []);
  useEffect(() => () => clearTimeout(hearingTimer.current), []);
  const addTurn = (role, content, mode = 'text') => {
    const value = String(content || '').trim();
    if (!value) return;
    turnId.current += 1;
    // O id é capturado AGORA: o updater só roda no flush do React, e duas
    // chamadas no mesmo tick (resposta dividida em balões) leriam o mesmo
    // `turnId.current` final — chaves duplicadas na lista.
    const id = turnId.current;
    setConversation(previous => {
      const next = [...previous, { id, role, content: value, mode }];
      // O estado guarda a conversa inteira da sessão; o navegador fica com as
      // últimas 100 mensagens para não crescer sem limite.
      saveConversation(next);
      return next;
    });
  };
  const clearChat = () => {
    turnId.current = 0;
    setConversation([]);
    clearStoredConversation();
  };
  const exportChat = () => {
    if (!conversation.length) return;
    const blob = new Blob([JSON.stringify(conversation, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `usami-conversa-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  const reportModel = useCallback(value => {
    setReport(value);
    if (value.animations) setSelectedClip(String(Math.max(0, value.animations.findIndex(clip => clip.boneTracks && !clip.excludedTracks))));
    director.current = value?.manifest ? createMotionDirector({ controller: controller.current, capabilities: { ...value.manifest, customIdle: value.customIdle !== false, customWave: value.customWave !== false, customTilt: value.customTilt !== false } }) : null;
    // Automatic life (blink + idle) only for 3D models with a manifest; Live2D brings its own rig.
    blinkName.current = value?.blinkName ?? null;
    blinkMode.current = blinkName.current ? (blinkName.current === 'blink' && value?.expressions?.includes('blink') ? 'expression' : 'morph') : null;
    auto.current = value?.manifest && (value.blink || value.customIdle !== false) ? createAutoMotion({ blink: Boolean(value.blink), idle: value.customIdle !== false }) : null;
    lastIdleActive.current = false;
  }, []);
  useEffect(() => () => { if (source.startsWith('blob:')) URL.revokeObjectURL(source); }, [source]);
  useEffect(() => {
    if (!synthesisSupported) return undefined;
    const pickVoice = () => {
      const voices = window.speechSynthesis.getVoices() || [];
      ptVoiceRef.current = voices.find(voice => /^pt[-_]br/i.test(voice.lang || '')) || voices.find(voice => /^pt/i.test(voice.lang || '')) || null;
    };
    pickVoice();
    window.speechSynthesis.addEventListener('voiceschanged', pickVoice);
    return () => window.speechSynthesis.removeEventListener('voiceschanged', pickVoice);
  }, [synthesisSupported]);
  useEffect(() => {
    if (!call) return undefined;
    const timer = setInterval(() => setCallSeconds(seconds => seconds + 1), 1000);
    return () => clearInterval(timer);
  }, [call]);
  const loadFile = event => {
    const file = event.target.files?.[0];
    if (!file) return;
    setReport(null);
    setBoneIndex(0); setAngle(0); setMorphValues({}); setSelectedClip('0');
    setSourceType(file.name.toLowerCase().endsWith('.fbx') ? 'fbx' : 'gltf');
    setSourceName(file.name);
    setSource(URL.createObjectURL(file));
    event.target.value = '';
  };
  const loadFromPath = path => {
    const target = (path || '').trim();
    const dot = target.lastIndexOf('.');
    const extension = dot < 0 ? '' : target.slice(dot).toLowerCase();
    if (!target || !['.glb', '.gltf', '.vrm', '.fbx'].includes(extension)) return;
    setReport(null);
    setBoneIndex(0); setAngle(0); setMorphValues({}); setSelectedClip('0');
    setSourceType(extension === '.fbx' ? 'fbx' : 'gltf');
    setSourceName(target.split('/').pop());
    setSource(target);
  };
  const styleIdForActions = actions => {
    const expression = actions?.find(action => action?.type === 'set_expression')?.name?.toLowerCase?.() || '';
    if (/happy|joy|smile|fun|glad|laugh/.test(expression)) return 'happy';
    if (/sad|cry|sorrow|tear/.test(expression)) return 'sad';
    if (/angry|mad|rage|annoy/.test(expression)) return 'angry';
    if (/surprise|shock|wow|amaze/.test(expression)) return 'surprised';
    if (/relax|calm|sleepy|tired|content/.test(expression)) return 'relaxed';
    return 'neutral';
  };
  const toggleVoice = () => {
    const next = !voiceOffRef.current;
    voiceOffRef.current = next;
    setVoiceOff(next);
    if (next) {
      // Muting cuts whatever is playing immediately (server TTS + call synthesis).
      ttsAudio.current?.pause();
      if (window.speechSynthesis) { try { window.speechSynthesis.cancel(); } catch {} }
    }
  };
  // O rosto acompanha a fala, não um cronômetro fixo: `holdFace` empurra o
  // vencimento das expressões vivas para o tempo que a fala ainda vai ocupar,
  // `learnPace` corrige o ritmo com a duração real de cada balão já tocado.
  const pace = () => (speechPaceRef.current ??= createSpeechPace());
  const holdFace = text => expressionDriverRef.current?.extend(pace().holdMs(String(text ?? '').length));
  const learnPace = (text, elapsedMs) => pace().observe(String(text ?? '').length, elapsedMs);

  // Fila de áudio da resposta: UMA síntese por vez. O provedor de voz não
  // tolera requisições concorrentes (5 POST /api/tts em paralelo = 5×504; com
  // uma em voo todas voltam 200), então cada parte é sintetizada, exibida e
  // tocada em ordem. Cada parte pede o áudio EM STREAMING: o servidor despeja
  // PCM na medida em que o provedor gera e o primeiro som sai ~1 s depois do
  // pedido, contra ~5,3 s do WAV inteiro. A próxima parte é pedida quando a
  // rede da atual termina (onStreamEnd) — continua havendo uma requisição em
  // vó e nenhum buraco de silêncio entre balões. O caminho de elemento
  // (HTMLAudioElement reutilizado, blob: URL revogado depois de tocar) fica
  // para o HIT de cache e para o modo quieto, que desacelera a voz pelo
  // playbackRate — recurso que o PCM cru não tem.
  const speakReply = async (...args) => {
    // O orbe e o badge só precisam saber se há fala em curso; o token impede
    // que uma fila abandonada apague o "falando" da fila que a substituiu.
    const mine = ttsQueue.current + 1;
    setVoiceSpeaking(true);
    try { await speakReplyQueue(...args); } finally { if (ttsQueue.current <= mine) setVoiceSpeaking(false); }
  };
  const speakReplyQueue = async (reply, styleId = 'neutral', timedActions = [], onPart = () => {}) => {
    const rawParts = Array.isArray(reply) ? reply : parseReplyBalloons(String(reply ?? ''));
    const parts = rawParts
      .map(part => {
        if (typeof part === 'object' && part !== null) {
          const display = String(part.display ?? part.text ?? '').trim();
          const ttsText = String(part.ttsText ?? part.display ?? part.text ?? '').trim();
          const emotionKey = part.emotionKey || null;
          return { display, ttsText, emotionKey };
        }
        const text = String(part ?? '').trim();
        return { display: text, ttsText: text, emotionKey: null };
      })
      .filter(p => p.display || p.ttsText);
    if (!parts.length) return;
    const queueId = ++ttsQueue.current;
    const alive = () => !voiceOffRef.current && ttsQueue.current === queueId;
    // Sem áudio (mudo ou síntese quebrada) as ações agendadas não têm com que
    // se sincronizar: executar em vez de descartar, senão o corpo não reage.
    const flushTimedActions = () => { for (const action of timedActions) director.current?.execute([action]); };
    // No streaming não existe elemento com 'ended'/duration para o
    // speechScheduler, então as ações são agendadas contra o início da fala —
    // que é exatamente o que delayMs significa. Mesmo esquema do modo chamada.
    let actionsStarted = false;
    const runActionsAtSpeechStart = () => {
      if (actionsStarted) return;
      actionsStarted = true;
      for (const action of timedActions) {
        if (action?.trigger === 'end') continue;
        const delay = Number(action?.delayMs);
        if (Number.isFinite(delay) && delay > 0) {
          setTimeout(() => { if (alive()) director.current?.execute([action]); }, delay);
        } else director.current?.execute([action]);
      }
    };
    const runActionsAtSpeechEnd = () => {
      if (!alive()) return;
      for (const action of timedActions) if (action?.trigger === 'end') director.current?.execute([action]);
    };
    // Mute: nunca pede /api/tts — os balões entram todos de uma vez e a boca
    // fica fechada (fallback mudo), como quando a síntese falha.
    if (voiceOffRef.current) {
      parts.forEach(part => {
        onPart(part.display);
        if (part.emotionKey && expressionDriverRef.current) {
          applyVrmEmotion(part.emotionKey, expressionDriverRef.current);
        }
      });
      flushTimedActions();
      return;
    }
    if (!ttsAudio.current) ttsAudio.current = new Audio();
    const audio = ttsAudio.current;
    // Streaming exige o grafo Web Audio da camada de boca: é por ele que o PCM
    // toca e é ele que mede o lábio. Sem AudioContext ou sem visemas, pede o
    // blob direto — senão cada frase custaria dois pedidos ao provedor de voz.
    const canStream = !quiet && Boolean(audioLipSync.current?.getTap?.());
    // Nunca rejeita: a fila pode ser abandonada (fala nova ou mudo) com uma
    // requisição no ar — sem unhandled rejection.
    const askTts = (text, stream, partStyle = styleId) => fetch('/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, styleId: partStyle, stream }) })
      .then(async response => {
        if (!response || !response.ok) return null;
        // PCM cru atrás do header de stream; qualquer outra resposta de áudio é
        // o blob do caminho normal (HIT de cache, provedor sem streaming).
        if (stream && response.headers.get('x-tts-stream') === '1') return { stream: response };
        const type = response.headers.get('content-type') || '';
        if (!type.includes('audio/')) return null;
        return { url: URL.createObjectURL(await response.blob()) };
      })
      .catch(() => null);
    let attached = false;
    let played = false;
    // Etapa 5: a boca é dirigida pelo áudio que realmente toca — o layer se
    // anexa ao elemento reutilizado e cria o grafo Web Audio (AudioContext +
    // AnalyserNode, RMS contínuo) de forma preguiçosa no primeiro rAF com o
    // áudio pronto. Sem duração do servidor, sem timeline textual.
    const playWithElement = async url => {
      if (!attached) {
        audioLipSync.current?.attach(audio);
        attached = true;
        // Frente 2: as timedActions do turno inteiro são agendadas com o áudio
        // da PRIMEIRA parte, uma única vez — se o streaming já cuidou delas,
        // o scheduler não repete.
        if (!actionsStarted && timedActions.length > 0 && speechScheduler.current) {
          actionsStarted = true;
          speechScheduler.current.schedule({
            actions: timedActions,
            audio,
            onAction: (action) => {
              director.current?.execute([action]);
            },
          });
        }
      }
      audio.playbackRate = quiet ? .8 : 1;
      await playAudioPart(audio, url);
      URL.revokeObjectURL(url);
      played = true;
    };
    const firstStyle = parts[0]?.emotionKey ? getVrmEmotionConfig(parts[0].emotionKey).coarse : styleId;
    let pending = askTts(parts[0].ttsText, canStream, firstStyle);
    for (let index = 0; index < parts.length; index += 1) {
      const job = await pending;
      pending = null;
      // Fila superseded ou mute durante a síntese: larga o resto.
      if (!alive()) { if (job?.url) URL.revokeObjectURL(job.url); break; }
      // O balão pode ter nascido com a primeira amostra de áudio (streaming);
      // `shown` evita o segundo onPart da mesma frase.
      let shown = false;
      const partStartedAt = performance.now();
      if (job?.stream) {
        const tap = audioLipSync.current?.getTap?.() || null;
        const external = tap ? audioLipSync.current.beginExternal() : false;
        let outcome = { streamed: false };
        if (tap) {
          try {
            outcome = await playPcmStream({
              response: job.stream,
              audioContext: tap.context,
              input: tap.input,
              shouldContinue: alive,
              onFirstAudio: () => {
                if (!alive()) return;
                shown = true;
                onPart(parts[index].display);
                runActionsAtSpeechStart();
                if (parts[index].emotionKey && expressionDriverRef.current) {
                  applyVrmEmotion(parts[index].emotionKey, expressionDriverRef.current);
                }
                holdFace(parts[index].display);
              },
              onStreamEnd: () => {
                if (!pending && index + 1 < parts.length) {
                  const nextStyle = parts[index + 1].emotionKey ? getVrmEmotionConfig(parts[index + 1].emotionKey).coarse : styleId;
                  pending = askTts(parts[index + 1].ttsText, canStream, nextStyle);
                }
              },
            });
          } finally {
            if (external) audioLipSync.current.endExternal();
          }
        }
        if (outcome.streamed) {
          played = true;
          learnPace(parts[index].display, performance.now() - partStartedAt);
          runActionsAtSpeechEnd();
          if (!alive()) break;
          continue;
        }
        // Stream entregue mas mudo (Web Audio perdido no meio do turno, ou a
        // rede caiu antes da primeira amostra): sem segunda síntese — pedir de
        // novo custaria outro provedor inteiro. O texto ainda aparece abaixo.
      }
      if (!shown) onPart(parts[index].display);
      if (!job?.url) continue;
      if (!pending && index + 1 < parts.length) {
        const nextStyle = parts[index + 1].emotionKey ? getVrmEmotionConfig(parts[index + 1].emotionKey).coarse : styleId;
        pending = askTts(parts[index + 1].ttsText, canStream, nextStyle);
      }
      if (parts[index].emotionKey && expressionDriverRef.current) {
        applyVrmEmotion(parts[index].emotionKey, expressionDriverRef.current);
      }
      holdFace(parts[index].display);
      await playWithElement(job.url);
      learnPace(parts[index].display, performance.now() - partStartedAt);
      if (!alive()) break;
    }
    // A última síntese em voo nunca vai tocar (fila terminou ou foi abandonada):
    // revoga quando resolver. revoke em URL já revogada é no-op.
    if (pending) Promise.resolve(pending).then(late => { if (late?.url) URL.revokeObjectURL(late.url); });
    if (!played) { audioLipSync.current?.clear(); flushTimedActions(); }
  };
  const awardXP = gains => {
    setIntimacy(previous => {
      const next = {};
      let changed = false;
      METER_KEYS.forEach(key => {
        next[key] = Math.min(999, Math.max(0, Math.floor((previous[key] || 0) + (gains?.[key] || 0))));
        if (next[key] !== (previous[key] || 0)) changed = true;
      });
      if (!changed) return previous;
      try { localStorage.setItem(INTIMACY_KEY, JSON.stringify(next)); } catch {}
      return next;
    });
  };
  const gainsFor = (content, duringCall) => {
    const gains = { carinho: 1 };
    if (LAUGHTER_PATTERN.test(content)) gains.humor = 2;
    if (content.length > 120 || duringCall) gains.companhia = 2;
    return gains;
  };
  const speakSpoken = (reply, timedActions = []) => {
    // Mute: skip browser synthesis too — the caller keeps animating the lips.
    if (!synthesisSupported || voiceOffRef.current) return;
    const synthesis = window.speechSynthesis;
    try { synthesis.cancel(); } catch {}
    const utterance = new SpeechSynthesisUtterance(String(reply || '').slice(0, 400));
    utterance.lang = 'pt-BR';
    const voices = synthesis.getVoices() || [];
    const voice = ptVoiceRef.current || voices.find(item => /^pt[-_]br/i.test(item.lang || '')) || voices.find(item => /^pt/i.test(item.lang || ''));
    if (voice) utterance.voice = voice;
    utterance.rate = quiet ? .8 : .98;
    utterance.pitch = quiet ? .95 : 1;
    utterance.onstart = () => {
      speakingRef.current = true;
      setVoiceSpeaking(true);
      // Frente 2: ações com timing no modo chamada — start executa agora,
      // delayMs via setTimeout, end via onend da utterance (middle não tem
      // duração conhecida no speechSynthesis).
      for (const action of timedActions ?? []) {
        if (action?.trigger === 'start' || (!action?.trigger && !action?.delayMs)) {
          director.current?.execute([action]);
        } else if (action?.delayMs && action.delayMs > 0) {
          setTimeout(() => director.current?.execute([action]), action.delayMs);
        }
      }
    };
    const releaseMic = () => { speakingRef.current = false; setVoiceSpeaking(false); };
    utterance.onend = () => {
      releaseMic();
      for (const action of timedActions ?? []) {
        if (action?.trigger === 'end') director.current?.execute([action]);
      }
    };
    utterance.onerror = releaseMic;
    synthesis.speak(utterance);
  };
  const endCall = reason => {
    if (!callActiveRef.current) return;
    callActiveRef.current = false;
    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    try { recognition?.abort(); } catch {}
    if (window.speechSynthesis) { try { window.speechSynthesis.cancel(); } catch {} }
    speakingRef.current = false;
    clearTimeout(hearingTimer.current);
    setMicListening(false);
    setMicHearing(false);
    setMicError(false);
    setVoiceSpeaking(false);
    const minutes = Math.max(0, Math.floor((Date.now() - callStartRef.current) / 60000));
    if (minutes > 0) awardXP({ companhia: minutes });
    setCall(false);
    setChat(true);
    setMessage(reason || 'Chamada encerrada.');
  };
  const startCall = () => {
    if (call) return;
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) { setMessage('Reconhecimento de voz indisponível neste navegador. Use Chrome ou Edge.'); return; }
    const recognition = new Recognition();
    recognition.lang = 'pt-BR';
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.onstart = () => { setMicListening(true); setMicError(false); };
    recognition.onresult = event => {
      if (speakingRef.current) return;
      // Qualquer resultado (inclusive parcial) acende o "te ouvindo"; apaga
      // sozinho se a fala parar, sem depender do evento final.
      setMicHearing(true);
      clearTimeout(hearingTimer.current);
      hearingTimer.current = setTimeout(() => setMicHearing(false), 1200);
      let final = '';
      for (let index = event.resultIndex; index < event.results.length; index++) if (event.results[index].isFinal) final += event.results[index][0].transcript;
      const heard = final.trim();
      if (heard) submitRef.current?.(heard, { spoken: true });
    };
    recognition.onerror = event => {
      if (['not-allowed', 'service-not-allowed', 'audio-capture'].includes(event.error)) setMicError(true);
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') endCall('Não foi possível acessar o microfone. Verifique a permissão do navegador.');
      else if (event.error === 'audio-capture') endCall('Nenhum microfone encontrado.');
      else if (event.error === 'network') endCall('Falha de rede no reconhecimento de voz.');
    };
    recognition.onend = () => { setMicListening(false); if (callActiveRef.current) { try { recognition.start(); } catch { endCall(); } } };
    recognitionRef.current = recognition;
    try { recognition.start(); } catch { setMessage('Não foi possível iniciar o microfone.'); return; }
    callActiveRef.current = true;
    callStartRef.current = Date.now();
    setCallSeconds(0);
    setChat(false);
    setCall(true);
  };
  // Frente 2: particiona actions em imediatas (executar agora) e timed
  // (disparar durante a fala via delayMs ou trigger 'start'/'middle'/'end').
  const partitionByTiming = (actions) => {
    const immediate = [];
    const timed = [];
    for (const action of actions ?? []) {
      if (action?.trigger || action?.delayMs) timed.push(action);
      else immediate.push(action);
    }
    return [immediate, timed];
  };

  const submitMessage = async (content, { spoken = false } = {}) => {
    const value = String(content || '').trim();
    if (!value || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    addTurn('user', value, spoken ? 'voice' : 'text');
    // Frente 3: classifica a frase do usuário em AUs FACS e aplica ao
    // expression-driver do Shiro enquanto o LLM processa (paralelo).
    const facs = classifyFacs(value);
    if (facs.aus.length > 0 && expressionDriverRef.current) {
      applyFacsToDriver(facs.aus, facs.intensity, expressionDriverRef.current, { ttlMs: 4000 });
    } else {
      expressionDriverRef.current?.set('19-prefab_doubt', 0.40, { ttlMs: 3500 });
    }
    // Reação de escuta ativa / reflexão imediata (Neuro-sama style)
    vrmGestures.current?.gesture('tilt');
    awardXP(gainsFor(value, spoken));
    setMessage('Usami está pensando…');
    try {
      const manifest = report?.manifest ? { ...report.manifest, customIdle: report.customIdle !== false, customWave: report.customWave !== false, customTilt: report.customTilt !== false } : null;
      const response = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: value, capabilities: manifest ? summarizeCapabilities(manifest) : undefined }) });
      let data = null;
      try { data = await response.json(); } catch { throw new Error('Resposta inválida do servidor.'); }
      if (!response.ok) throw new Error(data?.error || 'Falha na conversa.');
      if (typeof data?.reply !== 'string' || !data.reply.trim()) throw new Error('Resposta inválida do servidor.');
      // Etapa 3: emoção confiável no texto aplica o engine e remove o set_expression
      // do LLM (evita blend duplo); sem confiança, as actions seguem intactas.
      const resolved = resolveReplyEmotion({ reply: data.reply, actions: data.actions, engine: emotionEngine.current });
      // Etapa 4: emoção aplicada também vira pose de corpo (head) com TTL; sem
      // confiança, a pose vigente decai sozinha até neutral — nada a fazer aqui.
      if (resolved.applied && resolved.emotion) vrmGestures.current?.setEmotion(resolved.emotion.label, resolved.emotion.intensity, 4500);
      const [immediateActions, timedActions] = partitionByTiming(resolved.actions);
      const results = director.current?.execute(immediateActions)?.results || [];
      // A expressão do turno nasce com prazo proporcional à resposta inteira: a
      // síntese do primeiro balão pode levar mais que o TTL padrão, e o rosto
      // não pode sumir antes de a fala começar. Cada balão renova no seu início.
      if (!voiceOffRef.current) holdFace(data.reply);
      if (results.some(result => result.applied)) poke();
      const gestureRequested = results.some(result => result.type === 'gesture');
      const gestureApplied = results.some(result => result.type === 'gesture' && result.applied);
      // Respostas longas viram vários balões (~60 chars, máx 5, sem perder
      // texto) com tags de emoção e SFX fatiados pelo parser do OpenAmika V2.
      let effectiveReply = data.reply;
      if (data.surface?.mode === 'say+think' && data.surface?.reply) {
        const blurt = String(data.surface.reply).trim();
        if (blurt && !effectiveReply.toLowerCase().includes(blurt.toLowerCase())) {
          const toneTag = data.surface.tone ? `[${data.surface.tone}]` : '';
          effectiveReply = `${toneTag} ${blurt}. ${effectiveReply}`.trim();
        }
      }

      const parsedBalloons = parseReplyBalloons(effectiveReply);
      const balloons = parsedBalloons.length
        ? parsedBalloons
        : [{ display: String(effectiveReply).trim(), ttsText: String(effectiveReply).trim(), emotionKey: null, speechTags: [] }];
      // Se houver speechTags vindas no payload do servidor (legado), anexa ao último balão
      const speechTags = Array.isArray(data.speechTags) ? data.speechTags : [];
      if (speechTags.length > 0) {
        const last = balloons[balloons.length - 1];
        last.ttsText = `${last.ttsText} ${speechTags.map(t => `<${t}>`).join(' ')}`;
      }
      const fullCleanText = balloons.map(b => b.display).join(' ');
      if (spoken) {
        // Call mode: speechSynthesis não passa pelo Web Audio (não existe
        // HTMLAudioElement) nem pela fila de partes — timing via
        // utterance.onend / setTimeout e balões exibidos de uma vez. Tags de
        // som não se aplicam aqui; a fala sintetizada é só o texto exibido.
        speakSpoken(fullCleanText, timedActions);
        balloons.forEach(part => addTurn('assistant', part.display, 'voice'));
      } else {
        // Cada balão é exibido por speakReply no instante em que a fala dele
        // toca: mensagem → áudio → mensagem → áudio, um atrás do outro.
        const defaultStyle = resolved.emotion?.label || styleIdForActions(resolved.actions);
        speakReply(balloons, defaultStyle, timedActions, part => addTurn('assistant', stripSpeechTags(part), 'text'));
      }
      setMessage(fullCleanText + (gestureRequested && !gestureApplied ? ' (Gesto indisponível neste modelo.)' : ''));
    } catch (error) { setMessage(error.message || 'Não foi possível conversar.'); }
    finally {
      busyRef.current = false;
      setBusy(false);
      // Limpa mesmo quando a resposta falha: o texto enviado não fica preso no
      // composer esperando um novo clique. No modo voz o campo é outro fluxo.
      if (!spoken) setText('');
    }
  };
  useEffect(() => { submitRef.current = submitMessage; });

  // Frente n8n: consome comandos vindos do n8n e aplica no avatar localmente.
  // O servidor não acessa o DOM do navegador, então a fila de comandos é o
  // ponto de integração (n8n POST /api/n8n/command → cliente GET consome).
  useEffect(() => {
    let timer;
    const poll = async () => {
      try {
        const response = await fetch('/api/n8n/commands');
        if (!response.ok) return;
        const data = await response.json();
        const commands = data?.commands ?? [];
        for (const cmd of commands ?? []) {
          const ctrl = controller.current;
          if (!ctrl) continue;
          try {
            if (cmd.type === 'say') {
              submitRef.current?.(cmd.message);
            } else if (cmd.type === 'proactive_say') {
              const effectiveReply = String(cmd.message || '').trim();
              if (effectiveReply && !busyRef.current) {
                if (cmd.gesture && ctrl?.gesture) ctrl.gesture(cmd.gesture);
                let immediateActions = [];
                let timedActions = [];
                if (Array.isArray(cmd.actions) && cmd.actions.length > 0) {
                  [immediateActions, timedActions] = partitionByTiming(cmd.actions);
                  director.current?.execute(immediateActions);
                }
                const parsedBalloons = parseReplyBalloons(effectiveReply);
                const balloons = parsedBalloons.length
                  ? parsedBalloons
                  : [{ display: effectiveReply, ttsText: effectiveReply, emotionKey: null, speechTags: [] }];
                const fullCleanText = balloons.map(b => b.display).join(' ');
                const defaultStyle = cmd.emotion || (balloons[0]?.emotionKey ? getVrmEmotionConfig(balloons[0].emotionKey)?.styleId : 'casual');
                holdFace(effectiveReply);
                speakReply(balloons, defaultStyle, timedActions, part => addTurn('assistant', stripSpeechTags(part), 'text'));
                setMessage(fullCleanText);
              }
            } else if (cmd.type === 'gesture') {
              ctrl.gesture(cmd.name);
            } else if (cmd.type === 'set_expression') {
              ctrl.setExpression(cmd.name, cmd.weight ?? 1);
            } else if (cmd.type === 'set_morph') {
              ctrl.setMorph(cmd.name, cmd.value ?? 0);
            } else if (cmd.type === 'set_mesh_visible') {
              ctrl.setMeshVisible(cmd.name, cmd.visible ?? true);
            } else if (cmd.type === 'play_sequence') {
              ctrl.playSequence(cmd);
            }
          } catch {
            // Falha ao aplicar um comando não interrompe os seguintes.
          }
        }
      } catch {
        // n8n offline: ignora e tenta de novo no próximo ciclo.
      }
    };
    poll();
    timer = setInterval(poll, 2000);
    return () => clearInterval(timer);
  }, [controller]);

  const sendMessage = event => { event.preventDefault(); submitMessage(text); };
  const meshList = report?.meshList || [];
  const topLevel = Math.max(...METER_KEYS.map(key => levelFor(intimacy[key] || 0)));
  const defaultVisible = mesh => sourceType === 'fbx' ? true : mesh.skinned;
  const isMeshVisible = mesh => meshPrefs[mesh.name] ?? defaultVisible(mesh);
  const toggleMesh = mesh => {
    const next = !isMeshVisible(mesh);
    setMeshPrefs(old => {
      const updated = { ...old, [mesh.name]: next };
      saveMeshPrefs(sourceName, updated);
      return updated;
    });
    controller.current?.setMeshVisible(mesh.name, next);
  };
  const resetMeshes = () => {
    clearMeshPrefs(sourceName);
    setMeshPrefs({});
    controller.current?.applyDefaultVisibility();
  };
  return <main className={'stage ' + (call ? 'voice-mode' : 'text-mode') + (quiet ? ' companion' : '') + (chat ? ' history-open' : '')}>
    <div className="backdrop" />
    {sourceType === 'live2d'
      ? <Live2DAvatar controller={controller} onReport={reportModel} />
      : <Avatar source={source} sourceType={sourceType} sourceName={sourceName} onReport={reportModel} controller={controller} auto={auto} blinkMode={blinkMode} blinkName={blinkName} lastIdleActive={lastIdleActive} audioLipSync={audioLipSync} ttsAudio={ttsAudio} emotionEngine={emotionEngine} vrmGestures={vrmGestures} expressionDriverRef={expressionDriverRef} />}
    <header><div className="header-actions"><button className="icon" onClick={() => setChat(open => !open)} aria-label={chat ? 'Ocultar conversa' : 'Mostrar conversa'} aria-expanded={chat}><MessagesSquare size={19}/></button><button className="icon" onClick={() => setPanel(true)} aria-label="Configurações e modelo"><Settings size={19}/></button></div><span className={'status' + (call ? ' calling' : '')}><i />{call ? (busy ? 'Usami está pensando' : `sua vez · ${formatCallTime(callSeconds)}`) : busy ? 'pensando' : quiet ? 'modo companion' : 'com você'}</span><div className="corner"><div className="bond"><button className="bond-pill" onClick={() => setBondOpen(open => !open)} aria-expanded={bondOpen} aria-label="Medidores de intimidade">♥ Nível {topLevel}</button>{bondOpen && <div className="bond-bars"><BondMeters intimacy={intimacy}/></div>}</div><span className="credit">白ー (shiro) — Model by Sweet_nya555</span></div></header>
    {chat && <section className="chat-history" aria-label="Histórico da conversa">
      <div className="chat-history-head"><span><MessagesSquare size={14}/> conversa</span><div className="chat-history-actions"><button onClick={exportChat} disabled={!conversation.length} aria-label="Exportar histórico" title="Exportar histórico"><Download size={14}/></button><button onClick={clearChat} disabled={!conversation.length} aria-label="Limpar histórico" title="Limpar histórico"><Trash2 size={15}/></button><button onClick={() => setChat(false)} aria-label="Ocultar histórico"><X size={15}/></button></div></div>
      <div className="chat-scroll">
        {conversation.length ? conversation.map(turn => <div className={'chat-turn ' + turn.role} key={turn.id}><span>{turn.role === 'assistant' ? 'Usami' : 'Você'}{turn.mode === 'voice' ? ' · voz' : ''}</span><p>{turn.content}</p></div>) : <div className="chat-empty"><p>Comece do seu jeito.</p><span>Escreva abaixo ou inicie uma chamada com a Usami.</span></div>}
        {busy && <div className="chat-typing" aria-label="Usami está digitando"><i/><i/><i/></div>}
      </div>
    </section>}
    {call && <VoiceBeacon phase={voicePhase} getLevel={getVoiceLevel} />}
    <div className="controls">
      {call && message && <p className="voice-caption" role="status">{message}</p>}
      <div className="privacy-note">Mensagens usam os provedores configurados para responder.</div>
      <form className="composer" onSubmit={sendMessage}>
        <button className="composer-tool" type="button" disabled title="Envio de imagem em breve" aria-label="Enviar imagem indisponível"><ImagePlus size={18}/></button>
        <input value={text} onChange={event => setText(event.target.value)} placeholder={call ? 'Escreva enquanto fala...' : 'Diga alguma coisa...'} aria-label="Mensagem" maxLength={2000} />
        {!call && <button className="composer-call" type="button" onClick={startCall} disabled={!recognitionSupported} title={!recognitionSupported ? 'Reconhecimento de voz indisponível neste navegador.' : 'Iniciar chamada de voz'} aria-label="Iniciar chamada de voz"><Phone size={18}/></button>}
        {!call && <button className="composer-call" type="button" onClick={toggleVoice} aria-label="Alternar voz" aria-pressed={voiceOff} title={voiceOff?'Voz silenciada':'Silenciar voz'}>{voiceOff?<VolumeX size={18}/>:<Volume2 size={18}/>}</button>}
        <button className="composer-send" aria-label="Enviar mensagem" type="submit" disabled={busy || !text.trim()}><Send size={18}/></button>
      </form>
      {call && <div className="dock" aria-label="Controles da chamada">
        <button className={'round live ' + voicePhase.id} disabled={!recognitionSupported} title={'Microfone: ' + voicePhase.label} aria-label={'Microfone: ' + voicePhase.label}><MicBadge phase={voicePhase}/></button>
        <button className={'round '+(chat?'selected':'')} onClick={() => setChat(!chat)} aria-label={chat?'Ocultar histórico':'Mostrar histórico'} aria-expanded={chat}><Keyboard size={19}/></button>
        <button className="round hangup" onClick={() => endCall()} aria-label="Encerrar chamada"><PhoneOff size={19}/></button>
        <button className={'round '+(voiceOff?'selected':'')} onClick={toggleVoice} aria-label="Alternar voz" aria-pressed={voiceOff} title={voiceOff?'Voz silenciada':'Silenciar voz'}>{voiceOff?<VolumeX size={19}/>:<Volume2 size={19}/>}</button>
        <button className={'round '+(quiet?'selected':'')} onClick={() => setQuiet(!quiet)} aria-label="Alternar modo companion" aria-pressed={quiet}><Moon size={19}/></button>
      </div>}
      {!call && !chat && <button className="history-toggle" onClick={() => setChat(true)}><MessagesSquare size={16}/> Mostrar conversa</button>}
    </div>
    {panel && <div className="scrim" onClick={() => setPanel(false)}>
      <aside onClick={event => event.stopPropagation()} aria-label="Configurações da Usami">
        <div className="panel-head">
          <div><span className="eyebrow">CONFIGURAÇÕES</span><h2>Usami</h2></div>
          <button className="icon" onClick={() => setPanel(false)} aria-label="Fechar"><X size={20}/></button>
        </div>
        <div className="panel-tabs" role="tablist">
          {[['chat', 'Conversa'], ['voice', 'Voz'], ['avatar', 'Avatar'], ['memory', 'Memória'], ['personality', 'Jeito'], ['about', 'Sobre']].map(([id, label]) => <button key={id} role="tab" aria-selected={settingsTab === id} className={settingsTab === id ? 'active' : ''} onClick={() => setSettingsTab(id)}>{label}</button>)}
        </div>
        <div className="panel-content" role="tabpanel">
          {settingsTab === 'chat' && <div>
            <h3>Histórico da conversa</h3>
            <p>As últimas {MAX_STORED_TURNS} mensagens ficam salvas apenas neste navegador.</p>
            <div className="rig-actions">
              <button onClick={exportChat} disabled={!conversation.length}>Exportar JSON</button>
              <button onClick={clearChat} disabled={!conversation.length}>Limpar histórico</button>
            </div>
            <h3>Intimidade</h3>
            <div className="rig-actions">
              <button onClick={() => { setIntimacy({ carinho: 0, humor: 0, companhia: 0 }); try { localStorage.removeItem(INTIMACY_KEY); } catch {} }}>Zerar medidores</button>
            </div>
            <p className="settings-hint">Zerar os medidores não apaga a conversa.</p>
          </div>}
          {settingsTab === 'voice' && <div>
            <h3>Voz oficial</h3>
            <p>Gemini 3.8 Flash TTS com a voz desenhada para a Usami. A configuração fica no servidor local, não neste navegador.</p>
            <p>O tom muda por emoção e o texto pode pedir sons curtos como <code>&lt;laugh&gt;</code>, <code>&lt;chuckle&gt;</code>, <code>&lt;sigh&gt;</code> e <code>&lt;short pause&gt;</code>. A tag vira áudio e não aparece no balão.</p>
            <p className="settings-hint">Para trocar voz ou modelo, ajuste <code>GEMINI_TTS_VOICE</code> e <code>GEMINI_TTS_MODEL</code> no <code>.env</code> e reinicie <code>npm run api</code>.</p>
            <h3>Privacidade</h3>
            <p>A chave da API permanece no servidor. O painel não pede nem guarda chaves.</p>
          </div>}
          {settingsTab === 'avatar' && <div>
            <h3>Modelo</h3>
            <p>Teste os controles reais do modelo. O arquivo permanece neste navegador.</p>
            <input ref={fileInput} type="file" accept=".glb,.vrm,.fbx" hidden onChange={loadFile}/>
            <button className="upload" onClick={() => fileInput.current?.click()}><Upload size={17}/> Escolher GLB, VRM ou FBX</button>
            <label className="rig-label">Modelo local (public/)<input placeholder="/models/exemplo.vrm" value={modelPath} onChange={event => setModelPath(event.target.value)} /></label>
            <div className="rig-actions"><button onClick={() => loadFromPath(modelPath)}>Carregar caminho</button></div>
            <p>Arquivos grandes não cabem no upload; caminhos servidos por /public. Ex.: /models/shiro.vrm</p>
            <h3>Inspeção do modelo</h3>
            {!report ? <p>Carregando modelo...</p> : report.error ? <p role="alert">{report.error}</p> : <>
              <dl>{Object.entries({ Formato: report.format, Meshes: report.meshes, Bones: report.bones, Triângulos: report.triangles, Animações: report.animations.length, 'Morph targets': report.morphs.length, Expressões: report.expressions.length }).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl>
              {report.live2d && <p>Live2D ativo: o modelo usa os parâmetros, a física e o idle criados pela riggadora. Arraste o cursor sobre ela para o olhar acompanhar.</p>}
              {report.format === 'FBX' && <p>{sourceName.toLowerCase() === 'felis.fbx' ? 'Felis: usando as texturas-base locais quando disponíveis. Os shaders e efeitos do Unity não são reproduzidos.' : 'FBX em teste: texturas externas e materiais do Unity podem não acompanhar este arquivo.'}</p>}
              {!report.live2d && <>
                <h3>Movimentos personalizados</h3>
                <p>Testes para o rig Autumn. O idle é contínuo; o aceno dura alguns segundos. Não estão ligados às respostas da IA.</p>
                <div className="rig-actions">
                  <button disabled={!report.customIdle} onClick={() => { controller.current?.idle(); poke(); }}>Iniciar idle</button>
                  <button disabled={!report.customWave} onClick={() => { controller.current?.wave(); poke(); }}>Acenar</button>
                  <button onClick={() => controller.current?.stop()}>Parar movimentos</button>
                </div>
                {(!report.customIdle || !report.customWave) && <p>Alguns ossos necessários não foram encontrados neste modelo.</p>}
                <h3>Meshes</h3>
                {meshList.length ? <>
                  {meshList.map(mesh => <label className="rig-label" key={mesh.name}>{mesh.name} {mesh.skinned ? '(rig)' : '(sem rig)'}<input type="checkbox" checked={isMeshVisible(mesh)} onChange={() => toggleMesh(mesh)} /></label>)}
                  <div className="rig-actions"><button onClick={resetMeshes}>Restaurar visibilidade padrão</button></div>
                  <p>Modelos sem esqueleto começam ocultos; desmarque para esconder acessórios ou mostre o que quiser.</p>
                </> : <p>Nenhuma mesh presente.</p>}
                <h3>Animações</h3>
                {report.animations.length ? <>
                  <label className="rig-label">Clip<select value={selectedClip} onChange={event => setSelectedClip(event.target.value)}>{report.animations.map((clip, index) => <option key={index} value={index}>{clip.name} — {clip.boneTracks ? `rig (${clip.boneTracks} canais)` : 'sem canais de ossos'}</option>)}</select></label>
                  <p>{!report.animations[Number(selectedClip)]?.boneTracks ? 'Este clip não tem canais de ossos identificados; ele pode pertencer ao cenário ou a outros objetos.' : report.animations[Number(selectedClip)].excludedTracks ? `Teste bloqueado: ${report.animations[Number(selectedClip)].excludedTracks} canais não são de ossos e a reprodução parcial pode deslocar o avatar. Este clip precisa de análise adicional.` : 'Teste dos canais de ossos. A presença de canais não garante movimento visível.'}</p>
                  <div className="rig-actions"><button disabled={!report.animations[Number(selectedClip)]?.boneTracks || report.animations[Number(selectedClip)]?.excludedTracks > 0} onClick={() => { controller.current?.play(Number(selectedClip)); poke(); }}>Reproduzir</button><button onClick={() => controller.current?.stop()}>Parar</button></div>
                </> : <p>Este modelo não contém clips.</p>}
                <h3>Ossos</h3>
                <p>Rotação local limitada; iniciar uma animação pode sobrescrever o ajuste.</p>
                <label className="rig-label">Osso<select value={boneIndex} onChange={event => { setBoneIndex(Number(event.target.value)); setAngle(0); }}>{report.boneNames.map(bone => <option key={bone.index} value={bone.index}>{bone.name} [{bone.index}]</option>)}</select></label>
                <label className="rig-label">Eixo<select value={axis} onChange={event => { setAxis(event.target.value); setAngle(0); }}><option value="x">X</option><option value="y">Y</option><option value="z">Z</option></select></label>
                <label className="rig-label">Rotação: {angle}°<input type="range" min="-45" max="45" value={angle} onChange={event => { const value = Number(event.target.value); setAngle(value); controller.current?.bone(boneIndex, axis, value); }} /></label>
                <h3>Expressões</h3>
                {(() => { const curated = curateExpressions(report.expressions || [], { limit: Infinity }).curated; return curated.length ? <div className="rig-actions">{curated.map(item => <button key={item.name} title={`${item.tag}: ${item.name}`} onClick={() => { controller.current?.setExpression?.(item.name, 1); setTimeout(() => controller.current?.setExpression?.(item.name, 0), 3000); poke(); }}>{labelExpression(item.name)}</button>)}</div> : <p>Nenhuma expressão no modelo.</p>; })()}
                <h3>Morph targets</h3>
                {report.morphs.length ? report.morphs.map(name => <label className="rig-label" key={name}>{name}: {Math.round((morphValues[name] || 0) * 100)}%<input type="range" min="0" max="1" step=".01" value={morphValues[name] || 0} onChange={event => { const value = Number(event.target.value); setMorphValues(old => ({ ...old, [name]: value })); controller.current?.morph(name, value); }} /></label>) : <p>Nenhum morph target encontrado.</p>}
                <button className="upload" onClick={() => { controller.current?.reset(); setAngle(0); setMorphValues({}); }}>Restaurar pose inicial</button>
              </>}
            </>}
          </div>}
          {settingsTab === 'memory' && <MemoryPanel />}
          {settingsTab === 'personality' && <PersonalityPanel />}
          {settingsTab === 'about' && <div>
            <h3>Usami Companion</h3>
            <p>Versão 0.1.0 — companion com avatar 3D/Live2D e voz própria.</p>
            <h3>Tecnologias</h3>
            <ul>
              <li>React 19 + Vite</li>
              <li>Three.js + @pixiv/three-vrm (VRM/GLB)</li>
              <li>Live2D Cubism 3 (opcional)</li>
              <li>OpenRouter / NVIDIA (LLM) + Gemini (TTS)</li>
              <li>Web Speech API para a chamada de voz</li>
            </ul>
            <h3>Créditos</h3>
            <ul>
              <li>Modelo 3D: <b>白ー (shiro)</b> por <a href="https://github.com/Sweet-nya555" target="_blank" rel="noopener">Sweet_nya555</a></li>
              <li>Ícones: <a href="https://lucide.dev" target="_blank" rel="noopener">Lucide</a></li>
            </ul>
            <h3>Privacidade</h3>
            <p>Texto e voz passam pela API local em <code>127.0.0.1:8787</code>, que lê as chaves do <code>.env</code>. O histórico da conversa fica no <code>localStorage</code> deste navegador.</p>
          </div>}
          <div className="panel-footer"><BondMeters intimacy={intimacy} values /><p className="disclaimer">Texto e voz usam os provedores configurados no servidor. O teste de clips reproduz apenas canais identificados nos ossos.</p></div>
        </div>
      </aside>
    </div>}
  </main>;
}
