import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { pathToFileURL } from 'node:url';
import { curateExpressions } from './src/expressions-catalog.js';
import { createFileTtsCache, createTtsCacheKey } from './src/tts-cache.js';

export const DEFAULT_MODEL = process.env.OPENROUTER_MODEL || 'nvidia/nemotron-3-ultra-550b-a55b:free';

const DEFAULT_SYSTEM = 'Você é Usami, uma companion acolhedora, curiosa e natural. Responda em português de forma breve. Não incentive dependência emocional ou exclusividade. Responda SOMENTE JSON: {"reply":"resposta","gesture":"neutral" ou "tilt","actions":[{"type":"gesture","name":"tilt" ou "wave" ou "idle"},{"type":"play_clip","name":"Nome do clip"},{"type":"set_morph","name":"Nome do morph","value":0 a 1},{"type":"set_mesh_visible","name":"Nome de mesh acessório","visible":true ou false}]}. Actions é opcional e pode ser vazio; no máximo 5 ações.'.trim();

const DEFAULT_ALLOWED_ORIGINS = ['http://127.0.0.1:5173', 'http://localhost:5173'];

const DIRECTOR_VERBS = ['play_clip', 'gesture', 'set_morph', 'set_mesh_visible', 'set_expression'];

export function isAllowedOrigin(origin, host, allowedOrigins = DEFAULT_ALLOWED_ORIGINS) {
  if (!origin) return true;
  if (allowedOrigins.includes(origin)) return true;
  try {
    const url = new URL(origin);
    return Boolean(host) && url.host === host;
  } catch {
    return false;
  }
}

export function parseChatBody(body) {
  let input;
  try {
    input = JSON.parse(body);
  } catch {
    return { ok: false, status: 400, error: 'Corpo da requisição inválido (JSON esperado).' };
  }
  if (typeof input?.message !== 'string' || !input.message.trim() || input.message.length > 2000) {
    return { ok: false, status: 400, error: 'Informe uma mensagem de até 2000 caracteres.' };
  }
  return { ok: true, message: input.message.trim(), input: { ...input, message: undefined } };
}

export function parseTtsBody(body) {
  let input;
  try {
    input = JSON.parse(body);
  } catch {
    return { ok: false, status: 400, error: 'Corpo da requisição inválido (JSON esperado).' };
  }
  if (typeof input?.text !== 'string' || !input.text.trim() || input.text.length > 2000) {
    return { ok: false, status: 400, error: 'Informe um texto de até 2000 caracteres.' };
  }
  const styleId = typeof input.styleId === 'string' && input.styleId.trim() ? input.styleId.trim().slice(0, 80) : 'neutral';
  const rate = Number.isFinite(Number(input.rate)) ? Number(input.rate) : 1;
  const pitch = Number.isFinite(Number(input.pitch)) ? Number(input.pitch) : 1;
  return { ok: true, text: input.text.trim(), styleId, rate, pitch };
}

export function sanitizeCapabilities(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const names = (list, limit, allowed) => (Array.isArray(list) ? list.filter(value => typeof value === 'string' && value.length > 0).map(value => value.slice(0, 60)).filter(value => !allowed || allowed.includes(value)).slice(0, limit) : []);
  const meshes = Array.isArray(input.meshes) ? input.meshes.filter(mesh => typeof mesh?.name === 'string' && mesh.name.length > 0).map(mesh => ({ name: mesh.name.slice(0, 60), accessory: mesh.accessory === true })).slice(0, 100) : [];
  return {
    format: typeof input.format === 'string' ? input.format.slice(0, 40) : '',
    clips: names(input.clips, 40),
    morphs: names(input.morphs, 60),
    meshes,
    expressions: names(input.expressions, 20),
    gestures: names(input.gestures, 5, ['tilt', 'idle', 'wave']),
  };
}

export function sanitizeActions(raw) {
  const actions = Array.isArray(raw) ? raw : [];
  return actions.filter(action => action && typeof action === 'object' && !Array.isArray(action) && DIRECTOR_VERBS.includes(action.type)).slice(0, 5).map(action => {
    const base = { type: action.type, name: typeof action.name === 'string' ? action.name.slice(0, 60) : action.name };
    if (action.type === 'set_morph') base.value = action.value;
    if (action.type === 'set_mesh_visible') base.visible = action.visible;
    if (action.type === 'set_expression') base.weight = action.weight;
    return base;
  });
}

