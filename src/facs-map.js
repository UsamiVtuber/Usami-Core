// Mapeamento de Action Units FACS (Facial Action Coding System) para
// expressões nomeadas do avatar principal (VRM 0.x "白_shiro_").
//
// Os nomes são os SLOTS GLOBAIS do modelo (confrontados com as 38
// expressões do shiro.vrm em 2026-10-23), não os índices de família.
//
// Cada AU mapeia para { name, weight } do expressionManager do Shiro.
// AU43 (olhos fechados) e AU45 (piscar) não mapeiam para expressão —
// são tratados pelo blink/auto-motion separado.

export const FACS_TO_SHIRO = {
  'AU1':   [{ name: '12-prefab_sad01', weight: 0.7 }],      // sobrancelha interna levantada → tristeza
  'AU2':   [{ name: '21-prefab_emoji', weight: 0.7 }],       // sobrancelha externa levantada → surpresa
  'AU4':   [{ name: '08-prefab_angry02', weight: 0.8 }],     // sobrancelha abaixada/franzida → raiva/foco
  'AU5':   [{ name: '20-prefab_startled', weight: 0.6 }],    // pálpebra superior elevada → olhos bem abertos
  'AU6':   [{ name: '02-prefab_happy02', weight: 0.6 }],     // bochecha elevada → sorriso feliz
  'AU9':   [{ name: '09-prefab_angry03', weight: 0.8 }],     // nariz enrugado → nojo/desgosto
  'AU12':  [{ name: '02-prefab_happy02', weight: 0.8 }],     // canto da boca elevado → feliz
  'AU15':  [{ name: '13-prefab_sad02', weight: 0.8 }],       // canto da boca abaixado → triste
  'AU20':  [{ name: '21-prefab_emoji', weight: 0.7 }],       // canto da boca esticado → medo/surpreso
  'AU24':  [{ name: '08-prefab_angry02', weight: 0.7 }],     // apertar lábios → raiva/determinação
  'AU25':  [{ name: '21-prefab_emoji', weight: 0.5 }],       // lábios separados → surpreso/falando
  'AU26':  [{ name: '21-prefab_emoji', weight: 0.8 }],       // mandíbula aberta → surpreso/gritando
  'AU43':  [],                                                // olhos fechados → sem expressão direta (suprime blink)
  'AU45':  [],                                                // piscar → tratado pelo blink automático
};

// AUs acionados por cada emoção semântica (fallback quando o classificador
// devolve uma emoção em vez de AUs diretos).
export const EMOTION_TO_FACS = {
  neutral:   [],
  happy:     ['AU6', 'AU12'],
  shy:       ['AU1', 'AU15', 'AU25'],
  sad:       ['AU1', 'AU4', 'AU15'],
  soft:      ['AU6', 'AU12'],
  angry:     ['AU4', 'AU24'],
  surprised: ['AU1', 'AU2', 'AU5', 'AU25', 'AU26'],
  doubtful:  ['AU4', 'AU1', 'AU25'],
};

export const FACS_LABELS = {
  'AU1':  'Sobrancelha interna levantada',
  'AU2':  'Sobrancelha externa levantada',
  'AU4':  'Sobrancelha abaixada',
  'AU5':  'Olhos bem abertos',
  'AU6':  'Bochecha elevada',
  'AU9':  'Nariz enrugado',
  'AU12': 'Canto da boca elevado',
  'AU15': 'Canto da boca abaixado',
  'AU20': 'Canto da boca esticado',
  'AU24': 'Lábios apertados',
  'AU25': 'Lábios separados',
  'AU26': 'Mandíbula aberta',
  'AU43': 'Olhos fechados',
  'AU45': 'Piscar',
};
