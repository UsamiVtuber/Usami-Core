/**
 * Self-Introspection somente leitura (S11).
 *
 * Monta um retrato fiel de módulos, ferramentas registradas, skills, versões,
 * erros recentes de execução e limitações conhecidas usando apenas fontes em
 * allowlist explícita (`package.json`, `docs/*.md` permitidos, nomes de arquivos
 * em `src/`, Registry, SkillCatalog, Executor e PermissionGate). Nunca lê
 * `.env`, `USAMI_KEYS_FILE`, `vault/` nem expõe stack traces ou credenciais, e
 * evita o termo `capabilities` (reservado ao manifesto do avatar).
 */
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_SCHEMAS } from './agent-contracts.js';

export const SELF_SCHEMA = 'usami.agent.self.v1';
export const DEFAULT_ERROR_LIMIT = 10;
export const MAX_ERROR_LIMIT = 50;
const MAX_DOC_BYTES = 128 * 1024;
const MAX_SUMMARY_REASON_CHARS = 160;

export const DEFAULT_ALLOWLISTED_DOCS = Object.freeze([
  'docs/architecture.md',
  'docs/usami-2.0-architecture-map.md',
]);

const DEFAULT_ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWED_MODULE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.(?:js|mjs|jsx|ts)$/;
const FORBIDDEN_PATH_SEGMENT_RE = /(?:^|\/)(?:\.env(?:\..*)?|\.git|vault|data|tmp|secrets?|credentials?|keys?\.env)(?:\/|$)/i;

const SECRET_PATTERNS = Object.freeze([
  /\bsk-(?:or-|tinyfish-)?[a-zA-Z0-9_-]{8,}\b/gi,
  /\bfc-[a-zA-Z0-9_-]{8,}\b/gi,
  /\bnvapi-[a-zA-Z0-9_-]{8,}\b/gi,
  /\b(?:ghp|gho|ghu|ghs)_[a-zA-Z0-9]{10,}\b/g,
  /\bgithub_pat_[a-zA-Z0-9_]{12,}\b/g,
  /\bya29\.[a-zA-Z0-9._-]{12,}\b/g,
  /\b1\/\/[a-zA-Z0-9._-]{12,}\b/g,
  /\bBearer\s+[a-zA-Z0-9._-]{8,}\b/gi,
  /\b(?:USAMI_API_TOKEN|OPENROUTER_API_KEY|NVIDIA_API_KEY|ELEVENLABS_API_KEY|GEMINI_API_KEY|PLANE_API_KEY|GITHUB_TOKEN|GH_TOKEN|TINYFISH_API_KEY|FIRECRAWL_API_KEY|PLUGGY_API_KEY|PLUGGY_CLIENT_SECRET|BELVO_SECRET_PASSWORD|GOOGLE_CLIENT_SECRET|GOOGLE_REFRESH_TOKEN|GOOGLE_ACCESS_TOKEN|API_KEY|SECRET|PASSWORD|ACCESS_TOKEN)\s*[:=]\s*\S+/gi,
  /\bx-usami-token\s*[:=]\s*\S+/gi,
]);

const STACK_LINE_RE = /\s+at\s+(?:async\s+)?(?:[^\s(]+\s+\()?[^\n)]+:\d+(?::\d+)?\)?/g;
const WIN_PATH_RE = /\b[A-Za-z]:\\(?:[^\\\s)'"]+\\)*[^\\\s)'"]*/g;
const POSIX_PATH_RE = /(?:\/(?:Users|home|var|etc|tmp|app|srv|opt|root)\/[^\s)'"]+)/g;

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export function redactSecrets(value) {
  let text = String(value ?? '');
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, '[redigido]');
  }
  return text;
}

export function stripStackAndSecrets(value, maxChars = MAX_SUMMARY_REASON_CHARS) {
  const withoutStack = String(value ?? '')
    .split(/\r?\n/)[0]
    .replace(STACK_LINE_RE, '')
    .replace(WIN_PATH_RE, '[caminho]')
    .replace(POSIX_PATH_RE, '[caminho]');
  const clean = redactSecrets(withoutStack).replace(/\s+/g, ' ').trim();
  if (!clean) return 'erro registrado sem detalhes públicos';
  return clean.length <= maxChars ? clean : `${clean.slice(0, maxChars - 3)}...`;
}

