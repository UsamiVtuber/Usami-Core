/**
 * Skill operacional Git Assistant (Git local + GitHub REST API).
 *
 * Publica `skills/git-assistant` em `dataDir/skills` quando ausente e registra:
 *  - `git.status` (nível 1): branch atual, HEAD e alterações locais;
 *  - `git.log` (nível 1): histórico recente de commits;
 *  - `git.diff` (nível 1): resumo `--stat` e diff redigido;
 *  - `github.repos` (nível 3): consulta repositórios/branches/commits/PRs via `GITHUB_TOKEN`;
 *  - `git.commit` (nível 4): stage em allowlist + commit (exige confirmação humana S5);
 *  - `git.push` (nível 4): push sem `--force` (exige confirmação humana S5);
 *  - `github.pr` (nível 4): cria Pull Request no GitHub (exige confirmação humana S5).
 */
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { AGENT_SCHEMAS } from './agent-contracts.js';
import { readEnvValue } from './api-security.js';
import { redactSecrets } from './self-introspection.js';
import { publishSkillPackage } from './skill-package.js';
import {
  GIT_ASSISTANT_SCHEMA,
  GIT_REPO_TARGETS,
  normalizeGitHubRepo,
  normalizeRepoTarget,
  parseGitLog,
  parsePorcelainStatus,
  parseRepoSlug,
  redactGitText,
  sanitizeGitRelPath,
  validateBranchName,
  validateCommitFiles,
  validateCommitMessage,
  validateGitRef,
  validateRemoteName,
} from '../skills/git-assistant/git-core.mjs';

const execFileAsync = promisify(execFile);

export const GIT_ASSISTANT_SKILL_ID = 'git-assistant';
export const GIT_ASSISTANT_TOOLS = Object.freeze([
  'git.status',
  'git.log',
  'git.diff',
  'git.commit',
  'git.push',
  'github.repos',
  'github.pr',
  'github.issue',
  'code.propose',
  'code.proposals',
]);

const GITHUB_API_BASE = 'https://api.github.com';
const DEFAULT_USAMI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_DESKTOP_ROOT = resolve(DEFAULT_USAMI_ROOT, '../usami-desktop');
const DEFAULT_WORKSPACE_ROOT = resolve(DEFAULT_USAMI_ROOT, '..');
const MAX_DIFF_CHARS = 3500;
const GIT_TIMEOUT_MS = 15000;

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function sanitizeError(error) {
  const raw = error?.stderr || error?.message || String(error ?? 'erro git');
  return redactSecrets(redactGitText(raw)).replace(/\s+/g, ' ').trim().slice(0, 240);
}

async function defaultExecGit(cwd, args, { env } = {}) {
  try {
    const res = await execFileAsync('git', args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 512 * 1024,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(env || {}) },
    });
    return {
      stdout: String(res.stdout || ''),
      stderr: String(res.stderr || ''),
    };
  } catch (error) {
    throw new Error(sanitizeError(error));
  }
}

function createEphemeralAskPass(token) {
  const dir = mkdtempSync(join(tmpdir(), 'usami-git-askpass-'));
  const isWin = process.platform === 'win32';
  const scriptPath = join(dir, isWin ? 'askpass.cmd' : 'askpass.sh');
  const script = isWin
    ? '@echo off\r\necho %~1 | findstr /i "username" >nul\r\nif %errorlevel%==0 (\r\n  echo x-access-token\r\n) else (\r\n  echo %USAMI_GIT_PASS%\r\n)\r\n'
    : '#!/bin/sh\ncase "$1" in\n  [Uu]sername*) printf "%s\\n" "x-access-token" ;;\n  *) printf "%s\\n" "$USAMI_GIT_PASS" ;;\nesac\n';
  writeFileSync(scriptPath, script, 'utf8');
  if (!isWin) {
    try { chmodSync(scriptPath, 0o700); } catch {}
  }
  return {
    env: {
      GIT_ASKPASS: scriptPath,
      SSH_ASKPASS: scriptPath,
      USAMI_GIT_PASS: token,
      GIT_TERMINAL_PROMPT: '0',
    },
    cleanup() {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    },
  };
}

