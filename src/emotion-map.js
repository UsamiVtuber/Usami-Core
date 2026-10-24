// Mapa semântico de emoções do avatar principal (VRM 0.x "白_shiro_").
//
// ATENÇÃO (pt-BR): os números das variantes (happy04, awkward02, sad02, ...)
// são propostas preliminares pendentes de confirmação visual pelo usuário;
// trocar o número é editar somente este arquivo — nenhum outro ponto do
// código referencia esses nomes diretamente.
//
// Famílias reais do avatar: 01 happy (01..06), 07 angry (01..05),
// 12 sad (01..03), 15 awkward (01..04), 19 doubt, 20 startled.
//
// eyesClosed: true marca expressões que fecham os olhos; o emotion-engine
// usa isso para suprimir o blink automático enquanto elas estiverem ativas.

export const EMOTION_MAP = {
  neutral:   { expressions: {},                             eyesClosed: false },
  happy:     { expressions: { '01-prefab_happy04': 1 },     eyesClosed: true  },
  shy:       { expressions: { '15-prefab_awkward02': 1 },   eyesClosed: true  },
  sad:       { expressions: { '12-prefab_sad02': 1 },       eyesClosed: false },
  soft:      { expressions: { '12-prefab_sad01': 0.6 },     eyesClosed: false },
  angry:     { expressions: { '07-prefab_angry02': 1 },     eyesClosed: false },
  surprised: { expressions: { '20-prefab_startled': 1 },    eyesClosed: false },
  doubtful:  { expressions: { '19-prefab_doubt': 1 },       eyesClosed: false },
};

export const EMOTION_LABELS = Object.keys(EMOTION_MAP);
