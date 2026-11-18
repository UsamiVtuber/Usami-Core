/**
 * Focus Guardian Store
 * Dedicated JSON store for focus sessions, profiles, and blocklists.
 * Lazy-loads on first write; preserves data across instances.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir as resolveDataDir } from '../../src/data-paths.js';

const FILE_VERSION = 1;

function generateId(prefix = 'focus') {
  return `${prefix}-${Math.random().toString(36).slice(2, 14)}`;
}

function isoNow() {
  return new Date().toISOString();
}

function defaultData() {
  return {
    version: FILE_VERSION,
    sessions: [],
    profiles: [],
    blocklists: [],
    settings: {
      defaultProfile: 'Deep Work',
      breakReminderEnabled: true,
      breakReminderIntervalMinutes: 50,
      autoStartBreaks: false,
    },
    updatedAt: isoNow(),
  };
}

function normalize(input) {
  if (!input || typeof input !== 'object') return defaultData();
  if (input.version !== FILE_VERSION) {
    // Future migration logic here
  }
  return {
    version: FILE_VERSION,
    sessions: Array.isArray(input.sessions) ? input.sessions : [],
    profiles: Array.isArray(input.profiles) ? input.profiles : [],
    blocklists: Array.isArray(input.blocklists) ? input.blocklists : [],
    settings: { ...defaultData().settings, ...(input.settings || {}) },
    updatedAt: typeof input.updatedAt === 'string' ? input.updatedAt : isoNow(),
  };
}

export function createFocusStore({ dataDir = resolveDataDir() } = {}) {
  const filePath = join(dataDir, 'focus-sessions.json');
  let data = defaultData();
  let loaded = false;

  function ensureLoaded() {
    if (loaded) return;
    if (existsSync(filePath)) {
      try {
        data = normalize(JSON.parse(readFileSync(filePath, 'utf8')));
      } catch {
        data = defaultData();
      }
    }
    loaded = true;
  }

  function persist() {
    ensureLoaded();
    data.updatedAt = isoNow();
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  }

  function snapshot() {
    ensureLoaded();
    return {
      sessions: data.sessions.map(s => ({ ...s })),
      profiles: data.profiles.map(p => ({ ...p })),
      blocklists: data.blocklists.map(b => ({ ...b })),
      settings: { ...data.settings },
      updatedAt: data.updatedAt,
    };
  }

  // --- Sessions ---

  function createSession(session) {
    ensureLoaded();
    const now = isoNow();
    const newSession = {
      id: session.id || generateId('session'),
      profileId: session.profileId || data.settings.defaultProfile,
      status: 'active', // active, paused, completed, cancelled
      plannedDurationMinutes: session.plannedDurationMinutes || 25,
      actualDurationMinutes: 0,
      startedAt: session.startedAt || now,
      endedAt: null,
      pausedAt: null,
      totalPausedDurationMs: 0,
      breaksTaken: 0,
      distractionsBlocked: 0,
      notes: session.notes || '',
      metadata: session.metadata || {},
      createdAt: now,
      updatedAt: now,
    };
    data.sessions.push(newSession);
    persist();
    return { ok: true, session: { ...newSession } };
  }

  function getSession(id) {
    ensureLoaded();
    const session = data.sessions.find(s => s.id === id);
    return session ? { ...session } : null;
  }

  function getActiveSession() {
    ensureLoaded();
    const session = data.sessions.find(s => s.status === 'active' || s.status === 'paused');
    return session ? { ...session } : null;
  }

  function updateSession(id, patch) {
    ensureLoaded();
    const index = data.sessions.findIndex(s => s.id === id);
    if (index < 0) return { ok: false, notFound: true };

    const current = data.sessions[index];
    const next = { ...current };
    const changed = [];

    const editableFields = ['status', 'plannedDurationMinutes', 'actualDurationMinutes', 'endedAt', 'pausedAt', 'totalPausedDurationMs', 'breaksTaken', 'distractionsBlocked', 'notes', 'metadata'];
    for (const field of editableFields) {
      if (field in patch) {
        next[field] = patch[field];
        changed.push(field);
      }
    }

    if (!changed.length) return { ok: true, session: { ...current }, changed: [] };

    next.updatedAt = isoNow();
    data.sessions[index] = next;
    persist();
    return { ok: true, session: { ...next }, changed };
  }

  function listSessions({ limit = 100, status, profileId, since, until } = {}) {
    ensureLoaded();
    let sessions = data.sessions;

    if (status) {
      sessions = sessions.filter(s => s.status === status);
    }
    if (profileId) {
      sessions = sessions.filter(s => s.profileId === profileId);
    }
    if (since) {
      const sinceDate = new Date(since);
      sessions = sessions.filter(s => new Date(s.startedAt) >= sinceDate);
    }
    if (until) {
      const untilDate = new Date(until);
      sessions = sessions.filter(s => new Date(s.startedAt) <= untilDate);
    }

    sessions = [...sessions].sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));

    if (limit > 0) sessions = sessions.slice(0, limit);

    return sessions.map(s => ({ ...s }));
  }

  function getSessionStats({ since, until, profileId } = {}) {
    ensureLoaded();
    let sessions = data.sessions.filter(s => s.status === 'completed');

    if (since) {
      const sinceDate = new Date(since);
      sessions = sessions.filter(s => new Date(s.startedAt) >= sinceDate);
    }
    if (until) {
      const untilDate = new Date(until);
      sessions = sessions.filter(s => new Date(s.startedAt) <= untilDate);
    }
    if (profileId) {
      sessions = sessions.filter(s => s.profileId === profileId);
    }

    const totalSessions = sessions.length;
    const totalMinutes = sessions.reduce((sum, s) => sum + (s.actualDurationMinutes || 0), 0);
    const totalBreaks = sessions.reduce((sum, s) => sum + (s.breaksTaken || 0), 0);
    const totalDistractionsBlocked = sessions.reduce((sum, s) => sum + (s.distractionsBlocked || 0), 0);
    const avgDuration = totalSessions > 0 ? Math.round(totalMinutes / totalSessions) : 0;

    // Group by date
    const byDate = {};
    for (const s of sessions) {
      const date = s.startedAt.split('T')[0];
      if (!byDate[date]) byDate[date] = { sessions: 0, minutes: 0 };
      byDate[date].sessions++;
      byDate[date].minutes += s.actualDurationMinutes || 0;
    }

    return {
      totalSessions,
      totalMinutes,
      totalBreaks,
      totalDistractionsBlocked,
      avgDurationMinutes: avgDuration,
      byDate,
    };
  }

  // --- Profiles ---

  function createProfile(profile) {
    ensureLoaded();
    const now = isoNow();
    const newProfile = {
      id: profile.id || generateId('profile'),
      name: profile.name,
      description: profile.description || '',
      plannedDurationMinutes: profile.plannedDurationMinutes || 25,
      breakIntervalMinutes: profile.breakIntervalMinutes || 50,
      breakDurationMinutes: profile.breakDurationMinutes || 5,
      blocklistIds: profile.blocklistIds || [],
      allowNotifications: profile.allowNotifications !== false,
      autoStartBreaks: profile.autoStartBreaks || false,
      soundEnabled: profile.soundEnabled !== false,
      color: profile.color || '#4A90D9',
      createdAt: now,
      updatedAt: now,
    };
    data.profiles.push(newProfile);
    persist();
    return { ok: true, profile: { ...newProfile } };
  }

  function getProfile(id) {
    ensureLoaded();
    const profile = data.profiles.find(p => p.id === id);
    return profile ? { ...profile } : null;
  }

  function getProfileByName(name) {
    ensureLoaded();
    const profile = data.profiles.find(p => p.name.toLowerCase() === name.toLowerCase());
    return profile ? { ...profile } : null;
  }

  function updateProfile(id, patch) {
    ensureLoaded();
    const index = data.profiles.findIndex(p => p.id === id);
    if (index < 0) return { ok: false, notFound: true };

    const current = data.profiles[index];
    const next = { ...current };
    const changed = [];

    const editableFields = ['name', 'description', 'plannedDurationMinutes', 'breakIntervalMinutes', 'breakDurationMinutes', 'blocklistIds', 'allowNotifications', 'autoStartBreaks', 'soundEnabled', 'color'];
    for (const field of editableFields) {
      if (field in patch) {
        next[field] = patch[field];
        changed.push(field);
      }
    }

    if (!changed.length) return { ok: true, profile: { ...current }, changed: [] };

    next.updatedAt = isoNow();
    data.profiles[index] = next;
    persist();
    return { ok: true, profile: { ...next }, changed };
  }

  function listProfiles() {
    ensureLoaded();
    return data.profiles.map(p => ({ ...p }));
  }

  function deleteProfile(id) {
    ensureLoaded();
    const index = data.profiles.findIndex(p => p.id === id);
    if (index < 0) return { ok: false, notFound: true };

    // Check if any session uses this profile
    const inUse = data.sessions.some(s => s.profileId === id);
    if (inUse) return { ok: false, errors: ['profile in use by sessions'] };

    data.profiles.splice(index, 1);
    persist();
    return { ok: true, removed: true };
  }

  // --- Blocklists ---

  function createBlocklist(blocklist) {
    ensureLoaded();
    const now = isoNow();
    const newBlocklist = {
      id: blocklist.id || generateId('blocklist'),
      name: blocklist.name,
      description: blocklist.description || '',
      type: blocklist.type || 'websites', // websites, apps, custom
      entries: Array.isArray(blocklist.entries) ? blocklist.entries : [],
      enabled: blocklist.enabled !== false,
      createdAt: now,
      updatedAt: now,
    };
    data.blocklists.push(newBlocklist);
    persist();
    return { ok: true, blocklist: { ...newBlocklist } };
  }

  function getBlocklist(id) {
    ensureLoaded();
    const blocklist = data.blocklists.find(b => b.id === id);
    return blocklist ? { ...blocklist } : null;
  }

  function updateBlocklist(id, patch) {
    ensureLoaded();
    const index = data.blocklists.findIndex(b => b.id === id);
    if (index < 0) return { ok: false, notFound: true };

    const current = data.blocklists[index];
    const next = { ...current };
    const changed = [];

    const editableFields = ['name', 'description', 'type', 'entries', 'enabled'];
    for (const field of editableFields) {
      if (field in patch) {
        next[field] = patch[field];
        changed.push(field);
      }
    }

    if (!changed.length) return { ok: true, blocklist: { ...current }, changed: [] };

    next.updatedAt = isoNow();
    data.blocklists[index] = next;
    persist();
    return { ok: true, blocklist: { ...next }, changed };
  }

  function listBlocklists({ enabled } = {}) {
    ensureLoaded();
    let blocklists = data.blocklists;
    if (enabled !== undefined) {
      blocklists = blocklists.filter(b => b.enabled === enabled);
    }
    return blocklists.map(b => ({ ...b }));
  }

  function deleteBlocklist(id) {
    ensureLoaded();
    const index = data.blocklists.findIndex(b => b.id === id);
    if (index < 0) return { ok: false, notFound: true };

    // Check if any profile uses this blocklist
    const inUse = data.profiles.some(p => p.blocklistIds?.includes(id));
    if (inUse) return { ok: false, errors: ['blocklist in use by profiles'] };

    data.blocklists.splice(index, 1);
    persist();
    return { ok: true, removed: true };
  }

  // --- Settings ---

  function getSettings() {
    ensureLoaded();
    return { ...data.settings };
  }

  function updateSettings(patch) {
    ensureLoaded();
    const next = { ...data.settings, ...patch };
    data.settings = next;
    persist();
    return { ok: true, settings: { ...next } };
  }

  // --- Default profiles/blocklists initialization ---

  function initializeDefaults() {
    ensureLoaded();
    if (data.profiles.length === 0) {
      // Deep Work profile
      data.profiles.push({
        id: generateId('profile'),
        name: 'Deep Work',
        description: 'Foco profundo, sem distrações, sessões longas',
        plannedDurationMinutes: 50,
        breakIntervalMinutes: 50,
        breakDurationMinutes: 10,
        blocklistIds: [],
        allowNotifications: false,
        autoStartBreaks: true,
        soundEnabled: true,
        color: '#2E7D32',
        createdAt: isoNow(),
        updatedAt: isoNow(),
      });

      // Pomodoro profile
      data.profiles.push({
        id: generateId('profile'),
        name: 'Pomodoro',
        description: 'Sessões curtas de 25min com pausas de 5min',
        plannedDurationMinutes: 25,
        breakIntervalMinutes: 25,
        breakDurationMinutes: 5,
        blocklistIds: [],
        allowNotifications: true,
        autoStartBreaks: true,
        soundEnabled: true,
        color: '#C62828',
        createdAt: isoNow(),
        updatedAt: isoNow(),
      });

      // Light Focus profile
      data.profiles.push({
        id: generateId('profile'),
        name: 'Light Focus',
        description: 'Foco leve, notificações permitidas',
        plannedDurationMinutes: 45,
        breakIntervalMinutes: 45,
        breakDurationMinutes: 5,
        blocklistIds: [],
        allowNotifications: true,
        autoStartBreaks: false,
        soundEnabled: false,
        color: '#F57F17',
        createdAt: isoNow(),
        updatedAt: isoNow(),
      });

      // Default blocklist - Social Media
      const socialBlocklistId = generateId('blocklist');
      data.blocklists.push({
        id: socialBlocklistId,
        name: 'Redes Sociais',
        description: 'Bloqueia principais redes sociais',
        type: 'websites',
        entries: [
          'facebook.com', 'twitter.com', 'x.com', 'instagram.com',
          'tiktok.com', 'linkedin.com', 'reddit.com', 'youtube.com',
          'discord.com', 'whatsapp.com', 'telegram.org'
        ],
        enabled: true,
        createdAt: isoNow(),
        updatedAt: isoNow(),
      });

      // Default blocklist - Entertainment
      const entertainmentBlocklistId = generateId('blocklist');
      data.blocklists.push({
        id: entertainmentBlocklistId,
        name: 'Entretenimento',
        description: 'Bloqueia sites de streaming e jogos',
        type: 'websites',
        entries: [
          'netflix.com', 'hulu.com', 'disneyplus.com', 'primevideo.com',
          'twitch.tv', 'steam.com', 'epicgames.com', 'battle.net',
          'spotify.com', 'soundcloud.com'
        ],
        enabled: true,
        createdAt: isoNow(),
        updatedAt: isoNow(),
      });

      // Link blocklists to Deep Work profile
      const deepWorkProfile = data.profiles.find(p => p.name === 'Deep Work');
      if (deepWorkProfile) {
        deepWorkProfile.blocklistIds = [socialBlocklistId, entertainmentBlocklistId];
      }

      persist();
    }
  }

  return {
    // Sessions
    createSession,
    getSession,
    getActiveSession,
    updateSession,
    listSessions,
    getSessionStats,
    // Profiles
    createProfile,
    getProfile,
    getProfileByName,
    updateProfile,
    listProfiles,
    deleteProfile,
    // Blocklists
    createBlocklist,
    getBlocklist,
    updateBlocklist,
    listBlocklists,
    deleteBlocklist,
    // Settings
    getSettings,
    updateSettings,
    // Init
    initializeDefaults,
    // For testing/debugging
    _ensureLoaded: ensureLoaded,
    _getRaw: () => snapshot(),
  };
}