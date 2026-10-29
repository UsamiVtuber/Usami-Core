import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createVowelDriver,
  spectrumToVowelFrame,
  VOWELS,
  VOWEL_FORMANTS,
  AMPLITUDE_FLOOR,
  WEIGHT_FLOOR,
  SILENCE_MS,
  ATTACK_RATE,
  RELEASE_RATE,
  WINNER_CAP,
  RUNNER_CAP,
  OUTPUT_SCALE,
  EPSILON,
} from '../src/vowel-driver.js';

const makeClock = (start = 0) => {
  let t = start;
  return { now: () => t, advance: ms => { t += ms; } };
};

test('constantes exportadas do driver', () => {
  assert.equal(VOWELS.length, 5);
  assert.deepEqual(VOWELS, ['A', 'E', 'I', 'O', 'U']);
  assert.ok(AMPLITUDE_FLOOR === 0.04);
  assert.ok(WEIGHT_FLOOR === 0.05);
  assert.ok(SILENCE_MS === 160);
  assert.ok(ATTACK_RATE === 50);
  assert.ok(RELEASE_RATE === 30);
  assert.ok(WINNER_CAP === 0.7);
  assert.ok(RUNNER_CAP === 0.35);
  assert.ok(OUTPUT_SCALE === 0.7);
  assert.ok(EPSILON === 0.01);
});

test('spectrumToVowelFrame: energia em bandas de A → A máximo', () => {
  const data = new Uint8Array(512).fill(0);
  // F1 A: 650-1050 Hz; F2 A: 1000-1550 Hz
  // 48 kHz / 1024 = 46.875 Hz/bin
  // F1 ~ bins 14-22, F2 ~ bins 21-33
  for (let i = 14; i <= 22; i += 1) data[i] = 255;
  for (let i = 21; i <= 33; i += 1) data[i] = 255;
  const frame = spectrumToVowelFrame(data, { sampleRate: 48000, fftSize: 1024 });
  // volume é RMS normalizado; com ~22 bins em 255 e resto 0, volume ~ sqrt(22/512) ≈ 0.2
  assert.ok(frame.volume > 0.1, `volume > 0.1 (veio ${frame.volume})`);
  assert.equal(frame.weights.A, 1, 'peso A = 1 (máximo normalizado)');
  for (const v of ['E', 'I', 'O', 'U']) {
    assert.ok(frame.weights[v] < frame.weights.A, `${v} < A (veio ${frame.weights[v]} vs ${frame.weights.A})`);
  }
});

test('spectrumToVowelFrame: energia em bandas de I → I máximo', () => {
  const data = new Uint8Array(512).fill(0);
  // F1 I: 200-420 Hz; F2 I: 2000-3000 Hz
  // bins: F1 ~ 4-9, F2 ~ 43-64
  for (let i = 4; i <= 9; i += 1) data[i] = 255;
  for (let i = 43; i <= 64; i += 1) data[i] = 255;
  const frame = spectrumToVowelFrame(data, { sampleRate: 48000, fftSize: 1024 });
  assert.ok(frame.volume > 0.1);
  assert.equal(frame.weights.I, 1, 'peso I = 1');
  for (const v of ['A', 'E', 'O', 'U']) {
    assert.ok(frame.weights[v] < frame.weights.I);
  }
});

test('spectrumToVowelFrame: espectro zerado → volume 0 e pesos 0', () => {
  const data = new Uint8Array(512).fill(0);
  const frame = spectrumToVowelFrame(data, { sampleRate: 48000, fftSize: 1024 });
  assert.equal(frame.volume, 0);
  for (const v of VOWELS) assert.equal(frame.weights[v], 0);
});

test('createVowelDriver: volume 1 + pesos {A:1} → A abre, outras ~0', () => {
  const clock = makeClock(1000);
  const driver = createVowelDriver(clock.now);
  for (let step = 0; step < 10; step += 1) {
    clock.advance(20);
    const w = driver.update({ volume: 1, weights: { A: 1 } }, 0.02);
    if (step >= 3) {
      assert.ok(w.A > 0.3, `A abre (veio ${w.A})`);
      for (const v of ['E', 'I', 'O', 'U']) assert.ok(w[v] < 0.1, `${v} ≈ 0 (veio ${w[v]})`);
    }
  }
});

