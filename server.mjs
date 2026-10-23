import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { pathToFileURL } from 'node:url';

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
  if (capabilities.expressions?.length) catalog.expressions = capabilities.expressions;
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
    return send(200, { reply: parsed.reply, gesture: parsed.gesture, actions });
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const handler = createChatHandler();
  const server = createServer(handler);
  server.listen(8787, '127.0.0.1', () => console.log('Usami API local em 127.0.0.1:8787'));
}
