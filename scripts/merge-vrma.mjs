import { readFileSync, writeFileSync } from 'fs';

function readGlb(path){
  const buf = readFileSync(path);
  if (buf.slice(0,4).toString('ascii') !== 'glTF') throw new Error(path+': não é GLB binário');
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.slice(20, 20+jsonLen).toString('utf8'));
  const binLen = buf.readUInt32LE(12 + 8 + jsonLen);
  const bin = buf.slice(12 + 16 + jsonLen, 12 + 16 + jsonLen + binLen);
  return { json, bin };
}

const [vrmPath, ...vrmaPaths] = process.argv.slice(2);

const target = process.env.OUT;

const { json, bin } = readGlb(vrmPath);
if ((json.buffers?.length ?? 0) !== 1) throw new Error('esperado: VRM com buffer único');

let binOut = Buffer.from(bin);
// realinha bufferView para GLB exige byteLength %4 e offset %4
while (binOut.length % 4) binOut = Buffer.concat([binOut, Buffer.alloc(4 - binOut.length % 4)]);

// mapeia índice de nó do VRMA -> índice no VRM: nome exato, senão nome canônico humanoid do VRM
function buildHumanMap(vrmJson){
  const map = {};
  const hum = vrmJson.extensions?.VRM?.humanoid?.humanBones || [];
  const byNode = new Map(vrmJson.nodes.map((n, i) => [i, n]));
  for (const hb of hum){
    const node = byNode.get(hb.node);
    if (node?.name) map[hb.bone.toLowerCase()] = node.name;
  }
  return map;
}
json.animations ??= [];
const jointIdx = new Set((json.skins || []).flatMap(s => s.joints));
const humanMap = buildHumanMap(json);
const dropped = [];
for (const vp of vrmaPaths){
  const v = readGlb(vp);
  const anim = v.json.animations[0];
  const clipName = `vrma-${vp.split(/[\\/]/).pop().replace(/^VRMA_?/i, '').replace('.vrma', '')}`;
  // rescreve accessors (relativos ao buffer do VRMA) para views no buffer do VRM
  const newAccessors = [];
  for (const acc of Object.values(anim.samplers).map(s=>[s.input,s.output]).flat()){
    const a = v.json.accessors[acc];
    const bv = v.json.bufferViews[a.bufferView];
    const comps = { SCALAR:1, VEC2:2, VEC3:3, VEC4:4, MAT4:16 }[a.type];
    const es = { 5120:1,5121:1,5122:2,5123:2,5125:4,5126:4 }[a.componentType];
    const byteLen = comps * es * a.count;
    const abs = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
    const data = Buffer.from(v.bin.slice(abs, abs + byteLen));
    let off = binOut.length;
    binOut = Buffer.concat([binOut, data]);
    while (binOut.length % 4) binOut = Buffer.concat([binOut, Buffer.alloc(1)]);
    newAccessors.push(json.accessors.push({ componentType: a.componentType, count: a.count, type: a.type,
      min: a.min, max: a.max, bufferView: json.bufferViews.push({ buffer: 0, byteOffset: off, byteLength: data.length }) - 1 }) - 1);
  }
  const samplers = anim.samplers.map((s, i) => ({ input: newAccessors[i*2], output: newAccessors[i*2+1], interpolation: s.interpolation }));
  const channels = [];
  for (const c of anim.channels){
    const vrmaName = v.json.nodes[c.target.node]?.name;
    if (!vrmaName) { dropped.push(`${clipName}: nó ${c.target.node} sem nome`); continue; }
    let j = json.nodes.findIndex(n => n.name === vrmaName);
    if (j >= 0 && !jointIdx.has(j)) {
      const alt = json.nodes.findIndex((n, i) => n.name === vrmaName && jointIdx.has(i));
      j = alt;
    }
    if (j < 0) {
      const canon = humanMap[vrmaName.toLowerCase()];
      if (canon) j = json.nodes.findIndex(n => n.name === canon);
    }
    if (j < 0) { dropped.push(`${clipName}: osso "${vrmaName}" ausente`); continue; }
    channels.push({ sampler: c.sampler, target: { node: j, path: c.target.path } });
  }
  if (!channels.length) throw new Error(`${clipName}: nenhum canal remapeado, abortando`);
  json.animations.push({ name: clipName, samplers, channels });
}

// mapeia índice de nó do VRMA -> índice no VRM, pela ordem dos nós de ossos

json.buffers[0].byteLength = binOut.length;
function writeGlb(path, json, binOut){
  let jsonStr = JSON.stringify(json);
  while (jsonStr.length % 4) jsonStr += ' ';
  const jsonBuf = Buffer.from(jsonStr, 'utf8');
  const total = 12 + 8 + jsonBuf.length + 8 + binOut.length;
  const header = Buffer.alloc(12); header.write('glTF',0,'ascii'); header.writeUInt32LE(2,4); header.writeUInt32LE(total,8);
  const jh = Buffer.alloc(8); jh.writeUInt32LE(jsonBuf.length,0); jh.writeUInt32LE(0x4E4F534A,4);
  const bh = Buffer.alloc(8); bh.writeUInt32LE(binOut.length,0); bh.writeUInt32LE(0x004E4942,4);
  writeFileSync(path, Buffer.concat([header, jh, jsonBuf, bh, binOut]));
}
writeGlb(target, json, binOut);
console.log(`OK ${target}: animações=[${json.animations.map(a=>a.name).join(", ")}] canais descartados=${dropped.length}`); for (const d of dropped.slice(0,12)) console.log("  -", d); if (dropped.length>12) console.log("  ...", dropped.length-12, "mais");
