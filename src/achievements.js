// Catálogo puro de conquistas da Usami. As condições olham o snapshot do
// vínculo (bond-store): medidores, resumo de nível e o log de momentos — a
// mesma atividade real que o core já registra, sem instrumentação nova.
//
// Cada condição devolve o timestamp (ms) do evento que a satisfez, ou null
// quando ainda não desbloqueada. O store converte em `unlockedAt` ISO. Como a
// reavaliação parte do estado persistido (e não de um hook pontual), um
// desbloqueio não se perde se o processo morrer entre a gravação do vínculo e
// a das conquistas: a próxima reavaliação recupera.

import { LEVEL_NAMES } from './bond-core.js';

const toMs = value => {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  const ms = typeof value === 'number' ? value : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
};

// O log do vínculo é mais recente primeiro; para a data do desbloqueio vale o
// evento mais antigo que satisfaz a condição, então varre do fim para o início.
const earliestEventAt = (log, kinds) => {
  const wanted = Array.isArray(kinds) ? kinds : [kinds];
  const list = Array.isArray(log) ? log : [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const entry = list[index];
    if (entry && wanted.includes(entry.kind)) {
      const at = toMs(entry.at);
      if (at !== null) return at;
    }
  }
  return null;
};

const anyActivityAt = bond =>
  earliestEventAt(bond?.log, ['chat', 'voice', 'laugh', 'long', 'call', 'level']);

// O k-ésimo evento 'level' do log marca a chegada ao Nv.(k+1). Se o log já
// rodou (limite de 20 momentos) e o nível atual cobre a conquista, cai no
// evento mais recente do log — a data exata de um nível antigo não sobrevive
// ao corte do histórico.
const levelReachedAt = (bond, level) => {
  const log = Array.isArray(bond?.log) ? bond.log : [];
  const levelEvents = [];
  for (let index = log.length - 1; index >= 0; index -= 1) {
    if (log[index]?.kind === 'level') levelEvents.push(log[index]);
  }
  const direct = levelEvents[level - 2];
  if (direct) return toMs(direct.at);
  if ((bond?.summary?.level ?? 0) < level) return null;
  const last = log[0];
  return last ? toMs(last.at) : null;
};

const levelAchievement = (level, icon) => ({
  id: `nivel-${level}`,
  name: LEVEL_NAMES[level - 1],
  description: `Alcance o Nível ${level} do vínculo (${LEVEL_NAMES[level - 1]}).`,
  icon,
  condition: bond => levelReachedAt(bond, level),
});

export const ACHIEVEMENTS = [
  {
    id: 'primeira-conversa',
    name: 'Primeira Palavra',
    description: 'Converse com a Usami pela primeira vez.',
    icon: 'chat',
    condition: anyActivityAt,
  },
  {
    id: 'risada-juntos',
    name: 'Riram Juntos',
    description: 'Faça a Usami rir com você.',
    icon: 'smile',
    condition: bond => earliestEventAt(bond?.log, 'laugh'),
  },
  {
    id: 'papo-longo',
    name: 'Papo que Não Acaba',
    description: 'Conte algo com calma em uma conversa longa.',
    icon: 'message',
    condition: bond => earliestEventAt(bond?.log, 'long'),
  },
  {
    id: 'voz-a-voz',
    name: 'Voz a Voz',
    description: 'Converse com a Usami usando a voz.',
    icon: 'mic',
    condition: bond => earliestEventAt(bond?.log, 'voice'),
  },
  {
    id: 'na-linha',
    name: 'Na Linha',
    description: 'Complete uma chamada de voz com a Usami.',
    icon: 'phone',
    condition: bond => earliestEventAt(bond?.log, 'call'),
  },
  levelAchievement(2, 'heart'),
  levelAchievement(3, 'star'),
  levelAchievement(4, 'sparkles'),
  levelAchievement(5, 'crown'),
];
