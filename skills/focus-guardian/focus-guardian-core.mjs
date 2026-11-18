/**
 * Focus Guardian Skill Core
 * Gerencia sessões de foco, perfis, blocklists, pausas e estatísticas.
 */
import { createFocusStore } from './focus-store.mjs';
import { dataDir as resolveDataDir } from '../../src/data-paths.js';

function nowIso() {
  return new Date().toISOString();
}

function calculateActualDuration(session) {
  if (session.status === 'completed' && session.endedAt && session.startedAt) {
    const started = new Date(session.startedAt);
    const ended = new Date(session.endedAt);
    const totalMs = ended - started - (session.totalPausedDurationMs || 0);
    return Math.max(0, Math.round(totalMs / 60000));
  }
  if ((session.status === 'active' || session.status === 'paused') && session.startedAt) {
    const started = new Date(session.startedAt);
    const now = new Date();
    const pausedMs = session.status === 'paused' && session.pausedAt
      ? now - new Date(session.pausedAt)
      : 0;
    const totalMs = now - started - (session.totalPausedDurationMs || 0) - pausedMs;
    return Math.max(0, Math.round(totalMs / 60000));
  }
  return session.actualDurationMinutes || 0;
}

export function createFocusGuardianCore({
  dataDir = resolveDataDir(),
} = {}) {
  const focusStore = createFocusStore({ dataDir });
  focusStore.initializeDefaults();

  // --- Tools ---

  /**
   * Inicia uma nova sessão de foco.
   * @param {{profileId?:string, plannedDurationMinutes?:number, notes?:string, metadata?:object}} params
   */
  async function startFocusSession({ profileId, plannedDurationMinutes, notes, metadata } = {}) {
    // Verifica se já existe sessão ativa
    const active = focusStore.getActiveSession();
    if (active) {
      throw new Error(`Já existe uma sessão ativa (${active.id}). Pare-a primeiro.`);
    }

    // Resolve profile
    let profile;
    if (profileId) {
      profile = focusStore.getProfile(profileId);
      if (!profile) throw new Error(`perfil não encontrado (${profileId})`);
    } else {
      const settings = focusStore.getSettings();
      profile = focusStore.getProfileByName(settings.defaultProfile) || focusStore.listProfiles()[0];
      if (!profile) throw new Error('nenhum perfil disponível');
    }

    const session = focusStore.createSession({
      profileId: profile.id,
      plannedDurationMinutes: plannedDurationMinutes || profile.plannedDurationMinutes,
      notes,
      metadata,
    });

    return {
      ok: true,
      session: session.session,
      profile,
      message: `Sessão "${profile.name}" iniciada (${session.session.plannedDurationMinutes}min)`,
    };
  }

  /**
   * Pausa a sessão ativa.
   * @param {{sessionId?:string}} params
   */
  async function pauseFocusSession({ sessionId } = {}) {
    const session = sessionId ? focusStore.getSession(sessionId) : focusStore.getActiveSession();
    if (!session) throw new Error('nenhuma sessão ativa para pausar');
    if (session.status !== 'active') throw new Error(`sessão não está ativa (status: ${session.status})`);

    const updated = focusStore.updateSession(session.id, {
      status: 'paused',
      pausedAt: nowIso(),
    });
    if (!updated.ok) throw new Error('falha ao pausar sessão');

    return { ok: true, session: updated.session, message: 'Sessão pausada' };
  }

  /**
   * Retoma a sessão pausada.
   * @param {{sessionId?:string}} params
   */
  async function resumeFocusSession({ sessionId } = {}) {
    const session = sessionId ? focusStore.getSession(sessionId) : focusStore.getActiveSession();
    if (!session) throw new Error('nenhuma sessão pausada para retomar');
    if (session.status !== 'paused') throw new Error(`sessão não está pausada (status: ${session.status})`);

    const pausedDurationMs = session.pausedAt ? new Date() - new Date(session.pausedAt) : 0;
    const updated = focusStore.updateSession(session.id, {
      status: 'active',
      pausedAt: null,
      totalPausedDurationMs: (session.totalPausedDurationMs || 0) + pausedDurationMs,
    });
    if (!updated.ok) throw new Error('falha ao retomar sessão');

    return { ok: true, session: updated.session, message: 'Sessão retomada' };
  }

  /**
   * Finaliza a sessão ativa/pausada.
   * @param {{sessionId?:string, notes?:string}} params
   */
  async function stopFocusSession({ sessionId, notes } = {}) {
    const session = sessionId ? focusStore.getSession(sessionId) : focusStore.getActiveSession();
    if (!session) throw new Error('nenhuma sessão ativa/pausada para finalizar');
    if (session.status === 'completed' || session.status === 'cancelled') {
      throw new Error(`sessão já finalizada (status: ${session.status})`);
    }

    const actualDuration = calculateActualDuration({ ...session, endedAt: nowIso() });
    const updated = focusStore.updateSession(session.id, {
      status: 'completed',
      endedAt: nowIso(),
      actualDurationMinutes: actualDuration,
      notes: notes ? `${session.notes}\n${notes}`.trim() : session.notes,
    });
    if (!updated.ok) throw new Error('falha ao finalizar sessão');

    return {
      ok: true,
      session: updated.session,
      actualDurationMinutes: actualDuration,
      message: `Sessão finalizada (${actualDuration}min de foco)`,
    };
  }

  /**
   * Cancela a sessão ativa/pausada sem contar tempo.
   * @param {{sessionId?:string}} params
   */
  async function cancelFocusSession({ sessionId } = {}) {
    const session = sessionId ? focusStore.getSession(sessionId) : focusStore.getActiveSession();
    if (!session) throw new Error('nenhuma sessão ativa/pausada para cancelar');
    if (session.status === 'completed' || session.status === 'cancelled') {
      throw new Error(`sessão já finalizada (status: ${session.status})`);
    }

    const updated = focusStore.updateSession(session.id, {
      status: 'cancelled',
      endedAt: nowIso(),
      actualDurationMinutes: 0,
    });
    if (!updated.ok) throw new Error('falha ao cancelar sessão');

    return { ok: true, session: updated.session, message: 'Sessão cancelada' };
  }

  /**
   * Registra uma pausa realizada durante a sessão.
   * @param {{sessionId?:string}} params
   */
  async function takeBreak({ sessionId } = {}) {
    const session = sessionId ? focusStore.getSession(sessionId) : focusStore.getActiveSession();
    if (!session) throw new Error('nenhuma sessão ativa');
    if (session.status !== 'active') throw new Error('sessão deve estar ativa para registrar pausa');

    const updated = focusStore.updateSession(session.id, {
      breaksTaken: (session.breaksTaken || 0) + 1,
    });
    if (!updated.ok) throw new Error('falha ao registrar pausa');

    return { ok: true, session: updated.session, breaksTaken: updated.session.breaksTaken };
  }

  /**
   * Registra distração bloqueada.
   * @param {{sessionId?:string, count?:number}} params
   */
  async function recordDistractionBlocked({ sessionId, count = 1 } = {}) {
    const session = sessionId ? focusStore.getSession(sessionId) : focusStore.getActiveSession();
    if (!session) throw new Error('nenhuma sessão ativa');

    const updated = focusStore.updateSession(session.id, {
      distractionsBlocked: (session.distractionsBlocked || 0) + count,
    });
    if (!updated.ok) throw new Error('falha ao registrar distração');

    return { ok: true, session: updated.session, distractionsBlocked: updated.session.distractionsBlocked };
  }

  /**
   * Retorna status da sessão atual.
   * @param {{}} params
   */
  function getFocusStatus() {
    const session = focusStore.getActiveSession();
    if (!session) {
      return { ok: true, active: false };
    }

    const actualDuration = calculateActualDuration(session);
    const remainingMinutes = Math.max(0, session.plannedDurationMinutes - actualDuration);
    const progressPercent = session.plannedDurationMinutes > 0
      ? Math.min(100, Math.round((actualDuration / session.plannedDurationMinutes) * 100))
      : 0;

    const profile = focusStore.getProfile(session.profileId);

    return {
      ok: true,
      active: true,
      session: {
        ...session,
        actualDurationMinutes: actualDuration,
        remainingMinutes,
        progressPercent,
      },
      profile,
    };
  }

  /**
   * Lista sessões com filtros.
   * @param {{status?:string, profileId?:string, since?:string, until?:string, limit?:number}} params
   */
  function listFocusSessions({ status, profileId, since, until, limit = 50 } = {}) {
    const sessions = focusStore.listSessions({ status, profileId, since, until, limit });
    return { ok: true, sessions, count: sessions.length };
  }

  /**
   * Retorna estatísticas de foco.
   * @param {{since?:string, until?:string, profileId?:string}} params
   */
  function getFocusStats({ since, until, profileId } = {}) {
    const stats = focusStore.getSessionStats({ since, until, profileId });
    return { ok: true, ...stats };
  }

  // --- Profiles ---

  /**
   * Cria ou atualiza um perfil de foco.
   * @param {{id?:string, name:string, description?:string, plannedDurationMinutes?:number, breakIntervalMinutes?:number, breakDurationMinutes?:number, blocklistIds?:string[], allowNotifications?:boolean, autoStartBreaks?:boolean, soundEnabled?:boolean, color?:string}} params
   */
  async function upsertProfile({ id, name, description, plannedDurationMinutes, breakIntervalMinutes, breakDurationMinutes, blocklistIds, allowNotifications, autoStartBreaks, soundEnabled, color }) {
    if (!name?.trim()) throw new Error('name: obrigatório');

    if (id) {
      const existing = focusStore.getProfile(id);
      if (!existing) throw new Error(`perfil não encontrado (${id})`);

      const patch = {};
      if (name) patch.name = name.trim();
      if (description !== undefined) patch.description = description;
      if (plannedDurationMinutes !== undefined) patch.plannedDurationMinutes = plannedDurationMinutes;
      if (breakIntervalMinutes !== undefined) patch.breakIntervalMinutes = breakIntervalMinutes;
      if (breakDurationMinutes !== undefined) patch.breakDurationMinutes = breakDurationMinutes;
      if (blocklistIds !== undefined) patch.blocklistIds = blocklistIds;
      if (allowNotifications !== undefined) patch.allowNotifications = allowNotifications;
      if (autoStartBreaks !== undefined) patch.autoStartBreaks = autoStartBreaks;
      if (soundEnabled !== undefined) patch.soundEnabled = soundEnabled;
      if (color !== undefined) patch.color = color;

      const updated = focusStore.updateProfile(id, patch);
      if (!updated.ok) throw new Error(updated.notFound ? `perfil não encontrado (${id})` : updated.errors?.join('; ') || 'falha ao atualizar');
      return { ok: true, action: 'updated', profile: updated.profile };
    }

    const created = focusStore.createProfile({ name: name.trim(), description, plannedDurationMinutes, breakIntervalMinutes, breakDurationMinutes, blocklistIds, allowNotifications, autoStartBreaks, soundEnabled, color });
    if (!created.ok) throw new Error('falha ao criar perfil');
    return { ok: true, action: 'created', profile: created.profile };
  }

  /**
   * Obtém um perfil por ID ou nome.
   * @param {{id?:string, name?:string}} params
   */
  function getProfile({ id, name }) {
    if (!id && !name) throw new Error('id ou name: obrigatório');

    const profile = id ? focusStore.getProfile(id) : focusStore.getProfileByName(name);
    if (!profile) throw new Error(id ? `perfil não encontrado (${id})` : `perfil não encontrado com nome "${name}"`);

    return { ok: true, profile };
  }

  /**
   * Lista todos os perfis.
   * @param {{}} params
   */
  function listProfiles() {
    const profiles = focusStore.listProfiles();
    return { ok: true, profiles, count: profiles.length };
  }

  /**
   * Remove um perfil.
   * @param {{id:string}} params
   */
  async function deleteProfile({ id }) {
    const result = focusStore.deleteProfile(id);
    if (!result.ok) throw new Error(result.notFound ? `perfil não encontrado (${id})` : result.errors?.join('; ') || 'falha ao remover');
    return { ok: true, removed: true };
  }

  // --- Blocklists ---

  /**
   * Cria ou atualiza uma blocklist.
   * @param {{id?:string, name?:string, description?:string, type?:'websites'|'apps'|'custom', entries?:string[], enabled?:boolean}} params
   */
  async function upsertBlocklist({ id, name, description, type, entries, enabled }) {
    if (id) {
      const existing = focusStore.getBlocklist(id);
      if (!existing) throw new Error(`blocklist não encontrada (${id})`);

      const patch = {};
      if (name !== undefined) {
        if (!name?.trim()) throw new Error('name: não pode ser vazio');
        patch.name = name.trim();
      }
      if (description !== undefined) patch.description = description;
      if (type) patch.type = type;
      if (entries !== undefined) patch.entries = entries;
      if (enabled !== undefined) patch.enabled = enabled;

      const updated = focusStore.updateBlocklist(id, patch);
      if (!updated.ok) throw new Error(updated.notFound ? `blocklist não encontrada (${id})` : 'falha ao atualizar');
      return { ok: true, action: 'updated', blocklist: updated.blocklist };
    }

    if (!name?.trim()) throw new Error('name: obrigatório');
    const created = focusStore.createBlocklist({ name: name.trim(), description, type, entries, enabled });
    if (!created.ok) throw new Error('falha ao criar blocklist');
    return { ok: true, action: 'created', blocklist: created.blocklist };
  }

  /**
   * Obtém uma blocklist.
   * @param {{id:string}} params
   */
  function getBlocklist({ id }) {
    const blocklist = focusStore.getBlocklist(id);
    if (!blocklist) throw new Error(`blocklist não encontrada (${id})`);
    return { ok: true, blocklist };
  }

  /**
   * Lista blocklists.
   * @param {{enabled?:boolean}} params
   */
  function listBlocklists({ enabled } = {}) {
    const blocklists = focusStore.listBlocklists({ enabled });
    return { ok: true, blocklists, count: blocklists.length };
  }

  /**
   * Remove uma blocklist.
   * @param {{id:string}} params
   */
  async function deleteBlocklist({ id }) {
    const result = focusStore.deleteBlocklist(id);
    if (!result.ok) throw new Error(result.notFound ? `blocklist não encontrada (${id})` : result.errors?.join('; ') || 'falha ao remover');
    return { ok: true, removed: true };
  }

  // --- Settings ---

  /**
   * Obtém configurações globais.
   * @param {{}} params
   */
  function getSettings() {
    return { ok: true, settings: focusStore.getSettings() };
  }

  /**
   * Atualiza configurações globais.
   * @param {{defaultProfile?:string, breakReminderEnabled?:boolean, breakReminderIntervalMinutes?:number, autoStartBreaks?:boolean}} params
   */
  async function updateSettings({ defaultProfile, breakReminderEnabled, breakReminderIntervalMinutes, autoStartBreaks }) {
    const patch = {};
    if (defaultProfile !== undefined) patch.defaultProfile = defaultProfile;
    if (breakReminderEnabled !== undefined) patch.breakReminderEnabled = breakReminderEnabled;
    if (breakReminderIntervalMinutes !== undefined) patch.breakReminderIntervalMinutes = breakReminderIntervalMinutes;
    if (autoStartBreaks !== undefined) patch.autoStartBreaks = autoStartBreaks;

    const result = focusStore.updateSettings(patch);
    return { ok: true, settings: result.settings };
  }

  // --- Blocklist checking (for integration with browser/OS) ---

  /**
   * Verifica se um domínio/URL está bloqueado nas blocklists ativas do perfil atual.
   * @param {{url:string, profileId?:string}} params
   */
  function checkBlocked({ url, profileId }) {
    let profile;
    if (profileId) {
      profile = focusStore.getProfile(profileId);
    } else {
      const active = focusStore.getActiveSession();
      if (active) profile = focusStore.getProfile(active.profileId);
      else {
        const settings = focusStore.getSettings();
        profile = focusStore.getProfileByName(settings.defaultProfile) || focusStore.listProfiles()[0];
      }
    }
    if (!profile) return { ok: true, blocked: false, reason: 'no profile' };

    const blocklists = profile.blocklistIds
      .map(id => focusStore.getBlocklist(id))
      .filter(b => b && b.enabled);

    let matched = false;
    let matchedEntry = null;
    let matchedBlocklist = null;

    try {
      const hostname = new URL(url).hostname.replace('www.', '');
      for (const bl of blocklists) {
        for (const entry of bl.entries) {
          if (hostname === entry || hostname.endsWith('.' + entry)) {
            matched = true;
            matchedEntry = entry;
            matchedBlocklist = bl.name;
            break;
          }
        }
        if (matched) break;
      }
    } catch {
      // Invalid URL
    }

    return {
      ok: true,
      blocked: matched,
      entry: matchedEntry,
      blocklist: matchedBlocklist,
      profile: profile.name,
    };
  }

  // --- Tool Specs ---
  const toolSpecs = [
    // Session control
    {
      schema: 'usami.agent.tool.v1',
      name: 'focus.start',
      version: '1.0.0',
      description: 'Inicia uma nova sessão de foco com perfil opcional.',
      origin: 'skill',
      permissionLevel: 2,
      timeoutMs: 3000,
      parameters: [
        { name: 'profileId', type: 'string', required: false, description: 'ID do perfil (focus-profile-...)' },
        { name: 'plannedDurationMinutes', type: 'number', required: false, description: 'Duração planejada em minutos (padrão: do perfil)' },
        { name: 'notes', type: 'string', required: false, description: 'Notas iniciais' },
        { name: 'metadata', type: 'object', required: false, description: 'Metadados extras' },
      ],
      verify: (result) => result && result.ok === true && result.session && typeof result.session.id === 'string',
    },
    {
      schema: 'usami.agent.tool.v1',
      name: 'focus.pause',
      version: '1.0.0',
      description: 'Pausa a sessão de foco ativa.',
      origin: 'skill',
      permissionLevel: 2,
      timeoutMs: 2000,
      parameters: [
        { name: 'sessionId', type: 'string', required: false, description: 'ID da sessão (padrão: ativa)' },
      ],
      verify: (result) => result && result.ok === true && result.session && result.session.status === 'paused',
    },
    {
      schema: 'usami.agent.tool.v1',
      name: 'focus.resume',
      version: '1.0.0',
      description: 'Retoma a sessão de foco pausada.',
      origin: 'skill',
      permissionLevel: 2,
      timeoutMs: 2000,
      parameters: [
        { name: 'sessionId', type: 'string', required: false, description: 'ID da sessão (padrão: pausada)' },
      ],
      verify: (result) => result && result.ok === true && result.session && result.session.status === 'active',
    },
    {
      schema: 'usami.agent.tool.v1',
      name: 'focus.stop',
      version: '1.0.0',
      description: 'Finaliza a sessão de foco ativa/pausada e registra duração.',
      origin: 'skill',
      permissionLevel: 2,
      timeoutMs: 3000,
      parameters: [
        { name: 'sessionId', type: 'string', required: false, description: 'ID da sessão (padrão: ativa/pausada)' },
        { name: 'notes', type: 'string', required: false, description: 'Notas finais' },
      ],
      verify: (result) => result && result.ok === true && result.session && result.session.status === 'completed' && typeof result.actualDurationMinutes === 'number',
    },
    {
      schema: 'usami.agent.tool.v1',
      name: 'focus.cancel',
      version: '1.0.0',
      description: 'Cancela a sessão de foco ativa/pausada sem contar tempo.',
      origin: 'skill',
      permissionLevel: 2,
      timeoutMs: 2000,
      parameters: [
        { name: 'sessionId', type: 'string', required: false, description: 'ID da sessão (padrão: ativa/pausada)' },
      ],
      verify: (result) => result && result.ok === true && result.session && result.session.status === 'cancelled',
    },
    {
      schema: 'usami.agent.tool.v1',
      name: 'focus.break',
      version: '1.0.0',
      description: 'Registra uma pausa realizada durante a sessão.',
      origin: 'skill',
      permissionLevel: 2,
      timeoutMs: 2000,
      parameters: [
        { name: 'sessionId', type: 'string', required: false, description: 'ID da sessão (padrão: ativa)' },
      ],
      verify: (result) => result && result.ok === true && result.session && typeof result.breaksTaken === 'number',
    },
    {
      schema: 'usami.agent.tool.v1',
      name: 'focus.distraction',
      version: '1.0.0',
      description: 'Registra distração bloqueada (incrementa contador).',
      origin: 'skill',
      permissionLevel: 2,
      timeoutMs: 2000,
      parameters: [
        { name: 'sessionId', type: 'string', required: false, description: 'ID da sessão (padrão: ativa)' },
        { name: 'count', type: 'number', required: false, description: 'Quantidade (padrão: 1)' },
      ],
      verify: (result) => result && result.ok === true && result.session && typeof result.distractionsBlocked === 'number',
    },
    {
      schema: 'usami.agent.tool.v1',
      name: 'focus.status',
      version: '1.0.0',
      description: 'Retorna status da sessão ativa (progresso, tempo restante, perfil).',
      origin: 'skill',
      permissionLevel: 1,
      timeoutMs: 2000,
      parameters: [],
      verify: (result) => result && result.ok === true && typeof result.active === 'boolean',
    },
    {
      schema: 'usami.agent.tool.v1',
      name: 'focus.sessions',
      version: '1.0.0',
      description: 'Lista sessões com filtros opcionais.',
      origin: 'skill',
      permissionLevel: 1,
      timeoutMs: 3000,
      parameters: [
        { name: 'status', type: 'string', required: false, description: 'Filtrar por status: active, paused, completed, cancelled', enum: ['active', 'paused', 'completed', 'cancelled'] },
        { name: 'profileId', type: 'string', required: false, description: 'Filtrar por perfil' },
        { name: 'since', type: 'string', required: false, description: 'Data inicial (ISO-8601)' },
        { name: 'until', type: 'string', required: false, description: 'Data final (ISO-8601)' },
        { name: 'limit', type: 'number', required: false, description: 'Limite (padrão: 50)' },
      ],
      verify: (result) => result && result.ok === true && Array.isArray(result.sessions) && typeof result.count === 'number',
    },
    {
      schema: 'usami.agent.tool.v1',
      name: 'focus.stats',
      version: '1.0.0',
      description: 'Retorna estatísticas agregadas de foco.',
      origin: 'skill',
      permissionLevel: 1,
      timeoutMs: 3000,
      parameters: [
        { name: 'since', type: 'string', required: false, description: 'Data inicial (ISO-8601)' },
        { name: 'until', type: 'string', required: false, description: 'Data final (ISO-8601)' },
        { name: 'profileId', type: 'string', required: false, description: 'Filtrar por perfil' },
      ],
      verify: (result) => result && result.ok === true && typeof result.totalSessions === 'number' && typeof result.totalMinutes === 'number',
    },
    // Profiles
    {
      schema: 'usami.agent.tool.v1',
      name: 'focus.profile.upsert',
      version: '1.0.0',
      description: 'Cria ou atualiza um perfil de foco.',
      origin: 'skill',
      permissionLevel: 2,
      timeoutMs: 3000,
      parameters: [
        { name: 'id', type: 'string', required: false, description: 'ID do perfil para atualização' },
        { name: 'name', type: 'string', required: true, description: 'Nome do perfil' },
        { name: 'description', type: 'string', required: false, description: 'Descrição' },
        { name: 'plannedDurationMinutes', type: 'number', required: false, description: 'Duração planejada padrão (min)' },
        { name: 'breakIntervalMinutes', type: 'number', required: false, description: 'Intervalo para pausa (min)' },
        { name: 'breakDurationMinutes', type: 'number', required: false, description: 'Duração da pausa (min)' },
        { name: 'blocklistIds', type: 'array', required: false, description: 'IDs das blocklists', items: { type: 'string' } },
        { name: 'allowNotifications', type: 'boolean', required: false, description: 'Permitir notificações' },
        { name: 'autoStartBreaks', type: 'boolean', required: false, description: 'Iniciar pausas automaticamente' },
        { name: 'soundEnabled', type: 'boolean', required: false, description: 'Sons habilitados' },
        { name: 'color', type: 'string', required: false, description: 'Cor hex' },
      ],
      verify: (result) => result && result.ok === true && result.profile && typeof result.profile.id === 'string',
    },
    {
      schema: 'usami.agent.tool.v1',
      name: 'focus.profile.list',
      version: '1.0.0',
      description: 'Lista todos os perfis de foco.',
      origin: 'skill',
      permissionLevel: 1,
      timeoutMs: 2000,
      parameters: [],
      verify: (result) => result && result.ok === true && Array.isArray(result.profiles) && typeof result.count === 'number',
    },
    {
      schema: 'usami.agent.tool.v1',
      name: 'focus.profile.delete',
      version: '1.0.0',
      description: 'Remove um perfil (se não estiver em uso).',
      origin: 'skill',
      permissionLevel: 3,
      timeoutMs: 2000,
      parameters: [
        { name: 'id', type: 'string', required: true, description: 'ID do perfil' },
      ],
      verify: (result) => result && result.ok === true && result.removed === true,
    },
    // Blocklists
    {
      schema: 'usami.agent.tool.v1',
      name: 'focus.blocklist.upsert',
      version: '1.0.0',
      description: 'Cria ou atualiza uma blocklist de sites/apps.',
      origin: 'skill',
      permissionLevel: 2,
      timeoutMs: 3000,
      parameters: [
        { name: 'id', type: 'string', required: false, description: 'ID da blocklist para atualização' },
        { name: 'name', type: 'string', required: true, description: 'Nome da blocklist' },
        { name: 'description', type: 'string', required: false, description: 'Descrição' },
        { name: 'type', type: 'string', required: false, description: 'Tipo: websites, apps, custom', enum: ['websites', 'apps', 'custom'] },
        { name: 'entries', type: 'array', required: false, description: 'Lista de domínios/entradas', items: { type: 'string' } },
        { name: 'enabled', type: 'boolean', required: false, description: 'Blocklist ativa' },
      ],
      verify: (result) => result && result.ok === true && result.blocklist && typeof result.blocklist.id === 'string',
    },
    {
      schema: 'usami.agent.tool.v1',
      name: 'focus.blocklist.get',
      version: '1.0.0',
      description: 'Obtém uma blocklist por ID.',
      origin: 'skill',
      permissionLevel: 1,
      timeoutMs: 2000,
      parameters: [
        { name: 'id', type: 'string', required: true, description: 'ID da blocklist' },
      ],
      verify: (result) => result && result.ok === true && result.blocklist && typeof result.blocklist.id === 'string',
    },
    {
      schema: 'usami.agent.tool.v1',
      name: 'focus.blocklist.list',
      version: '1.0.0',
      description: 'Lista blocklists com filtro opcional por ativo.',
      origin: 'skill',
      permissionLevel: 1,
      timeoutMs: 2000,
      parameters: [
        { name: 'enabled', type: 'boolean', required: false, description: 'Filtrar apenas ativas/inativas' },
      ],
      verify: (result) => result && result.ok === true && Array.isArray(result.blocklists) && typeof result.count === 'number',
    },
    {
      schema: 'usami.agent.tool.v1',
      name: 'focus.blocklist.delete',
      version: '1.0.0',
      description: 'Remove uma blocklist (se não estiver em uso).',
      origin: 'skill',
      permissionLevel: 3,
      timeoutMs: 2000,
      parameters: [
        { name: 'id', type: 'string', required: true, description: 'ID da blocklist' },
      ],
      verify: (result) => result && result.ok === true && result.removed === true,
    },
    // Settings
    {
      schema: 'usami.agent.tool.v1',
      name: 'focus.settings.get',
      version: '1.0.0',
      description: 'Obtém configurações globais do Focus Guardian.',
      origin: 'skill',
      permissionLevel: 1,
      timeoutMs: 2000,
      parameters: [],
      verify: (result) => result && result.ok === true && result.settings && typeof result.settings === 'object',
    },
    {
      schema: 'usami.agent.tool.v1',
      name: 'focus.settings.update',
      version: '1.0.0',
      description: 'Atualiza configurações globais.',
      origin: 'skill',
      permissionLevel: 2,
      timeoutMs: 2000,
      parameters: [
        { name: 'defaultProfile', type: 'string', required: false, description: 'Perfil padrão (nome ou ID)' },
        { name: 'breakReminderEnabled', type: 'boolean', required: false, description: 'Lembretes de pausa ativados' },
        { name: 'breakReminderIntervalMinutes', type: 'number', required: false, description: 'Intervalo do lembrete (min)' },
        { name: 'autoStartBreaks', type: 'boolean', required: false, description: 'Auto-iniciar pausas' },
      ],
      verify: (result) => result && result.ok === true && result.settings && typeof result.settings === 'object',
    },
    // Integration
    {
      schema: 'usami.agent.tool.v1',
      name: 'focus.check-blocked',
      version: '1.0.0',
      description: 'Verifica se uma URL está bloqueada pelas blocklists do perfil atual/ativo.',
      origin: 'skill',
      permissionLevel: 1,
      timeoutMs: 2000,
      parameters: [
        { name: 'url', type: 'string', required: true, description: 'URL para verificar' },
        { name: 'profileId', type: 'string', required: false, description: 'ID do perfil (padrão: ativo/padrão)' },
      ],
      verify: (result) => result && result.ok === true && typeof result.blocked === 'boolean',
    },
  ];

  return {
    // Session control
    startFocusSession,
    pauseFocusSession,
    resumeFocusSession,
    stopFocusSession,
    cancelFocusSession,
    takeBreak,
    recordDistractionBlocked,
    getFocusStatus,
    listFocusSessions,
    getFocusStats,
    // Profiles
    upsertProfile,
    getProfile,
    listProfiles,
    deleteProfile,
    // Blocklists
    upsertBlocklist,
    getBlocklist,
    listBlocklists,
    deleteBlocklist,
    // Settings
    getSettings,
    updateSettings,
    // Integration
    checkBlocked,
    // Store
    focusStore,
    // Tool specs
    toolSpecs,
  };
}