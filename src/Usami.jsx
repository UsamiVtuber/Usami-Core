import { useCallback, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { Keyboard, Mic, Send, Settings, Moon, X, Upload, Volume2, Info } from 'lucide-react';
import { inspectAnimation } from './animation-utils';
import { createCustomMotion } from './custom-motion';
import { buildCapabilityManifest, resolveMeshVisibility, summarizeCapabilities } from './capability-manifest';
import { createMotionDirector } from './motion-director';
import { loadMeshPrefs, saveMeshPrefs, clearMeshPrefs } from './mesh-preferences';
import './usami.css';

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
        controller.current = { gesture: () => false, stop: () => false, reset: () => false };
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

function Avatar({ source, sourceType, sourceName, onReport, controller }) {
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
    element.appendChild(renderer.domElement);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x766485, 2.2));
    const light = new THREE.DirectionalLight(0xffebd8, 2);
    light.position.set(2, 4, 4);
    scene.add(light);
    let mixer, vrm, customMotion, disposed = false, gesture = null;
    const localTextures = [];
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
      let meshes = 0, bones = 0, triangles = 0;
      const morphs = new Set();
      const boneList = [];
      const morphList = [];
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
      const manifest = buildCapabilityManifest(avatar, animations, vrm?.expressionManager?.expressions?.map(e => e.expressionName) || []);
      const preferences = loadMeshPrefs(sourceName);
      const visibility = resolveMeshVisibility(manifest, sourceType === 'fbx' ? Object.fromEntries(manifest.meshes.map(mesh => [mesh.name, true])) : preferences).slice();
      manifest.meshes.forEach((mesh, index) => { const meshObject = findMesh(avatar, mesh, manifest.meshes); if (meshObject) meshObject.visible = visibility[index]; });
      const initialRotations = boneList.map(bone => bone.quaternion.clone());
      customMotion = createCustomMotion(boneList);
      controller.current = {
        gesture(name) {
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
        idle() { gesture = null; mixer.stopAllAction(); return customMotion.startIdle(); },
        wave() { gesture = null; mixer.stopAllAction(); return customMotion.wave(); },
        playClip(name) { const index = animations.findIndex(animation => animation.name === name); if (index >= 0) play(index); },
        setMorph(name, value) { morph(name, value); },
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
        reset() { mixer.stopAllAction(); gesture = null; customMotion.stop(); boneList.forEach((bone, i) => bone.quaternion.copy(initialRotations[i])); morphList.forEach(item => { item.object.morphTargetInfluences[item.index] = 0; }); }
      };
      onReport({ format: sourceType === 'fbx' ? 'FBX' : vrm ? 'VRM' : 'GLB / glTF', meshes, bones, customIdle: customMotion.idleAvailable, customWave: customMotion.waveAvailable, boneNames: boneList.map((bone, index) => ({ name: bone.name || 'Sem nome', index })), triangles: Math.round(triangles), morphs: [...morphs], bounds: size.toArray().map(n => n.toFixed(2)).join(' × '), animations: animations.map(({ name, boneTracks, excludedTracks }) => ({ name, boneTracks, excludedTracks })), expressions: vrm?.expressionManager?.expressions?.map(e => e.expressionName) || [], meshList: manifest.meshes, manifest });
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
    const draw = () => { frame = requestAnimationFrame(draw); const delta = Math.min(clock.getDelta(), .1); mixer?.update(delta); vrm?.update(delta); customMotion?.update(delta); if (gesture) { gesture.elapsed += delta; const progress = Math.min(gesture.elapsed / 2, 1); gesture.bone.quaternion.copy(gesture.base); gesture.bone.rotateZ(Math.sin(Math.PI * progress) * .12); if (progress === 1) gesture = null; } renderer.render(scene, camera); };
    draw();
    return () => {
      disposed = true;
      controller.current = null;
      cancelAnimationFrame(frame);
      observer.disconnect();
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

export function Usami() {
  const [source, setSource] = useState('/live2d/Resources/youling/youling.model3.json');
  const [sourceType, setSourceType] = useState('live2d');
  const [sourceName, setSourceName] = useState('youling.model3.json');
  const [report, setReport] = useState(null);
  const [meshPrefs, setMeshPrefs] = useState({});
  const [panel, setPanel] = useState(false);
  const [chat, setChat] = useState(false);
  const [text, setText] = useState('');
  const [message, setMessage] = useState('');
  const [quiet, setQuiet] = useState(false);
  const [boneIndex, setBoneIndex] = useState(0);
  const [axis, setAxis] = useState('x');
  const [angle, setAngle] = useState(0);
  const [morphValues, setMorphValues] = useState({});
  const [selectedClip, setSelectedClip] = useState('0');
  const [busy, setBusy] = useState(false);
  const fileInput = useRef(null);
  const controller = useRef(null);
  const director = useRef(null);
  const reportModel = useCallback(value => {
    setReport(value);
    if (value.animations) setSelectedClip(String(Math.max(0, value.animations.findIndex(clip => clip.boneTracks && !clip.excludedTracks))));
    director.current = value?.manifest ? createMotionDirector({ controller: controller.current, capabilities: { ...value.manifest, customIdle: value.customIdle !== false, customWave: value.customWave !== false } }) : null;
  }, []);
  useEffect(() => () => { if (source.startsWith('blob:')) URL.revokeObjectURL(source); }, [source]);
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
  const sendMessage = async event => {
    event.preventDefault();
    if (busy || !text.trim()) return;
    setBusy(true);
    setMessage('Usami está pensando…');
    try {
      const manifest = report?.manifest ? { ...report.manifest, customIdle: report.customIdle !== false, customWave: report.customWave !== false } : null;
      const response = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: text, capabilities: manifest ? summarizeCapabilities(manifest) : undefined }) });
      let data = null;
      try { data = await response.json(); } catch { throw new Error('Resposta inválida do servidor.'); }
      if (!response.ok) throw new Error(data?.error || 'Falha na conversa.');
      if (typeof data?.reply !== 'string' || !data.reply.trim()) throw new Error('Resposta inválida do servidor.');
      const results = director.current?.execute(data.actions)?.results || [];
      const gestureRequested = results.some(result => result.type === 'gesture');
      const gestureApplied = results.some(result => result.type === 'gesture' && result.applied);
      setMessage(data.reply + (gestureRequested && !gestureApplied ? ' (Gesto indisponível neste modelo.)' : ''));
      setText('');
    } catch (error) { setMessage(error.message || 'Não foi possível conversar.'); }
    finally { setBusy(false); }
  };
  const meshList = report?.meshList || [];
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
  return <main className="stage">
    <div className="backdrop" />
    {sourceType === 'live2d'
      ? <Live2DAvatar controller={controller} onReport={reportModel} />
      : <Avatar source={source} sourceType={sourceType} sourceName={sourceName} onReport={reportModel} controller={controller} />}
    <header><span className="brand">USAMI <small>companion</small></span><span className="status"><i />{busy ? 'pensando' : quiet ? 'modo tranquilo' : 'em repouso'}</span><button className="icon" onClick={() => setPanel(true)} aria-label="Configurações e modelo"><Settings size={19}/></button></header>
    <div className="welcome"><span>UM MOMENTO COM</span><h1>Usami</h1><p>Um lugar tranquilo para estar, conversar e descobrir.</p></div>
    <div className="controls">
      {message && <p className="notice" role="status">{message}</p>}
      {chat && <><div className="privacy-note">Ao enviar, sua mensagem será compartilhada com a OpenRouter e o provedor selecionado.</div><form className="composer" onSubmit={sendMessage}><input value={text} onChange={event => setText(event.target.value)} placeholder="Escreva uma mensagem..." aria-label="Mensagem" maxLength={2000} /><button aria-label="Enviar mensagem" type="submit" disabled={busy || !text.trim()}><Send size={18}/></button></form></>}
      <div className="dock">
        <button className="round" onClick={() => setMessage('A conversa por voz ainda não está disponível. Nenhum microfone foi ativado.')} aria-label="Microfone indisponível"><Mic size={19}/></button>
        <button className={'round '+(chat?'selected':'')} onClick={() => { setChat(!chat); setMessage(''); }} aria-label={chat?'Fechar campo de texto':'Abrir campo de texto'} aria-expanded={chat}><Keyboard size={19}/></button>
        <button className={'round '+(quiet?'selected':'')} onClick={() => setQuiet(!quiet)} aria-label="Alternar modo tranquilo" aria-pressed={quiet}><Moon size={19}/></button>
        <button className="round" onClick={() => setMessage('A reprodução de áudio ainda não está disponível.')} aria-label="Áudio indisponível"><Volume2 size={19}/></button>
        <button className="round" onClick={() => setPanel(true)} aria-label="Detalhes do avatar"><Info size={19}/></button>
      </div>
      <div className="hint">SUA COMPANHIA, NO SEU RITMO</div>
    </div>
    {panel && <div className="scrim" onClick={() => setPanel(false)}><aside onClick={event => event.stopPropagation()}><div className="panel-head"><div><span className="eyebrow">LABORATÓRIO</span><h2>Avatar & rig</h2></div><button className="icon" onClick={() => setPanel(false)} aria-label="Fechar"><X size={20}/></button></div><p>Teste os controles reais do modelo. O arquivo permanece neste navegador.</p><input ref={fileInput} type="file" accept=".glb,.vrm,.fbx" hidden onChange={loadFile}/><button className="upload" onClick={() => fileInput.current?.click()}><Upload size={17}/> Escolher GLB, VRM ou FBX</button><h3>Inspeção do modelo</h3>{!report ? <p>Carregando modelo...</p> : report.error ? <p role="alert">{report.error}</p> : <>
      <dl>{Object.entries({Formato:report.format,Meshes:report.meshes,Bones:report.bones,Triângulos:report.triangles,Animações:report.animations.length,'Morph targets':report.morphs.length,Expressões:report.expressions.length}).map(([key,value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl>
      {report.live2d && <p>Live2D ativo: o modelo usa os parâmetros, a física e o idle criados pela riggadora. Arraste o cursor sobre ela para o olhar acompanhar.</p>}
      {report.format === 'FBX' && <p>{sourceName.toLowerCase() === 'felis.fbx' ? 'Felis: usando as texturas-base locais quando disponíveis. Os shaders e efeitos do Unity não são reproduzidos.' : 'FBX em teste: texturas externas e materiais do Unity podem não acompanhar este arquivo.'}</p>}
      {!report.live2d && <><h3>Movimentos personalizados</h3><p>Testes para o rig Autumn. O idle é contínuo; o aceno dura alguns segundos. Não estão ligados às respostas da IA.</p><div className="rig-actions"><button disabled={!report.customIdle} onClick={() => controller.current?.idle()}>Iniciar idle</button><button disabled={!report.customWave} onClick={() => controller.current?.wave()}>Acenar</button><button onClick={() => controller.current?.stop()}>Parar movimentos</button></div>{(!report.customIdle || !report.customWave) && <p>Alguns ossos necessários não foram encontrados neste modelo.</p>}
      <h3>Meshes</h3>{meshList.length ? <>{meshList.map(mesh => <label className="rig-label" key={mesh.name}>{mesh.name} {mesh.skinned ? '(rig)' : '(sem rig)'}<input type="checkbox" checked={isMeshVisible(mesh)} onChange={() => toggleMesh(mesh)} /></label>)}<div className="rig-actions"><button onClick={resetMeshes}>Restaurar visibilidade padrão</button></div><p>Modelos sem esqueleto começam ocultos; desmarque para esconder acessórios ou mostre o que quiser.</p></> : <p>Nenhuma mesh presente.</p>}
      <h3>Animações</h3>{report.animations.length ? <><label className="rig-label">Clip<select value={selectedClip} onChange={e => setSelectedClip(e.target.value)}>{report.animations.map((clip,i) => <option key={i} value={i}>{clip.name} — {clip.boneTracks ? `rig (${clip.boneTracks} canais)` : 'sem canais de ossos'}</option>)}</select></label><p>{!report.animations[Number(selectedClip)]?.boneTracks ? 'Este clip não tem canais de ossos identificados; ele pode pertencer ao cenário ou a outros objetos.' : report.animations[Number(selectedClip)].excludedTracks ? `Teste bloqueado: ${report.animations[Number(selectedClip)].excludedTracks} canais não são de ossos e a reprodução parcial pode deslocar o avatar. Este clip precisa de análise adicional.` : 'Teste dos canais de ossos. A presença de canais não garante movimento visível.'}</p><div className="rig-actions"><button disabled={!report.animations[Number(selectedClip)]?.boneTracks || report.animations[Number(selectedClip)]?.excludedTracks > 0} onClick={() => controller.current?.play(Number(selectedClip))}>Reproduzir</button><button onClick={() => controller.current?.stop()}>Parar</button></div></> : <p>Este modelo não contém clips.</p>}
      <h3>Ossos</h3><p>Rotação local limitada; iniciar uma animação pode sobrescrever o ajuste.</p><label className="rig-label">Osso<select value={boneIndex} onChange={e => {setBoneIndex(Number(e.target.value));setAngle(0);}}>{report.boneNames.map(b => <option key={b.index} value={b.index}>{b.name} [{b.index}]</option>)}</select></label><label className="rig-label">Eixo<select value={axis} onChange={e => {setAxis(e.target.value);setAngle(0);}}><option value="x">X</option><option value="y">Y</option><option value="z">Z</option></select></label><label className="rig-label">Rotação: {angle}°<input type="range" min="-45" max="45" value={angle} onChange={e => {const value=Number(e.target.value);setAngle(value);controller.current?.bone(boneIndex,axis,value);}} /></label>
      <h3>Morph targets</h3>{report.morphs.length ? report.morphs.map(name => <label className="rig-label" key={name}>{name}: {Math.round((morphValues[name] || 0)*100)}%<input type="range" min="0" max="1" step=".01" value={morphValues[name] || 0} onChange={e => {const value=Number(e.target.value);setMorphValues(old => ({...old,[name]:value}));controller.current?.morph(name,value);}} /></label>) : <p>Nenhum morph target encontrado.</p>}
      <button className="upload" onClick={() => {controller.current?.reset();setAngle(0);setMorphValues({});}}>Restaurar pose inicial</button></>}
    </>}<p className="disclaimer">Teste inicial de texto com OpenRouter. Voz ainda não está integrada. O teste de clips reproduz apenas canais identificados nos ossos.</p></aside></div>}
  </main>;
}
