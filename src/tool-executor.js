/**
 * Executor de ferramentas do domínio agêntico.
 *
 * Resolve a ferramenta no registry, valida argumentos, aplica timeout, captura
 * falhas e só reporta sucesso quando `verify(result)` aprova o resultado. Cada
 * execução vira um `ExecutionRecord` (contrato de `agent-contracts.js`) em
 * `data/executions.json`, append-only com teto.
 *
 * O histórico guarda só metadados (nomes dos argumentos, nunca valores): é
 * auditoria, não uma segunda cópia da memória. Escrita atômica (tmp + rename) e
 * relógio injetável, como no `operational-memory-store.js`.
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { dataDir as resolveDataDir } from './data-paths.js';
import {
  AGENT_LIMITS,
  AGENT_SCHEMAS,
  EXECUTION_ORIGINS,
  validateExecutionRecord,
} from './agent-contracts.js';
import { validateToolArguments } from './tool-registry.js';

const FILE_NAME = 'executions.json';
const FILE_VERSION = 1;
export const EXECUTIONS_LIMIT = 500;
export const EXECUTIONS_DEFAULT_LIST = 50;

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const iso = ms => new Date(ms).toISOString();

function summarizeArguments(args) {
  const keys = Object.keys(args).sort();
  return (keys.length ? `args: ${keys.join(', ')}` : 'args: nenhum').slice(0, AGENT_LIMITS.maxInputSummaryChars);
}

function sanitizeReason(error) {
  const raw = typeof error?.message === 'string' ? error.message : String(error ?? '');
  const clean = raw.replace(/\s+/g, ' ').trim().slice(0, AGENT_LIMITS.maxReasonChars);
  return clean.length >= 3 ? clean : 'erro desconhecido na execução';
}

export function createToolExecutor({
  registry,
  dataDir = resolveDataDir(),
  filePath = join(dataDir, FILE_NAME),
  now = () => Date.now(),
  limit = EXECUTIONS_LIMIT,
  onLoadError = message => console.error(message),
} = {}) {
  if (!registry || typeof registry.get !== 'function') throw new Error('createToolExecutor: registry é obrigatório.');
  if (!dataDir || typeof dataDir !== 'string') throw new Error('createToolExecutor: dataDir é obrigatório.');

  const defaultData = () => ({ version: FILE_VERSION, executions: [], updatedAt: iso(now()) });
  let data = defaultData();

  function persist() {
    mkdirSync(dirname(filePath), { recursive: true });
    data.updatedAt = iso(now());
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

  function normalize(input) {
    if (!isPlainObject(input)) throw new Error('histórico de execuções: arquivo deve ser um objeto JSON');
    if (input.version !== FILE_VERSION) throw new Error(`histórico de execuções: versão ${JSON.stringify(input.version)} não suportada`);
    if (!Array.isArray(input.executions)) throw new Error('histórico de execuções: campo executions deve ser uma lista');
    const executions = [];
    for (const [index, raw] of input.executions.entries()) {
      const checked = validateExecutionRecord(raw);
      if (!checked.ok) {
        onLoadError(`Aviso: execução ${index} inválida ignorada (${checked.errors.join('; ')})`);
        continue;
      }
      executions.push(checked.value);
    }
    if (executions.length > limit) executions.splice(0, executions.length - limit);
    return {
      version: FILE_VERSION,
      executions,
      updatedAt: typeof input.updatedAt === 'string' ? input.updatedAt : iso(now()),
    };
  }

  const snapshot = () => ({
    executions: data.executions.map(record => ({ ...record })),
    updatedAt: data.updatedAt,
  });

  function append(record) {
    const checked = validateExecutionRecord(record);
    if (!checked.ok) throw new Error(`execução inválida: ${checked.errors.join('; ')}`);
    data.executions.push(checked.value);
    if (data.executions.length > limit) data.executions.splice(0, data.executions.length - limit);
    persist();
    return { ...checked.value };
  }

  async function execute(name, args, { origin = 'agent' } = {}) {
    if (!EXECUTION_ORIGINS.includes(origin)) {
      return { ok: false, invalidOrigin: true, errors: [`origin inválido (use ${EXECUTION_ORIGINS.join('|')})`] };
    }
    const tool = registry.get(name);
    if (!tool) return { ok: false, notFound: true, errors: ['tool: não registrada'] };

    const validation = validateToolArguments(tool, args === undefined ? {} : args);
    if (!validation.ok) return { ok: false, invalidArguments: true, errors: validation.errors };

    const startedMs = now();
    const startedAt = iso(startedMs);
    const inputSummary = summarizeArguments(validation.value);
    const controller = new AbortController();
    let timer;
    const timedOut = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(Object.assign(new Error(`tempo esgotado após ${tool.timeoutMs} ms`), { code: 'USAMI_TOOL_TIMEOUT' }));
      }, tool.timeoutMs);
    });

    let outcome;
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => tool.execute(validation.value, { signal: controller.signal })),
        timedOut,
      ]);
      let verified = false;
      try {
        verified = tool.verify(result) === true;
      } catch {
        verified = false;
      }
      const finishedMs = now();
      const base = {
        schema: AGENT_SCHEMAS.execution,
        id: `ex-${randomBytes(6).toString('hex')}`,
        tool: tool.name,
        permissionLevel: tool.permissionLevel,
        origin,
        startedAt,
        finishedAt: iso(finishedMs),
        durationMs: Math.max(0, finishedMs - startedMs),
        inputSummary,
      };
      outcome = verified
        ? { ok: true, result, record: { ...base, status: 'ok', verified: true } }
        : { ok: false, record: { ...base, status: 'failed', verified: false, reason: 'verificação: resultado reprovado por verify()' } };
    } catch (error) {
      const finishedMs = now();
      outcome = {
        ok: false,
        record: {
          schema: AGENT_SCHEMAS.execution,
          id: `ex-${randomBytes(6).toString('hex')}`,
          tool: tool.name,
          status: error?.code === 'USAMI_TOOL_TIMEOUT' ? 'timeout' : 'failed',
          permissionLevel: tool.permissionLevel,
          origin,
          startedAt,
          finishedAt: iso(finishedMs),
          durationMs: Math.max(0, finishedMs - startedMs),
          verified: false,
          reason: sanitizeReason(error),
          inputSummary,
        },
      };
    } finally {
      clearTimeout(timer);
    }

    const record = append(outcome.record);
    return outcome.ok ? { ok: true, record, result: outcome.result } : { ok: false, record };
  }

  return {
    /**
     * Carrega o histórico. Arquivo ilegível é preservado ao lado (`.corrupt-*`)
     * e o executor começa vazio: o histórico é auditoria best-effort e não pode
     * impedir a ferramenta de rodar.
     */
    load() {
      try {
        data = normalize(JSON.parse(readFileSync(filePath, 'utf8')));
      } catch (error) {
        if (error?.code === 'ENOENT') {
          data = defaultData();
          return snapshot();
        }
        const quarantine = `${filePath}.corrupt-${now()}`;
        try { renameSync(filePath, quarantine); } catch {}
        data = defaultData();
        onLoadError(`Aviso: histórico de execuções ilegível; preservado em ${quarantine}`);
      }
      return snapshot();
    },

    /** Execuções em ordem de gravação (mais antiga primeiro). */
    getAll() {
      return snapshot();
    },

    /** Histórico para a API: mais recente primeiro. */
    list({ limit: listLimit = EXECUTIONS_DEFAULT_LIST } = {}) {
      const max = Number.isInteger(listLimit) ? Math.min(Math.max(listLimit, 1), limit) : EXECUTIONS_DEFAULT_LIST;
      return data.executions.slice(-max).reverse().map(record => ({ ...record }));
    },

    execute,
  };
}
