import test from 'node:test';
import assert from 'node:assert/strict';
import { createGestureLibrary, GESTURE_DEFS, gestureAvailability } from '../src/vrm-gesture-library.js';
import { legacyAxisTable } from '../src/vrm-bone-calibration.js';

// Fake mínimo no idioma dos testes locais: rotação plana com clone() e relógio
// injetável, como em vrm-gesture-layer.test.mjs.
const makeRotation = (x = 0, y = 0, z = 0) => ({
  x, y, z,
  clone() { return Object.assign(makeRotation(), { x: this.x, y: this.y, z: this.z }); },
});
const makeNode = (x = 0, y = 0, z = 0) => ({ rotation: makeRotation(x, y, z) });

const FULL_RIG = [
  'leftUpperArm', 'leftLowerArm', 'leftHand', 'leftShoulder',
  'rightUpperArm', 'rightLowerArm', 'rightHand', 'rightShoulder',
  'head', 'neck', 'hips', 'spine', 'chest',
];

function makeHumanoid(present = FULL_RIG, seed = 0) {
  const nodes = {};
  for (const name of present) nodes[name] = makeNode(seed + 0.01, seed + 0.02, seed + 0.03);
  return { nodes, getNormalizedBoneNode: name => nodes[name] ?? null };
}

function makeClock(start = 0) {
  let t = start;
  return { now: () => t, advance: ms => { t += ms; return t; } };
}

const offset = (node, base) => ({
  x: +(node.rotation.x - base.x).toFixed(4),
  y: +(node.rotation.y - base.y).toFixed(4),
  z: +(node.rotation.z - base.z).toFixed(4),
});

test('rig completo: todos os gestos declarados ficam disponíveis', () => {
  const library = createGestureLibrary({ humanoid: makeHumanoid(), now: makeClock().now });
  assert.deepEqual(library.names, Object.keys(GESTURE_DEFS));
  assert.equal(library.available.clap, true);
  assert.equal(library.available.bow, true);
});

test('humanoid nulo: nada disponível e nenhuma chamada quebra', () => {
  const library = createGestureLibrary({ humanoid: null, now: makeClock().now });
  assert.deepEqual(library.names, []);
  assert.equal(library.play('clap'), false);
  assert.equal(library.stop(), true);
  library.update();
  library.clear();
  assert.equal(library.active().name, null);
});

test('gesto inexistente e gesto sem osso são recusados', () => {
  const library = createGestureLibrary({ humanoid: makeHumanoid(), now: makeClock().now });
  assert.equal(library.play('dancinha'), false);
  const legsOnly = makeHumanoid(['hips', 'head']);
  const limited = createGestureLibrary({ humanoid: legsOnly, now: makeClock().now });
  assert.equal(limited.available.clap, false);
  assert.equal(limited.available.bow, false);
  assert.equal(limited.play('clap'), false);
});

test('ombros sem osso de ombro: gesto degrada em vez de quebrar', () => {
  const clock = makeClock(0);
  const humanoid = makeHumanoid(FULL_RIG.filter(name => !name.endsWith('Shoulder')));
  const library = createGestureLibrary({ humanoid, now: clock.now });
  assert.equal(library.available.shrug, true, 'ainda tem braços');
  assert.equal(library.play('shrug'), true);
  clock.advance(GESTURE_DEFS.shrug.durationMs / 2);
  library.update();
  assert.equal(humanoid.nodes.leftShoulder, undefined);
  const base = { x: 0.01, y: 0.02, z: 0.03 };
  assert.ok(Math.abs(offset(humanoid.nodes.leftUpperArm, base).z + 0.22) < 1e-4, 'braço sobe mesmo sem o osso de ombro');
  assert.ok(Math.abs(library.headOffsets().x + 0.06) < 1e-4, 'head vira offset para a camada');
  assert.deepEqual(offset(humanoid.nodes.head, base), { x: 0, y: 0, z: 0 }, 'a biblioteca não escreve em head');
});

test('envelope: ataque sobe, platô segura e release devolve à base', () => {
  const clock = makeClock(0);
  const humanoid = makeHumanoid();
  const library = createGestureLibrary({ humanoid, now: clock.now });
  const base = humanoid.nodes.rightUpperArm.rotation.clone();
  const def = GESTURE_DEFS.point;

  library.play('point');
  clock.advance(def.durationMs / 2);
  library.update();
  const held = offset(humanoid.nodes.rightUpperArm, base).z;
  assert.ok(held < 0, 'braço levanta no platô');

  clock.advance(def.durationMs);
  library.update();
  assert.equal(library.active().name, null, 'gesto one-shot termina sozinho');
  assert.deepEqual(offset(humanoid.nodes.rightUpperArm, base), { x: 0, y: 0, z: 0 });
});

