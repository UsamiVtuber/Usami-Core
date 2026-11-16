import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Porta da API local; o Host válido da própria API sempre entra na allowlist.
export const API_PORT = 8787;

// Header com o segredo das rotas sensíveis. O Vite injeta no proxy (o token não
// chega ao navegador); o n8n o envia por conta própria.
export const API_TOKEN_HEADER = 'x-usami-token';

// .env do projeto: USAMI_KEYS_FILE ou o arquivo ao lado da pasta usami/.
export function keysFilePath() {
  return process.env.USAMI_KEYS_FILE || fileURLToPath(new URL('../../.env', import.meta.url));
}

// Lê uma variável do ambiente e, na falta, do .env do projeto. Nunca loga o valor.
export function readEnvValue(name, { filePath = keysFilePath() } = {}) {
  if (process.env[name]) return process.env[name];
  try {
    const match = readFileSync(filePath, 'utf8').match(new RegExp('^' + name + '\\s*=\\s*(.+)$', 'm'));
    return match ? match[1].trim().replace(/^(["'])(.*)\1$/, '$2') : null;
  } catch {
    return null;
  }
}

export function readApiToken() {
  return readEnvValue('USAMI_API_TOKEN');
}

function csv(value) {
  return String(value || '').split(',').map(item => item.trim()).filter(Boolean);
}

// Origens do front. USAMI_ALLOWED_ORIGINS acrescenta as de LAN/terminal.local.
export function withExtraOrigins(origins) {
  const extra = process.env.USAMI_ALLOWED_ORIGINS || readEnvValue('USAMI_ALLOWED_ORIGINS');
  return [...new Set([...origins, ...csv(extra)])];
}

// Hosts aceitos: o da API, os das origens permitidas e USAMI_ALLOWED_HOSTS.
// O Host vem do cliente — em DNS rebinding é o do atacante —, então só vale o
// que está nesta lista fechada, nunca o que a própria requisição afirma.
export function allowedHosts(allowedOrigins) {
  const extra = process.env.USAMI_ALLOWED_HOSTS || readEnvValue('USAMI_ALLOWED_HOSTS');
  const hosts = new Set([`127.0.0.1:${API_PORT}`, `localhost:${API_PORT}`, `10.42.0.91:${API_PORT}`, `10.42.0.1:${API_PORT}`, ...csv(extra)]);
  for (const origin of allowedOrigins) {
    try {
      hosts.add(new URL(origin).host);
    } catch {
      // origem malformada na configuração: ignora
    }
  }
  return hosts;
}

export function isAllowedRequest(origin, host, allowedOrigins) {
  if (!host || !allowedHosts(allowedOrigins).has(String(host).toLowerCase())) return false;
  if (!origin) return true;
  return allowedOrigins.includes(origin);
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

// Fail-closed: sem token configurado no servidor, a rota sensível não responde.
// Retorna null quando autorizado, ou { status, error }.
export function checkApiToken(req, expected) {
  if (!expected) return { status: 503, error: 'Rota protegida: defina USAMI_API_TOKEN no servidor.' };
  const received = req.headers?.[API_TOKEN_HEADER];
  if (typeof received !== 'string' || !safeEqual(received, expected)) {
    return { status: 401, error: 'Token ausente ou inválido.' };
  }
  return null;
}

// Assinatura do webhook de saída: HMAC-SHA256 de "<timestamp>.<corpo>".
export function signWebhook(secret, timestamp, body) {
  return 'sha256=' + createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}
