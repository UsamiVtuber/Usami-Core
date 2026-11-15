import { useCallback, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { apiFetch } from './api-client.js';

/**
 * Superfície de captura para transmissão (S18).
 *
 * - Fundo transparente (OBS browser source com "transparent background").
 * - Avatar VRM + legenda (última mensagem do chat ao vivo).
 * - Sem controles, sem painéis, sem token no bundle.
 * - Poll só-leitura em GET /api/live/messages (borda D2 aplicada pelo servidor).
 */
export default function LivePage() {
  const canvasRef = useRef(null);
  const [caption, setCaption] = useState(null); // { user, text, ts }
  const [status, setStatus] = useState('sem sessão');

  // Legenda: poll leve apenas leitura das mensagens já sanitizadas pelo store.
  const poll = useCallback(async () => {
    try {
      const res = await apiFetch('/api/live/messages?limit=1');
      if (!res.ok) return;
      const data = await res.json();
      const msg = (data.messages && data.messages[0]) || null;
      if (msg) {
        setStatus(msg.trusted === false ? 'ao vivo' : 'ao vivo');
        setCaption({ user: msg.user, text: msg.text, ts: msg.ts });
      } else {
        setStatus(status === 'ao vivo' ? 'ao vivo' : 'sem sessão');
      }
    } catch {
      setStatus('sem sessão');
    }
  }, [status]);

  useEffect(() => {
    poll();
    const timer = setInterval(poll, 3000);
    return () => clearInterval(timer);
  }, [poll]);

  // Avatar VRM com fundo transparente. Falha silenciosa: a legenda segue
  // visível mesmo que o modelo não carregue (captura nunca fica quebrada).
  useEffect(() => {
    const element = canvasRef.current;
    if (!element) return;
    let disposed = false;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
    camera.position.set(0, 1.4, 4.2);
    camera.lookAt(0, 1.4, 0);

    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: false });
    renderer.setClearColor(0x000000, 0); // transparente
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    const canvas = renderer.domElement;
    element.appendChild(canvas);

    const resize = () => {
      const rect = element.getBoundingClientRect() || { width: 640, height: 480 };
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      renderer.setSize(rect.width, rect.height);
      renderer.setPixelRatio(dpr);
      camera.aspect = rect.width / rect.height;
      camera.updateProjectionMatrix();
    };
    window.addEventListener('resize', resize);
    resize();

    const light = new THREE.DirectionalLight(0xffffff, 1.6);
    light.position.set(2, 5, 4);
    scene.add(light);
    scene.add(new THREE.AmbientLight(0xffffff, 0.7));

    let vrm = null;
    const loader = new GLTFLoader();
    loader.register(parser => new VRMLoaderPlugin(parser));
    loader.load(
      '/models/companion-a.vrm',
      loaded => {
        if (disposed) return;
        vrm = loaded.userData.vrm;
        if (vrm) {
          VRMUtils.rotateVRM0(vrm);
          vrm.humanoid.update?.();
          scene.add(vrm.scene);
        } else {
          scene.add(loaded.scene);
        }
      },
      undefined,
      error => {
        // Sem avatar não impede a legenda: captura continua útil.
        console.warn('[live] avatar não carregou:', error?.message || error);
      }
    );

    const lookTarget = new THREE.Vector3(0, 1.6, 3);
    let lastTime = performance.now();
    const loop = now => {
      if (disposed) return;
      requestAnimationFrame(loop);
      const delta = (now - lastTime) / 1000;
      lastTime = now;
      if (vrm) vrm.update(delta);
      // Olhar sutil fixo à frente (sem interação de mouse na captura).
      renderer.render(scene, camera);
    };
    requestAnimationFrame(loop);

    return () => {
      disposed = true;
      window.removeEventListener('resize', resize);
      if (vrm) vrm.dispose?.();
      renderer.dispose();
      scene.remove(...scene.children);
      element.removeChild(canvas);
    };
  }, []);

  return (
    <div className="live-page" style={{ width: '100%', height: '100%', position: 'relative', background: 'transparent' }}>
      <div ref={canvasRef} style={{ width: '100%', height: '100%', position: 'absolute', inset: 0, zIndex: 0 }} />
      {caption && (
        <div className="live-caption-wrap" style={{ position: 'absolute', bottom: 12, left: 0, right: 0, zIndex: 10, pointerEvents: 'none', display: 'flex', justifyContent: 'center' }}>
          <div className="live-caption" style={{ maxWidth: 'min(720px, 88vw)', padding: '10px 16px', borderRadius: 16, background: 'rgba(11, 19, 43, 0.78)', border: '1px solid rgba(249, 249, 251, 0.12)', color: '#F9F9FB', fontFamily: "'Fraunces', Georgia, serif", fontSize: '15px', lineHeight: 1.5, textAlign: 'center', textShadow: '0 1px 4px rgba(0,0,0,.5)', backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)', boxShadow: '0 10px 30px rgba(0,0,0,.45)' }}>
            <span style={{ display: 'block', fontFamily: "'DM Sans', system-ui", fontSize: '11px', letterSpacing: '.12em', textTransform: 'uppercase', color: '#FFA6C9', marginBottom: 4, opacity: 0.9 }}>{caption.user}</span>
            {caption.text}
          </div>
        </div>
      )}
      <div className="live-status" style={{ position: 'absolute', top: 10, left: 10, zIndex: 10, fontFamily: "'DM Sans', system-ui", fontSize: '11px', letterSpacing: '.12em', textTransform: 'uppercase', color: 'rgba(249, 249, 251, 0.7)', pointerEvents: 'none' }}>{status}</div>
    </div>
  );
}
