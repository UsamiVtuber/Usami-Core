/**
 * Skill operacional Spotify Player (Spotify Web API via OAuth2 PKCE).
 *
 * Publica `skills/spotify-player` em `dataDir/skills` quando ausente e registra:
 *  - `spotify.now_playing` (nível 3): consulta faixa/dispositivo atual;
 *  - `spotify.search` (nível 3): busca faixas, álbuns, artistas ou playlists;
 *  - `spotify.playlists` (nível 3): lista playlists do usuário;
 *  - `spotify.control` (nível 3): play/pause/next/previous/volume/shuffle.
 */
import { AGENT_SCHEMAS } from './agent-contracts.js';
import { readEnvValue } from './api-security.js';
import { publishSkillPackage } from './skill-package.js';
import { createSpotifyAuthClient } from './spotify-auth.js';
import {
  SPOTIFY_SCHEMA,
  buildSearchParams,
  normalizePlaybackState,
  normalizePlaylist,
  normalizeStatsQuery,
  normalizeStatsResponse,
  normalizeTrack,
  validatePlaybackCommand,
} from '../skills/spotify-player/spotify-core.mjs';

export const SPOTIFY_SKILL_ID = 'spotify-player';
export const SPOTIFY_TOOLS = Object.freeze([
  'spotify.now_playing',
  'spotify.search',
  'spotify.playlists',
  'spotify.control',
  'spotify.stats',
]);

const DEFAULT_SPOTIFY_STATS_URL = 'http://10.42.0.1:5678/webhook/usami-spotify-stats';

const SPOTIFY_API_BASE = 'https://api.spotify.com/v1';
const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export function publishSpotifySkill({ dataDir, bundledDir } = {}) {
  return publishSkillPackage({ skillId: SPOTIFY_SKILL_ID, dataDir, bundledDir });
}

