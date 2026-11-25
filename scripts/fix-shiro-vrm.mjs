import { readFileSync, writeFileSync } from 'fs';

function readGlb(path) {
  const buf = readFileSync(path);
  if (buf.slice(0, 4).toString('ascii') !== 'glTF') throw new Error(path + ': não é GLB binário');
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.slice(20, 20 + jsonLen).toString('utf8'));
  const binLen = buf.readUInt32LE(12 + 8 + jsonLen);
  const bin = buf.slice(12 + 16 + jsonLen, 12 + 16 + jsonLen + binLen);
  return { json, bin };
}

function writeGlb(path, json, bin) {
  let jsonStr = JSON.stringify(json);
  while (jsonStr.length % 4) jsonStr += ' ';
  const jsonBuf = Buffer.from(jsonStr, 'utf8');
  const total = 12 + 8 + jsonBuf.length + 8 + bin.length;
  const header = Buffer.alloc(12);
  header.write('glTF', 0, 'ascii');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(total, 8);
  const jh = Buffer.alloc(8);
  jh.writeUInt32LE(jsonBuf.length, 0);
  jh.writeUInt32LE(0x4E4F534A, 4);
  const bh = Buffer.alloc(8);
  bh.writeUInt32LE(bin.length, 0);
  bh.writeUInt32LE(0x004E4942, 4);
  writeFileSync(path, Buffer.concat([header, jh, jsonBuf, bh, bin]));
}

const inputPath = 'public/models/shiro.vrm';
const outputPath = 'public/models/shiro.fixed.vrm';

const { json, bin } = readGlb(inputPath);

console.log('=== CORRIGINDO shiro.vrm ===\n');

// 1. CORRIGIR MATERIAL clothes01_red (material 8) - remover doubleSided: true
console.log('1. Corrigindo material clothes01_red (doubleSided: true -> false)');
if (json.materials[8] && json.materials[8].doubleSided === true) {
  json.materials[8].doubleSided = false;
  console.log('   ✓ Material 8 corrigido');
} else {
  console.log('   - Material 8 já OK ou não encontrado');
}

// 2. CORRIGIR HIERARQUIA DOS OSSOS DA SAIA/TÚNICA - parentar ao hips (node 20)
console.log('\n2. Corrigindo hierarquia dos ossos da saia/túnica');
const skirtBoneIndices = [21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40];
skirtBoneIndices.forEach(idx => {
  if (json.nodes[idx]) {
    json.nodes[idx].parent = 20; // hips
  }
});
console.log(`   ✓ ${skirtBoneIndices.length} ossos da saia/túnica parentados ao hips (node 20)`);

