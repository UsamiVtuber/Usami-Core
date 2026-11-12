export const GIT_ASSISTANT_SCHEMA = 'usami.git.assistant.v1';
export const GIT_REPO_TARGETS = Object.freeze(['usami', 'desktop', 'workspace']);

const FORBIDDEN_GIT_PATH_RE = /(?:^|\/)(?:\.env(?:\..*)?|keys?\.env|secrets?|credentials?|vault|data|\.git|node_modules|target|dist)(?:\/|$)/i;
const BRANCH_RE = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,99}$/;
const REMOTE_RE = /^[a-zA-Z0-9._-]{1,40}$/;
const REPO_SLUG_RE = /^[a-zA-Z0-9._-]{1,80}\/[a-zA-Z0-9._-]{1,100}$/;
const REF_RE = /^[a-zA-Z0-9._~^/-]{1,120}$/;

const SECRET_REDACTORS = Object.freeze([
  /\b(?:ghp|gho|ghu|ghs)_[a-zA-Z0-9]{10,}\b/g,
  /\bgithub_pat_[a-zA-Z0-9_]{12,}\b/g,
  /\bsk-(?:or-)?[a-zA-Z0-9_-]{8,}\b/g,
  /\bnvapi-[a-zA-Z0-9_-]{8,}\b/gi,
  /\bBearer\s+[a-zA-Z0-9._-]{8,}\b/gi,
  /\bx-access-token:[^\s@]+@/gi,
  /https?:\/\/[^/\s:@]+:[^/\s@]+@/gi,
  /\b(?:GITHUB_TOKEN|GH_TOKEN|USAMI_API_TOKEN|OPENROUTER_API_KEY|NVIDIA_API_KEY|API_KEY|SECRET|PASSWORD|ACCESS_TOKEN)\s*[:=]\s*\S+/gi,
]);

export function redactGitText(value) {
  let text = String(value ?? '');
  for (const pattern of SECRET_REDACTORS) {
    text = text.replace(pattern, '[redigido]');
  }
  return text;
}

export function normalizeRepoTarget(target = 'usami') {
  const clean = String(target ?? 'usami').trim().toLowerCase();
  if (!GIT_REPO_TARGETS.includes(clean)) {
    throw new Error(`target inválido: "${clean}". Use: ${GIT_REPO_TARGETS.join(', ')}.`);
  }
  return clean;
}

export function sanitizeGitRelPath(relPath) {
  const clean = String(relPath ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!clean || clean.startsWith('/') || clean.includes('..') || clean.includes('\0') || clean.startsWith('-')) {
    throw new Error(`caminho git inválido: ${relPath}`);
  }
  if (FORBIDDEN_GIT_PATH_RE.test(clean)) {
    throw new Error(`caminho protegido bloqueado no git: ${clean}`);
  }
  return clean;
}

export function validateCommitFiles(files) {
  if (files === undefined || files === null) return [];
  if (!Array.isArray(files)) throw new Error('files deve ser uma lista de caminhos relativos.');
  if (files.length > 50) throw new Error('máximo de 50 arquivos por commit.');
  return files.map(sanitizeGitRelPath);
}

export function validateCommitMessage(message) {
  const clean = String(message ?? '').replace(/\r\n/g, '\n').trim();
  if (clean.length < 3 || clean.length > 400) {
    throw new Error('message de commit deve ter entre 3 e 400 caracteres.');
  }
  if (clean.includes('\0') || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(clean)) {
    throw new Error('message de commit contém caracteres de controle inválidos.');
  }
  return clean;
}

export function validateBranchName(branch) {
  const clean = String(branch ?? '').trim();
  if (
    !BRANCH_RE.test(clean)
    || clean.includes('..')
    || clean.includes('@{')
    || clean.endsWith('/')
    || clean.endsWith('.lock')
    || clean.startsWith('-')
  ) {
    throw new Error(`nome de branch inválido: ${branch}`);
  }
  return clean;
}

export function validateRemoteName(remote = 'origin') {
  const clean = String(remote ?? 'origin').trim() || 'origin';
  if (!REMOTE_RE.test(clean) || clean.startsWith('-')) {
    throw new Error(`remote inválido: ${remote}`);
  }
  return clean;
}

export function validateGitRef(ref) {
  if (ref === undefined || ref === null || ref === '') return null;
  const clean = String(ref).trim();
  if (!REF_RE.test(clean) || clean.startsWith('-') || clean.includes('..') || clean.includes('@{')) {
    throw new Error(`ref git inválida: ${ref}`);
  }
  return clean;
}

export function parseRepoSlug(slug) {
  const clean = String(slug ?? '').trim();
  if (!REPO_SLUG_RE.test(clean) || clean.includes('..')) {
    throw new Error('repo deve seguir o formato owner/nome.');
  }
  const [owner, name] = clean.split('/');
  return { slug: `${owner}/${name}`, owner, name };
}

export function parsePorcelainStatus(stdout) {
  const lines = String(stdout ?? '').split(/\r?\n/).filter(Boolean);
  let branch = 'HEAD';
  let upstream = null;
  let ahead = 0;
  let behind = 0;
  const staged = [];
  const modified = [];
  const untracked = [];

  for (const line of lines) {
    if (line.startsWith('## ')) {
      const head = line.slice(3).trim();
      const dots = head.indexOf('...');
      if (dots >= 0) {
        branch = head.slice(0, dots).trim();
        const rest = head.slice(dots + 3);
        const bracketMatch = /\[([^\]]+)\]$/.exec(rest);
        upstream = (bracketMatch ? rest.slice(0, bracketMatch.index) : rest).trim() || null;
        if (bracketMatch) {
          const a = /ahead (\d+)/.exec(bracketMatch[1]);
          const b = /behind (\d+)/.exec(bracketMatch[1]);
          if (a) ahead = Number(a[1]);
          if (b) behind = Number(b[1]);
        }
      } else {
        branch = head.replace(/^No commits yet on /, '').trim() || 'HEAD';
      }
      continue;
    }

    if (line.length < 4) continue;
    const x = line[0];
    const y = line[1];
    const rawPath = line.slice(3).trim();
    const safePath = FORBIDDEN_GIT_PATH_RE.test(rawPath) ? '[arquivo-protegido]' : rawPath;

    if (x === '?' && y === '?') {
      untracked.push(safePath);
    } else {
      if (x !== ' ' && x !== '?') staged.push(`${x} ${safePath}`);
      if (y !== ' ' && y !== '?') modified.push(`${y} ${safePath}`);
    }
  }

  return {
    branch,
    upstream,
    ahead,
    behind,
    clean: staged.length === 0 && modified.length === 0 && untracked.length === 0,
    staged: staged.slice(0, 60),
    modified: modified.slice(0, 60),
    untracked: untracked.slice(0, 60),
  };
}

export function parseGitLog(stdout) {
  return String(stdout ?? '')
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => {
      const [hash = '', author = '', date = '', ...rest] = line.split('\x1f');
      if (!hash) return null;
      return {
        hash: hash.trim().slice(0, 12),
        author: author.trim(),
        date: date.trim(),
        subject: redactGitText(rest.join('\x1f').trim()),
      };
    })
    .filter(Boolean);
}

export function normalizeGitHubRepo(item) {
  if (!item || typeof item !== 'object') return null;
  return {
    fullName: String(item.full_name || ''),
    private: item.private === true,
    defaultBranch: String(item.default_branch || 'main'),
    language: item.language || null,
    updatedAt: item.updated_at || null,
    htmlUrl: item.html_url || null,
    description: item.description ? String(item.description).slice(0, 200) : '',
  };
}