function appendDevice(url, deviceId) {
  if (!deviceId) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}device_id=${encodeURIComponent(deviceId)}`;
}

export function createSpotifyTools({
  spotifyAuth = createSpotifyAuthClient(),
  onTelemetry = null,
  statsUrlProvider = () => readEnvValue('N8N_SPOTIFY_STATS_URL') || DEFAULT_SPOTIFY_STATS_URL,
  fetchImpl = (...args) => fetch(...args),
} = {}) {
  function emitTelemetry(tool, extra = {}) {
    if (typeof onTelemetry !== 'function') return;
    try {
      Promise.resolve(onTelemetry({ tool, ...extra })).catch(() => {});
    } catch {
      // telemetria nunca bloqueia a tool
    }
  }

  function wrapTool(tool) {
    const origExecute = tool.execute.bind(tool);
    return {
      ...tool,
      async execute(args = {}) {
        const started = Date.now();
        try {
          const res = await origExecute(args);
          emitTelemetry(tool.name, {
            ok: true,
            durationMs: Date.now() - started,
            action: args?.action || null,
          });
          return res;
        } catch (err) {
          emitTelemetry(tool.name, {
            ok: false,
            isError: true,
            durationMs: Date.now() - started,
            action: args?.action || null,
            errorMessage: String(err?.message || err),
          });
          throw err;
        }
      },
    };
  }
  const nowPlayingTool = {
    schema: AGENT_SCHEMAS.tool,
    name: 'spotify.now_playing',
    version: '1.0.0',
    description: 'Mostra a música ou episódio tocando agora no Spotify, artista, progresso e dispositivo ativo.',
    origin: 'skill',
    permissionLevel: 3,
    timeoutMs: 10000,
    parameters: [],
    verify(result) {
      return isPlainObject(result) && result.ok === true && result.schema === SPOTIFY_SCHEMA;
    },
    async execute() {
      const raw = await spotifyAuth.requestJson(`${SPOTIFY_API_BASE}/me/player`);
      return {
        ok: true,
        schema: SPOTIFY_SCHEMA,
        ...normalizePlaybackState(raw),
      };
    },
  };

  const searchTool = {
    schema: AGENT_SCHEMAS.tool,
    name: 'spotify.search',
    version: '1.0.0',
    description: 'Busca faixas, artistas, álbuns ou playlists no catálogo do Spotify.',
    origin: 'skill',
    permissionLevel: 3,
    timeoutMs: 10000,
    parameters: [
      { name: 'query', type: 'string', required: true, description: 'Texto da busca (ex.: nome da música ou artista).' },
      { name: 'type', type: 'string', required: false, description: 'track | album | artist | playlist (padrão track).' },
      { name: 'limit', type: 'number', required: false, description: 'Quantidade de resultados (1 a 20, padrão 5).' },
    ],
    verify(result) {
      return isPlainObject(result) && result.ok === true && result.schema === SPOTIFY_SCHEMA && Array.isArray(result.items);
    },
    async execute(args = {}) {
      const params = buildSearchParams(args);
      const type = params.get('type');
      const data = await spotifyAuth.requestJson(`${SPOTIFY_API_BASE}/search?${params.toString()}`);

      let items = [];
      if (type === 'track') {
        items = (data?.tracks?.items || []).map(normalizeTrack).filter(Boolean);
      } else if (type === 'playlist') {
        items = (data?.playlists?.items || []).map(normalizePlaylist).filter(Boolean);
      } else if (type === 'album') {
        items = (data?.albums?.items || []).map(item => ({
          id: item?.id || null,
          uri: item?.uri || null,
          name: item?.name || 'Álbum',
          artists: Array.isArray(item?.artists) ? item.artists.map(a => a?.name).filter(Boolean) : [],
          url: item?.external_urls?.spotify || null,
        }));
      } else if (type === 'artist') {
        items = (data?.artists?.items || []).map(item => ({
          id: item?.id || null,
          uri: item?.uri || null,
          name: item?.name || 'Artista',
          genres: Array.isArray(item?.genres) ? item.genres.slice(0, 5) : [],
          url: item?.external_urls?.spotify || null,
        }));
      }

      return {
        ok: true,
        schema: SPOTIFY_SCHEMA,
        type,
        count: items.length,
        items,
      };
    },
  };

  const playlistsTool = {
    schema: AGENT_SCHEMAS.tool,
    name: 'spotify.playlists',
    version: '1.0.0',
    description: 'Lista as playlists da conta conectada no Spotify.',
    origin: 'skill',
    permissionLevel: 3,
    timeoutMs: 10000,
    parameters: [
      { name: 'limit', type: 'number', required: false, description: 'Máximo de playlists (1 a 50, padrão 20).' },
    ],
    verify(result) {
      return isPlainObject(result) && result.ok === true && result.schema === SPOTIFY_SCHEMA && Array.isArray(result.playlists);
    },
    async execute(args = {}) {
      const limit = Number.isInteger(args.limit) ? Math.min(Math.max(args.limit, 1), 50) : 20;
      const data = await spotifyAuth.requestJson(`${SPOTIFY_API_BASE}/me/playlists?limit=${limit}`);
      const playlists = (data?.items || []).map(normalizePlaylist).filter(Boolean);
      return {
        ok: true,
        schema: SPOTIFY_SCHEMA,
        count: playlists.length,
        playlists,
      };
    },
  };

  const controlTool = {
    schema: AGENT_SCHEMAS.tool,
    name: 'spotify.control',
    version: '1.0.0',
    description: 'Controla a reprodução no Spotify: play (com uri ou query opcional), pause, next, previous, volume ou shuffle.',
    origin: 'skill',
    permissionLevel: 3,
    timeoutMs: 12000,
    parameters: [
      { name: 'action', type: 'string', required: true, description: 'play | pause | next | previous | volume | shuffle' },
      { name: 'uri', type: 'string', required: false, description: 'URI Spotify opcional para play (ex.: spotify:track:...).' },
      { name: 'query', type: 'string', required: false, description: 'Busca rápida opcional para tocar a primeira faixa encontrada.' },
      { name: 'volumePercent', type: 'number', required: false, description: 'Volume de 0 a 100 quando action=volume.' },
      { name: 'shuffleState', type: 'boolean', required: false, description: 'true/false quando action=shuffle.' },
      { name: 'deviceId', type: 'string', required: false, description: 'ID opcional do dispositivo Spotify.' },
    ],
    verify(result) {
      return isPlainObject(result) && result.ok === true && result.schema === SPOTIFY_SCHEMA;
    },
    async execute(args = {}) {
      const cmd = validatePlaybackCommand(args);
      let resolvedTrack = null;

      if (cmd.action === 'play') {
        let targetUri = cmd.uri || null;
        if (!targetUri && cmd.query) {
          const params = buildSearchParams({ query: cmd.query, type: 'track', limit: 1 });
          const found = await spotifyAuth.requestJson(`${SPOTIFY_API_BASE}/search?${params.toString()}`);
          const first = found?.tracks?.items?.[0];
          if (!first?.uri) {
            throw new Error(`Nenhuma faixa encontrada no Spotify para "${cmd.query}".`);
          }
          targetUri = first.uri;
          resolvedTrack = normalizeTrack(first);
        }

        const body = targetUri
          ? (targetUri.startsWith('spotify:track:') ? { uris: [targetUri] } : { context_uri: targetUri })
          : undefined;
        await spotifyAuth.requestJson(appendDevice(`${SPOTIFY_API_BASE}/me/player/play`, cmd.deviceId), {
          method: 'PUT',
          body,
        });
        return {
          ok: true,
          schema: SPOTIFY_SCHEMA,
          action: 'play',
          uri: targetUri,
          track: resolvedTrack,
        };
      }

      if (cmd.action === 'pause') {
        await spotifyAuth.requestJson(appendDevice(`${SPOTIFY_API_BASE}/me/player/pause`, cmd.deviceId), { method: 'PUT' });
        return { ok: true, schema: SPOTIFY_SCHEMA, action: 'pause' };
      }

      if (cmd.action === 'next') {
        await spotifyAuth.requestJson(appendDevice(`${SPOTIFY_API_BASE}/me/player/next`, cmd.deviceId), { method: 'POST' });
        return { ok: true, schema: SPOTIFY_SCHEMA, action: 'next' };
      }

      if (cmd.action === 'previous') {
        await spotifyAuth.requestJson(appendDevice(`${SPOTIFY_API_BASE}/me/player/previous`, cmd.deviceId), { method: 'POST' });
        return { ok: true, schema: SPOTIFY_SCHEMA, action: 'previous' };
      }

      if (cmd.action === 'volume') {
        const url = appendDevice(
          `${SPOTIFY_API_BASE}/me/player/volume?volume_percent=${cmd.volumePercent}`,
          cmd.deviceId,
        );
        await spotifyAuth.requestJson(url, { method: 'PUT' });
        return { ok: true, schema: SPOTIFY_SCHEMA, action: 'volume', volumePercent: cmd.volumePercent };
      }

      const url = appendDevice(
        `${SPOTIFY_API_BASE}/me/player/shuffle?state=${cmd.shuffleState}`,
        cmd.deviceId,
      );
      await spotifyAuth.requestJson(url, { method: 'PUT' });
      return { ok: true, schema: SPOTIFY_SCHEMA, action: 'shuffle', shuffleState: cmd.shuffleState };
    },
  };

  const statsTool = {
    schema: AGENT_SCHEMAS.tool,
    name: 'spotify.stats',
    version: '1.0.0',
    description: 'Consulta estatísticas estilo Last.fm (top músicas, top artistas e histórico recente de scrobbles) no Postgres via n8n.',
    origin: 'skill',
    permissionLevel: 3,
    timeoutMs: 8000,
    parameters: [
      { name: 'period', type: 'string', required: false, description: 'Janela: 24h | 7d | 30d | all (padrão 7d).' },
      { name: 'limit', type: 'number', required: false, description: 'Quantidade de itens no ranking (1 a 20, padrão 5).' },
    ],
    verify(result) {
      return isPlainObject(result)
        && result.ok === true
        && result.schema === SPOTIFY_SCHEMA
        && Array.isArray(result.topTracks)
        && Array.isArray(result.topArtists);
    },
    async execute(args = {}) {
      const query = normalizeStatsQuery(args);
      const url = String(statsUrlProvider() || '').trim();
      if (!url) {
        throw new Error('URL do webhook Spotify Stats não configurada.');
      }
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(query),
        signal: AbortSignal.timeout(7000),
      });
      if (!response.ok) {
        throw new Error(`Spotify Stats no n8n falhou (HTTP ${response.status}).`);
      }
      const raw = await response.json();
      return {
        ok: true,
        schema: SPOTIFY_SCHEMA,
        ...normalizeStatsResponse(raw, query.period),
      };
    },
  };

  return [nowPlayingTool, searchTool, playlistsTool, controlTool, statsTool].map(wrapTool);
}
