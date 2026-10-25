import test from 'node:test';
import assert from 'node:assert/strict';
import { createVrmGestureLayer } from '../src/vrm-gesture-layer.js';

// Fake mínimo no idioma dos testes locais: rotação plana com clone() via
// Object.assign e relógio injetável, como no harness do expression-driver.
const makeRotation = (x = 0, y = 0, z = 0) => ({
  x, y, z,
  clone() { return Object.assign(makeRotation(), { x: this.x, y: this.y, z: this.z }); },
});
const makeNode = (x = 0, y = 0, z = 0) => ({ rotation: makeRotation(x, y, z) });

function makeHumanoid({ upperArm = true, lowerArm = true, hand = true, head = true } = {}) {
  const nodes = {
    rightUpperArm: upperArm ? makeNode(.05, 0, -.1) : null,
    rightLowerArm: lowerArm ? makeNode(0, .05, -.2) : null,
    rightHand: hand ? makeNode(.01, 0, .02) : null,
    head: head ? makeNode(.03, 0, .01) : null,
  };
  return { nodes, getNormalizedBoneNode: name => nodes[name] ?? null };
}

function makeClock(start = 0) {
  let t = start;
  return { now: () => t, advance: ms => { t += ms; return t; } };
}

const snapshot = node => ({ x: node.rotation.x, y: node.rotation.y, z: node.rotation.z });
const snapshotAll = humanoid => Object.fromEntries(Object.entries(humanoid.nodes).filter(([, node]) => node).map(([name, node]) => [name, snapshot(node)]));
const settle = (layer, clock, steps, stepMs) => { for (let i = 0; i < steps; i++) { clock.advance(stepMs); layer.update(); } };

test('humanoid nulo: available tudo false e nenhuma chamada quebra', () => {
  const layer = createVrmGestureLayer({ humanoid: null, now: makeClock().now });
  assert.equal(layer.available.wave, false);
  assert.equal(layer.available.tilt, false);
  assert.equal(layer.available.idle, false);
  assert.equal(layer.available.emotions, false);
  assert.equal(layer.wave(), false);
  assert.equal(layer.tilt(), false);
  assert.equal(layer.gesture('wave'), false);
  assert.equal(layer.gesture('idle'), false);
  assert.equal(layer.setEmotion('happy'), false);
  layer.update();
  layer.clear();
  assert.equal(layer.active().wave, false);
  assert.equal(layer.active().tilt, false);
});

test('humanoid completo: wave/tilt/idle/emotions disponíveis; idle é no-op', () => {
  const layer = createVrmGestureLayer({ humanoid: makeHumanoid(), now: makeClock().now });
  assert.equal(layer.available.wave, true);
  assert.equal(layer.available.tilt, true);
  assert.equal(layer.available.idle, true);
  assert.equal(layer.available.emotions, true);
  assert.equal(layer.gesture('idle'), true);
  assert.equal(layer.gesture('gesto-inexistente'), false);
});

test('sem rightLowerArm: wave indisponível, tilt/emotions intactos', () => {
  const layer = createVrmGestureLayer({ humanoid: makeHumanoid({ lowerArm: false }), now: makeClock().now });
  assert.equal(layer.available.wave, false);
  assert.equal(layer.wave(), false);
  assert.equal(layer.gesture('wave'), false);
  assert.equal(layer.available.tilt, true);
  assert.equal(layer.available.emotions, true);
  assert.equal(layer.tilt(), true);
  assert.equal(layer.setEmotion('happy', 1), true);
});

