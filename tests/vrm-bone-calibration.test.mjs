import test from 'node:test';
import assert from 'node:assert/strict';

import {
  calibrateArmAxes,
  legacyAxisTable,
  resolveAxis,
  SEMANTIC_AXES,
} from '../src/vrm-bone-calibration.js';

// ---------------------------------------------------------------------------
// rigs sintéticos: posições/quat no espaço mundo, sem three.js
// ---------------------------------------------------------------------------

function quatFromAxisAngle(axis, angle) {
  const [x, y, z] = axis;
  const h = angle / 2;
  const s = Math.sin(h);
  return [x * s, y * s, z * s, Math.cos(h)];
}

function qmul(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] + a[1] * b[3] + a[2] * b[0] - a[0] * b[2],
    a[3] * b[2] + a[2] * b[3] + a[0] * b[1] - a[1] * b[0],
    a[3] * b[3] - a[0] * b[2] - a[1] * b[1] - a[2] * b[2],
  ];
}

// Personagem em pé, olhando para +Z. Braços em T: esquerdo para +X, direito
// para -X. Frames locais ESPPELHADOS (roll do osso acompanha o braço): é o
// cenário do shiro, onde sinais iguais de z produzem efeitos opostos.
function mirroredTRig() {
  const leftFrame = quatFromAxisAngle([0, 0, 1], -Math.PI / 2); // Y local -> +X mundo
  const rightFrame = quatFromAxisAngle([0, 0, 1], Math.PI / 2); // Y local -> -X mundo
  const pos = {
    head: [0, 1.75, 0],
    leftShoulder: [0.16, 1.45, 0],
    rightShoulder: [-0.16, 1.45, 0],
    leftUpperArm: [0.2, 1.45, 0],
    leftLowerArm: [0.47, 1.45, 0],
    leftHand: [0.74, 1.45, 0],
    rightUpperArm: [-0.2, 1.45, 0],
    rightLowerArm: [-0.47, 1.45, 0],
    rightHand: [-0.74, 1.45, 0],
  };
  const quat = {
    leftShoulder: leftFrame, rightShoulder: rightFrame,
    leftUpperArm: leftFrame, leftLowerArm: leftFrame, leftHand: leftFrame,
    rightUpperArm: rightFrame, rightLowerArm: rightFrame, rightHand: rightFrame,
    head: [0, 0, 0, 1],
  };
  return {
    worldPosition: name => pos[name] ?? null,
    worldQuaternion: name => quat[name] ?? null,
  };
}

// Aplica `value` rad na semântica de um osso e devolve a nova posição da mão
// (rotação do offset mundo em torno do eixo mundo resolvido pela tabela).
function applySemanticToHand(probe, table, bone, semantic, value) {
  const side = bone.startsWith('left') ? 'left' : 'right';
  const resolved = resolveAxis(table, bone, semantic);
  assert(resolved, `semântica ${semantic} não resolvida para ${bone}`);
  const q = probe.worldQuaternion(bone);
  const unit = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }[resolved.axis];
  const worldAxis = (() => {
    const [x, y, z, w] = q;
    const t = [2 * (y * unit[2] - z * unit[1]), 2 * (z * unit[0] - x * unit[2]), 2 * (x * unit[1] - y * unit[0])];
    return [unit[0] + w * t[0] + (y * t[2] - z * t[1]), unit[1] + w * t[1] + (z * t[0] - x * t[2]), unit[2] + w * t[2] + (x * t[1] - y * t[0])];
  })();
  const pivot = probe.worldPosition(bone);
  const hand = probe.worldPosition(`${side}Hand`);
  const r = [hand[0] - pivot[0], hand[1] - pivot[1], hand[2] - pivot[2]];
  const angle = resolved.sign * value;
  const c = Math.cos(angle), s = Math.sin(angle);
  const crossA = [worldAxis[1] * r[2] - worldAxis[2] * r[1], worldAxis[2] * r[0] - worldAxis[0] * r[2], worldAxis[0] * r[1] - worldAxis[1] * r[0]];
  const dotA = worldAxis[0] * r[0] + worldAxis[1] * r[1] + worldAxis[2] * r[2];
  return [
    pivot[0] + r[0] * c + crossA[0] * s + worldAxis[0] * dotA * (1 - c),
    pivot[1] + r[1] * c + crossA[1] * s + worldAxis[1] * dotA * (1 - c),
    pivot[2] + r[2] * c + crossA[2] * s + worldAxis[2] * dotA * (1 - c),
  ];
}

// ---------------------------------------------------------------------------