// 3. CORRIGIR SECONDARY ANIMATION (Spring Bones) DA SAIA
console.log('\n3. Corrigindo secondary animation da saia (grupos 7-16)');
const secAnim = json.extensions.VRM.secondaryAnimation;
if (secAnim && secAnim.boneGroups) {
  // Grupos 7-16 são os da saia (VRMSkirtTool)
  const skirtGroups = [7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
  
  skirtGroups.forEach((groupIdx, layer) => {
    const group = secAnim.boneGroups[groupIdx];
    if (!group) return;
    
    // Variar parâmetros por camada para movimento mais natural
    // Camadas inferiores (mais próximas do quadril) = mais rígidas, menos gravidade
    // Camadas superiores (ponta da saia) = mais moles, mais gravidade
    const progress = layer / (skirtGroups.length - 1); // 0 a 1
    
    group.stiffiness = 0.5 + progress * 0.8;        // 0.5 a 1.3
    group.gravityPower = 0.3 + progress * 0.7;      // 0.3 a 1.0 (ERA 0!)
    group.dragForce = 0.1 + progress * 0.3;         // 0.1 a 0.4
    group.hitRadius = 0.03 + progress * 0.04;       // 0.03 a 0.07
    
    // Gravidade sempre para baixo
    group.gravityDir = { x: 0, y: -1, z: 0 };
    
    console.log(`   Grupo ${groupIdx} (${group.comment}): stiff=${group.stiffiness.toFixed(2)}, grav=${group.gravityPower.toFixed(2)}, drag=${group.dragForce.toFixed(2)}, hitRad=${group.hitRadius.toFixed(3)}`);
  });
}

// 4. CORRIGIR COLLIDERS - adicionar colliders cápsula no quadril/pernas para colisão da saia
console.log('\n4. Adicionando colliders para colisão da saia');
if (!secAnim.colliderGroups) secAnim.colliderGroups = [];

// Limpar colliders inválidos (todos os 60 atuais têm shape undefined)
secAnim.colliderGroups = [];

// Collider no quadril (hips) - cápsula cobrindo a região do quadril
secAnim.colliderGroups.push({
  node: 20, // hips
  shape: 'Capsule',
  offset: { x: 0, y: 0.05, z: 0 },
  radius: 0.12,
  tail: { x: 0, y: -0.15, z: 0 }
});

// Collider na coxa esquerda
secAnim.colliderGroups.push({
  node: 226, // upper_leg.L
  shape: 'Capsule',
  offset: { x: 0, y: -0.1, z: 0 },
  radius: 0.08,
  tail: { x: 0, y: -0.35, z: 0 }
});

// Collider na coxa direita
secAnim.colliderGroups.push({
  node: 240, // upper_leg.R
  shape: 'Capsule',
  offset: { x: 0, y: -0.1, z: 0 },
  radius: 0.08,
  tail: { x: 0, y: -0.35, z: 0 }
});

// Collider na perna esquerda (opcional, para saias longas)
secAnim.colliderGroups.push({
  node: 227, // lower_leg.L
  shape: 'Capsule',
  offset: { x: 0, y: -0.1, z: 0 },
  radius: 0.06,
  tail: { x: 0, y: -0.35, z: 0 }
});

// Collider na perna direita
secAnim.colliderGroups.push({
  node: 241, // lower_leg.R
  shape: 'Capsule',
  offset: { x: 0, y: -0.1, z: 0 },
  radius: 0.06,
  tail: { x: 0, y: -0.35, z: 0 }
});

console.log(`   ✓ ${secAnim.colliderGroups.length} colliders adicionados (hips, coxas, pernas)`);

// 5. CORRIGIR BLEND SHAPE "prefab_clothes" - afetar todos os 3 primitives do clothes01
console.log('\n5. Corrigindo blend shape prefab_clothes (grupo 34)');
const bsGroups = json.extensions.VRM.blendShapeMaster.blendShapeGroups;
const clothesBs = bsGroups[34]; // 22-prefab_clothes
if (clothesBs && clothesBs.name === '22-prefab_clothes') {
  // Adicionar binds para os primitives 1 e 2 (mesmo mesh, índices 1 e 2)
  clothesBs.binds.push(
    { mesh: 2, index: 1, weight: 100 }, // primitive 1 (clothes01_red)
    { mesh: 2, index: 2, weight: 100 }  // primitive 2 (clothes01_green)
  );
  console.log('   ✓ Blend shape agora afeta todos os 3 primitives do clothes01');
}

// 6. OPCIONAL: Remover primitives redundantes do clothes01 (mesma geometria, materiais diferentes)
// Como todos os 3 primitives compartilham a MESMA geometria (mesmos accessors),
// isso causa overdraw. O ideal seria mesclar em 1 primitive com material que suporte
// as variações de cor via vertex color ou texture.
// Por agora, mantemos mas garantimos que o blend shape afete todos.

// Salvar
writeGlb(outputPath, json, bin);
console.log(`\n=== SALVO EM: ${outputPath} ===`);

// Verificar tamanho
const stats = require('fs').statSync(outputPath);
console.log(`Tamanho: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);