test('wave: amplitude cresce monotonicamente no ataque e volta EXATA à base', () => {
  const humanoid = makeHumanoid();
  const clock = makeClock();
  const layer = createVrmGestureLayer({ humanoid, now: clock.now });
  const expected = snapshotAll(humanoid);
  const upper = humanoid.nodes.rightUpperArm;
  const baseZ = upper.rotation.z;
  assert.equal(layer.wave(), true);
  let previous = upper.rotation.z;
  for (let step = 1; step <= 6; step++) {
    clock.advance(100);
    layer.update();
    const offset = upper.rotation.z - baseZ;
    assert.ok(upper.rotation.z < previous, `offset em direção a -1.25 cresce monotonicamente no passo ${step}`);
    assert.ok(offset > -1.25 - 1e-9 && offset <= 0, `offset dentro do envelope no passo ${step}`);
    previous = upper.rotation.z;
  }
  clock.advance(600);
  layer.update(); // t=1200: platô do envelope
  assert.ok(Math.abs(upper.rotation.z - (baseZ - 1.25)) < 1e-9, 'pico = base - 1.25');
  clock.advance(3000);
  layer.update(); // t=4200 > 3000: fim do gesto
  assert.equal(layer.active().wave, false);
  assert.equal(upper.rotation.z, baseZ, 'rightUpperArm volta exato à base');
  assert.equal(humanoid.nodes.rightLowerArm.rotation.z, expected.rightLowerArm.z, 'rightLowerArm volta exato à base');
  assert.equal(humanoid.nodes.rightHand.rotation.z, expected.rightHand.z, 'rightHand volta exato à base');
  clock.advance(100);
  layer.update();
  assert.equal(upper.rotation.z, baseZ, 'updates seguintes continuam na base, sem acumulação');
});

test('wave durante wave retorna false e não reinicia', () => {
  const humanoid = makeHumanoid();
  const clock = makeClock();
  const layer = createVrmGestureLayer({ humanoid, now: clock.now });
  const upper = humanoid.nodes.rightUpperArm;
  const baseZ = upper.rotation.z;
  assert.equal(layer.wave(), true);
  clock.advance(700);
  layer.update(); // t=700: platô
  assert.ok(Math.abs(upper.rotation.z - (baseZ - 1.25)) < 1e-9);
  assert.equal(layer.wave(), false);
  assert.equal(layer.gesture('wave'), false);
  clock.advance(100);
  layer.update(); // t=800: segue o envelope original, não voltou ao ataque
  assert.ok(Math.abs(upper.rotation.z - (baseZ - 1.25)) < 1e-9, 'não reiniciou');
  clock.advance(2200);
  layer.update(); // t=3000: fim
  assert.equal(upper.rotation.z, baseZ);
  assert.equal(layer.active().wave, false);
});

test('tilt: head.z vai a ~0.14 e volta à base após 1.2s + release', () => {
  const humanoid = makeHumanoid();
  const clock = makeClock();
  const layer = createVrmGestureLayer({ humanoid, now: clock.now });
  const head = humanoid.nodes.head;
  const baseZ = head.rotation.z;
  assert.equal(layer.tilt(), true);
  assert.equal(layer.tilt(), false, 'tilt em andamento recusa novo tilt');
  clock.advance(400);
  layer.update(); // t=400: platô (ataque de 300ms)
  assert.ok(Math.abs(head.rotation.z - (baseZ + 0.14)) < 1e-9, 'pico = base + 0.14');
  clock.advance(1000);
  layer.update(); // t=1400 > 1200: fim, base restaurada
  assert.equal(head.rotation.z, baseZ, 'head.z volta exato à base');
  assert.equal(layer.active().tilt, false);
  assert.equal(layer.tilt(), true, 'após terminar, tilt pode tocar de novo');
});

test('setEmotion(sad): alvo 0.16, expira para neutral e decai de volta ~base', () => {
  const humanoid = makeHumanoid();
  const clock = makeClock();
  const layer = createVrmGestureLayer({ humanoid, now: clock.now });
  const head = humanoid.nodes.head;
  const baseX = head.rotation.x;
  assert.equal(layer.setEmotion('sad', 1, 4500), true);
  assert.equal(layer.active().emotion.label, 'sad');
  settle(layer, clock, 60, 50); // 3000ms de rampa: converge ao alvo
  assert.ok(Math.abs(head.rotation.x - (baseX + 0.16)) < 0.005, 'head.x converge a base + 0.16');
  clock.advance(4600);
  layer.update(); // t=7600 > expiresAt: alvo vira neutral
  assert.equal(layer.active().emotion.target.x, 0, 'expirado: alvo neutral');
  assert.equal(layer.active().emotion.label, 'neutral');
  settle(layer, clock, 100, 50); // 5000ms de release
  assert.ok(Math.abs(head.rotation.x - baseX) < 0.005, 'decai de volta ~base');
});