export function containsSensitiveLeak(value) {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return /\b(?:sk-or-v1-|nvapi-|ghp_|github_pat_|OPENROUTER_API_KEY=|NVIDIA_API_KEY=|USAMI_API_TOKEN=|PLANE_API_KEY=|GITHUB_TOKEN=|GH_TOKEN=)/i.test(serialized)
    || /\n\s+at\s+\S+:\d+/.test(serialized);
}

function normalizeRelPath(relPath) {
  return String(relPath ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

function isAllowedDocRelPath(relPath, allowlistedDocs) {
  const normalized = normalizeRelPath(relPath);
  if (!normalized || normalized.startsWith('/') || normalized.includes('..')) return false;
  if (FORBIDDEN_PATH_SEGMENT_RE.test(normalized)) return false;
  return allowlistedDocs.includes(normalized);
}

function readAllowlistedFile(rootDir, relPath, { maxBytes = MAX_DOC_BYTES } = {}) {
  const rootResolved = resolve(rootDir);
  const target = resolve(rootResolved, relPath);
  const diff = relative(rootResolved, target).replace(/\\/g, '/');
  if (!diff || diff.startsWith('..') || isAbsolute(diff) || FORBIDDEN_PATH_SEGMENT_RE.test(diff)) {
    throw new Error(`fonte fora da allowlist: ${relPath}`);
  }
  const stat = lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`fonte inválida (symlink ou não-arquivo): ${relPath}`);
  }
  if (stat.size > maxBytes) {
    throw new Error(`fonte excede limite de ${maxBytes} bytes: ${relPath}`);
  }
  return readFileSync(target, 'utf8');
}

function classifyModuleArea(filename) {
  if (/^(?:agent-|operational-memory|permission-gate|tool-|task-planner|skill-|personal-planner|self-introspection|memory-search)/.test(filename)) {
    return 'agent';
  }
  if (/^(?:animation|motion|vrm|vrma|expression|eye|facs|natural-idle|surface-reflex|sequence|scenes|mesh)/.test(filename)) {
    return 'animation';
  }
  if (/^(?:tts|stt|audio|speech|voice|visemes|vowel)/.test(filename)) {
    return 'voice';
  }
  if (/^(?:memory|bond|affinity|achievements|personality|conversation|rag|vault)/.test(filename)) {
    return 'memory';
  }
  if (/\.(?:jsx|css|ts)$/.test(filename)) {
    return 'ui';
  }
  return 'core';
}

