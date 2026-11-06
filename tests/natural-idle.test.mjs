import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNaturalIdle } from '../src/natural-idle.js';

test('createNaturalIdle oscila peito e ombros em harmonia na respiração', () => {
  let t = 0;
  const idle = createNaturalIdle({
    now: () => t,
    breathHz: 0.25, // ciclo de 4000ms
  });

  // t = 0: senoide em 0 -> breath = 0.5
  const f0 = idle.update(0);
  assert.ok(Math.abs(f0.chest.rotX) < 0.001);
  assert.equal(f0.shoulders.leftRotZ, 0);
  assert.equal(f0.shoulders.rightRotZ, 0);

  // t = 1000ms: pico de inspiração (1/4 de ciclo)
  const f1 = idle.update(1000);
  assert.ok(f1.chest.rotX > 0.01, 'Peito expande');
  assert.ok(f1.shoulders.leftRotZ > 0.005, 'Ombro esquerdo eleva');
  assert.ok(f1.shoulders.rightRotZ < -0.005, 'Ombro direito eleva em espelho');

  // t = 3000ms: expiração máxima (3/4 de ciclo)
  const f3 = idle.update(3000);
  assert.ok(f3.chest.rotX < -0.01, 'Peito retrai');
  assert.ok(f3.shoulders.leftRotZ < -0.005, 'Ombro esquerdo desce');
});

test('createNaturalIdle gera deslocamento suave de peso (weight-shift) nos quadris e espinha', () => {
  let t = 0;
  const idle = createNaturalIdle({
    now: () => t,
    weightShiftHz: 0.1, // ciclo de 10s (pico em 2500ms)
  });

  const f0 = idle.update(0);
  assert.equal(f0.hips.rotZ, 0);
  assert.equal(f0.hips.posX, 0);

  // No pico de 2.5s: inclinação de quadril e compensação na espinha
  const fPico = idle.update(2500);
  assert.ok(fPico.hips.rotZ > 0.01, 'Quadril inclina');
  assert.ok(fPico.hips.posX > 0.005, 'Quadril desloca no eixo X');
  assert.ok(fPico.spine.rotZ < 0, 'Espinha compensa no sentido oposto para manter cabeça estável');
});

test('createNaturalIdle aplica speech-reactive head bobbing quando speechLevel > 0', () => {
  let t = 1000;
  const idle = createNaturalIdle({ now: () => t });

  // Sem fala: cabeça estável
  const quiet = idle.update(1000, { speechLevel: 0, deltaSeconds: 0.016 });
  assert.equal(quiet.head.rotX, 0);
  assert.equal(quiet.head.rotY, 0);

  // Com fala ativa: acentuação de cabeça oscila
  let maxPitch = 0;
  for (let i = 0; i < 20; i++) {
    t += 16;
    const speaking = idle.update(t, { speechLevel: 0.8, deltaSeconds: 0.016 });
    if (Math.abs(speaking.head.rotX) > maxPitch) {
      maxPitch = Math.abs(speaking.head.rotX);
    }
  }
  assert.ok(maxPitch > 0.01, `Esperado micro-aceno de cabeça durante a fala, máximo foi ${maxPitch}`);
});

test('createNaturalIdle aplica pose reflexiva ao pensar (isThinking: true)', () => {
  const idle = createNaturalIdle();
  const thinking = idle.update(1000, { isThinking: true });
  assert.ok(thinking.head.rotZ > 0.03, 'Inclinação de cabeça ao pensar');
  assert.ok(thinking.neck.rotZ > 0.01, 'Pescoço acompanha inclinação');
});
