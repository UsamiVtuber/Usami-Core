import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveCharacterVoiceProsody } from '../src/tts-prosody.js';
import { createDefaultUsamiManifest } from '../src/character-manifest-schema.js';
import { createCharacterRegistry } from '../src/character-context.js';

const scratchDir = mkdtempSync(join(tmpdir(), 'usami-tts-dyn-init-'));
process.env.USAMI_DATA_DIR = scratchDir;
const { createTtsHandler } = await import('../server.mjs');

function mockReq({ method = 'POST', url = '/api/tts', headers = {}, body = '' } = {}) {
  const chunks = body ? [Buffer.from(body)] : [];
  return {
    method,
    url,
    headers,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

function mockRes() {
  const res = { statusCode: null, headers: null, body: '' };
  res.writeHead = (status, headers) => { res.statusCode = status; res.headers = headers; };
  res.end = (data) => { res.body = data; };
  return res;
}

test('resolveCharacterVoiceProsody: resolve voz, prosódia e overrides do manifesto', () => {
  const manifest = createDefaultUsamiManifest();
  manifest.metadata.id = 'yuki-ice';
  manifest.voice = {
    engine: 'gemini_multimodal',
    defaultVoice: 'Aoede',
    model: 'gemini-2.5-flash-preview-tts',
    baseInstruction: '[em português do Brasil, voz calma e cristalina] ',
    pitchOffset: -2.0,
    speakingRate: 0.9,
    prosodyMap: {
      angry: {
        voice: 'Puck',
        pitchOffset: 1.5,
        rate: 1.15,
        styleClause: 'tom firme e gélido',
      },
    },
  };

  const neutral = resolveCharacterVoiceProsody(manifest, 'neutral');
  assert.equal(neutral.voice, 'Aoede');
  assert.equal(neutral.pitchOffset, -2.0);
  assert.equal(neutral.speakingRate, 0.9);
  assert.equal(neutral.styleClause, '');

  const angry = resolveCharacterVoiceProsody(manifest, 'casual_angry');
  assert.equal(angry.voice, 'Puck');
  assert.equal(angry.pitchOffset, 1.5);
  assert.equal(angry.speakingRate, 1.15);
  assert.equal(angry.styleClause, 'tom firme e gélido');

  const safeFallback = resolveCharacterVoiceProsody(null, 'happy', { fallbackVoice: 'Kore' });
  assert.equal(safeFallback.voice, 'Kore');
  assert.match(safeFallback.styleClause, /super animada/);
});

test('createTtsHandler: dois personagens com vozes distintas sintetizam sem colisão via x-character-id', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'usami-tts-dyn-'));
  const registry = createCharacterRegistry({ dataDir: dir, allowSyntheticManifest: true });

  const charA = createDefaultUsamiManifest();
  charA.metadata.id = 'char-alpha';
  charA.voice.defaultVoice = 'Puck';
  charA.voice.baseInstruction = '[voz enérgica do alpha] ';
  charA.voice.prosodyMap = {};
  registry.getOrCreate('char-alpha', { manifest: charA });

  const charB = createDefaultUsamiManifest();
  charB.metadata.id = 'char-beta';
  charB.voice.defaultVoice = 'Aoede';
  charB.voice.baseInstruction = '[voz calma da beta] ';
  charB.voice.prosodyMap = {};
  registry.getOrCreate('char-beta', { manifest: charB });

  const providerPayloads = [];
  const fakePcm = Buffer.from('pcm-audio-ok');
  const handler = createTtsHandler({
    characterRegistry: registry,
    getConfig: async () => ({ provider: 'gemini', apiKey: 'gem-key', geminiVoice: 'Kore' }),
    fetchImpl: async (_url, opts) => {
      providerPayloads.push(JSON.parse(opts.body));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;rate=24000', data: fakePcm.toString('base64') } }] } }],
        }),
      };
    },
  });

  try {
    const resA = mockRes();
    await handler(mockReq({
      headers: { host: '127.0.0.1:8787', 'content-type': 'application/json', 'x-character-id': 'char-alpha' },
      body: JSON.stringify({ text: 'Olá do Alpha', styleId: 'happy' }),
    }), resA);
    assert.equal(resA.statusCode, 200);

    const resB = mockRes();
    await handler(mockReq({
      headers: { host: '127.0.0.1:8787', 'content-type': 'application/json', 'x-character-id': 'char-beta' },
      body: JSON.stringify({ text: 'Olá da Beta', styleId: 'relaxed' }),
    }), resB);
    assert.equal(resB.statusCode, 200);

    assert.equal(providerPayloads.length, 2);
    assert.equal(providerPayloads[0].generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Puck');
    assert.match(providerPayloads[0].contents[0].parts[0].text, /^\[voz enérgica do alpha/);

    assert.equal(providerPayloads[1].generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Aoede');
    assert.match(providerPayloads[1].contents[0].parts[0].text, /^\[voz calma da beta/);
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { }
  }
});

test('createTtsHandler: preserva voz e modelo customizados da Usami mesmo com x-character-id e cai para flash no 429', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'usami-tts-custom-'));
  const registry = createCharacterRegistry({ dataRoot: dir });
  const calls = [];
  const fakePcm = Buffer.alloc(16);

  const handler = createTtsHandler({
    characterRegistry: registry,
    getConfig: async () => ({
      provider: 'gemini',
      apiKey: 'gem-key',
      geminiModel: 'gemini-2.5-pro-preview-tts',
      geminiVoice: 'Zephyr',
      geminiInstruction: '[em português do Brasil, voz customizada da Usami] ',
    }),
    fetchImpl: async (url, opts) => {
      calls.push({ url, body: JSON.parse(opts.body) });
      if (calls.length === 1) {
        return { ok: false, status: 429, text: async () => 'quota exceeded' };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;rate=24000', data: fakePcm.toString('base64') } }] } }],
        }),
      };
    },
  });

  try {
    const res = mockRes();
    await handler(mockReq({
      headers: { host: '127.0.0.1:8787', 'content-type': 'application/json', 'x-character-id': 'usami' },
      body: JSON.stringify({ text: 'Oi, testando minha voz customizada!', styleId: 'neutral' }),
    }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(calls.length, 2);
    assert.match(calls[0].url, /gemini-2\.5-pro-preview-tts:generateContent/);
    assert.equal(calls[0].body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Zephyr');
    assert.match(calls[0].body.contents[0].parts[0].text, /^\[em português do Brasil, voz customizada da Usami/);
    assert.match(calls[1].url, /gemini-2\.5-flash-preview-tts:generateContent/);
    assert.equal(calls[1].body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Kore');
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { }
  }
});
