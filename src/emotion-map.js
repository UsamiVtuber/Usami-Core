// Mapa semântico de emoções do avatar principal (VRM 0.x "白_shiro_").
//
// ATENÇÃO (pt-BR): o prefixo de cada expressão é o SLOT GLOBAL do modelo
// (happy04 → "04-prefab_happy04", awkward02 → "16-prefab_awkward02"), não o
// índice da família. Os nomes abaixo foram confrontados com a lista real de
// 38 expressões do arquivo shiro.vrm (2026-10-23). As escolhas de variante
// (happy04, awkward02, sad02, angry02…) seguem pendentes de confirmação
// visual pelo usuário; trocar a variante é editar somente este arquivo —
// nenhum outro ponto do código referencia esses nomes diretamente.
//
// Famílias reais do avatar: 01 happy (01..06), 07 angry (01..05),
// 12 sad (01..03), 15 awkward (01..04), 19 doubt, 20 startled.
//
// eyesClosed: true marca expressões que fecham os olhos; o emotion-engine
// usa isso para suprimir o blink automático enquanto elas estiverem ativas.

export const EMOTION_MAP = {
  neutral:   { expressions: {},                             eyesClosed: false },
  happy:     { expressions: { '04-prefab_happy04': 1 },     eyesClosed: true  },
  shy:       { expressions: { '16-prefab_awkward02': 1 },   eyesClosed: true  },
  sad:       { expressions: { '13-prefab_sad02': 1 },       eyesClosed: false },
  soft:      { expressions: { '12-prefab_sad01': 0.6 },     eyesClosed: false },
  angry:     { expressions: { '08-prefab_angry02': 1 },     eyesClosed: false },
  surprised: { expressions: { '20-prefab_startled': 1 },    eyesClosed: false },
  doubtful:  { expressions: { '19-prefab_doubt': 1 },       eyesClosed: false },
};

export const EMOTION_LABELS = Object.keys(EMOTION_MAP);

// Rótulos humanos para a lista do painel. Os IDs técnicos permanecem intactos
// porque são os nomes reais registrados pelo expressionManager do VRM.
export const EXPRESSION_LABELS = Object.freeze({
  neutral: 'Neutra',
  '01-prefab_happy01': 'Feliz suave', '02-prefab_happy02': 'Feliz sorridente',
  '03-prefab_happy03': 'Feliz apaixonada', '04-prefab_happy04': 'Feliz de olhos fechados',
  '05-prefab_happy05': 'Feliz radiante', '06-prefab_happy06': 'Feliz empolgada',
  '07-prefab_angry01': 'Irritada', '08-prefab_angry02': 'Brava', '09-prefab_angry03': 'Furiosa',
  '10-prefab_angry04': 'Furiosa de olhos fechados', '11-prefab_angry05': 'Brava contida',
  '12-prefab_sad01': 'Triste suave', '13-prefab_sad02': 'Chorando', '14-prefab_sad03': 'Triste abatida',
  '15-prefab_awkward01': 'Envergonhada', '16-prefab_awkward02': 'Constrangida',
  '17-prefab_awkward03': 'Constrangida nervosa', '18-prefab_awkward04': 'Desconfortável',
  '19-prefab_doubt': 'Desconfiada', '20-prefab_startled': 'Assustada',
  '21-prefab_emoji': 'Reação emoji', '22-prefab_clothes': 'Efeito roupa',
  '23-prefab_hat': 'Efeito chapéu', '24-prefab_hairpin': 'Efeito presilha',
  '25-prefab_sleeve': 'Efeito manga',
});

// Overrides explícitos para os nomes autorais do Shiro.
export const EXPRESSION_TAGS = Object.freeze({
  '01-prefab_happy01': 'happy', '02-prefab_happy02': 'happy', '03-prefab_happy03': 'happy',
  '04-prefab_happy04': 'happy', '05-prefab_happy05': 'happy', '06-prefab_happy06': 'happy',
  '07-prefab_angry01': 'angry', '08-prefab_angry02': 'angry', '09-prefab_angry03': 'angry',
  '10-prefab_angry04': 'angry', '11-prefab_angry05': 'angry',
  '12-prefab_sad01': 'sad', '13-prefab_sad02': 'sad', '14-prefab_sad03': 'sad',
  '15-prefab_awkward01': 'awkward', '16-prefab_awkward02': 'awkward',
  '17-prefab_awkward03': 'awkward', '18-prefab_awkward04': 'awkward',
  '19-prefab_doubt': 'doubtful', '20-prefab_startled': 'surprised',
  '21-prefab_emoji': 'effect', '22-prefab_clothes': 'effect', '23-prefab_hat': 'effect',
  '24-prefab_hairpin': 'effect', '25-prefab_sleeve': 'effect',
});