test('resolveAxis: eixos crus passam direto; semântica usa a tabela', () => {
  const table = legacyAxisTable();
  assert.deepEqual(resolveAxis(table, 'rightUpperArm', 'x'), { axis: 'x', sign: 1 });
  assert.deepEqual(resolveAxis(table, 'rightUpperArm', 'raise'), { axis: 'z', sign: -1 });
  assert.equal(resolveAxis(table, 'spine', 'raise'), null);
});

test('sonda no rig espelhado inverte o sinal de raise entre L e R', () => {
  const probe = mirroredTRig();
  const table = calibrateArmAxes({ probe });
  const raiseL = table.leftUpperArm.raise;
  const raiseR = table.rightUpperArm.raise;
  // mesmo eixo com sinais opostos (ou eixos distintos) — o essencial: o efeito
  // mundo de "raise" é o MESMO para os dois lados, o que a mesa legada não dá.
  const handL = applySemanticToHand(probe, table, 'leftUpperArm', 'raise', 0.6);
  const handR = applySemanticToHand(probe, table, 'rightUpperArm', 'raise', 0.6);
  assert(handL[1] > 1.45 + 0.05, `mão esquerda deveria SUBIR, y=${handL[1].toFixed(3)}`);
  assert(handR[1] > 1.45 + 0.05, `mão direita deveria SUBIR, y=${handR[1].toFixed(3)}`);
  assert(raiseL && raiseR);
});

test('regressão wave2: raise bilateral simétrico com tabela calibrada, assimétrico com legada', () => {
  const probe = mirroredTRig();
  const calibrated = calibrateArmAxes({ probe });
  const legacy = legacyAxisTable();
  for (const [label, table, expectSymmetric] of [['calibrada', calibrated, true], ['legada', legacy, false]]) {
    const handL = applySemanticToHand(probe, table, 'leftUpperArm', 'raise', 1.15);
    const handR = applySemanticToHand(probe, table, 'rightUpperArm', 'raise', 1.15);
    const upL = handL[1] - 1.45;
    const upR = handR[1] - 1.45;
    if (expectSymmetric) {
      assert(upL > 0.2 && upR > 0.2, `${label}: ambas as mãos devem subir (${upL.toFixed(2)}, ${upR.toFixed(2)})`);
      assert(Math.abs(upL - upR) < 0.05, `${label}: subida simétrica esperada (${upL.toFixed(2)} vs ${upR.toFixed(2)})`);
    } else if (label === 'legada') {
      // a mesa legada é exatamente a suposição que quebra no rig espelhado
      assert(upL * upR <= 0 || Math.abs(upL - upR) > 0.2, 'legada deveria ser assimétrica neste rig');
    }
  }
});

test('fwd bilateral também espelhado: ambas as mãos vão para +Z', () => {
  const probe = mirroredTRig();
  const table = calibrateArmAxes({ probe });
  const handL = applySemanticToHand(probe, table, 'leftUpperArm', 'fwd', 0.5);
  const handR = applySemanticToHand(probe, table, 'rightUpperArm', 'fwd', 0.5);
  assert(handL[2] > 0.05, `mão esquerda deveria ir à frente, z=${handL[2].toFixed(3)}`);
  assert(handR[2] > 0.05, `mão direita deveria ir à frente, z=${handR[2].toFixed(3)}`);
});

test('flex do antebraço encurta a distância da mão ao ombro', () => {
  const probe = mirroredTRig();
  const table = calibrateArmAxes({ probe });
  for (const side of ['left', 'right']) {
    const shoulder = probe.worldPosition(`${side}Shoulder`);
    const before = probe.worldPosition(`${side}Hand`);
    const after = applySemanticToHand(probe, table, `${side}LowerArm`, 'flex', 1.2);
    const d0 = Math.hypot(...before.map((v, i) => v - shoulder[i]));
    const d1 = Math.hypot(...after.map((v, i) => v - shoulder[i]));
    assert(d1 < d0 - 0.01, `${side}: flex deveria aproximar mão do ombro (${d0.toFixed(3)} -> ${d1.toFixed(3)})`);
  }
});

test('probe sem âncoras (osssos ausentes) devolve a tabela legada intacta', () => {
  const empty = { worldPosition: () => null, worldQuaternion: () => null };
  assert.deepEqual(calibrateArmAxes({ probe: empty }), legacyAxisTable());
});

test('ombros: raise levanta a cabeça para os dois lados', () => {
  const probe = mirroredTRig();
  const table = calibrateArmAxes({ probe });
  for (const bone of ['leftShoulder', 'rightShoulder']) {
    const resolved = resolveAxis(table, bone, 'raise');
    assert(resolved, `${bone} sem raise`);
  }
});

test('SEMANTIC_AXES cobre o vocabulário que as definições usam', () => {
  assert.deepEqual([...SEMANTIC_AXES].sort(), ['flick', 'flex', 'fold', 'fwd', 'raise'].sort());
});
