/**
 * Núcleo puro da skill Spotify Player (normalização e validação sem I/O).
 */

export const SPOTIFY_SCHEMA = 'usami.skill.spotify.v1';

const VALID_ACTIONS = new Set(['play', 'pause', 'next', 'previous', 'volume', 'shuffle']);
const VALID_SEARCH_TYPES = new Set(['track', 'album', 'artist', 'playlist']);
const SPOTIFY_URI_RE = /^spotify:(?:track|album|artist|playlist):[a-zA-Z0-9]+$/;

export function normalizeTrack(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const artists = Array.isArray(raw.artists)
    ? raw.artists.map(a => a?.name).filter(Boolean)
    : [];
  return {
    id: raw.id || null,
    uri: raw.uri || null,
    name: raw.name || 'Faixa desconhecida',
    artists,
    album: raw.album?.name || null,
    durationMs: Number.isFinite(raw.duration_ms) ? raw.duration_ms : null,
    url: raw.external_urls?.spotify || null,
  };
}

export function normalizePlaybackState(raw) {
  if (!raw || typeof raw !== 'object') {
    return { playing: false, track: null, device: null, progressMs: 0 };
  }
  const item = raw.item && raw.item.type === 'track'
    ? normalizeTrack(raw.item)
    : raw.item
      ? {
          id: raw.item.id || null,
          uri: raw.item.uri || null,
          name: raw.item.name || 'Conteúdo atual',
          artists: [],
          album: raw.item.show?.name || null,
          durationMs: Number.isFinite(raw.item.duration_ms) ? raw.item.duration_ms : null,
          url: raw.item.external_urls?.spotify || null,
        }
      : null;

  return {
    playing: Boolean(raw.is_playing),
    progressMs: Number.isFinite(raw.progress_ms) ? raw.progress_ms : 0,
    shuffle: Boolean(raw.shuffle_state),
    repeat: raw.repeat_state || 'off',
    device: raw.device
      ? {
          id: raw.device.id || null,
          name: raw.device.name || 'Dispositivo',
          type: raw.device.type || null,
          volumePercent: Number.isFinite(raw.device.volume_percent) ? raw.device.volume_percent : null,
        }
      : null,
    track: item,
  };
}

export function normalizePlaylist(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    id: raw.id || null,
    uri: raw.uri || null,
    name: raw.name || 'Playlist sem nome',
    owner: raw.owner?.display_name || raw.owner?.id || null,
    tracksTotal: Number.isFinite(raw.tracks?.total) ? raw.tracks.total : 0,
    public: Boolean(raw.public),
    url: raw.external_urls?.spotify || null,
  };
}

export function buildSearchParams({ query, type = 'track', limit = 5 } = {}) {
  const cleanQuery = String(query || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!cleanQuery) {
    throw new Error('query é obrigatória para buscar no Spotify.');
  }
  const cleanType = VALID_SEARCH_TYPES.has(type) ? type : 'track';
  const cleanLimit = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 20) : 5;
  return new URLSearchParams({
    q: cleanQuery,
    type: cleanType,
    limit: String(cleanLimit),
  });
}

export function validatePlaybackCommand(args = {}) {
  const action = String(args.action || '').trim().toLowerCase();
  if (!VALID_ACTIONS.has(action)) {
    throw new Error(`Ação Spotify inválida: ${args.action || '(vazia)'}. Use: ${[...VALID_ACTIONS].join(', ')}.`);
  }

  const out = { action };
  if (args.deviceId !== undefined && args.deviceId !== null) {
    const dev = String(args.deviceId).trim();
    if (dev) out.deviceId = dev.slice(0, 120);
  }

  if (action === 'play') {
    if (typeof args.uri === 'string' && args.uri.trim()) {
      const uri = args.uri.trim();
      if (!SPOTIFY_URI_RE.test(uri)) {
        throw new Error('URI Spotify inválida (esperado spotify:track|album|artist|playlist:<id>).');
      }
      out.uri = uri;
    } else if (typeof args.query === 'string' && args.query.trim()) {
      out.query = args.query.trim().slice(0, 200);
    }
  }

  if (action === 'volume') {
    const vol = Number(args.volumePercent);
    if (!Number.isFinite(vol) || vol < 0 || vol > 100) {
      throw new Error('volumePercent deve estar entre 0 e 100.');
    }
    out.volumePercent = Math.round(vol);
  }

  if (action === 'shuffle') {
    out.shuffleState = args.shuffleState !== false;
  }

  return out;
}

const VALID_STATS_PERIODS = new Set(['24h', '7d', '30d', 'all']);

export function normalizeStatsQuery({ period = '7d', limit = 5 } = {}) {
  const cleanPeriod = String(period || '7d').trim().toLowerCase();
  const safePeriod = VALID_STATS_PERIODS.has(cleanPeriod) ? cleanPeriod : '7d';
  const cleanLimit = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 20) : 5;
  return { period: safePeriod, limit: cleanLimit };
}

export function normalizeStatsResponse(raw, fallbackPeriod = '7d') {
  if (!raw || typeof raw !== 'object') {
    return {
      period: fallbackPeriod,
      totalScrobbles: 0,
      uniqueTracks: 0,
      topTracks: [],
      topArtists: [],
      recent: [],
    };
  }
  return {
    period: typeof raw.period === 'string' ? raw.period : fallbackPeriod,
    totalScrobbles: Number.isFinite(Number(raw.totalScrobbles)) ? Number(raw.totalScrobbles) : 0,
    uniqueTracks: Number.isFinite(Number(raw.uniqueTracks)) ? Number(raw.uniqueTracks) : 0,
    topTracks: Array.isArray(raw.topTracks) ? raw.topTracks : [],
    topArtists: Array.isArray(raw.topArtists) ? raw.topArtists : [],
    recent: Array.isArray(raw.recent) ? raw.recent : [],
  };
}