test('setEmotion com intensidade 0.5 alvo pela metade; rótulo desconhecido cai em neutral', () => {
  const humanoid = makeHumanoid();
  const clock = makeClock();
  const layer = createVrmGestureLayer({ humanoid, now: clock.now });
  const head = humanoid.nodes.head;
  const baseX = head.rotation.x;
  const baseZ = head.rotation.z;
  assert.equal(layer.setEmotion('sad', 2, 10000), true, 'intensidade passa por clamp01');
  settle(layer, clock, 60, 50);
  assert.ok(Math.abs(head.rotation.x - (baseX + 0.16)) < 0.005, 'intensidade 2 limitada a 1');
  assert.equal(layer.setEmotion('sad', 0.5, 10000), true);
  settle(layer, clock, 60, 50);
  assert.ok(Math.abs(head.rotation.x - (baseX + 0.08)) < 0.005, 'alvo pela metade (0.08)');
  assert.ok(Math.abs(head.rotation.z - baseZ) < 0.005, 'sad não mexe no z');
  assert.equal(layer.setEmotion('euforia-inexistente', 1, 1000), true);
  assert.equal(layer.active().emotion.label, 'neutral');
  assert.equal(layer.active().emotion.target.x, 0, 'rótulo desconhecido vira pose neutral');
});

test('re-set estende o TTL preservando o current', () => {
  const humanoid = makeHumanoid();
  const clock = makeClock();
  const layer = createVrmGestureLayer({ humanoid, now: clock.now });
  layer.setEmotion('sad', 1, 1000);
  clock.advance(300);
  layer.update();
  const current = layer.active().emotion.current.x;
  const expiresBefore = layer.active().emotion.expiresAt;
  assert.ok(current > 0 && current < 0.16, 'current no meio da rampa');
  layer.setEmotion('sad', 1, 5000); // re-set
  const after = layer.active().emotion;
  assert.equal(after.current.x, current, 'current preservado no re-set');
  assert.ok(after.expiresAt > expiresBefore, 'TTL estendido');
  clock.advance(2500);
  layer.update(); // t=2800: além do TTL antigo (1000), dentro do novo
  const state = layer.active().emotion;
  assert.equal(state.target.x, 0.16, 'alvo sad vigora além do TTL antigo');
  assert.ok(state.current.x > current, 'rampa continuou de onde parou, sem reset');
});

test('emoção + wave simultâneos compõem no mesmo update sem interferência', () => {
  const humanoid = makeHumanoid();
  const clock = makeClock();
  const layer = createVrmGestureLayer({ humanoid, now: clock.now });
  const upper = humanoid.nodes.rightUpperArm;
  const head = humanoid.nodes.head;
  const upperBase = upper.rotation.z;
  const headBase = head.rotation.x;
  layer.setEmotion('sad', 1, 10000);
  assert.equal(layer.wave(), true);
  clock.advance(1200);
  layer.update();
  assert.ok(Math.abs(upper.rotation.z - (upperBase - 1.25)) < 1e-9, 'braço em pleno envelope (sustentação)');
  assert.ok(Math.abs(head.rotation.x - (headBase + 0.16)) < 0.005, 'pose avança no mesmo update');
  assert.equal(layer.active().wave, true);
  assert.equal(layer.active().emotion.label, 'sad');
});

