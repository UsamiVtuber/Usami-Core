import test from 'node:test';
import assert from 'node:assert/strict';
import { createVrmIdleSway } from '../src/vrm-idle-sway.js';

const EPS = 1e-9;

test('sinais ficam nas faixas breath 0..1 e sway −1..1; breath(t0) = 0.5 e sways zerados', () => {
  let t = 1000;
  const sway = createVrmIdleSway({ now: () => t });
  const first = sway.update(1000);
  assert.ok(Math.abs(first.breath - 0.5) < EPS); // sin(0) → (0+1)/2
  assert.ok(Math.abs(first.swayX) < EPS);
  assert.ok(Math.abs(first.swayZ) < EPS);
  for (let dt = 0; dt <= 40000; dt += 137) {
    const state = sway.update(t + dt);
    assert.ok(state.breath >= 0 && state.breath <= 1, `breath fora da faixa em dt=${dt}: ${state.breath}`);
    assert.ok(state.swayX >= -1 && state.swayX <= 1, `swayX fora da faixa em dt=${dt}: ${state.swayX}`);
    assert.ok(state.swayZ >= -1 && state.swayZ <= 1, `swayZ fora da faixa em dt=${dt}: ${state.swayZ}`);
  }
});

test('respiração segue senoide de período 4 s: 0.5 → 1 → 0.5 → 0 → 0.5', () => {
  const sway = createVrmIdleSway({ now: () => 2000 });
  assert.ok(Math.abs(sway.update(2000).breath - 0.5) < EPS); // sin(0)
  assert.ok(Math.abs(sway.update(3000).breath - 1) < EPS);   // sin(π/2) → pico no quarto de ciclo
  assert.ok(Math.abs(sway.update(4000).breath - 0.5) < EPS); // sin(π) → meio ciclo volta a 0.5
  assert.ok(Math.abs(sway.update(5000).breath - 0) < EPS);   // sin(3π/2) → vale
  assert.ok(Math.abs(sway.update(6000).breath - 0.5) < EPS); // sin(2π) → ciclo completo reinicia
});

test('swayX tem período ≈9090 ms: pico 1 no quarto de período e troca de sinal na meia volta', () => {
  const t0 = 500;
  const sway = createVrmIdleSway({ now: () => t0 });
  const quarter = 250 / 0.11; // ≈2272.727 ms
  const half = 500 / 0.11;    // ≈4545.454 ms
  assert.ok(Math.abs(sway.update(t0).swayX) < EPS);
  assert.ok(Math.abs(sway.update(t0 + quarter).swayX - 1) < EPS); // sin(π/2)
  assert.ok(Math.abs(sway.update(t0 + 2272).swayX - 1) < 1e-6);    // quarto arredondado da spec já está a ~4e-7 do pico
  assert.ok(Math.abs(sway.update(t0 + half).swayX) < EPS);         // sin(π)
  assert.ok(sway.update(t0 + 500).swayX > 0);
  assert.ok(sway.update(t0 + half + 500).swayX < 0);               // inverte o sinal após a meia volta
});

test('swayZ roda em 0.83·swayHz e não zera junto com swayX', () => {
  const t0 = 0;
  const sway = createVrmIdleSway({ now: () => t0 });
  const swayPeriod = 1000 / 0.11;
  const atFull = sway.update(t0 + swayPeriod);
  assert.ok(Math.abs(atFull.swayX) < EPS);                                  // swayX completou o ciclo
  assert.ok(Math.abs(atFull.swayZ - Math.sin(Math.PI * 2 * 0.83)) < EPS);   // swayZ ainda em fase distinta (≈−0.876)
  const quarterZ = 250 / (0.83 * 0.11);
  assert.ok(Math.abs(sway.update(t0 + quarterZ).swayZ - 1) < EPS);          // pico do swayZ no seu próprio quarto de período
});

test('determinismo: dois módulos com o mesmo clock produzem a mesma sequência', () => {
  let t = 7000;
  const clock = () => t;
  const a = createVrmIdleSway({ now: clock });
  const b = createVrmIdleSway({ now: clock });
  for (const dt of [0, 137, 1000, 2272, 4000, 4545, 9091, 40000]) {
    const sa = a.update(t + dt);
    assert.deepEqual(sa, b.update(t + dt));
    assert.deepEqual(sa, a.update(t + dt)); // sem acumulação: mesma t → mesmo estado
  }
  t = 8234;
  assert.deepEqual(a.update(), b.update()); // t padrão vem do clock injetado
});

test('breathAmp e swayAmp escalam os sinais sem mudar a fase', () => {
  const t0 = 3000;
  const plain = createVrmIdleSway({ now: () => t0 });
  const scaled = createVrmIdleSway({ now: () => t0, breathAmp: 0.5, swayAmp: 2 });
  for (const dt of [0, 733, 1500, 2272, 5000, 12000]) {
    const base = plain.update(t0 + dt);
    const amp = scaled.update(t0 + dt);
    assert.equal(amp.breath, 0.5 * base.breath);
    assert.equal(amp.swayX, 2 * base.swayX);
    assert.equal(amp.swayZ, 2 * base.swayZ);
  }
});

test('frequências customizadas mudam os períodos (breathHz/swayHz 0.5 → ciclo de 2 s)', () => {
  const t0 = 100;
  const sway = createVrmIdleSway({ now: () => t0, breathHz: 0.5, swayHz: 0.5 });
  assert.ok(Math.abs(sway.update(t0 + 500).breath - 1) < EPS);     // quarto do ciclo de 2 s
  assert.ok(Math.abs(sway.update(t0 + 1000).breath - 0.5) < EPS);  // meio ciclo
  assert.ok(Math.abs(sway.update(t0 + 2000).breath - 0.5) < EPS);  // ciclo completo
  assert.ok(Math.abs(sway.update(t0 + 500).swayX - 1) < EPS);      // quarto do período de swayX
  assert.ok(Math.abs(sway.update(t0 + 1000).swayX) < EPS);         // meia volta de swayX
  assert.ok(Math.abs(sway.update(t0 + 500).swayZ - Math.sin(Math.PI * 2 * 0.83 * 0.25)) < EPS); // swayZ segue 0.83·swayHz
});
