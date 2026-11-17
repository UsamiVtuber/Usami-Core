import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SPOTIFY_SCHEMA,
  buildSearchParams,
  normalizePlaybackState,
  normalizePlaylist,
  normalizeTrack,
  validatePlaybackCommand,
} from '../spotify-core.mjs';

test('spotify-core: normaliza track, playback e playlist e valida comandos', () => {
  assert.equal(SPOTIFY_SCHEMA, 'usami.skill.spotify.v1');

  const track = normalizeTrack({
    id: 't1',
    uri: 'spotify:track:123',
    name: 'Idol',
    artists: [{ name: 'YOASOBI' }],
    album: { name: 'THE BOOK 3' },
    duration_ms: 213000,
    external_urls: { spotify: 'https://open.spotify.com/track/123' },
  });
  assert.equal(track.name, 'Idol');
  assert.deepEqual(track.artists, ['YOASOBI']);

  const pb = normalizePlaybackState({
    is_playing: true,
    progress_ms: 12000,
    shuffle_state: false,
    repeat_state: 'context',
    device: { id: 'dev1', name: 'Desktop', type: 'Computer', volume_percent: 65 },
    item: { type: 'track', id: 't1', uri: 'spotify:track:123', name: 'Idol', artists: [{ name: 'YOASOBI' }] },
  });
  assert.equal(pb.playing, true);
  assert.equal(pb.device.volumePercent, 65);
  assert.equal(pb.track.name, 'Idol');

  const pl = normalizePlaylist({
    id: 'p1',
    uri: 'spotify:playlist:abc',
    name: 'Anime Mix',
    owner: { display_name: 'Amari' },
    tracks: { total: 42 },
    public: false,
  });
  assert.equal(pl.tracksTotal, 42);

  const params = buildSearchParams({ query: 'yoasobi idol', type: 'track', limit: 3 });
  assert.equal(params.get('q'), 'yoasobi idol');
  assert.equal(params.get('limit'), '3');

  assert.throws(() => validatePlaybackCommand({ action: 'destroy' }));
  assert.throws(() => validatePlaybackCommand({ action: 'volume', volumePercent: 150 }));
  assert.deepEqual(validatePlaybackCommand({ action: 'play', query: 'Idol' }), { action: 'play', query: 'Idol' });
});
