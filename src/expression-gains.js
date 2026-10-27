// Régua de visibilidade das expressões faciais do shiro.
//
// O peso que o LLM escolhe não significa a mesma coisa de expressão para
// expressão: medido no próprio shiro.vrm (2026-10-27), o deslocamento p90 dos
// vértices da faixa do rosto a peso 1.0 vai de 0.7 mm (09-prefab_angry03) a
// 49.2 mm (11-prefab_angry05) — 70× de diferença entre duas expressões que o
// modelo trata como equivalentes. Sem isso, "brava 0.7" quase não aparece e
// "feliz 0.7" domina a cara inteira.
//
// A tabela abaixo é dado medido, não palpite: cada número é o p90 (mm) de
// deslocamento morfológico na região do rosto, com o morph peso 1.0. Para
// medir de novo, é só atualizar os números — a referência (mediana) e os
// ganhos são recalculados a partir deles.
//
// Limites: ganho acima de 1 só empurra o peso para o teto (1.0); um morph de
// 0.7 mm não fica visível aument peso — isso é recorte de catálogo, não
// calibração.

export const FACE_P90_MM = Object.freeze({
  '01-prefab_happy01': 13.8,
  '02-prefab_happy02': 11.7,
  '03-prefab_happy03': 4.3,
  '04-prefab_happy04': 31.9,
  '05-prefab_happy05': 4.0,
  '06-prefab_happy06': 13.9,
  '07-prefab_angry01': 8.6,
  '08-prefab_angry02': 48.4,
  '09-prefab_angry03': 0.7,
  '10-prefab_angry04': 48.5,
  '11-prefab_angry05': 49.2,
  '12-prefab_sad01': 43.3,
  '13-prefab_sad02': 13.7,
  '14-prefab_sad03': 36.9,
  '15-prefab_awkward01': 26.3,
  '16-prefab_awkward02': 34.3,
  '17-prefab_awkward03': 14.3,
  '18-prefab_awkward04': 25.9,
  '19-prefab_doubt': 3.8,
  '20-prefab_startled': 9.6,
});

// Equalizar na mediana mantém a maioria das expressões perto do que já é hoje
// e só corta forte as que explodem o rosto.
const sorted = Object.values(FACE_P90_MM).sort((a, b) => a - b);
export const REFERENCE_P90_MM = (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.ceil((sorted.length - 1) / 2)]) / 2;

export const MAX_BOOST = 4;   // acima disso a expressão só satura no teto de peso
export const MAX_CUT = 0.25;  // abaixo disso a emoção some do rosto

// 1 = sem medição (outro modelo, outra expressão): não mexer no peso.
export function gainFor(name, { reference = REFERENCE_P90_MM } = {}) {
  const measured = FACE_P90_MM[name];
  if (!Number.isFinite(measured) || measured <= 0) return 1;
  return Math.min(MAX_BOOST, Math.max(MAX_CUT, reference / measured));
}

// Tabela pronta para injetar no driver de expressões, só com os nomes que o
// modelo realmente tem e que foram medidos.
export function buildExpressionGains(names, options) {
  const gains = {};
  for (const name of names ?? []) {
    if (typeof name !== 'string') continue;
    const gain = gainFor(name, options);
    if (gain !== 1) gains[name] = gain;
  }
  return gains;
}

