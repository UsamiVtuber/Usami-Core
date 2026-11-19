import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { createSpotifyAuthClient, createSpotifyConnectorHandler } from '../src/spotify-auth.js';
import { createSpotifyTools, publishSpotifySkill } from '../src/spotify-skill.js';
import { SPOTIFY_SCHEMA } from '../skills/spotify-player/spotify-core.mjs';
import { classifyDeterministic, DEFAULT_TOOL_MATCHERS, formatExecutedTurnFallbackReply } from '../src/agent-core.js';

function mockReq({ method = 'GET', url = '/', headers = {} } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = { host: '127.0.0.1:8787', ...headers };
  process.nextTick(() => req.emit('end'));
  return req;
}

function mockRes() {
  let resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  const res = {
    statusCode: 200,
    headers: {},
    body: '',
    writeHead(status, headers = {}) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(chunk = '') {
      this.body += String(chunk || '');
      resolveDone(this);
    },
  };
  return { res, done };
}

test('spotify-auth: fluxo OAuth2 PKCE completo, persistência em disco e refresh automático em 401', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'usami-spotify-auth-'));
  try {
    let tokenCalls = 0;
    let apiCalls = 0;
    const auth = createSpotifyAuthClient({
      dataDir: dir,
      envProvider: key => (key === 'SPOTIFY_CLIENT_ID' ? 'client-abc' : null),
      fetchImpl: async (url, opts) => {
        if (String(url) === 'https://accounts.spotify.com/api/token') {
          tokenCalls += 1;
          const params = new URLSearchParams(opts.body);
          if (params.get('grant_type') === 'authorization_code') {
            assert.equal(params.get('client_id'), 'client-abc');
            assert.ok(params.get('code_verifier'));
            return new Response(JSON.stringify({
              access_token: 'tok-1',
              refresh_token: 'ref-1',
              expires_in: 3600,
              scope: 'user-read-playback-state',
            }), { status: 200 });
          }
          if (params.get('grant_type') === 'refresh_token') {
            assert.equal(params.get('refresh_token'), 'ref-1');
            return new Response(JSON.stringify({
              access_token: 'tok-2',
              expires_in: 3600,
            }), { status: 200 });
          }
        }
        apiCalls += 1;
        if (apiCalls === 1) {
          assert.equal(opts.headers.Authorization, 'Bearer tok-1');
          return new Response(JSON.stringify({ error: { message: 'expired' } }), { status: 401 });
        }
        assert.equal(opts.headers.Authorization, 'Bearer tok-2');
        return new Response(JSON.stringify({ is_playing: true, item: { type: 'track', name: 'Track 2' } }), { status: 200 });
      },
    });

    assert.equal(auth.getStatus().configured, true);
    assert.equal(auth.getStatus().connected, false);

    const flow = auth.startAuthFlow();
    assert.match(flow.authorizeUrl, /^https:\/\/accounts\.spotify\.com\/authorize\?/);
    assert.equal(flow.redirectUri, 'http://127.0.0.1:8787/oauth/callback');

    const handler = createSpotifyConnectorHandler({
      spotifyAuth: auth,
      allowedOrigins: ['http://127.0.0.1:5173'],
    });

    const cbRes = mockRes();
    await handler(mockReq({
      method: 'GET',
      url: `/oauth/callback?code=code-xyz&state=${encodeURIComponent(flow.state)}`,
    }), cbRes.res);
    await cbRes.done;
    assert.equal(cbRes.res.statusCode, 200);
    assert.match(cbRes.res.body, /Spotify conectado/);
    assert.equal(auth.getStatus().connected, true);

    const data = await auth.requestJson('https://api.spotify.com/v1/me/player');
    assert.equal(data.is_playing, true);
    assert.equal(tokenCalls, 2);
    assert.equal(apiCalls, 2);

    const npRes = mockRes();
    await handler(mockReq({
      method: 'GET',
      url: '/api/connectors/spotify/now-playing',
    }), npRes.res);
    await npRes.done;
    assert.equal(npRes.res.statusCode, 200);
    const npJson = JSON.parse(npRes.res.body);
    assert.equal(npJson.ok, true);
    assert.equal(npJson.connected, true);
    assert.equal(npJson.playing, true);
    assert.equal(npJson.track.name, 'Track 2');

    // Nova instância lê tokens persistidos do disco
    const authReloaded = createSpotifyAuthClient({
      dataDir: dir,
      envProvider: key => (key === 'SPOTIFY_CLIENT_ID' ? 'client-abc' : null),
    });
    assert.equal(authReloaded.getStatus().connected, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('spotify-skill: publica manifesto e executa now_playing, search, playlists e control', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'usami-spotify-skill-'));
  try {
    const pub = publishSpotifySkill({ dataDir: dir });
    assert.equal(pub.published, true);

    const calls = [];
    const fakeAuth = {
      async requestJson(url, opts = {}) {
        calls.push({ url, method: opts.method || 'GET', body: opts.body });
        if (url.endsWith('/me/player')) {
          return {
            is_playing: true,
            progress_ms: 5000,
            device: { id: 'd1', name: 'PC', type: 'Computer', volume_percent: 50 },
            item: { type: 'track', id: 't1', uri: 'spotify:track:1', name: 'Racing Into The Night', artists: [{ name: 'YOASOBI' }] },
          };
        }
        if (url.includes('/search?')) {
          return {
            tracks: {
              items: [{ id: 't2', uri: 'spotify:track:2', name: 'Idol', artists: [{ name: 'YOASOBI' }] }],
            },
          };
        }
        if (url.includes('/me/playlists')) {
          return {
            items: [{ id: 'p1', uri: 'spotify:playlist:1', name: 'Focus', owner: { display_name: 'Amari' }, tracks: { total: 10 } }],
          };
        }
        return null;
      },
    };

    const telemetryEvents = [];
    const tools = createSpotifyTools({
      spotifyAuth: fakeAuth,
      onTelemetry: evt => telemetryEvents.push(evt),
      statsUrlProvider: () => 'http://10.42.0.1:5678/webhook/usami-spotify-stats',
      fetchImpl: async (url, opts) => {
        assert.equal(url, 'http://10.42.0.1:5678/webhook/usami-spotify-stats');
        const body = JSON.parse(opts.body);
        assert.equal(body.period, '30d');
        return new Response(JSON.stringify({
          ok: true,
          period: '30d',
          totalScrobbles: 42,
          uniqueTracks: 15,
          topTracks: [{ name: 'Shelter', plays: 9 }],
          topArtists: [{ artist: 'Porter Robinson', plays: 12 }],
          recent: [],
        }), { status: 200 });
      },
    });
    const byName = Object.fromEntries(tools.map(t => [t.name, t]));

    const nowRes = await byName['spotify.now_playing'].execute();
    assert.equal(nowRes.schema, SPOTIFY_SCHEMA);
    assert.equal(nowRes.playing, true);
    assert.equal(nowRes.track.name, 'Racing Into The Night');

    const searchRes = await byName['spotify.search'].execute({ query: 'Idol', type: 'track' });
    assert.equal(searchRes.items[0].uri, 'spotify:track:2');

    const plRes = await byName['spotify.playlists'].execute({ limit: 5 });
    assert.equal(plRes.playlists[0].name, 'Focus');

    const playRes = await byName['spotify.control'].execute({ action: 'play', query: 'Idol' });
    assert.equal(playRes.uri, 'spotify:track:2');
    const playCall = calls.find(c => c.url.endsWith('/me/player/play'));
    assert.deepEqual(playCall.body, { uris: ['spotify:track:2'] });

    const volRes = await byName['spotify.control'].execute({ action: 'volume', volumePercent: 80 });
    assert.equal(volRes.volumePercent, 80);

    const statsRes = await byName['spotify.stats'].execute({ period: '30d', limit: 5 });
    assert.equal(statsRes.totalScrobbles, 42);
    assert.equal(statsRes.topArtists[0].artist, 'Porter Robinson');

    assert.equal(telemetryEvents.length, 6);
    assert.equal(telemetryEvents[0].tool, 'spotify.now_playing');
    assert.equal(telemetryEvents[0].ok, true);
    assert.equal(telemetryEvents[3].action, 'play');
    assert.equal(telemetryEvents[5].tool, 'spotify.stats');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('agent-core: roteia pedidos de Spotify no chat/Discord para os matchers e formata fallback', () => {
  assert.equal(classifyDeterministic('o que tá tocando no spotify?').kind, 'operational');
  assert.equal(classifyDeterministic('oq eu estava ouvindo?').kind, 'operational');
  assert.equal(classifyDeterministic('qual música eu tô ouvindo agora?').kind, 'operational');
  assert.equal(classifyDeterministic('toca Idol no spotify').kind, 'operational');
  assert.equal(classifyDeterministic('pausa a música').kind, 'operational');
  assert.equal(classifyDeterministic('mostra minhas playlists').kind, 'operational');
  assert.equal(classifyDeterministic('quais músicas eu mais ouvi no spotify?').kind, 'operational');

  const statsMatcher = DEFAULT_TOOL_MATCHERS.find(m => m.toolName === 'spotify.stats');
  assert.ok(statsMatcher.matches('meu top artistas esse mes'));
  assert.deepEqual(statsMatcher.buildArgs('meu top artistas esse mes', 'meu top artistas esse mes'), {
    period: '30d',
    limit: 5,
  });

  const statsReply = formatExecutedTurnFallbackReply({
    status: 'executed',
    tool: 'spotify.stats',
    result: {
      period: '7d',
      totalScrobbles: 18,
      topTracks: [{ name: 'STATIC', plays: 6 }],
      topArtists: [{ artist: 'Virtual Riot', plays: 8 }],
    },
  });
  assert.match(statsReply, /18 scrobbles/);

  const playMatcher = DEFAULT_TOOL_MATCHERS.find(m => m.toolName === 'spotify.control');
  assert.ok(playMatcher.matches('toca idol no spotify'));
  assert.deepEqual(playMatcher.buildArgs('toca Idol no spotify', 'toca idol no spotify'), {
    action: 'play',
    query: 'Idol',
  });
  assert.deepEqual(playMatcher.buildArgs('pausa o spotify', 'pausa o spotify'), { action: 'pause' });

  const reply = formatExecutedTurnFallbackReply({
    status: 'executed',
    tool: 'spotify.now_playing',
    result: { playing: true, track: { name: 'Idol', artists: ['YOASOBI'] } },
  });
  assert.equal(reply, 'Tocando agora no Spotify: Idol — YOASOBI.');
});

test('agent-core: spotify matchers removem envelope do Discord e sufixos de cortesia', () => {
  const playMatcher = DEFAULT_TOOL_MATCHERS.find(m => m.toolName === 'spotify.control');
  const searchMatcher = DEFAULT_TOOL_MATCHERS.find(m => m.toolName === 'spotify.search');

  // Mensagem real do Discord (workflow n8n adiciona "[Discord | Ruka]: ")
  // Inclui "musica" para que o SPOTIFY_CONTROL_RE faça match
  const discordMsg = '[Discord | Ruka]: coloca a musica black flag dp omar varela pra mim';
  const discordNormalized = 'discord | ruka: coloca a musica black flag dp omar varela pra mim';

  // spotify.control: deve extrair query limpa "black flag dp omar varela"
  assert.ok(playMatcher.matches(discordNormalized));
  const playArgs = playMatcher.buildArgs(discordMsg, discordNormalized);
  assert.equal(playArgs.action, 'play');
  assert.equal(playArgs.query, 'black flag dp omar varela');

  // spotify.search: mesmo envelope, verbos de busca
  const searchMsg = '[Discord | Ruka]: busca black flag dp omar varela no spotify por favor';
  const searchNormalized = 'discord | ruka: busca black flag dp omar varela no spotify por favor';
  assert.ok(searchMatcher.matches(searchNormalized));
  const searchArgs = searchMatcher.buildArgs(searchMsg);
  assert.equal(searchArgs.query, 'black flag dp omar varela');

  // Regressão: sem envelope continua funcionando
  assert.deepEqual(playMatcher.buildArgs('toca Idol no spotify', 'toca idol no spotify'), {
    action: 'play',
    query: 'Idol',
  });
  assert.deepEqual(searchMatcher.buildArgs('busca Idol no spotify'), {
    query: 'Idol',
    type: 'track',
    limit: 5,
  });
});
