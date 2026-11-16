/**
 * Collab Engine: FloorLease, PRE_YIELD & Agendamento Zero-Knowledge (Fase 4 — RFC-001).
 *
 * Garante turn-taking determinístico entre múltiplas IAs em collab ao vivo
 * (evitando sobreposição de fala) e negociação de horários sem expor títulos
 * ou detalhes privados das agendas.
 */

export function createFloorLeaseCoordinator({
  leaseTtlMs = 20_000,
  now = () => Date.now(),
} = {}) {
  let activeLease = null; // { did, grantedAt, expiresAt, preYielding }
  const queue = [];

  function expireIfNeeded() {
    if (activeLease && now() >= activeLease.expiresAt) {
      activeLease = null;
      promoteNext();
    }
  }

  function promoteNext() {
    if (activeLease || queue.length === 0) return;
    const nextDid = queue.shift();
    const t = now();
    activeLease = {
      did: nextDid,
      grantedAt: t,
      expiresAt: t + leaseTtlMs,
      preYielding: false,
    };
  }

  function requestFloor(did) {
    if (!did || typeof did !== 'string') {
      throw new Error('did é obrigatório para requestFloor.');
    }
    expireIfNeeded();
    if (!activeLease) {
      const t = now();
      activeLease = {
        did,
        grantedAt: t,
        expiresAt: t + leaseTtlMs,
        preYielding: false,
      };
      return { granted: true, holder: did, preYielding: false, queuePosition: 0 };
    }
    if (activeLease.did === did) {
      return {
        granted: true,
        holder: did,
        preYielding: activeLease.preYielding,
        queuePosition: 0,
      };
    }
    if (!queue.includes(did)) {
      queue.push(did);
    }
    return {
      granted: false,
      holder: activeLease.did,
      preYielding: activeLease.preYielding,
      queuePosition: queue.indexOf(did) + 1,
    };
  }

  function preYield(did) {
    expireIfNeeded();
    if (!activeLease || activeLease.did !== did) {
      return { ok: false, reason: 'Agent não detém o FloorLease ativo.' };
    }
    activeLease.preYielding = true;
    return {
      ok: true,
      holder: did,
      nextUp: queue[0] || null,
      preYielding: true,
    };
  }

  function releaseFloor(did) {
    expireIfNeeded();
    if (!activeLease || activeLease.did !== did) {
      return { ok: false, holder: activeLease?.did || null };
    }
    activeLease = null;
    promoteNext();
    return {
      ok: true,
      holder: activeLease?.did || null,
    };
  }

  function status() {
    expireIfNeeded();
    return {
      holder: activeLease?.did || null,
      preYielding: Boolean(activeLease?.preYielding),
      expiresAt: activeLease?.expiresAt || null,
      queue: [...queue],
    };
  }

  return { requestFloor, preYield, releaseFloor, status };
}

/**
 * Negocia o primeiro horário livre em comum usando apenas intervalos opacos
 * `{ start, end }` (Zero-Knowledge: nenhum título/descrição de evento trafega).
 */
export function negotiateZeroKnowledgeSchedule({
  myBusySlots = [],
  peerBusySlots = [],
  windowStart,
  windowEnd,
  durationMs = 30 * 60_000,
} = {}) {
  if (!Number.isFinite(windowStart) || !Number.isFinite(windowEnd) || windowEnd <= windowStart) {
    throw new Error('Janela de agendamento inválida.');
  }
  const merged = [...myBusySlots, ...peerBusySlots]
    .filter(s => s && Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)
    .map(s => ({
      start: Math.max(windowStart, s.start),
      end: Math.min(windowEnd, s.end),
    }))
    .filter(s => s.end > s.start)
    .sort((a, b) => a.start - b.start);

  // Consolida sobreposições
  const consolidated = [];
  for (const slot of merged) {
    const last = consolidated[consolidated.length - 1];
    if (last && slot.start <= last.end) {
      last.end = Math.max(last.end, slot.end);
    } else {
      consolidated.push({ ...slot });
    }
  }

  let cursor = windowStart;
  for (const busy of consolidated) {
    if (busy.start - cursor >= durationMs) {
      return { ok: true, slot: { start: cursor, end: cursor + durationMs } };
    }
    cursor = Math.max(cursor, busy.end);
  }
  if (windowEnd - cursor >= durationMs) {
    return { ok: true, slot: { start: cursor, end: cursor + durationMs } };
  }
  return { ok: false, slot: null };
}