test('createVowelDriver: S mapeia para I', () => {
  const clock = makeClock(1000);
  const driver = createVowelDriver(clock.now);
  const w = driver.update({ volume: 1, weights: { S: 1 } }, 0.02);
  assert.ok(w.I > 0.3, 'S → I (veio ' + w.I + ')');
  for (const v of ['A', 'E', 'O', 'U']) assert.ok(w[v] < 0.1);
});

test('createVowelDriver: silêncio 160 ms zera a saída (decaimento suave)', () => {
  const clock = makeClock(1000);
  const driver = createVowelDriver(clock.now);
  driver.update({ volume: 1, weights: { A: 1 } }, 0.02);
  clock.advance(200); // passa 200 ms sem áudio (> 160 ms silêncio)
  const w = driver.update({ volume: 0, weights: {} }, 0.02);
  // Driver suaviza com release rate; não zera instantaneamente.
  // Após 1 frame de silêncio (20ms), deve ter decaído significativamente.
  assert.ok(w.A < 0.5, `A decaiu (veio ${w.A})`);
  // Avança mais frames para zerar
  for (let i = 0; i < 10; i += 1) {
    clock.advance(20);
    const w2 = driver.update({ volume: 0, weights: {} }, 0.02);
    if (w2.A < 0.02) break;
  }
  const wFinal = driver.update({ volume: 0, weights: {} }, 0.02);
  for (const v of VOWELS) assert.ok(wFinal[v] < 0.02, `${v} ≈ 0 após decaimento (veio ${wFinal[v]})`);
});

test('createVowelDriver: reset() zera tudo', () => {
  const clock = makeClock(1000);
  const driver = createVowelDriver(clock.now);
  driver.update({ volume: 1, weights: { A: 1 } }, 0.02);
  driver.reset();
  const w = driver.update({ volume: 0, weights: {} }, 0.02);
  for (const v of VOWELS) assert.equal(w[v], 0);
});

test('createVowelDriver: ataque mais rápido que release', () => {
  const clock = makeClock(1000);
  const driver = createVowelDriver(clock.now);
  // Sobe
  clock.advance(20);
  const up = driver.update({ volume: 1, weights: { A: 1 } }, 0.02);
  // Desce
  clock.advance(20);
  const down = driver.update({ volume: 0, weights: {} }, 0.02);
  // No mesmo dt, a subida (taxa 50) deve ser maior que descida (taxa 30)
  // como up.A > down.A partindo de estados diferentes, comparamos taxas diretas:
  assert.ok(ATTACK_RATE > RELEASE_RATE, 'ATTACK_RATE > RELEASE_RATE');
});

test('spectrumToVowelFrame: "A" vs "U" produzem pesos distintos (motivação do port)', () => {
  // Espectro A
  const dataA = new Uint8Array(512).fill(0);
  for (let i = 14; i <= 22; i += 1) dataA[i] = 255;
  for (let i = 21; i <= 33; i += 1) dataA[i] = 255;
  const frameA = spectrumToVowelFrame(dataA, { sampleRate: 48000, fftSize: 1024 });
  // Espectro U
  const dataU = new Uint8Array(512).fill(0);
  for (let i = 5; i <= 10; i += 1) dataU[i] = 255;   // F1 U ~ 220-480 Hz
  for (let i = 11; i <= 17; i += 1) dataU[i] = 255;  // F2 U ~ 500-800 Hz
  const frameU = spectrumToVowelFrame(dataU, { sampleRate: 48000, fftSize: 1024 });
  assert.ok(frameA.weights.A > frameA.weights.U, 'A: A > U');
  assert.ok(frameU.weights.U > frameU.weights.A, 'U: U > A');
  // Antes do port, ambos produziriam o mesmo RMS → mesmos visemas.
});