test('hold: a pose fica até stop(), que devolve todos os ossos à base', () => {
  const clock = makeClock(0);
  const humanoid = makeHumanoid();
  const library = createGestureLibrary({ humanoid, now: clock.now });
  const bases = Object.fromEntries(Object.entries(humanoid.nodes).map(([name, node]) => [name, node.rotation.clone()]));

  library.play('arms-crossed');
  clock.advance(10_000);
  library.update();
  assert.ok(offset(humanoid.nodes.leftLowerArm, bases.leftLowerArm).z !== 0, 'pose mantida');
  assert.equal(library.active().name, 'arms-crossed');

  library.stop();
  library.update();
  for (const name of Object.keys(GESTURE_DEFS['arms-crossed'].bones)) {
    if (!humanoid.nodes[name]) continue;
    assert.deepEqual(offset(humanoid.nodes[name], bases[name]), { x: 0, y: 0, z: 0 }, name);
  }
  assert.equal(library.active().name, null);
});

test('troca de gesto: ossos do gesto anterior voltam à base, os do novo mandam', () => {
  const clock = makeClock(0);
  const humanoid = makeHumanoid();
  const library = createGestureLibrary({ humanoid, now: clock.now });
  const base = { leftUpperArm: humanoid.nodes.leftUpperArm.rotation.clone(), rightUpperArm: humanoid.nodes.rightUpperArm.rotation.clone() };

  library.play('cheer');
  clock.advance(600);
  library.update();
  assert.ok(offset(humanoid.nodes.leftUpperArm, base.leftUpperArm).z !== 0);

  library.play('hand-on-hip');
  clock.advance(600);
  library.update();
  assert.deepEqual(offset(humanoid.nodes.leftUpperArm, base.leftUpperArm), { x: 0, y: 0, z: 0 }, 'esquerda liberada');
  assert.ok(offset(humanoid.nodes.rightUpperArm, base.rightUpperArm).z < 0, 'direita na cintura');
});

test('palmas: as duas mãos oscilam em direções opostas durante o gesto', () => {
  const clock = makeClock(0);
  const humanoid = makeHumanoid();
  const library = createGestureLibrary({ humanoid, now: clock.now });
  const bases = { leftHand: humanoid.nodes.leftHand.rotation.clone(), rightHand: humanoid.nodes.rightHand.rotation.clone() };
  const samples = [];

  library.play('clap');
  for (let i = 0; i < 12; i++) {
    clock.advance(90);
    library.update();
    samples.push({
      l: offset(humanoid.nodes.leftHand, bases.leftHand).z,
      r: offset(humanoid.nodes.rightHand, bases.rightHand).z,
    });
  }
  const signs = new Set(samples.map(s => Math.sign(s.l)));
  assert.ok(signs.size > 1, 'a mão esquerda inverte o sentido (palmas)');
  for (const s of samples) assert.ok(Math.sign(s.l) !== Math.sign(s.r) || (s.l === 0 && s.r === 0), 'mãos alternadas');
});

test('head é da camada de gestos: a biblioteca só expõe os offsets', () => {
  const clock = makeClock(0);
  const humanoid = makeHumanoid();
  const library = createGestureLibrary({ humanoid, now: clock.now });
  const headBase = humanoid.nodes.head.rotation.clone();

  library.play('bow');
  clock.advance(1000);
  library.update();
  assert.deepEqual(offset(humanoid.nodes.head, headBase), { x: 0, y: 0, z: 0 }, 'não escreve em head');
  assert.ok(library.headOffsets().x > 0, 'reporta o offset que a camada deve somar');

  clock.advance(5000);
  library.update();
  assert.equal(library.headOffsets().x, 0, 'terminou, offset zero');
});

test('update() sem gesto ativo não toca em nenhum osso', () => {
  const clock = makeClock(0);
  const humanoid = makeHumanoid();
  const library = createGestureLibrary({ humanoid, now: clock.now });
  const bases = Object.fromEntries(Object.entries(humanoid.nodes).map(([name, node]) => [name, node.rotation.clone()]));
  clock.advance(3000);
  library.update();
  for (const name of Object.keys(humanoid.nodes)) assert.deepEqual(offset(humanoid.nodes[name], bases[name]), { x: 0, y: 0, z: 0 });
});

