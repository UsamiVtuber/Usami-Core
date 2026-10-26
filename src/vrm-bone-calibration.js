// Auto-calibração semântica de eixos por modelo.
//
// O problema que este módulo resolve: a biblioteca de gestos e as shapes escrevem
// offsets em eixos EULERIANOS LOCAIS (x/z) de nós normalizados do VRM. A direção
// do mundo que um eixo local produz depende do roll de cada armature — o que era
// "z negativo = braço sobe" num rig vira "braço desce" (ou espelhado entre L e R)
// noutro. Foi assim que o shiro.vrm ficou com gestos assimétricos.
//
// A solução: o vocabulário de escrita passa a ser SEMÂNTICO (`raise`, `fwd`,
// `flex`, `fold`, `flick`) e este módulo deduz, no load, a tabela
// {osso → {semântica → (eixo local, sinal)}} medindo o modelo real. A dedução é
// 100% geométrica e sem side effects: para cada eixo local candidato, SIMULA uma
// rotação de δ e classifica o deslocamento resultante do marcador (mão/cabeça/
// ponta da mão). Nenhuma rotação do avatar é tocada durante a sondagem.
//
// Quando a classificação falha (osso ausente, eixo ambíguo), a semântica cai para
// a convenção legada — o comportamento não piora o que já existia.

export const SEMANTIC_AXES = Object.freeze(['raise', 'fwd', 'flex', 'fold', 'flick']);

// Convenção legada documentada em vrm-gesture-library.js: z negativo = sobe/dobra,
// x negativo = à frente. Simétrica entre L e R — exatamente a suposição que rigs
// espelhados violam. Serve de fallback e de default (testes, servidores sem sonda).
export function legacyAxisTable() {
  const arm = () => ({ raise: { axis: 'z', sign: -1 }, fwd: { axis: 'x', sign: -1 } });
  const forearm = () => ({ flex: { axis: 'z', sign: -1 }, fwd: { axis: 'x', sign: -1 } });
  const hand = () => ({ fold: { axis: 'x', sign: -1 }, flick: { axis: 'z', sign: -1 } });
  const shoulder = () => ({ raise: { axis: 'z', sign: -1 } });
  return {
    leftShoulder: shoulder(), rightShoulder: shoulder(),
    leftUpperArm: arm(), rightUpperArm: arm(),
    leftLowerArm: forearm(), rightLowerArm: forearm(),
    leftHand: hand(), rightHand: hand(),
  };
}

// Resolve um eixo de escrita (cru ou semântico) contra a tabela. Devolve
// { axis, sign } ou null quando a semântica não é conhecida para o osso.
export function resolveAxis(table, bone, axis) {
  if (axis === 'x' || axis === 'y' || axis === 'z') return { axis, sign: 1 };
  const entry = table?.[bone]?.[axis];
  return entry ? { axis: entry.axis, sign: entry.sign } : null;
}

// ---------------------------------------------------------------------------
// matemática vetorial mínima (arrays [x, y, z]; sem dependência de three.js)
// ---------------------------------------------------------------------------

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const len = a => Math.hypot(a[0], a[1], a[2]);
const norm = a => { const l = len(a); return l > 1e-9 ? scale(a, 1 / l) : [0, 0, 0]; };

// quat [x, y, z, w] (convenção three.js) rotacionando um vetor
function qrot(q, v) {
  const [x, y, z, w] = q;
  const t = [
    2 * (y * v[2] - z * v[1]),
    2 * (z * v[0] - x * v[2]),
    2 * (x * v[1] - y * v[0]),
  ];
  return [
    v[0] + w * t[0] + (y * t[2] - z * t[1]),
    v[1] + w * t[1] + (z * t[0] - x * t[2]),
    v[2] + w * t[2] + (x * t[1] - y * t[0]),
  ];
}

const AXIS_UNIT = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

// Rodrigues: v rotacionado de angle em torno do eixo unitário axis
function rotateAround(v, axis, angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return add(add(scale(v, c), scale(cross(axis, v), s)), scale(axis, dot(axis, v) * (1 - c)));
}

// ---------------------------------------------------------------------------
// sondagem
// ---------------------------------------------------------------------------

