import { useEffect, useRef } from 'react';
import { Mic, MicOff } from 'lucide-react';
import { smoothLevel } from './voice-phase.js';

// Badge do microfone: o ícone do dock ganha cor e pulso conforme a fase.
// A fase vem de `deriveVoicePhase`; aqui só se desenha.
export function MicBadge({ phase, size = 19 }) {
  const Icon = phase.id === 'error' || phase.id === 'idle' ? MicOff : Mic;
  return <span className={'mic-badge ' + phase.id} role="status" aria-label={'Microfone: ' + phase.label} title={'Microfone: ' + phase.label}>
    <Icon size={size} />
  </span>;
}

// Beacon: orbe que respira com a voz. A fala usa o TTS oficial e passa pelo
// grafo Web Audio, então o nível vem do AnalyserNode (`getLevel`); sem áudio
// tocando (ouvindo/pensando ou TTS fora do ar) o nível é uma respiração
// sintética — o orbe nunca finge medir o que não mede.
export function VoiceBeacon({ phase, getLevel }) {
  const ref = useRef(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    let frame = 0;
    let last = performance.now();
    let level = 0;
    const tick = now => {
      const dt = (now - last) / 1000;
      last = now;
      const measured = phase.id === 'speaking' && typeof getLevel === 'function' ? getLevel() : 0;
      let target = measured;
      if (!measured) {
        const t = now / 1000;
        if (phase.id === 'speaking') target = 0.35 + 0.25 * Math.sin(t * 7);
        else if (phase.id === 'hearing') target = 0.4 + 0.2 * Math.sin(t * 9);
        else if (phase.id === 'listening') target = 0.12 + 0.08 * Math.sin(t * 2.2);
        else if (phase.id === 'thinking') target = 0.2 + 0.15 * Math.sin(t * 4);
      }
      level = smoothLevel(level, target, dt);
      node.style.setProperty('--level', level.toFixed(3));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [phase.id, getLevel]);
  return <div ref={ref} className={'voice-beacon ' + phase.hue} aria-hidden="true"><i /></div>;
}
