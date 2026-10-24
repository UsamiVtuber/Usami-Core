import { useCallback, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { Keyboard, Mic, Phone, PhoneOff, Send, Settings, Moon, X, Upload, Volume2, VolumeX, Info, ImagePlus, MessagesSquare } from 'lucide-react';
import { inspectAnimation } from './animation-utils';
import { createCustomMotion } from './custom-motion';
import { buildCapabilityManifest, resolveMeshVisibility, summarizeCapabilities } from './capability-manifest';
import { createMotionDirector } from './motion-director';
import { createAutoMotion } from './auto-motion';
import { createExpressionDriver } from './expression-driver';
import { createEmotionEngine } from './emotion-engine';
import { resolveReplyEmotion } from './reply-emotion';
import { loadMeshPrefs, saveMeshPrefs, clearMeshPrefs } from './mesh-preferences';
import { createVrmIdleSway } from './vrm-idle-sway';
import { createVrmGestureLayer } from './vrm-gesture-layer';
import { createAudioLipSync } from './audio-lipsync';
import { curateExpressions, labelExpression } from './expressions-catalog';
import './usami.css';

// Viseme morph names exposed by the VRM avatar (capital I).
const VISEME_NAMES = ['a', 'I', 'u', 'e', 'o'];

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

function Avatar({ source, sourceType, sourceName, onReport, controller, auto, blinkMode, blinkName, lastIdleActive, audioLipSync, ttsAudio, emotionEngine, vrmGestures }) {
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
    const onPointerMove = event => {
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
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
    let mixer, vrm, customMotion, expressionDriver = null, disposed = false, gesture = null, sway = null, swayBase = null;
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
        vrm.humanoid.update?.();
      }
      if (vrm?.humanoid) {
        // Subtle idle sway (breath + lateral) driven through normalized nodes;
        // raw-bone motions (customMotion, director bone()) live in the other tree.
        sway = createVrmIdleSway();
        swayBase = ['spine', 'chest', 'neck'].map(part => {
          const node = vrm.humanoid.getNormalizedBoneNode?.(part);
          return node ? { part, node, x: node.rotation.x, z: node.rotation.z } : null;
        }).filter(Boolean);
      }
      if (vrm?.humanoid) {
        // Etapa 4: gestos procedurais (wave/tilt) + pose de corpo por emoção em
        // nós normalizados que nenhuma outra camada toca (braço direito + head).
        vrmGestures.current = createVrmGestureLayer({ humanoid: vrm.humanoid });
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
      });
      // Etapa 3: o engine de emoções só existe para VRMs com expressionManager
      // (Live2D/GLB ficam sem — o chat cai no fallback das actions do LLM).
      if (vrm?.expressionManager) emotionEngine.current = createEmotionEngine({ driver: expressionDriver });
      // Etapa 5: lip-sync dirigido pelo áudio real. O layer nasce sem elemento —
      // speakReply faz o attach do HTMLAudioElement reutilizado e o grafo Web Audio
      // (AudioContext + AnalyserNode) só é criado de forma preguiçosa, no primeiro
      // update com áudio pronto. Sem Web Audio o layer se desativa sozinho.
      audioLipSync.current = createAudioLipSync({ morphTargets: morphList.filter(m => VISEME_NAMES.includes(m.name)) });
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
        play(index) { const animation = animations[index]; if (!animation?.clip || animation.excludedTracks) return; gesture = null; customMotion.stop(); mixer.stopAllAction(); mixer.clipAction(animation.clip).reset().play(); },
        stop() { mixer.stopAllAction(); gesture = null; customMotion.stop(); },
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
      onReport({ format: sourceType === 'fbx' ? 'FBX' : vrm ? 'VRM' : 'GLB / glTF', meshes, bones, customIdle: customMotion.idleAvailable || Boolean(vrmGestures.current?.available.idle), customWave: customMotion.waveAvailable || Boolean(vrmGestures.current?.available.wave), customTilt: boneList.some(bone => bone.name === 'DEF-spine006') || Boolean(vrmGestures.current?.available.tilt), boneNames: boneList.map((bone, index) => ({ name: bone.name || 'Sem nome', index })), triangles: Math.round(triangles), morphs: [...morphs], bounds: size.toArray().map(n => n.toFixed(2)).join(' × '), animations: animations.map(({ name, boneTracks, excludedTracks }) => ({ name, boneTracks, excludedTracks })), expressions: expressionNames, blink: detectedBlink !== null, blinkName: detectedBlink, meshList: manifest.meshes, manifest });
    }, undefined, () => { if (!disposed) onReport({ error: 'Não foi possível carregar o modelo. Verifique se é um GLB, VRM ou FBX válido.' }); });
    const resize = () => {
      camera.aspect = element.clientWidth / element.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(element.clientWidth, element.clientHeight);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    resize();
    const clock = new THREE.Clock();
    let frame;
    const draw = () => {
      frame = requestAnimationFrame(draw);
      const delta = Math.min(clock.getDelta(), .1);
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
      if (sway && swayBase?.length) {
        const pose = sway.update();
        for (const base of swayBase) {
          if (base.part === 'chest') base.node.rotation.x = base.x + (pose.breath - .5) * .05;
          else if (base.part === 'spine') base.node.rotation.z = base.z + pose.swayX * .04;
          else if (base.part === 'neck') base.node.rotation.z = base.z + pose.swayZ * .03;
        }
      }
      // Etapa 4: gestos + pose emocional do humanoid, junto do sway e antes do vrm.update.
      vrmGestures.current?.update();
      // Ease the gaze toward the pointer target (frame-rate independent smoothing).
      if (lookTarget) lookTarget.position.lerp(lookDesired, 1 - Math.exp(-delta * 8));
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

export function Usami() {
  const [source, setSource] = useState('/models/shiro.vrm');
  const [sourceType, setSourceType] = useState('gltf');
  const [sourceName, setSourceName] = useState('shiro.vrm');
  const [modelPath, setModelPath] = useState('');
  const [report, setReport] = useState(null);
  const [meshPrefs, setMeshPrefs] = useState({});
  const [panel, setPanel] = useState(false);
  const [chat, setChat] = useState(true);
  const [text, setText] = useState('');
  const [message, setMessage] = useState('');
  const [conversation, setConversation] = useState([]);
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
  const [intimacy, setIntimacy] = useState(loadIntimacy);
  const [bondOpen, setBondOpen] = useState(false);
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
  const voiceOffRef = useRef(false);
  const recognitionRef = useRef(null);
  const callActiveRef = useRef(false);
  const callStartRef = useRef(0);
  const ptVoiceRef = useRef(null);
  const speakingRef = useRef(false);
  const busyRef = useRef(false);
  const submitRef = useRef(null);
  const turnId = useRef(0);
  const recognitionSupported = typeof window.SpeechRecognition === 'function' || typeof window.webkitSpeechRecognition === 'function';
  const synthesisSupported = typeof window.speechSynthesis === 'object' && typeof window.SpeechSynthesisUtterance === 'function';
  const poke = () => auto.current?.notifyActivity();
  const addTurn = (role, content, mode = 'text') => {
    const value = String(content || '').trim();
    if (!value) return;
    turnId.current += 1;
    setConversation(previous => [...previous, { id: turnId.current, role, content: value, mode }]);
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
  const speakReply = async (reply, styleId = 'neutral') => {
    // Mute: nunca pede /api/tts — a boca fica fechada (fallback mudo), o mesmo
    // comportamento do catch abaixo quando o áudio não chega.
    if (voiceOffRef.current) return;
    try {
      const response = await fetch('/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: reply, styleId }) });
      const type = response.headers.get('content-type') || '';
      if (!response.ok || !type.includes('audio/')) throw new Error('tts-status-' + response.status);
      const url = URL.createObjectURL(await response.blob());
      if (!ttsAudio.current) ttsAudio.current = new Audio();
      const audio = ttsAudio.current;
      audio.src = url;
      audio.playbackRate = quiet ? .8 : 1;
      audio.onended = () => { URL.revokeObjectURL(url); };
      await audio.play();
      // Etapa 5: a boca é dirigida pelo áudio que realmente toca — o layer se
      // anexa ao elemento reutilizado e cria o grafo Web Audio (AudioContext +
      // AnalyserNode, RMS contínuo) de forma preguiçosa no primeiro rAF com o
      // áudio pronto. Sem duração do servidor, sem timeline textual.
      audioLipSync.current?.attach(audio);
    } catch {
      // Fallback mudo (áudio indisponível): a boca apenas fica fechada.
      audioLipSync.current?.clear();
    }
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
  const speakSpoken = reply => {
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
    utterance.onstart = () => { speakingRef.current = true; };
    const releaseMic = () => { speakingRef.current = false; };
    utterance.onend = releaseMic;
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
    recognition.onresult = event => {
      if (speakingRef.current) return;
      let final = '';
      for (let index = event.resultIndex; index < event.results.length; index++) if (event.results[index].isFinal) final += event.results[index][0].transcript;
      const heard = final.trim();
      if (heard) submitRef.current?.(heard, { spoken: true });
    };
    recognition.onerror = event => {
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') endCall('Não foi possível acessar o microfone. Verifique a permissão do navegador.');
      else if (event.error === 'audio-capture') endCall('Nenhum microfone encontrado.');
      else if (event.error === 'network') endCall('Falha de rede no reconhecimento de voz.');
    };
    recognition.onend = () => { if (callActiveRef.current) { try { recognition.start(); } catch { endCall(); } } };
    recognitionRef.current = recognition;
    try { recognition.start(); } catch { setMessage('Não foi possível iniciar o microfone.'); return; }
    callActiveRef.current = true;
    callStartRef.current = Date.now();
    setCallSeconds(0);
    setChat(false);
    setCall(true);
  };
  const submitMessage = async (content, { spoken = false } = {}) => {
    const value = String(content || '').trim();
    if (!value || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    addTurn('user', value, spoken ? 'voice' : 'text');
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
      const results = director.current?.execute(resolved.actions)?.results || [];
      if (results.some(result => result.applied)) poke();
      const gestureRequested = results.some(result => result.type === 'gesture');
      const gestureApplied = results.some(result => result.type === 'gesture' && result.applied);
      if (spoken) {
        // Call mode: speechSynthesis não passa pelo Web Audio (não existe
        // HTMLAudioElement) — mantém o fallback mudo decidido na etapa 5.
        speakSpoken(data.reply);
      } else speakReply(data.reply, resolved.emotion?.label || styleIdForActions(resolved.actions));
      addTurn('assistant', data.reply, spoken ? 'voice' : 'text');
      setMessage(data.reply + (gestureRequested && !gestureApplied ? ' (Gesto indisponível neste modelo.)' : ''));
      if (!spoken) setText('');
    } catch (error) { setMessage(error.message || 'Não foi possível conversar.'); }
    finally { busyRef.current = false; setBusy(false); }
  };
  useEffect(() => { submitRef.current = submitMessage; });
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
      : <Avatar source={source} sourceType={sourceType} sourceName={sourceName} onReport={reportModel} controller={controller} auto={auto} blinkMode={blinkMode} blinkName={blinkName} lastIdleActive={lastIdleActive} audioLipSync={audioLipSync} ttsAudio={ttsAudio} emotionEngine={emotionEngine} vrmGestures={vrmGestures} />}
    <header><button className="icon" onClick={() => setPanel(true)} aria-label="Configurações e modelo"><Settings size={19}/></button><span className={'status' + (call ? ' calling' : '')}><i />{call ? (busy ? 'Usami está pensando' : `sua vez · ${formatCallTime(callSeconds)}`) : busy ? 'pensando' : quiet ? 'modo companion' : 'com você'}</span><div className="corner"><div className="bond"><button className="bond-pill" onClick={() => setBondOpen(open => !open)} aria-expanded={bondOpen} aria-label="Medidores de intimidade">♥ Nível {topLevel}</button>{bondOpen && <div className="bond-bars"><BondMeters intimacy={intimacy}/></div>}</div><span className="credit">白ー (shiro) — Model by Sweet_nya555</span></div></header>
    {chat && <section className="chat-history" aria-label="Histórico da conversa">
      <div className="chat-history-head"><span><MessagesSquare size={14}/> conversa</span><button onClick={() => setChat(false)} aria-label="Ocultar histórico"><X size={15}/></button></div>
      <div className="chat-scroll">
        {conversation.length ? conversation.map(turn => <div className={'chat-turn ' + turn.role} key={turn.id}><span>{turn.role === 'assistant' ? 'Usami' : 'Você'}{turn.mode === 'voice' ? ' · voz' : ''}</span><p>{turn.content}</p></div>) : <div className="chat-empty"><p>Comece do seu jeito.</p><span>Escreva abaixo ou inicie uma chamada com a Usami.</span></div>}
        {busy && <div className="chat-typing" aria-label="Usami está digitando"><i/><i/><i/></div>}
      </div>
    </section>}
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
        <button className="round live" disabled={!recognitionSupported} title="Microfone ativo" aria-label="Microfone ativo"><Mic size={19}/></button>
        <button className={'round '+(chat?'selected':'')} onClick={() => setChat(!chat)} aria-label={chat?'Ocultar histórico':'Mostrar histórico'} aria-expanded={chat}><Keyboard size={19}/></button>
        <button className="round hangup" onClick={() => endCall()} aria-label="Encerrar chamada"><PhoneOff size={19}/></button>
        <button className={'round '+(voiceOff?'selected':'')} onClick={toggleVoice} aria-label="Alternar voz" aria-pressed={voiceOff} title={voiceOff?'Voz silenciada':'Silenciar voz'}>{voiceOff?<VolumeX size={19}/>:<Volume2 size={19}/>}</button>
        <button className={'round '+(quiet?'selected':'')} onClick={() => setQuiet(!quiet)} aria-label="Alternar modo companion" aria-pressed={quiet}><Moon size={19}/></button>
        <button className="round" onClick={() => setPanel(true)} aria-label="Detalhes do avatar"><Info size={19}/></button>
      </div>}
      {!call && !chat && <button className="history-toggle" onClick={() => setChat(true)}><MessagesSquare size={16}/> Mostrar conversa</button>}
    </div>
    {panel && <div className="scrim" onClick={() => setPanel(false)}><aside onClick={event => event.stopPropagation()}><div className="panel-head"><div><span className="eyebrow">LABORATÓRIO</span><h2>Avatar & rig</h2></div><button className="icon" onClick={() => setPanel(false)} aria-label="Fechar"><X size={20}/></button></div><p>Teste os controles reais do modelo. O arquivo permanece neste navegador.</p><input ref={fileInput} type="file" accept=".glb,.vrm,.fbx" hidden onChange={loadFile}/><button className="upload" onClick={() => fileInput.current?.click()}><Upload size={17}/> Escolher GLB, VRM ou FBX</button><label className="rig-label">Modelo local (public/)<input placeholder="/models/exemplo.vrm" value={modelPath} onChange={e => setModelPath(e.target.value)} /></label><div className="rig-actions"><button onClick={() => loadFromPath(modelPath)}>Carregar caminho</button></div><p>Arquivos grandes não cabem no upload; caminhos servidos por /public. Ex.: /models/shiro.vrm</p><h3>Inspeção do modelo</h3>{!report ? <p>Carregando modelo...</p> : report.error ? <p role="alert">{report.error}</p> : <>
      <dl>{Object.entries({Formato:report.format,Meshes:report.meshes,Bones:report.bones,Triângulos:report.triangles,Animações:report.animations.length,'Morph targets':report.morphs.length,Expressões:report.expressions.length}).map(([key,value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl>
      {report.live2d && <p>Live2D ativo: o modelo usa os parâmetros, a física e o idle criados pela riggadora. Arraste o cursor sobre ela para o olhar acompanhar.</p>}
      {report.format === 'FBX' && <p>{sourceName.toLowerCase() === 'felis.fbx' ? 'Felis: usando as texturas-base locais quando disponíveis. Os shaders e efeitos do Unity não são reproduzidos.' : 'FBX em teste: texturas externas e materiais do Unity podem não acompanhar este arquivo.'}</p>}
      {!report.live2d && <><h3>Movimentos personalizados</h3><p>Testes para o rig Autumn. O idle é contínuo; o aceno dura alguns segundos. Não estão ligados às respostas da IA.</p><div className="rig-actions"><button disabled={!report.customIdle} onClick={() => { controller.current?.idle(); poke(); }}>Iniciar idle</button><button disabled={!report.customWave} onClick={() => { controller.current?.wave(); poke(); }}>Acenar</button><button onClick={() => controller.current?.stop()}>Parar movimentos</button></div>{(!report.customIdle || !report.customWave) && <p>Alguns ossos necessários não foram encontrados neste modelo.</p>}
      <h3>Meshes</h3>{meshList.length ? <>{meshList.map(mesh => <label className="rig-label" key={mesh.name}>{mesh.name} {mesh.skinned ? '(rig)' : '(sem rig)'}<input type="checkbox" checked={isMeshVisible(mesh)} onChange={() => toggleMesh(mesh)} /></label>)}<div className="rig-actions"><button onClick={resetMeshes}>Restaurar visibilidade padrão</button></div><p>Modelos sem esqueleto começam ocultos; desmarque para esconder acessórios ou mostre o que quiser.</p></> : <p>Nenhuma mesh presente.</p>}
      <h3>Animações</h3>{report.animations.length ? <><label className="rig-label">Clip<select value={selectedClip} onChange={e => setSelectedClip(e.target.value)}>{report.animations.map((clip,i) => <option key={i} value={i}>{clip.name} — {clip.boneTracks ? `rig (${clip.boneTracks} canais)` : 'sem canais de ossos'}</option>)}</select></label><p>{!report.animations[Number(selectedClip)]?.boneTracks ? 'Este clip não tem canais de ossos identificados; ele pode pertencer ao cenário ou a outros objetos.' : report.animations[Number(selectedClip)].excludedTracks ? `Teste bloqueado: ${report.animations[Number(selectedClip)].excludedTracks} canais não são de ossos e a reprodução parcial pode deslocar o avatar. Este clip precisa de análise adicional.` : 'Teste dos canais de ossos. A presença de canais não garante movimento visível.'}</p><div className="rig-actions"><button disabled={!report.animations[Number(selectedClip)]?.boneTracks || report.animations[Number(selectedClip)]?.excludedTracks > 0} onClick={() => { controller.current?.play(Number(selectedClip)); poke(); }}>Reproduzir</button><button onClick={() => controller.current?.stop()}>Parar</button></div></> : <p>Este modelo não contém clips.</p>}
      <h3>Ossos</h3><p>Rotação local limitada; iniciar uma animação pode sobrescrever o ajuste.</p><label className="rig-label">Osso<select value={boneIndex} onChange={e => {setBoneIndex(Number(e.target.value));setAngle(0);}}>{report.boneNames.map(b => <option key={b.index} value={b.index}>{b.name} [{b.index}]</option>)}</select></label><label className="rig-label">Eixo<select value={axis} onChange={e => {setAxis(e.target.value);setAngle(0);}}><option value="x">X</option><option value="y">Y</option><option value="z">Z</option></select></label><label className="rig-label">Rotação: {angle}°<input type="range" min="-45" max="45" value={angle} onChange={e => {const value=Number(e.target.value);setAngle(value);controller.current?.bone(boneIndex,axis,value);}} /></label>
      <h3>Expressões</h3>{(() => { const curated = curateExpressions(report.expressions || [], { limit: Infinity }).curated; return curated.length ? <div className="rig-actions">{curated.map(item => <button key={item.name} title={`${item.tag}: ${item.name}`} onClick={() => { controller.current?.setExpression?.(item.name, 1); setTimeout(() => controller.current?.setExpression?.(item.name, 0), 3000); poke(); }}>{labelExpression(item.name)}</button>)}</div> : <p>Nenhuma expressão no modelo.</p>; })()}
      <h3>Morph targets</h3>{report.morphs.length ? report.morphs.map(name => <label className="rig-label" key={name}>{name}: {Math.round((morphValues[name] || 0)*100)}%<input type="range" min="0" max="1" step=".01" value={morphValues[name] || 0} onChange={e => {const value=Number(e.target.value);setMorphValues(old => ({...old,[name]:value}));controller.current?.morph(name,value);}} /></label>) : <p>Nenhum morph target encontrado.</p>}
      <button className="upload" onClick={() => {controller.current?.reset();setAngle(0);setMorphValues({});}}>Restaurar pose inicial</button></>}
    </>}<h3>Intimidade</h3><BondMeters intimacy={intimacy} values /><p className="disclaimer">Teste inicial de texto com OpenRouter. A chamada de voz usa o reconhecimento e a síntese de voz do navegador. O teste de clips reproduz apenas canais identificados nos ossos.</p></aside></div>}
  </main>;
}