export function publishGitAssistantSkill({ dataDir, bundledDir } = {}) {
  return publishSkillPackage({ skillId: GIT_ASSISTANT_SKILL_ID, dataDir, bundledDir });
}

export function createGitAssistantClient({
  repoDirs = {
    usami: DEFAULT_USAMI_ROOT,
    desktop: DEFAULT_DESKTOP_ROOT,
    workspace: DEFAULT_WORKSPACE_ROOT,
  },
  envProvider = name => readEnvValue(name),
  execGit = defaultExecGit,
  fetchImpl = (...args) => fetch(...args),
} = {}) {
  function resolveRepoDir(target = 'usami') {
    const key = normalizeRepoTarget(target);
    const dir = repoDirs?.[key];
    if (!dir || typeof dir !== 'string' || !existsSync(dir)) {
      throw new Error(`repositório "${key}" não encontrado no workspace.`);
    }
    if (!existsSync(join(dir, '.git'))) {
      throw new Error(`diretório "${key}" não possui repositório Git inicializado.`);
    }
    return { target: key, cwd: resolve(dir) };
  }

  function readGitHubToken() {
    const raw = envProvider('GITHUB_TOKEN') || envProvider('GH_TOKEN') || '';
    return String(raw).trim();
  }

  async function requestGitHub(path, { method = 'GET', body } = {}) {
    const token = readGitHubToken();
    if (!token) {
      throw new Error('GITHUB_TOKEN não configurado no .env.');
    }
    const res = await fetchImpl(`${GITHUB_API_BASE}${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'Usami-Companion',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = typeof data?.message === 'string' ? `: ${redactSecrets(redactGitText(data.message))}` : '';
      throw new Error(`GitHub API erro HTTP ${res.status}${detail}`);
    }
    return data;
  }

  return {
    isGitHubConfigured() {
      return Boolean(readGitHubToken());
    },

    readBranchSync(target = 'usami') {
      try {
        const { target: key, cwd } = resolveRepoDir(target);
        const headRaw = readFileSync(join(cwd, '.git', 'HEAD'), 'utf8').trim();
        const refPrefix = 'ref: refs/heads/';
        const branch = headRaw.startsWith(refPrefix)
          ? headRaw.slice(refPrefix.length)
          : (headRaw ? headRaw.slice(0, 12) : 'HEAD');
        return { target: key, branch, head: null, staged: [], modified: [], untracked: [] };
      } catch {
        return null;
      }
    },

    async status({ target = 'usami' } = {}) {
      const { target: key, cwd } = resolveRepoDir(target);
      const { stdout } = await execGit(cwd, ['status', '--porcelain=v1', '-b']);
      const parsed = parsePorcelainStatus(stdout);

      let head = null;
      try {
        const logRes = await execGit(cwd, ['log', '-n', '1', '--format=%h\x1f%an\x1f%cI\x1f%s']);
        head = parseGitLog(logRes.stdout)[0] || null;
      } catch {
        head = null;
      }

      return {
        target: key,
        ...parsed,
        head,
      };
    },

    async log({ target = 'usami', limit = 10, path = null } = {}) {
      const { target: key, cwd } = resolveRepoDir(target);
      const safeLimit = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 20) : 10;
      const args = ['log', '-n', String(safeLimit), '--format=%h\x1f%an\x1f%cI\x1f%s'];
      if (path) {
        args.push('--', sanitizeGitRelPath(path));
      }
      const { stdout } = await execGit(cwd, args);
      const commits = parseGitLog(stdout);
      return {
        target: key,
        count: commits.length,
        commits,
      };
    },

    async diff({ target = 'usami', ref = null, path = null, staged = false } = {}) {
      const { target: key, cwd } = resolveRepoDir(target);
      const baseArgs = ['diff'];
      if (staged === true) baseArgs.push('--cached');
      const safeRef = validateGitRef(ref);
      if (safeRef) baseArgs.push(safeRef);
      const safePath = path ? sanitizeGitRelPath(path) : null;
      const pathTail = safePath ? ['--', safePath] : [];

      const statRes = await execGit(cwd, [...baseArgs, '--stat', ...pathTail]);
      const patchRes = await execGit(cwd, [...baseArgs, '--unified=2', ...pathTail]);
      const cleanPatch = redactSecrets(redactGitText(patchRes.stdout));
      const truncated = cleanPatch.length > MAX_DIFF_CHARS;

      return {
        target: key,
        staged: staged === true,
        ref: safeRef,
        stat: redactSecrets(redactGitText(statRes.stdout)).trim(),
        diff: truncated ? `${cleanPatch.slice(0, MAX_DIFF_CHARS)}\n...[truncado]` : cleanPatch,
        truncated,
      };
    },

    async commit({ target = 'usami', message, files = [] } = {}) {
      const { target: key, cwd } = resolveRepoDir(target);
      const safeMsg = validateCommitMessage(message);
      const safeFiles = validateCommitFiles(files);

      for (const rel of safeFiles) {
        const full = resolve(cwd, rel);
        if (existsSync(full) && lstatSync(full).isSymbolicLink()) {
          throw new Error(`symlink não permitido em commit: ${rel}`);
        }
      }

      if (safeFiles.length > 0) {
        await execGit(cwd, ['add', '--', ...safeFiles]);
      }

      const stagedRes = await execGit(cwd, ['diff', '--cached', '--name-only']);
      const stagedFiles = stagedRes.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      if (stagedFiles.length === 0) {
        throw new Error('nenhum arquivo em stage para commit (informe files ou faça stage antes).');
      }
      for (const rel of stagedFiles) sanitizeGitRelPath(rel);

      await execGit(cwd, ['commit', '-m', safeMsg]);
      const headRes = await execGit(cwd, ['log', '-n', '1', '--format=%h\x1f%an\x1f%cI\x1f%s']);
      const commit = parseGitLog(headRes.stdout)[0] || null;

      return {
        target: key,
        committed: true,
        files: stagedFiles,
        commit,
      };
    },

    async push({ target = 'usami', remote = 'origin', branch = null } = {}) {
      const { target: key, cwd } = resolveRepoDir(target);
      const safeRemote = validateRemoteName(remote);
      let targetBranch = branch ? validateBranchName(branch) : null;
      if (!targetBranch) {
        const brRes = await execGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
        targetBranch = validateBranchName(brRes.stdout.trim());
      }

      const token = readGitHubToken();
      const askPass = token ? createEphemeralAskPass(token) : null;
      try {
        await execGit(cwd, ['push', safeRemote, targetBranch], askPass ? { env: askPass.env } : {});
      } finally {
        askPass?.cleanup();
      }

      return {
        target: key,
        pushed: true,
        remote: safeRemote,
        branch: targetBranch,
      };
    },

    async listRepos({ owner = null, repo = null, limit = 10 } = {}) {
      const safeLimit = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 30) : 10;
      if (repo) {
        const { slug } = parseRepoSlug(repo);
        const [meta, branches, commits, pulls] = await Promise.all([
          requestGitHub(`/repos/${slug}`),
          requestGitHub(`/repos/${slug}/branches?per_page=10`),
          requestGitHub(`/repos/${slug}/commits?per_page=${Math.min(safeLimit, 15)}`),
          requestGitHub(`/repos/${slug}/pulls?state=open&per_page=10`),
        ]);
        return {
          mode: 'repo',
          repository: normalizeGitHubRepo(meta),
          branches: (Array.isArray(branches) ? branches : []).map(b => String(b?.name || '')).filter(Boolean),
          commits: (Array.isArray(commits) ? commits : []).map(c => ({
            hash: String(c?.sha || '').slice(0, 12),
            author: String(c?.commit?.author?.name || c?.author?.login || ''),
            date: String(c?.commit?.author?.date || ''),
            subject: redactGitText(String(c?.commit?.message || '').split(/\r?\n/)[0]).slice(0, 140),
          })),
          openPullRequests: (Array.isArray(pulls) ? pulls : []).map(pr => ({
            number: pr.number,
            title: String(pr.title || '').slice(0, 140),
            head: String(pr?.head?.ref || ''),
            base: String(pr?.base?.ref || ''),
            htmlUrl: pr.html_url || null,
          })),
        };
      }

      if (!readGitHubToken()) {
        throw new Error('GITHUB_TOKEN não configurado no .env.');
      }

      const effectiveOwner = String(owner || envProvider('GITHUB_USERNAME') || '').trim();
      const raw = owner
        ? await requestGitHub(`/users/${encodeURIComponent(String(owner).trim())}/repos?sort=updated&per_page=${safeLimit}`)
        : await requestGitHub(`/user/repos?sort=updated&affiliation=owner,collaborator&per_page=${safeLimit}`).catch((err) => {
            if (!effectiveOwner) throw err;
            return requestGitHub(`/users/${encodeURIComponent(effectiveOwner)}/repos?sort=updated&per_page=${safeLimit}`);
          });

      const repositories = (Array.isArray(raw) ? raw : []).map(normalizeGitHubRepo).filter(Boolean);
      return {
        mode: 'list',
        count: repositories.length,
        repositories,
      };
    },

    async createPullRequest({ repo, title, head, base = 'main', body = '', draft = false } = {}) {
      const { slug } = parseRepoSlug(repo);
      const safeTitle = String(title ?? '').trim().slice(0, 200);
      if (safeTitle.length < 3) throw new Error('title do PR deve ter ao menos 3 caracteres.');
      const safeHead = validateBranchName(head);
      const safeBase = validateBranchName(base);

      const created = await requestGitHub(`/repos/${slug}/pulls`, {
        method: 'POST',
        body: {
          title: safeTitle,
          head: safeHead,
          base: safeBase,
          body: String(body ?? '').slice(0, 500),
          draft: draft === true,
        },
      });

      return {
        created: true,
        repo: slug,
        number: created.number,
        title: String(created.title || safeTitle),
        htmlUrl: created.html_url || null,
      };
    },

    async createIssue({ repo, title, body = '', labels = ['usami-proposal'] } = {}) {
      const { slug } = parseRepoSlug(repo || 'UsamiVtuber/Usami-Core');
      const safeTitle = String(title ?? '').trim().slice(0, 200);
      if (safeTitle.length < 3) throw new Error('title da issue deve ter ao menos 3 caracteres.');
      const safeLabels = Array.isArray(labels)
        ? labels.map(l => String(l || '').trim()).filter(Boolean).slice(0, 10)
        : ['usami-proposal'];

      const created = await requestGitHub(`/repos/${slug}/issues`, {
        method: 'POST',
        body: {
          title: safeTitle,
          body: String(body ?? '').slice(0, 4000),
          ...(safeLabels.length ? { labels: safeLabels } : {}),
        },
      });

      return {
        created: true,
        repo: slug,
        number: created.number,
        title: String(created.title || safeTitle),
        htmlUrl: created.html_url || null,
        labels: Array.isArray(created.labels) ? created.labels.map(l => (typeof l === 'string' ? l : l.name)) : safeLabels,
      };
    },
  };
}

export function createGitAssistantTools({
  gitClient = createGitAssistantClient(),
  codeBridge = null,
} = {}) {
  const statusTool = {
    schema: AGENT_SCHEMAS.tool,
    name: 'git.status',
    version: '1.0.0',
    description: 'Consulta branch atual, último commit e arquivos modificados no repositório Git local (somente leitura).',
    origin: 'skill',
    permissionLevel: 1,
    timeoutMs: 10000,
    parameters: [
      { name: 'target', type: 'string', required: false, enum: [...GIT_REPO_TARGETS], description: 'Repositório alvo: usami, desktop ou workspace.' },
    ],
    verify(result) {
      return isPlainObject(result) && result.ok === true && result.schema === GIT_ASSISTANT_SCHEMA && typeof result.branch === 'string';
    },
    async execute(args = {}) {
      const data = await gitClient.status({ target: args.target || 'usami' });
      return { ok: true, schema: GIT_ASSISTANT_SCHEMA, ...data };
    },
  };

  const logTool = {
    schema: AGENT_SCHEMAS.tool,
    name: 'git.log',
    version: '1.0.0',
    description: 'Lista commits recentes do repositório local (somente leitura).',
    origin: 'skill',
    permissionLevel: 1,
    timeoutMs: 10000,
    parameters: [
      { name: 'target', type: 'string', required: false, enum: [...GIT_REPO_TARGETS], description: 'Repositório alvo: usami, desktop ou workspace.' },
      { name: 'limit', type: 'number', required: false, description: 'Quantidade de commits (1 a 20).' },
      { name: 'path', type: 'string', required: false, description: 'Caminho relativo opcional para filtrar histórico.' },
    ],
    verify(result) {
      return isPlainObject(result) && result.ok === true && result.schema === GIT_ASSISTANT_SCHEMA && Array.isArray(result.commits);
    },
    async execute(args = {}) {
      const data = await gitClient.log({ target: args.target || 'usami', limit: args.limit ?? 10, path: args.path ?? null });
      return { ok: true, schema: GIT_ASSISTANT_SCHEMA, ...data };
    },
  };

  const diffTool = {
    schema: AGENT_SCHEMAS.tool,
    name: 'git.diff',
    version: '1.0.0',
    description: 'Mostra resumo (--stat) e trecho de diff local com redação de segredos.',
    origin: 'skill',
    permissionLevel: 1,
    timeoutMs: 10000,
    parameters: [
      { name: 'target', type: 'string', required: false, enum: [...GIT_REPO_TARGETS], description: 'Repositório alvo: usami, desktop ou workspace.' },
      { name: 'ref', type: 'string', required: false, description: 'Commit ou ref opcional (ex.: HEAD~1).' },
      { name: 'path', type: 'string', required: false, description: 'Arquivo relativo opcional.' },
      { name: 'staged', type: 'boolean', required: false, description: 'Se true, compara índice staged (--cached).' },
    ],
    verify(result) {
      return isPlainObject(result) && result.ok === true && result.schema === GIT_ASSISTANT_SCHEMA && typeof result.diff === 'string';
    },
    async execute(args = {}) {
      const data = await gitClient.diff({
        target: args.target || 'usami',
        ref: args.ref ?? null,
        path: args.path ?? null,
        staged: args.staged === true,
      });
      return { ok: true, schema: GIT_ASSISTANT_SCHEMA, ...data };
    },
  };

  const reposTool = {
    schema: AGENT_SCHEMAS.tool,
    name: 'github.repos',
    version: '1.0.0',
    description: 'Consulta seus repositórios, branches, commits e PRs no GitHub via GITHUB_TOKEN.',
    origin: 'skill',
    permissionLevel: 3,
    timeoutMs: 15000,
    parameters: [
      { name: 'owner', type: 'string', required: false, description: 'Usuário/organização opcional no GitHub.' },
      { name: 'repo', type: 'string', required: false, description: 'Repositório específico owner/nome para detalhes.' },
      { name: 'limit', type: 'number', required: false, description: 'Máximo de itens (1 a 30).' },
    ],
    verify(result) {
      return isPlainObject(result)
        && result.ok === true
        && result.schema === GIT_ASSISTANT_SCHEMA
        && (Array.isArray(result.repositories) || isPlainObject(result.repository));
    },
    async execute(args = {}) {
      const data = await gitClient.listRepos({
        owner: args.owner ?? null,
        repo: args.repo ?? null,
        limit: args.limit ?? 10,
      });
      return { ok: true, schema: GIT_ASSISTANT_SCHEMA, ...data };
    },
  };

  const commitTool = {
    schema: AGENT_SCHEMAS.tool,
    name: 'git.commit',
    version: '1.0.0',
    description: 'Adiciona arquivos permitidos ao stage e cria commit local (exige confirmação humana nível 4).',
    origin: 'skill',
    permissionLevel: 4,
    timeoutMs: 15000,
    parameters: [
      { name: 'message', type: 'string', required: true, description: 'Mensagem do commit (3 a 400 chars).' },
      { name: 'files', type: 'array', required: false, description: 'Lista de caminhos relativos permitidos para stage.' },
      { name: 'target', type: 'string', required: false, enum: [...GIT_REPO_TARGETS], description: 'Repositório alvo: usami, desktop ou workspace.' },
    ],
    verify(result) {
      return isPlainObject(result) && result.ok === true && result.schema === GIT_ASSISTANT_SCHEMA && result.committed === true;
    },
    async execute(args = {}) {
      const data = await gitClient.commit({
        target: args.target || 'usami',
        message: args.message,
        files: args.files,
      });
      return { ok: true, schema: GIT_ASSISTANT_SCHEMA, ...data };
    },
  };

  const pushTool = {
    schema: AGENT_SCHEMAS.tool,
    name: 'git.push',
    version: '1.0.0',
    description: 'Envia commits locais para o remoto sem --force (exige confirmação humana nível 4).',
    origin: 'skill',
    permissionLevel: 4,
    timeoutMs: 20000,
    parameters: [
      { name: 'target', type: 'string', required: false, enum: [...GIT_REPO_TARGETS], description: 'Repositório alvo: usami, desktop ou workspace.' },
      { name: 'remote', type: 'string', required: false, description: 'Nome do remoto (padrão origin).' },
      { name: 'branch', type: 'string', required: false, description: 'Branch alvo (padrão branch atual).' },
    ],
    verify(result) {
      return isPlainObject(result) && result.ok === true && result.schema === GIT_ASSISTANT_SCHEMA && result.pushed === true;
    },
    async execute(args = {}) {
      const data = await gitClient.push({
        target: args.target || 'usami',
        remote: args.remote || 'origin',
        branch: args.branch ?? null,
      });
      return { ok: true, schema: GIT_ASSISTANT_SCHEMA, ...data };
    },
  };

  const prTool = {
    schema: AGENT_SCHEMAS.tool,
    name: 'github.pr',
    version: '1.0.0',
    description: 'Abre um Pull Request no GitHub via GITHUB_TOKEN (exige confirmação humana nível 4).',
    origin: 'skill',
    permissionLevel: 4,
    timeoutMs: 15000,
    parameters: [
      { name: 'repo', type: 'string', required: true, description: 'Repositório no formato owner/nome.' },
      { name: 'title', type: 'string', required: true, description: 'Título do PR.' },
      { name: 'head', type: 'string', required: true, description: 'Branch de origem.' },
      { name: 'base', type: 'string', required: false, description: 'Branch destino (padrão main).' },
      { name: 'body', type: 'string', required: false, description: 'Descrição do PR (até 500 chars).' },
      { name: 'draft', type: 'boolean', required: false, description: 'Cria como rascunho se true.' },
    ],
    verify(result) {
      return isPlainObject(result) && result.ok === true && result.schema === GIT_ASSISTANT_SCHEMA && result.created === true;
    },
    async execute(args = {}) {
      const data = await gitClient.createPullRequest({
        repo: args.repo,
        title: args.title,
        head: args.head,
        base: args.base || 'main',
        body: args.body || '',
        draft: args.draft === true,
      });
      return { ok: true, schema: GIT_ASSISTANT_SCHEMA, ...data };
    },
  };

  const issueTool = {
    schema: AGENT_SCHEMAS.tool,
    name: 'github.issue',
    version: '1.0.0',
    description: 'Abre uma Issue no GitHub via GITHUB_TOKEN para registrar propostas, bugs ou melhorias para code agents.',
    origin: 'skill',
    permissionLevel: 3,
    timeoutMs: 15000,
    parameters: [
      { name: 'title', type: 'string', required: true, description: 'Título da issue.' },
      { name: 'body', type: 'string', required: false, description: 'Descrição da proposta, contexto e arquivos sugeridos.' },
      { name: 'repo', type: 'string', required: false, description: 'Repositório GitHub no formato owner/repo (padrão UsamiVtuber/Usami-Core).' },
      { name: 'labels', type: 'array', required: false, description: 'Labels opcionais (padrão ["usami-proposal"]).' },
    ],
    verify(result) {
      return isPlainObject(result)
        && result.ok === true
        && result.schema === GIT_ASSISTANT_SCHEMA
        && result.created === true
        && typeof result.number === 'number';
    },
    async execute(args = {}) {
      const data = await gitClient.createIssue({
        repo: args.repo,
        title: args.title,
        body: args.body || '',
        labels: args.labels,
      });
      return { ok: true, schema: GIT_ASSISTANT_SCHEMA, ...data };
    },
  };

  const proposeTool = {
    schema: AGENT_SCHEMAS.tool,
    name: 'code.propose',
    version: '1.0.0',
    description: 'Propõe uma alteração de código ou melhoria. Se um Code Agent (Antigravity/Claude Code) estiver online via MCP, envia diretamente para ele; caso contrário, abre uma Issue no GitHub.',
    origin: 'skill',
    permissionLevel: 3,
    timeoutMs: 15000,
    parameters: [
      { name: 'title', type: 'string', required: true, description: 'Título claro da proposta de código.' },
      { name: 'description', type: 'string', required: false, description: 'Descrição detalhada com contexto e instruções para o Code Agent.' },
      { name: 'files', type: 'array', required: false, description: 'Lista de arquivos sugeridos para criação ou alteração.' },
      { name: 'suggestedAction', type: 'string', required: false, description: 'Tipo da ação (feature, bugfix, refactor, doc).' },
      { name: 'repo', type: 'string', required: false, description: 'Repositório GitHub de destino (padrão UsamiVtuber/Usami-Core).' },
    ],
    verify(result) {
      return isPlainObject(result)
        && result.ok === true
        && result.schema === GIT_ASSISTANT_SCHEMA
        && (result.routedTo === 'code_agent' || result.routedTo === 'github_issue')
        && isPlainObject(result.proposal);
    },
    async execute(args = {}) {
      if (codeBridge && typeof codeBridge.dispatchProposal === 'function') {
        const data = await codeBridge.dispatchProposal({
          title: args.title,
          description: args.description || args.body || '',
          files: args.files || [],
          suggestedAction: args.suggestedAction || args.action || 'feature',
          repo: args.repo || 'UsamiVtuber/Usami-Core',
        });
        return { ok: true, schema: GIT_ASSISTANT_SCHEMA, ...data };
      }
      const data = await gitClient.createIssue({
        repo: args.repo,
        title: `[Usami Proposal] ${args.title}`,
        body: args.description || args.body || '',
        labels: ['usami-proposal'],
      });
      return {
        ok: true,
        schema: GIT_ASSISTANT_SCHEMA,
        routedTo: 'github_issue',
        proposal: { id: `prop-issue-${data.number}`, title: data.title, status: 'pending' },
        issue: data,
        message: `Issue #${data.number} criada no GitHub.`,
      };
    },
  };

  const proposalsListTool = {
    schema: AGENT_SCHEMAS.tool,
    name: 'code.proposals',
    version: '1.0.0',
    description: 'Consulta as propostas de código registradas pela Usami para os Code Agents (Antigravity) e GitHub.',
    origin: 'skill',
    permissionLevel: 1,
    timeoutMs: 10000,
    parameters: [
      { name: 'status', type: 'string', required: false, description: 'Filtrar por status: pending, in_progress, completed, rejected ou all.' },
      { name: 'limit', type: 'number', required: false, description: 'Número máximo de propostas a listar (padrão: 5).' },
    ],
    verify(result) {
      return isPlainObject(result)
        && result.ok === true
        && result.schema === GIT_ASSISTANT_SCHEMA
        && Array.isArray(result.proposals);
    },
    async execute(args = {}) {
      if (codeBridge && typeof codeBridge.listProposals === 'function') {
        const list = codeBridge.listProposals({ status: args.status || 'all', limit: args.limit || 5 });
        return {
          ok: true,
          schema: GIT_ASSISTANT_SCHEMA,
          proposals: list,
          count: list.length,
        };
      }
      return {
        ok: true,
        schema: GIT_ASSISTANT_SCHEMA,
        proposals: [],
        count: 0,
      };
    },
  };

  return [statusTool, logTool, diffTool, reposTool, commitTool, pushTool, prTool, issueTool, proposeTool, proposalsListTool];
}