// probe: {
//   worldPosition(boneName) -> [x, y, z] | null,
//   worldQuaternion(boneName) -> [x, y, z, w] | null,
// }
export function calibrateArmAxes({
  probe,
  deltaRad = 0.4,
  dominance = 0.5,
  minMove = 1e-3,
}) {
  const table = legacyAxisTable();
  const wp = name => { try { return probe.worldPosition(name); } catch { return null; } };
  const wq = name => { try { return probe.worldQuaternion(name); } catch { return null; } };

  const shoulderL = wp('leftShoulder');
  const shoulderR = wp('rightShoulder');
  const head = wp('head');
  if (!shoulderL || !shoulderR || !head) return table; // sem âncoras: tudo legado

  // Frame do personagem derivado do próprio modelo:
  //   right = linha dos ombros, apontando para o lado direito do personagem
  //   up    = +Y mundo (rigs VRM ficam em pé)
  //   fwd   = up × right
  const right = norm([shoulderR[0] - shoulderL[0], 0, shoulderR[2] - shoulderL[2]]);
  if (len(right) < 1e-6) return table;
  const up = [0, 1, 0];
  const fwdDir = cross(up, right);

  // Deslocamento mundo do marcador se `bone` girar sign*δ em torno do eixo local.
  const markerDelta = (bone, pivotPos, markerPos, axisName, sign) => {
    const q = wq(bone);
    if (!q) return null;
    const worldAxis = norm(qrot(q, AXIS_UNIT[axisName]));
    if (len(worldAxis) < 1e-9) return null;
    const offset = sub(markerPos, pivotPos);
    return sub(rotateAround(offset, worldAxis, sign * deltaRad), offset);
  };

  // Entre os eixos livres do osso, escolhe o candidato com maior score, exigindo
  // que scoreFn declare o candidato válido (qualidade/dominância fica a cargo do
  // semantic-score, não deste laço).
  const pick = (bone, taken, scoreFn) => {
    let best = null;
    for (const axisName of ['x', 'y', 'z']) {
      if (taken.has(axisName)) continue;
      for (const sign of [1, -1]) {
        const score = scoreFn(bone, axisName, sign);
        if (score == null || !Number.isFinite(score) || score <= 0) continue;
        if (!best || score > best.score) best = { axis: axisName, sign, score };
      }
    }
    return best ? { axis: best.axis, sign: best.sign } : null;
  };

  // raise/fwd/flick/fold: dominância = a projeção na direção-alvo explica uma
  // fração honesta do deslocamento total (senão o eixo é torto demais). O laço
  // de cada osso abaixo aplica essa regra com um closure `score(dir)`.

  for (const side of ['left', 'right']) {
    const upper = `${side}UpperArm`;
    const lower = `${side}LowerArm`;
    const handBone = `${side}Hand`;
    const shoulderBone = `${side}Shoulder`;
    const sideShoulder = side === 'left' ? shoulderL : shoulderR;
    const upperPos = wp(upper);
    const elbow = wp(lower);
    const handPos = wp(handBone);

    // — ombro: raise move a cabeça para cima —
    {
      const taken = new Set();
      const raise = pick(shoulderBone, taken, (bone, axisName, sign) => {
        const d = markerDelta(shoulderBone, sideShoulder, head, axisName, sign);
        if (!d) return null;
        const m = len(d);
        if (m < minMove) return null;
        const p = dot(d, up);
        return Math.abs(p) >= dominance * m ? p : null;
      });
      if (raise) table[shoulderBone] = { ...table[shoulderBone], raise };
    }

    // — braço: raise sobe a mão; fwd leva a mão à frente (eixos distintos) —
    if (upperPos && handPos) {
      const taken = new Set();
      const score = (dir) => (bone, axisName, sign) => {
        const d = markerDelta(upper, upperPos, handPos, axisName, sign);
        if (!d) return null;
        const m = len(d);
        if (m < minMove) return null;
        const p = dot(d, dir);
        return Math.abs(p) >= dominance * m ? p : null;
      };
      const raise = pick(upper, taken, score(up));
      if (raise) { table[upper] = { ...table[upper], raise }; taken.add(raise.axis); }
      const fwd = pick(upper, taken, score(fwdDir));
      if (fwd) { table[upper] = { ...table[upper], fwd }; taken.add(fwd.axis); }
    }

    // — antebraço: flex = mão encurta a distância ao ombro (dobra de verdade);
    //   fwd = mão vai à frente num eixo diferente do flex —
    if (elbow && handPos && upperPos) {
      const taken = new Set();
      const dist0 = len(sub(handPos, upperPos));
      const flex = pick(lower, taken, (bone, axisName, sign) => {
        const d = markerDelta(lower, elbow, handPos, axisName, sign);
        if (!d) return null;
        const gain = dist0 - len(sub(add(handPos, d), upperPos));
        const moved = len(d);
        // num dobradiça real o ganho é modesto vs. o arco; 12% já o distingue
        return gain > minMove && gain >= 0.12 * moved ? gain : null;
      });
      if (flex) { table[lower] = { ...table[lower], flex }; taken.add(flex.axis); }
      const fwd = pick(lower, taken, (bone, axisName, sign) => {
        const d = markerDelta(lower, elbow, handPos, axisName, sign);
        if (!d) return null;
        const m = len(d);
        if (m < minMove) return null;
        const p = dot(d, fwdDir);
        return Math.abs(p) >= dominance * m ? p : null;
      });
      if (fwd) { table[lower] = { ...table[lower], fwd }; taken.add(fwd.axis); }
    }

    // — mão: marcador é a ponta (punho + 0.12 m na direção do antebraço);
    //   flick = lateral (aceno), fold = para a frente (dobrar a palma) —
    if (handPos && elbow) {
      const taken = new Set();
      const tip = add(handPos, scale(norm(sub(handPos, elbow)), 0.12));
      const score = (dir) => (bone, axisName, sign) => {
        const d = markerDelta(handBone, handPos, tip, axisName, sign);
        if (!d) return null;
        const m = len(d);
        if (m < minMove) return null;
        const p = dot(d, dir);
        return Math.abs(p) >= dominance * m ? p : null;
      };
      const flick = pick(handBone, taken, score(right));
      if (flick) { table[handBone] = { ...table[handBone], flick }; taken.add(flick.axis); }
      const fold = pick(handBone, taken, score(fwdDir));
      if (fold) { table[handBone] = { ...table[handBone], fold }; taken.add(fold.axis); }
    }
  }

  return table;
}
