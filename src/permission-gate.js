/**
 * Gate de permissões do domínio agêntico (S5).
 *
 * Traduz os níveis 1–4 de `agent-contracts.js` em autorização de execução:
 * ferramenta revogada é negada sempre; nível 4 exige uma confirmação humana de
 * uso único, emitida pelo handler depois da palavra escrita e guardada só em
 * memória (TTL curto) — a confirmação é um segundo fator, não um segredo
 * persistido. As revogações, sim, são duráveis (`data/permissions.json`),
 * aceitam ferramenta exata ou integração inteira (`namespace.*`) e a escrita é
 * atômica, como nos demais stores.
 *
 * Arquivo de permissões inválido falha fechado: o gate nega execuções e recusa
 * novas escritas até o operador resolver o arquivo, em vez de esquecer uma
 * revogação em silêncio.
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { dataDir as resolveDataDir } from './data-paths.js';
import { permissionRequiresConfirmation } from './agent-contracts.js';

const FILE_NAME = 'permissions.json';
const FILE_VERSION = 1;
const REVOCATION_LIMIT = 200;
const REASON_MAX = 200;
const EXACT_TOOL_RE = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_-]*)+$/;
const WILDCARD_TOOL_RE = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_-]*)*\.\*$/;

export const CONFIRMATION_WORD = 'CONFIRMAR';
export const DEFAULT_CONFIRMATION_TTL_MS = 120_000;
export const MAX_CONFIRMATION_TTL_MS = 600_000;

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const iso = ms => new Date(ms).toISOString();

function validScope(value) {
  return typeof value === 'string' && (EXACT_TOOL_RE.test(value) || WILDCARD_TOOL_RE.test(value));
}

function cleanReason(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') return null;
  return value.replace(/\s+/g, ' ').trim().slice(0, REASON_MAX);
}

export function createPermissionGate({
  registry,
  dataDir = resolveDataDir(),
  filePath = join(dataDir, FILE_NAME),
  now = () => Date.now(),
  ttlMs = DEFAULT_CONFIRMATION_TTL_MS,
  onLoadError = message => console.error(message),
} = {}) {
  if (!registry || typeof registry.get !== 'function') throw new Error('createPermissionGate: registry é obrigatório.');
  if (!dataDir || typeof dataDir !== 'string') throw new Error('createPermissionGate: dataDir é obrigatório.');
  if (!Number.isInteger(ttlMs) || ttlMs < 1000 || ttlMs > MAX_CONFIRMATION_TTL_MS) {
    throw new Error(`createPermissionGate: ttlMs deve ser inteiro entre 1000 e ${MAX_CONFIRMATION_TTL_MS}`);
  }

  const isoNow = () => iso(now());
  const defaultData = () => ({ version: FILE_VERSION, revocations: [], updatedAt: isoNow() });
  let data = defaultData();
  let loadFailed = false;
  // token → { tool, permissionLevel, createdAt, expiresAtMs }
  const confirmations = new Map();

  function assertWritable() {
    if (loadFailed) throw new Error('permissões: arquivo inválido não foi carregado; escrita recusada');
  }

  function persist() {
    mkdirSync(dirname(filePath), { recursive: true });
    data.updatedAt = isoNow();
    const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temporary, JSON.stringify(data, null, 2), 'utf8');
    try {
      renameSync(temporary, filePath);
    } catch (error) {
      try { unlinkSync(temporary); } catch {}
      if (error?.code !== 'EEXIST' && error?.code !== 'EPERM') throw error;
    }
    return data;
  }

  // Revogação inválida derruba o load: descartá-la seria liberar acesso que o
  // operador negou de propósito.
  function normalize(input) {
    if (!isPlainObject(input)) throw new Error('permissões: arquivo deve ser um objeto JSON');
    if (input.version !== FILE_VERSION) throw new Error(`permissões: versão ${JSON.stringify(input.version)} não suportada`);
    if (!Array.isArray(input.revocations)) throw new Error('permissões: campo revocations deve ser uma lista');
    const revocations = [];
    const scopes = new Set();
    for (const [index, raw] of input.revocations.entries()) {
      if (!isPlainObject(raw)) throw new Error(`permissões: revogação ${index} deve ser um objeto`);
      if (!validScope(raw.tool)) throw new Error(`permissões: revogação ${index} com escopo inválido`);
      if (scopes.has(raw.tool)) throw new Error(`permissões: escopo duplicado (${raw.tool})`);
      const reason = cleanReason(raw.reason);
      if (reason === null) throw new Error(`permissões: revogação ${index} com motivo inválido`);
      if (typeof raw.revokedAt !== 'string' || Number.isNaN(Date.parse(raw.revokedAt))) {
        throw new Error(`permissões: revogação ${index} sem revokedAt válido`);
      }
      scopes.add(raw.tool);
      revocations.push({ tool: raw.tool, ...(reason ? { reason } : {}), revokedAt: raw.revokedAt });
    }
    return {
      version: FILE_VERSION,
      revocations: revocations.slice(-REVOCATION_LIMIT),
      updatedAt: typeof input.updatedAt === 'string' ? input.updatedAt : isoNow(),
    };
  }

  function findRevocation(toolName) {
    return data.revocations.find(entry => (
      entry.tool === toolName
      || (WILDCARD_TOOL_RE.test(entry.tool) && toolName.startsWith(entry.tool.slice(0, -1)))
    )) ?? null;
  }

  function purgeExpired() {
    const time = now();
    for (const [token, entry] of confirmations) {
      if (entry.expiresAtMs <= time) confirmations.delete(token);
    }
  }

  function snapshot() {
    return {
      revocations: data.revocations.map(entry => ({ ...entry })),
      updatedAt: data.updatedAt,
    };
  }

  /**
   * Carrega as revogações; sem arquivo começa vazio e não grava. Arquivo
   * inválido marca o gate como indisponível e relança para o chamador logar.
   */
  function load() {
    try {
      data = normalize(JSON.parse(readFileSync(filePath, 'utf8')));
    } catch (error) {
      if (error?.code === 'ENOENT') {
        data = defaultData();
        return snapshot();
      }
      loadFailed = true;
      onLoadError(`Aviso: arquivo de permissões inválido (${error?.message || error}); execuções serão negadas.`);
      throw error;
    }
    return snapshot();
  }

  /** Pré-checagem sem consumir confirmação: revogação e disponibilidade. */
  function check(tool) {
    if (loadFailed) return { ok: false, reason: 'permissões indisponíveis: arquivo inválido' };
    const revoked = findRevocation(tool.name);
    if (revoked) {
      const suffix = revoked.reason ? `: ${revoked.reason}` : '';
      return { ok: false, reason: `ferramenta revogada (${revoked.tool})${suffix}` };
    }
    return { ok: true };
  }

  /**
   * Autoriza e consome a confirmação de uso único. Fora do nível 4 não há
   * token; revogação vence qualquer confirmação válida.
   */
  function authorize(tool, confirmation) {
    const checked = check(tool);
    if (!checked.ok) return checked;
    if (!permissionRequiresConfirmation(tool.permissionLevel)) return { ok: true };

    const token = typeof confirmation === 'string' ? confirmation.trim() : '';
    const entry = token ? confirmations.get(token) : null;
    if (!entry) return { ok: false, reason: 'confirmação de uso único ausente, inválida ou já usada' };
    confirmations.delete(token);
    if (entry.expiresAtMs <= now()) return { ok: false, reason: 'confirmação expirada; peça uma nova' };
    if (entry.tool !== tool.name) return { ok: false, reason: `confirmação emitida para outra ferramenta (${entry.tool})` };
    return { ok: true };
  }

  /** Emite o token depois da palavra escrita; só para ferramenta viva e não revogada. */
  function createConfirmation(toolName) {
    const tool = registry.get(toolName);
    if (!tool) return { ok: false, notFound: true, errors: ['tool: não registrada'] };
    if (!permissionRequiresConfirmation(tool.permissionLevel)) {
      return { ok: false, notRequired: true, errors: [`tool: nível ${tool.permissionLevel} não exige confirmação`] };
    }
    const checked = check(tool);
    if (!checked.ok) return { ok: false, denied: true, errors: [checked.reason] };

    purgeExpired();
    const token = randomBytes(16).toString('hex');
    const expiresAtMs = now() + ttlMs;
    confirmations.set(token, {
      tool: tool.name,
      permissionLevel: tool.permissionLevel,
      createdAt: iso(now()),
      expiresAtMs,
    });
    return {
      ok: true,
      confirmation: {
        token,
        tool: tool.name,
        permissionLevel: tool.permissionLevel,
        expiresAt: iso(expiresAtMs),
      },
    };
  }

  /** Revoga ferramenta exata ou integração (`namespace.*`); idempotente. */
  function revoke(tool, reason) {
    assertWritable();
    if (!validScope(tool)) return { ok: false, errors: ['tool: use namespace.nome ou namespace.*'] };
    const clean = cleanReason(reason);
    if (clean === null) return { ok: false, errors: ['reason: deve ser texto'] };
    const existing = data.revocations.find(entry => entry.tool === tool);
    if (existing) return { ok: true, revocation: { ...existing }, unchanged: true };

    const revocation = { tool, ...(clean ? { reason: clean } : {}), revokedAt: isoNow() };
    data.revocations.push(revocation);
    if (data.revocations.length > REVOCATION_LIMIT) data.revocations.splice(0, data.revocations.length - REVOCATION_LIMIT);
    persist();
    return { ok: true, revocation: { ...revocation }, unchanged: false };
  }

  function restore(tool) {
    assertWritable();
    if (!validScope(tool)) return { ok: false, errors: ['tool: use namespace.nome ou namespace.*'] };
    const index = data.revocations.findIndex(entry => entry.tool === tool);
    if (index < 0) return { ok: true, removed: false };
    data.revocations.splice(index, 1);
    persist();
    return { ok: true, removed: true };
  }

  return {
    load,
    check,
    authorize,
    createConfirmation,
    revoke,
    restore,
    list: snapshot,
  };
}