function readModulesInventory(rootDir) {
  const srcDir = resolve(rootDir, 'src');
  let entries;
  try {
    const stat = lstatSync(srcDir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return [];
    entries = readdirSync(srcDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const modules = [];
  for (const entry of entries) {
    if (!entry.isFile() || !ALLOWED_MODULE_RE.test(entry.name)) continue;
    modules.push({
      name: entry.name.replace(/\.(?:js|mjs|jsx|ts)$/, ''),
      file: `src/${entry.name}`,
      area: classifyModuleArea(entry.name),
    });
  }
  return modules.sort((a, b) => a.file.localeCompare(b.file));
}

function readPackageMetadata(rootDir) {
  try {
    const raw = JSON.parse(readAllowlistedFile(rootDir, 'package.json'));
    const scripts = isPlainObject(raw.scripts)
      ? Object.keys(raw.scripts).filter(name => typeof name === 'string')
      : [];
    return {
      name: typeof raw.name === 'string' ? raw.name : 'usami',
      version: typeof raw.version === 'string' ? raw.version : '0.0.0',
      type: typeof raw.type === 'string' ? raw.type : 'module',
      scripts,
    };
  } catch {
    return { name: 'usami', version: '0.0.0', type: 'module', scripts: [] };
  }
}

function parseDocMetadata(path, content) {
  const lines = content.split(/\r?\n/);
  let title = path;
  const sections = [];
  for (const line of lines) {
    const heading = /^(#{1,3})\s+(.+)$/.exec(line.trim());
    if (!heading) continue;
    const clean = redactSecrets(heading[2].trim());
    if (heading[1].length === 1 && title === path) {
      title = clean;
    } else if (sections.length < 20) {
      sections.push(clean);
    }
  }
  return { path, title, sections };
}

export function createSelfIntrospection({
  rootDir = DEFAULT_ROOT_DIR,
  allowlistedDocs = DEFAULT_ALLOWLISTED_DOCS,
  docPaths = DEFAULT_ALLOWLISTED_DOCS,
  registry = null,
  skillCatalog = null,
  executor = null,
  permissionGate = null,
  now = () => Date.now(),
} = {}) {
  if (!rootDir || typeof rootDir !== 'string') {
    throw new Error('createSelfIntrospection: rootDir é obrigatório.');
  }
  const normalizedAllowlist = [...new Set(allowlistedDocs.map(normalizeRelPath).filter(Boolean))];

  function readAllowlistedDocs() {
    const loaded = [];
    const rejected = [];
    for (const candidate of docPaths) {
      const normalized = normalizeRelPath(candidate);
      if (!isAllowedDocRelPath(normalized, normalizedAllowlist)) {
        rejected.push(normalized || String(candidate));
        continue;
      }
      try {
        const content = readAllowlistedFile(rootDir, normalized);
        loaded.push(parseDocMetadata(normalized, content));
      } catch {
        rejected.push(normalized);
      }
    }
    return { loaded, rejected };
  }

  function summarizeTools() {
    if (!registry || typeof registry.list !== 'function') return [];
    return registry.list().map(tool => {
      const check = permissionGate && typeof permissionGate.check === 'function'
        ? permissionGate.check(tool)
        : { ok: true };
      return {
        name: tool.name,
        version: tool.version,
        description: redactSecrets(tool.description),
        origin: tool.origin,
        permissionLevel: tool.permissionLevel,
        active: check.ok === true,
        revoked: check.ok !== true,
        ...(check.ok !== true && check.reason ? { revokedReason: stripStackAndSecrets(check.reason) } : {}),
        parameters: Array.isArray(tool.parameters)
          ? tool.parameters.map(param => ({ name: param.name, type: param.type, required: Boolean(param.required) }))
          : [],
      };
    }).sort((a, b) => a.name.localeCompare(b.name));
  }

  function summarizeSkills() {
    if (!skillCatalog || typeof skillCatalog.list !== 'function') return [];
    return skillCatalog.list().map(skill => ({
      id: skill.id,
      valid: skill.valid === true,
      ...(skill.name ? { name: skill.name } : {}),
      ...(skill.version ? { version: skill.version } : {}),
      ...(skill.description ? { description: redactSecrets(skill.description) } : {}),
      ...(skill.state ? { state: skill.state } : {}),
      ...(skill.origin ? { origin: skill.origin } : {}),
      ...(skill.maxPermissionLevel !== undefined ? { maxPermissionLevel: skill.maxPermissionLevel } : {}),
      activation: skill.activation ?? { canActivate: false, reasons: ['indisponível'] },
      ...(skill.missing ? { missing: skill.missing } : {}),
      ...(Array.isArray(skill.errors) ? { errors: skill.errors.map(err => stripStackAndSecrets(err, 140)) } : {}),
    }));
  }

  function summarizeRecentErrors(errorLimit = DEFAULT_ERROR_LIMIT) {
    const limit = Number.isInteger(errorLimit)
      ? Math.min(Math.max(errorLimit, 1), MAX_ERROR_LIMIT)
      : DEFAULT_ERROR_LIMIT;
    if (!executor || typeof executor.list !== 'function') {
      return {
        totalFailures: 0,
        byStatus: { failed: 0, denied: 0, timeout: 0 },
        items: [],
      };
    }

    const records = executor.list({ limit: 500 });
    const failures = records.filter(record => record && record.status !== 'ok');
    const byStatus = { failed: 0, denied: 0, timeout: 0 };
    for (const record of failures) {
      if (record.status in byStatus) byStatus[record.status] += 1;
    }

    const items = failures.slice(-limit).reverse().map(record => ({
      id: record.id,
      tool: record.tool,
      status: record.status,
      origin: record.origin,
      startedAt: record.startedAt,
      ...(record.finishedAt ? { finishedAt: record.finishedAt } : {}),
      reason: stripStackAndSecrets(record.reason),
    }));

    return {
      totalFailures: failures.length,
      byStatus,
      items,
    };
  }

  function collectIntegrations({ tools, skills }) {
    const namespaces = new Set(tools.filter(t => t.active).map(t => t.name.split('.')[0]));
    const integrations = [];
    if (namespaces.has('memory')) {
      integrations.push({ id: 'local-memory', kind: 'local', status: 'active', description: 'Memória local (somente leitura via memory.search; vault isolado).' });
    }
    if (namespaces.has('planner')) {
      integrations.push({ id: 'personal-planner', kind: 'skill', status: 'active', description: 'Planejamento semanal sobre memória operacional e Task Planner.' });
    }
    if (namespaces.has('self')) {
      integrations.push({ id: 'self-introspection', kind: 'local', status: 'active', description: 'Introspecção somente leitura do sistema.' });
    }
    for (const skill of skills) {
      if (skill.id === 'personal-planner') continue;
      integrations.push({
        id: skill.id,
        kind: 'skill',
        status: skill.activation?.canActivate ? 'active' : 'inactive',
        ...(skill.description ? { description: skill.description } : {}),
      });
    }
    return integrations;
  }

  function collectLimitations({ tools, skills, rejectedDocs }) {
    const limitations = [
      'Modo somente leitura: autodescrição não altera código nem instala skills sem proposta, confirmação humana e teste isolado (S8).',
      'Segredos e conteúdo privado (.env, chaves de API e vault/) não são inspecionados.',
    ];

    const toolNames = new Set(tools.filter(t => t.active).map(t => t.name));
    const hasNamespace = ns => [...toolNames].some(name => name.startsWith(`${ns}.`));

    if (!hasNamespace('calendar')) {
      limitations.push('Agenda externa (Calendar Manager) não conectada: cronogramas usam apenas a memória operacional local.');
    }
    if (!hasNamespace('email') && !hasNamespace('mail')) {
      limitations.push('E-mail externo (Email Assistant) não conectado.');
    }
    if (!hasNamespace('finance')) {
      limitations.push('Finanças externas (Finance Observer) não conectadas.');
    }
    if (!hasNamespace('web') && !hasNamespace('research')) {
      limitations.push('Busca web agêntica não integrada.');
    }

    for (const revoked of tools.filter(t => t.revoked)) {
      limitations.push(`Ferramenta revogada pelo gate de permissões: ${revoked.name}.`);
    }

    for (const skill of skills) {
      if (!skill.valid) {
        limitations.push(`Skill ${skill.id} com manifesto inválido.`);
      } else if (!skill.activation?.canActivate) {
        const why = skill.activation?.reasons?.join(', ') || 'não ativada';
        limitations.push(`Skill ${skill.id} indisponível no momento (${why}).`);
      }
    }

    if (permissionGate && typeof permissionGate.list === 'function') {
      try {
        const state = permissionGate.list();
        for (const entry of state.revocations ?? []) {
          if (entry.tool.endsWith('.*')) {
            limitations.push(`Escopo revogado pelo operador: ${entry.tool}.`);
          }
        }
      } catch {
        limitations.push('Gate de permissões indisponível para consulta de revogações.');
      }
    }

    if (rejectedDocs.length > 0) {
      limitations.push(`${rejectedDocs.length} fonte(s) fora da allowlist foram ignoradas.`);
    }

    return limitations;
  }

  function describe({ focus = 'all', errorLimit = DEFAULT_ERROR_LIMIT } = {}) {
    const pkg = readPackageMetadata(rootDir);
    const modules = readModulesInventory(rootDir);
    const { loaded: docs, rejected: rejectedDocs } = readAllowlistedDocs();
    const tools = summarizeTools();
    const skills = summarizeSkills();
    const recentErrors = summarizeRecentErrors(errorLimit);
    const integrations = collectIntegrations({ tools, skills });
    const limitations = collectLimitations({ tools, skills, rejectedDocs });

    const activeToolNames = tools.filter(t => t.active).map(t => t.name);
    const activeSkills = skills.filter(s => s.activation?.canActivate).map(s => s.id);
    const summaryParts = [
      `${pkg.name} v${pkg.version} (somente leitura): ${activeToolNames.length} ferramenta(s) ativa(s) (${activeToolNames.join(', ') || 'nenhuma'})`,
      `${activeSkills.length}/${skills.length} skill(s) ativa(s)`,
      `${modules.length} módulo(s) em src/`,
    ];
    if (recentErrors.totalFailures > 0) {
      summaryParts.push(`${recentErrors.totalFailures} falha(s)/negação(ões) recente(s) no histórico`);
    }
    summaryParts.push(`Principais limitações: ${limitations.slice(0, 3).join(' ')}`);

    return {
      schema: SELF_SCHEMA,
      readOnly: true,
      focus,
      generatedAt: new Date(now()).toISOString(),
      runtime: {
        ...pkg,
        nodeVersion: process.version,
        platform: process.platform,
      },
      sources: {
        packageJson: 'package.json',
        docs: docs.map(doc => doc.path),
        modulesDir: 'src',
        rejectedCount: rejectedDocs.length,
      },
      modules,
      tools,
      skills,
      integrations,
      limitations,
      recentErrors,
      docs,
      summary: summaryParts.join('; ') + '.',
    };
  }

  return {
    describe,
    allowlist: Object.freeze([...normalizedAllowlist]),
  };
}

export function formatSelfAwarenessPrompt({
  snapshot,
  gitStatus = null,
  githubConfigured = false,
  integrationsStatus = null,
} = {}) {
  if (!snapshot || typeof snapshot !== 'object') return '';
  const pkgName = String(snapshot.runtime?.name || 'usami');
  const pkgVer = String(snapshot.runtime?.version || '0.0.0');
  const modulesCount = Array.isArray(snapshot.modules) ? snapshot.modules.length : 0;
  const activeTools = Array.isArray(snapshot.tools)
    ? snapshot.tools.filter(t => t.active).map(t => t.name)
    : [];
  const activeSkillEntries = Array.isArray(snapshot.skills)
    ? snapshot.skills.filter(s => s.activation?.canActivate || s.state === 'active')
    : [];
  const activeSkillIds = activeSkillEntries.map(s => s.id);

  const lines = [
    `Runtime: ${pkgName} v${pkgVer} (${modulesCount} módulos em src/, código inspecionável em usami/ e usami-desktop/ via allowlist).`,
    `Skills prontas/ativas (${activeSkillEntries.length}): ${activeSkillIds.join(', ') || 'nenhuma'}.`,
  ];

  if (activeSkillEntries.length > 0) {
    for (const skill of activeSkillEntries) {
      const desc = redactSecrets(String(skill.description || '').replace(/\s+/g, ' ').trim()).slice(0, 140);
      lines.push(`- ${skill.id}${desc ? `: ${desc}` : ''}`);
    }
  }

  lines.push(`Ferramentas ativas (${activeTools.length}): ${activeTools.join(', ') || 'nenhuma'}.`);

  if (gitStatus && typeof gitStatus === 'object') {
    const headHash = gitStatus.head?.hash ? ` (${gitStatus.head.hash}: ${String(gitStatus.head.subject || '').slice(0, 70)})` : '';
    const dirtyCount = (gitStatus.staged?.length || 0) + (gitStatus.modified?.length || 0) + (gitStatus.untracked?.length || 0);
    lines.push(`Git local (${gitStatus.target || 'usami'}): branch ${gitStatus.branch || 'HEAD'}${headHash}; ${dirtyCount} alteração(ões) pendente(s).`);
  }

  const ghReady = Boolean(integrationsStatus?.github ?? githubConfigured);
  lines.push(`GitHub API (GITHUB_TOKEN): ${ghReady ? 'configurada' : 'não configurada (falha fechado até definir no .env)'}.`);

  if (integrationsStatus && typeof integrationsStatus === 'object') {
    const statusLabel = flag => (flag ? 'pronta' : 'não configurada');
    lines.push(
      'Integrações externas (.env): '
      + `Google (Calendar/Gmail)=${statusLabel(integrationsStatus.google)}, `
      + `Open Finance (Pluggy/Belvo)=${statusLabel(integrationsStatus.openFinance)}, `
      + `Pesquisa Web (TinyFish/Firecrawl)=${statusLabel(integrationsStatus.research)}, `
      + `GitHub API=${statusLabel(ghReady)}.`,
    );
  }

  lines.push('Uso das skills no chat: pedidos operacionais seguros (nível 1-3: agenda, e-mail, Open Finance, pesquisa web, código, Git, estudos, documentos, briefing) são executados antes da sua resposta; ações críticas (nível 4: commit, push, PR, envio de e-mail, criar evento) exigem confirmação humana. Nunca diga "vou verificar/mostrar primeiro..." prometendo ação futura: se há dados reais em RESULTADO DA SKILL EXECUTADA AGORA, entregue-os direto; caso contrário, responda com o que já consta acima.');
  lines.push('Regra: você CONHECE e TEM acesso direto a todas as skills e integrações listadas acima — quando perguntarem se você sabe das suas skills novas ou o que mudou, responda confirmando e citando exemplos reais dessa lista (ex.: Google Agenda/Gmail, Open Finance Pluggy, pesquisa web TinyFish/Firecrawl, Git/GitHub, briefing, estudos, documentos, código, skill-architect), sem nunca dizer que não sabe ou pedir para o usuário contar o que mudou, e sem inventar segredos ou tokens.');

  return redactSecrets(lines.join('\n'));
}

export function createSelfDescribeTool({ introspection } = {}) {
  if (!introspection || typeof introspection.describe !== 'function') {
    throw new Error('createSelfDescribeTool: introspection é obrigatório.');
  }

  return {
    schema: AGENT_SCHEMAS.tool,
    name: 'self.describe',
    version: '1.0.0',
    description: 'Lista módulos, ferramentas reais, skills, versões, erros recentes e limitações conhecidas (somente leitura).',
    origin: 'runtime',
    permissionLevel: 1,
    timeoutMs: 2000,
    parameters: [
      {
        name: 'focus',
        type: 'string',
        required: false,
        enum: ['all', 'tools', 'skills', 'modules', 'errors', 'limitations'],
        description: 'Área de interesse do retrato (sempre retorna ferramentas e limitações reais).',
      },
      {
        name: 'errorLimit',
        type: 'number',
        required: false,
        description: `Máximo de erros recentes resumidos (1 a ${MAX_ERROR_LIMIT}; padrão ${DEFAULT_ERROR_LIMIT}).`,
      },
    ],
    verify(result) {
      return isPlainObject(result)
        && result.schema === SELF_SCHEMA
        && result.readOnly === true
        && !Object.prototype.hasOwnProperty.call(result, 'capabilities')
        && Array.isArray(result.tools)
        && Array.isArray(result.skills)
        && Array.isArray(result.modules)
        && Array.isArray(result.limitations)
        && isPlainObject(result.recentErrors)
        && Array.isArray(result.recentErrors.items)
        && typeof result.summary === 'string'
        && result.summary.trim().length > 0
        && !containsSensitiveLeak(result);
    },
    execute(args = {}) {
      const focus = args.focus ?? 'all';
      const errorLimit = args.errorLimit === undefined ? DEFAULT_ERROR_LIMIT : args.errorLimit;
      if (!Number.isInteger(errorLimit) || errorLimit < 1 || errorLimit > MAX_ERROR_LIMIT) {
        throw new Error(`errorLimit: inteiro entre 1 e ${MAX_ERROR_LIMIT}`);
      }
      return introspection.describe({ focus, errorLimit });
    },
  };
}