export function filterActionsByCatalog(actions, capabilities) {
  const known = (list) => (!Array.isArray(list) ? null : new Set(list));
  const sets = capabilities ? {
    gesture: known(capabilities.gestures),
    play_clip: known(capabilities.clips),
    set_morph: known(capabilities.morphs),
    set_expression: known(capabilities.expressions),
  } : {};
  return (Array.isArray(actions) ? actions : []).filter(action => {
    const set = sets[action?.type];
    return set ? set.has(action?.name) : true; // sem catálogo conhecido → mantém
  });
}

export function systemFor(capabilities) {
  const base = DEFAULT_SYSTEM;
  if (!capabilities) return base;
  return base + ' Capabilidades disponíveis neste modelo: ' + JSON.stringify(capabilities) + '.';
}

export function parseProviderRaw(raw) {
  if (typeof raw !== 'string' || raw.length > 10000) {
    return { ok: false, status: 502, error: 'Resposta inválida do provedor.' };
  }
  let result;
  try {
    result = JSON.parse(raw.trim().replace(/^\`\`\`(?:json)?\s*/i, '').replace(/\s*\`\`\`$/, ''));
  } catch {
    if (/^[\[{]/.test(raw.trim()) || raw.length > 2000) {
      return { ok: false, status: 502, error: 'O modelo retornou um formato inválido. Tente novamente.' };
    }
    result = { reply: raw.trim(), gesture: 'neutral' };
  }
  if (typeof result?.reply !== 'string' || !result.reply.trim() || result.reply.length > 2000) {
    return { ok: false, status: 502, error: 'O modelo retornou uma resposta inválida.' };
  }
  return { ok: true, reply: result.reply.trim(), gesture: result.gesture === 'tilt' ? 'tilt' : 'neutral', actions: sanitizeActions(result.actions) };
}

export const CLASSIFIER_SYSTEM = 'Você é um classificador de reações de avatar. Dada uma frase e um catálogo de ações possíveis, responda SOMENTE JSON: {"actions":[{"type":"gesture","name":"tilt"|"wave"|"idle"},{"type":"set_expression","name":"<expression>","weight":0 a 1},{"type":"play_clip","name":"<clip>"},{"type":"set_morph","name":"<morph>","value":0 a 1}]} com no máximo 3 ações. Priorize coerência com a frase. Se nada fizer sentido, responda {"actions":[]}. Ações devem existir no catálogo.'.trim();

export async function classifyReply({ fetchImpl = globalThis.fetch, key, model, reply, capabilities, timeoutMs = 20000 }) {
  if (!key || typeof reply !== 'string' || !reply.trim() || !capabilities) return null;
  // Gestures alone (e.g. Live2D avatars) do not justify a second model call.
  if (!capabilities.expressions?.length && !capabilities.clips?.length && !capabilities.morphs?.length) return null;
  const catalog = {};
  const curatedExpressions = capabilities.expressions?.length ? curateExpressions(capabilities.expressions).curated.map(item => item.name) : [];
  if (curatedExpressions.length) catalog.expressions = curatedExpressions;
  if (capabilities.clips?.length) catalog.clips = capabilities.clips;
  if (capabilities.morphs?.length) catalog.morphs = capabilities.morphs;
  if (capabilities.gestures?.length) catalog.gestures = capabilities.gestures;
  const response = await fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: 200, temperature: 0, messages: [{ role: 'system', content: CLASSIFIER_SYSTEM }, { role: 'user', content: 'Frase: ' + reply.trim() + '\nCatálogo: ' + JSON.stringify(catalog) }] }),
    signal: AbortSignal.timeout(timeoutMs),
  }).catch(() => null);
  if (!response || !response.ok) return null;
  const data = await response.json().catch(() => null);
  const raw = data?.choices?.[0]?.message?.content;
  if (typeof raw !== 'string') return null;
  let parsed;
  try {
    parsed = JSON.parse(raw.trim().replace(/^\`\`\`(?:json)?\s*/i, '').replace(/\s*\`\`\`$/, ''));
  } catch {
    return null;
  }
  return Array.isArray(parsed?.actions) ? sanitizeActions(parsed.actions) : null;
}

export function createChatHandler(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const getKey = options.getKey || (async () => {
    const envPath = options.envPath || process.env.USAMI_KEYS_FILE || 'A:/Lira/LiraVtuber/.env';
    const parsed = parseEnv(await readFile(envPath, 'utf8'));
    return parsed.OPENROUTER_API_KEY || null;
  });
  const allowedOrigins = options.allowedOrigins || DEFAULT_ALLOWED_ORIGINS;
  const model = options.model || process.env.OPENROUTER_MODEL || DEFAULT_MODEL;
  const systemBase = options.system || DEFAULT_SYSTEM;
  const now = options.now || (() => Date.now());

  return async function handleChat(req, res) {
    const send = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify(data));
    };

    if (req.method !== 'POST' || req.url !== '/api/chat') {
      return send(404, { error: 'Não encontrado.' });
    }

    const origin = req.headers.origin;
    const host = req.headers.host;
    if (!isAllowedOrigin(origin, host, allowedOrigins)) {
      return send(403, { error: 'Origem não autorizada.' });
    }

    const contentType = (req.headers['content-type'] || '').split(';')[0].trim();
    if (contentType !== 'application/json') {
      return send(403, { error: 'Content-Type inválido.' });
    }

    let body = '';
    let tooLarge = false;
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 8192) {
        tooLarge = true;
        break;
      }
    }
    if (tooLarge) {
      return send(413, { error: 'Mensagem muito longa.' });
    }

    const parsedBody = parseChatBody(body);
    if (!parsedBody.ok) {
      return send(parsedBody.status, { error: parsedBody.error });
    }

    const capabilities = sanitizeCapabilities(parsedBody.input?.capabilities);
    const system = systemFor(capabilities);
    let key;
    try {
      key = await getKey();
    } catch {
      return send(502, { error: 'Não foi possível acessar a configuração.' });
    }
    if (!key) {
      return send(503, { error: 'Chave OpenRouter não configurada.' });
    }

    let response;
    try {
      response = await fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, max_tokens: 320, messages: [{ role: 'system', content: system }, { role: 'user', content: parsedBody.message }] }),
        signal: AbortSignal.timeout(45000),
      });
    } catch (error) {
      return send(502, { error: error?.name === 'TimeoutError' ? 'A solicitação expirou.' : 'Não foi possível acessar o provedor.' });
    }

    if (!response || !response.ok) {
      return send(502, { error: 'A OpenRouter recusou a solicitação ou está indisponível (HTTP ' + (response?.status ?? 0) + ').' });
    }

    let data;
    try {
      data = await response.json();
    } catch {
      return send(502, { error: 'Resposta inválida do provedor.' });
    }

    const raw = data?.choices?.[0]?.message?.content;
    const parsed = parseProviderRaw(raw);
    if (!parsed.ok) {
      return send(parsed.status, { error: parsed.error });
    }

    let actions = parsed.actions ?? [];
    try {
      const classified = await classifyReply({ fetchImpl, key, model, reply: parsed.reply, capabilities });
      if (classified) {
        const seen = new Set(classified.map(action => action.type + ':' + action.name));
        actions = sanitizeActions([...classified, ...actions.filter(action => !seen.has(action.type + ':' + action.name))]);
      }
    } catch {
      // classifier failure keeps parsed.actions
    }
    actions = filterActionsByCatalog(actions, capabilities);
    return send(200, { reply: parsed.reply, gesture: parsed.gesture, actions });
  };
}

const DEFAULT_GEMINI_TTS_MODEL = 'gemini-2.5-flash-preview-tts';
const DEFAULT_GEMINI_TTS_VOICE = 'Kore';
const DEFAULT_GEMINI_TTS_INSTRUCTION = 'Leia em português do Brasil, com tom acolhedor e animado: ';
const DEFAULT_GEMINI_TTS_SAMPLE_RATE = 24000;

function normalizeTtsProvider(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return normalized === 'gemini' || normalized === 'elevenlabs' ? normalized : null;
}

function parseGeminiSampleRate(mimeType) {
  const match = /rate=(\d+)/.exec(typeof mimeType === 'string' ? mimeType : '');
  const rate = match ? Number(match[1]) : DEFAULT_GEMINI_TTS_SAMPLE_RATE;
  return Number.isFinite(rate) && rate > 0 ? rate : DEFAULT_GEMINI_TTS_SAMPLE_RATE;
}

// Envelopa PCM mono 16-bit little-endian num WAV RIFF de 44 bytes, sem deps.
function pcmToWav(pcm, sampleRate) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // tamanho do subchunk fmt
  header.writeUInt16LE(1, 20); // audioFormat: PCM
  header.writeUInt16LE(1, 22); // canais: mono
  header.writeUInt32LE(sampleRate, 24); // sampleRate
  header.writeUInt32LE(sampleRate * 2, 28); // byteRate = rate * canais * 16/8
  header.writeUInt16LE(2, 32); // blockAlign
  header.writeUInt16LE(16, 34); // bitsPerSample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export function createTtsHandler(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const getConfig = options.getConfig || (async () => {
    // options.envPath (testes) substitui a cadeia inteira; sem ele, tenta o .env
    // do projeto e depois o fallback — o primeiro arquivo com um provedor
    // completo vence; no mesmo arquivo, gemini tem prioridade.
    const candidates = options.envPath
      ? [options.envPath]
      : [process.env.USAMI_KEYS_FILE || 'A:/Usami Project/.env', 'A:/Lira/LiraVtuber/.env'];
    for (const candidate of candidates) {
      let parsed;
      try {
        parsed = parseEnv(await readFile(candidate, 'utf8'));
      } catch {
        // arquivo ausente ou ilegível → tenta o próximo candidato
        continue;
      }
      const providerOverride = normalizeTtsProvider(options.provider || process.env.USAMI_TTS_PROVIDER);
      const hasGemini = Boolean(parsed.GEMINI_API_KEY);
      const hasElevenlabs = Boolean(parsed.ELEVENLABS_API_KEY && parsed.ELEVENLABS_VOICE_ID);
      // override explícito restringe o provedor; sem override, gemini vem primeiro
      if (hasGemini && (!providerOverride || providerOverride === 'gemini')) {
        return { provider: 'gemini', apiKey: parsed.GEMINI_API_KEY, geminiModel: parsed.GEMINI_TTS_MODEL, geminiVoice: parsed.GEMINI_TTS_VOICE };
      }
      if (hasElevenlabs && (!providerOverride || providerOverride === 'elevenlabs')) {
        return { provider: 'elevenlabs', apiKey: parsed.ELEVENLABS_API_KEY, voiceId: parsed.ELEVENLABS_VOICE_ID };
      }
    }
    return { provider: null, apiKey: null, voiceId: null };
  });
  const allowedOrigins = options.allowedOrigins || DEFAULT_ALLOWED_ORIGINS;
  const model = options.model || process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2';
  const ttsUrl = (options.ttsUrl || 'https://api.elevenlabs.io').replace(/\/+$/, '');
  const geminiUrl = (options.geminiUrl || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs || 30000;
  const cache = options.cache ? (options.cacheStore || createFileTtsCache({ directory: options.cacheDir || process.env.USAMI_TTS_CACHE_DIR || 'data/tts-cache' })) : null;

  return async function handleTts(req, res) {
    const send = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify(data));
    };

    if (req.method !== 'POST' || req.url !== '/api/tts') {
      return send(404, { error: 'Não encontrado.' });
    }

    const origin = req.headers.origin;
    const host = req.headers.host;
    if (!isAllowedOrigin(origin, host, allowedOrigins)) {
      return send(403, { error: 'Origem não autorizada.' });
    }

    const contentType = (req.headers['content-type'] || '').split(';')[0].trim();
    if (contentType !== 'application/json') {
      return send(403, { error: 'Content-Type inválido.' });
    }

    let body = '';
    let tooLarge = false;
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 8192) {
        tooLarge = true;
        break;
      }
    }
    if (tooLarge) {
      return send(413, { error: 'Texto muito longo.' });
    }

    const parsedBody = parseTtsBody(body);
    if (!parsedBody.ok) {
      return send(parsedBody.status, { error: parsedBody.error });
    }

    let config;
    try {
      config = await getConfig();
    } catch {
      return send(503, { error: 'TTS indisponível: configuração ausente.' });
    }
    // provider explícito (options/env) vence; sem ele, o config decide — um
    // config legado { apiKey, voiceId } sem provider continua significando elevenlabs
    const provider = normalizeTtsProvider(options.provider || process.env.USAMI_TTS_PROVIDER)
      || (config?.provider === 'gemini' ? 'gemini' : 'elevenlabs');
    if (!config?.apiKey || (provider === 'elevenlabs' && !config?.voiceId)) {
      return send(503, { error: 'TTS indisponível: configuração ausente.' });
    }

    const geminiModel = provider === 'gemini'
      ? (options.geminiModel || process.env.GEMINI_TTS_MODEL || config.geminiModel || DEFAULT_GEMINI_TTS_MODEL)
      : null;
    const geminiVoice = provider === 'gemini'
      ? (options.geminiVoice || process.env.GEMINI_TTS_VOICE || config.geminiVoice || DEFAULT_GEMINI_TTS_VOICE)
      : null;
    const audioFormat = provider === 'gemini' ? 'audio/wav' : 'audio/mpeg';
    const cacheKey = cache ? createTtsCacheKey({
      provider,
      model: provider === 'gemini' ? geminiModel : model,
      voiceId: provider === 'gemini' ? geminiVoice : config.voiceId,
      styleId: parsedBody.styleId,
      rate: parsedBody.rate,
      pitch: parsedBody.pitch,
      format: audioFormat,
      text: parsedBody.text,
    }) : null;
    if (cache && cacheKey) {
      try {
        const cached = await cache.get(cacheKey);
        if (cached) {
          res.writeHead(200, { 'Content-Type': audioFormat, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-TTS-Cache': 'HIT' });
          return res.end(cached);
        }
      } catch {
        // Cache failures never make TTS unavailable.
      }
    }

    let response;
    try {
      if (provider === 'gemini') {
        const instruction = options.geminiInstruction || process.env.GEMINI_TTS_INSTRUCTION || DEFAULT_GEMINI_TTS_INSTRUCTION;
        // a key vai apenas no header x-goog-api-key (nunca na URL); o prefixo de
        // instrução não conta no limite de 2000 chars, validado sobre o texto puro
        response = await fetchImpl(geminiUrl + '/v1beta/models/' + encodeURIComponent(geminiModel) + ':generateContent', {
          method: 'POST',
          headers: { 'x-goog-api-key': config.apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: instruction + parsedBody.text }] }],
            generationConfig: {
              responseModalities: ['AUDIO'],
              speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: geminiVoice } } },
            },
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } else {
        response = await fetchImpl(ttsUrl + '/v1/text-to-speech/' + encodeURIComponent(config.voiceId) + '?output_format=mp3_44100_128', {
          method: 'POST',
          headers: { 'xi-api-key': config.apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: parsedBody.text, model_id: model, output_format: 'mp3_44100_128' }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      }
    } catch {
      // timeout ou falha de rede; a apiKey nunca é exposta em resposta ou log
      return send(504, { error: 'TTS expirou.' });
    }

    if (!response || !response.ok) {
      // não repassa o corpo do provedor; preserva apenas o status 400/422/429
      const providerStatus = response?.status ?? 0;
      const status = providerStatus === 400 || providerStatus === 422 || providerStatus === 429 ? providerStatus : 502;
      return send(status, { error: 'TTS falhou no provedor.' });
    }

    let audio;
    try {
      if (provider === 'gemini') {
        const data = await response.json();
        const inlineData = data?.candidates?.[0]?.content?.parts?.find(part => part?.inlineData)?.inlineData;
        if (!inlineData || typeof inlineData.data !== 'string') {
          return send(502, { error: 'TTS falhou no provedor.' });
        }
        const pcm = Buffer.from(inlineData.data, 'base64');
        if (!pcm.length) {
          return send(502, { error: 'TTS falhou no provedor.' });
        }
        // o provedor devolve PCM mono 16-bit; envelopa num WAV RIFF de 44 bytes
        audio = pcmToWav(pcm, parseGeminiSampleRate(inlineData.mimeType));
      } else {
        audio = Buffer.from(await response.arrayBuffer());
      }
    } catch {
      return send(502, { error: 'TTS falhou no provedor.' });
    }

    res.writeHead(200, { 'Content-Type': audioFormat, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    if (cache && cacheKey) {
      try { await cache.put(cacheKey, audio); } catch {
        // Cache failures never make a successful synthesis fail.
      }
    }
    res.end(audio);
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const handleChat = createChatHandler();
  const handleTts = createTtsHandler({ cache: true });
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/chat') return handleChat(req, res);
    if (req.method === 'POST' && req.url === '/api/tts') return handleTts(req, res);
    res.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify({ error: 'Não encontrado.' }));
  });
  server.listen(8787, '127.0.0.1', () => console.log('Usami API local em 127.0.0.1:8787'));
}