test('clear() devolve todos os ossos à base, mesmo com gesto em curso', () => {
  const clock = makeClock(0);
  const humanoid = makeHumanoid();
  const library = createGestureLibrary({ humanoid, now: clock.now });
  const bases = Object.fromEntries(Object.entries(humanoid.nodes).map(([name, node]) => [name, node.rotation.clone()]));

  library.play('clap');
  clock.advance(800);
  library.update();
  library.clear();
  for (const [name, node] of Object.entries(humanoid.nodes)) assert.deepEqual(offset(node, bases[name]), { x: 0, y: 0, z: 0 }, name);
  assert.equal(library.active().name, null);
});

test('bow: move spine.x e neck.x, nunca chest (o eixo da respiração)', () => {
  const clock = makeClock(0);
  const humanoid = makeHumanoid();
  const library = createGestureLibrary({ humanoid, now: clock.now });
  // O sway escreve chest.x em toda moldura; se o bow também escrevesse, a
  // respiração pararia durante a reverência.
  humanoid.nodes.chest.rotation.x = 0.42;
  humanoid.nodes.spine.rotation.z = -0.11;
  humanoid.nodes.neck.rotation.z = 0.09;

  library.play('bow');
  clock.advance(GESTURE_DEFS.bow.durationMs / 2);
  library.update();
  assert.equal(humanoid.nodes.chest.rotation.x, 0.42, 'chest intacto');
  assert.equal(humanoid.nodes.spine.rotation.z, -0.11, 'spine.z é do sway');
  assert.equal(humanoid.nodes.neck.rotation.z, 0.09, 'neck.z é do sway');
  assert.ok(humanoid.nodes.spine.rotation.x > 0.4, 'spine.x inclina');
  assert.ok(humanoid.nodes.neck.rotation.x > 0, 'neck.x inclina');
});

test('axisTable calibrada: o mesmo gesto resolve sinais por modelo (rig espelhado)', () => {
  const clock = makeClock(0);
  const humanoid = makeHumanoid();
  // como calibrateArmAxes faria no shiro: lado R com raise em z POSITIVO
  const axisTable = {
    ...legacyAxisTable(),
    rightUpperArm: { raise: { axis: 'z', sign: 1 }, fwd: { axis: 'x', sign: -1 } },
    rightLowerArm: { flex: { axis: 'z', sign: 1 }, fwd: { axis: 'x', sign: -1 } },
  };
  const library = createGestureLibrary({ humanoid, now: clock.now, axisTable });
  const baseR = humanoid.nodes.rightUpperArm.rotation.clone();
  const baseL = humanoid.nodes.leftUpperArm.rotation.clone();

  library.play('wave2');
  clock.advance(GESTURE_DEFS.wave2.durationMs / 2);
  library.update();
  assert.ok(offset(humanoid.nodes.rightUpperArm, baseR).z > 0, 'R sobe com sinal +1 da tabela');
  assert.ok(offset(humanoid.nodes.leftUpperArm, baseL).z < 0, 'L sobe pela convenção legada');

  library.stop();
  assert.deepEqual(offset(humanoid.nodes.rightUpperArm, baseR), { x: 0, y: 0, z: 0 }, 'release usa os eixos resolvidos');
});

test('semântica desconhecida para o osso é ignorada, não chutada', () => {
  const clock = makeClock(0);
  const humanoid = makeHumanoid();
  const library = createGestureLibrary({ humanoid, now: clock.now, axisTable: {} });
  const base = humanoid.nodes.rightUpperArm.rotation.clone();
  library.play('point');
  clock.advance(GESTURE_DEFS.point.durationMs / 2);
  library.update();
  assert.deepEqual(offset(humanoid.nodes.rightUpperArm, base), { x: 0, y: 0, z: 0 }, 'nada é escrito sem tabela');
});

test('gestureAvailability: bow depende da espinha, não dos braços', () => {
  assert.equal(gestureAvailability(makeHumanoid(FULL_RIG.filter(name => !name.includes('Arm') && !name.includes('Hand') && !name.includes('Shoulder')))).bow, true);
  assert.equal(gestureAvailability(makeHumanoid(FULL_RIG.filter(name => !name.includes('Arm') && !name.includes('Hand') && !name.includes('Shoulder')))).clap, false);
});
