/**
 * Skill operacional Code Inspector (Fase 3 local, somente leitura).
 *
 * Publica `skills/code-inspector` em `dataDir/skills` quando ausente e registra
 * `code.inspect` (nível 1) e `code.search` (nível 1) com allowlist estrita
 * reutilizando `redactSecrets` de `self-introspection.js`.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_SCHEMAS } from './agent-contracts.js';
import { redactSecrets } from './self-introspection.js';
import { publishSkillPackage } from './skill-package.js';
import {
  CODE_INSPECT_SCHEMA,
  CODE_SEARCH_SCOPES,
  inspectAllowlistedFile,
  searchAllowlistedCode,
} from '../skills/code-inspector/inspector-core.mjs';

export const CODE_INSPECTOR_SKILL_ID = 'code-inspector';
export const CODE_INSPECTOR_TOOLS = Object.freeze(['code.inspect', 'code.search']);

const DEFAULT_ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export function publishCodeInspectorSkill({ dataDir, bundledDir } = {}) {
  return publishSkillPackage({ skillId: CODE_INSPECTOR_SKILL_ID, dataDir, bundledDir });
}

export function createCodeInspectorTools({
  rootDir = DEFAULT_ROOT_DIR,
} = {}) {
  const inspectTool = {
    schema: AGENT_SCHEMAS.tool,
    name: 'code.inspect',
    version: '1.0.0',
    description: 'Lê trecho e símbolos exportados de um arquivo na allowlist (src/, skills/, docs/, tests/, package.json, server.mjs).',
    origin: 'skill',
    permissionLevel: 1,
    timeoutMs: 5000,
    parameters: [
      { name: 'path', type: 'string', required: true, description: 'Caminho relativo permitido (ex.: src/agent-core.js).' },
      { name: 'startLine', type: 'number', required: false, description: 'Linha inicial (>= 1).' },
      { name: 'endLine', type: 'number', required: false, description: 'Linha final (máx. 120 linhas por leitura).' },
    ],
    verify(result) {
      return isPlainObject(result)
        && result.ok === true
        && result.schema === CODE_INSPECT_SCHEMA
        && result.mode === 'inspect'
        && typeof result.path === 'string'
        && isPlainObject(result.snippet)
        && Array.isArray(result.snippet.lines);
    },
    async execute(args = {}) {
      const inspected = inspectAllowlistedFile({
        rootDir,
        path: args.path,
        startLine: args.startLine,
        endLine: args.endLine,
      });
      inspected.snippet.lines = inspected.snippet.lines.map(entry => ({
        line: entry.line,
        text: redactSecrets(entry.text),
      }));
      return { ok: true, ...inspected };
    },
  };

  const searchTool = {
    schema: AGENT_SCHEMAS.tool,
    name: 'code.search',
    version: '1.0.0',
    description: 'Busca texto ou símbolo nos arquivos permitidos (src/, skills/, docs/) sem ler segredos ou vault.',
    origin: 'skill',
    permissionLevel: 1,
    timeoutMs: 5000,
    parameters: [
      { name: 'query', type: 'string', required: true, description: 'Termo ou símbolo procurado.' },
      { name: 'scope', type: 'string', required: false, enum: [...CODE_SEARCH_SCOPES], description: 'Escopo da busca: all, src, skills ou docs.' },
      { name: 'limit', type: 'number', required: false, description: 'Máximo de ocorrências (1 a 30).' },
    ],
    verify(result) {
      return isPlainObject(result)
        && result.ok === true
        && result.schema === CODE_INSPECT_SCHEMA
        && result.mode === 'search'
        && Array.isArray(result.matches);
    },
    async execute(args = {}) {
      const found = searchAllowlistedCode({
        rootDir,
        query: args.query,
        scope: args.scope,
        limit: args.limit,
      });
      found.matches = found.matches.map(match => ({
        ...match,
        preview: redactSecrets(match.preview),
      }));
      return { ok: true, ...found };
    },
  };

  return [inspectTool, searchTool];
}