test('clear restaura TODOS os nós à base exata e zera o estado', () => {
  const humanoid = makeHumanoid();
  const clock = makeClock();
  const layer = createVrmGestureLayer({ humanoid, now: clock.now });
  const expected = snapshotAll(humanoid);
  const head = humanoid.nodes.head;
  layer.wave();
  layer.tilt();
  layer.setEmotion('happy', 1, 10000);
  clock.advance(500);
  layer.update();
  assert.ok(layer.active().wave && layer.active().tilt, 'gestos em andamento antes do clear');
  assert.ok(Math.abs(head.rotation.x - expected.head.x) > 1e-3, 'head fora da base antes do clear');
  layer.clear();
  for (const [name, rotation] of Object.entries(expected)) {
    assert.deepEqual(snapshot(humanoid.nodes[name]), rotation, `${name} exatamente na base`);
  }
  const state = layer.active();
  assert.equal(state.wave, false);
  assert.equal(state.tilt, false);
  assert.equal(state.emotion.label, 'neutral');
  assert.equal(state.emotion.expiresAt, Number.POSITIVE_INFINITY);
  clock.advance(100);
  layer.update();
  for (const [name, rotation] of Object.entries(expected)) {
    assert.deepEqual(snapshot(humanoid.nodes[name]), rotation, `${name} continua na base após update`);
  }
});

// — Etapa 5: a camada delega os braços à biblioteca de gestos —

test('gestureNames e available expõem a biblioteca para o painel e para o director', () => {
  const layer = createVrmGestureLayer({ humanoid: makeHumanoid(), now: makeClock().now });
  assert.ok(layer.gestureNames.includes('clap'));
  assert.ok(!layer.gestureNames.includes('bow'), 'sem espinha no rig, o bow some da lista');
  assert.equal(layer.available['hand-on-hip'], true);
  assert.equal(layer.gesture('bow'), false);
  assert.equal(layer.gesture('dancinha'), false);
});

test('gesto da biblioteca assume o braço e o aceno legado espera a vez', () => {
  const humanoid = makeHumanoid();
  const clock = makeClock();
  const layer = createVrmGestureLayer({ humanoid, now: clock.now });
  const expected = snapshotAll(humanoid);
  const upper = humanoid.nodes.rightUpperArm;
  assert.equal(layer.gesture('clap'), true);
  assert.equal(layer.active().gesture, 'clap');
  assert.equal(layer.wave(), false, 'sem dois donos para o mesmo braço');
  assert.equal(layer.gesture('wave'), false);
  clock.advance(1000); // platô do clap
  layer.update();
  assert.ok(Math.abs(upper.rotation.x - (expected.rightUpperArm.x - 0.30)) < 1e-9, 'x vai ao alvo do gesto');
  assert.ok(Math.abs(upper.rotation.z - (expected.rightUpperArm.z - 0.18)) < 1e-9, 'z vai ao alvo do gesto');
  layer.stopGesture();
  clock.advance(50);
  layer.update();
  assert.equal(layer.active().gesture, null);
  assert.deepEqual(snapshot(upper), expected.rightUpperArm, 'stopGesture devolve o braço à base');
  assert.equal(layer.wave(), true, 'liberado, o legado pode tocar de novo');
});

test('head soma a pose emocional e o offset do gesto no mesmo update', () => {
  const humanoid = makeHumanoid();
  const clock = makeClock();
  const layer = createVrmGestureLayer({ humanoid, now: clock.now });
  const head = humanoid.nodes.head;
  const expected = snapshot(head);
  layer.setEmotion('sad', 1, 100000);
  assert.equal(layer.gesture('point'), true);
  settle(layer, clock, 24, 50); // 1200ms: rampa da pose convergiu, point no platô
  assert.ok(Math.abs(head.rotation.x - (expected.x + 0.16)) < 0.005, 'pose emocional em sad');
  assert.ok(Math.abs(head.rotation.y - (expected.y - 0.08)) < 1e-9, 'o y vem do gesto via headOffsets()');
  clock.advance(2000); // point acabou (2600ms)
  layer.update();
  assert.equal(head.rotation.y, expected.y, 'gesto encerrado devolve o y');
  assert.ok(Math.abs(head.rotation.x - (expected.x + 0.16)) < 0.005, 'a pose continua vigente');
});
