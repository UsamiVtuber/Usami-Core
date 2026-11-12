import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GIT_ASSISTANT_SCHEMA,
  normalizeGitHubRepo,
  parseGitLog,
  parsePorcelainStatus,
  parseRepoSlug,
  redactGitText,
  sanitizeGitRelPath,
  validateBranchName,
  validateCommitFiles,
  validateCommitMessage,
} from '../git-core.mjs';

test('parsePorcelainStatus e parseGitLog extraem estado e ocultam arquivos protegidos', () => {
  const status = parsePorcelainStatus([
    '## main...core/main [ahead 2, behind 1]',
    'M  src/server.mjs',
    ' M docs/architecture.md',
    '?? .env',
    '?? src/nova-skill.js',
  ].join('\n'));

  assert.equal(status.branch, 'main');
  assert.equal(status.upstream, 'core/main');
  assert.equal(status.ahead, 2);
  assert.equal(status.behind, 1);
  assert.equal(status.clean, false);
  assert.deepEqual(status.staged, ['M src/server.mjs']);
  assert.deepEqual(status.modified, ['M docs/architecture.md']);
  assert.deepEqual(status.untracked, ['[arquivo-protegido]', 'src/nova-skill.js']);

  const commits = parseGitLog('cd5d2ea12345\x1fLuke\x1f2026-11-11T23:14:00-03:00\x1ffeat(skills): integra skills externas\n');
  assert.equal(commits.length, 1);
  assert.equal(commits[0].hash, 'cd5d2ea12345');
  assert.equal(commits[0].subject, 'feat(skills): integra skills externas');
});

test('validadores bloqueiam .env, traversal, branch inválida e redigem tokens GitHub', () => {
  assert.throws(() => sanitizeGitRelPath('.env'), /bloqueado/);
  assert.throws(() => sanitizeGitRelPath('vault/nota.md'), /bloqueado/);
  assert.throws(() => validateCommitFiles(['../fora.js']), /inválido/);
  assert.deepEqual(validateCommitFiles(['src/agent-core.js']), ['src/agent-core.js']);

  assert.throws(() => validateBranchName('--force'), /inválido/);
  assert.throws(() => validateBranchName('main..dev'), /inválido/);
  assert.equal(validateBranchName('feat/git-skill'), 'feat/git-skill');

  assert.throws(() => validateCommitMessage('ok'), /3 e 400/);
  assert.deepEqual(parseRepoSlug('UsamiVtuber/Usami-Core'), {
    slug: 'UsamiVtuber/Usami-Core',
    owner: 'UsamiVtuber',
    name: 'Usami-Core',
  });

  const redacted = redactGitText('https://x-access-token:ghp_1234567890abcdef@github.com/a/b GITHUB_TOKEN=github_pat_abcdef12345678');
  assert.equal(redacted.includes('ghp_1234567890abcdef'), false);
  assert.equal(redacted.includes('github_pat_abcdef12345678'), false);

  const repo = normalizeGitHubRepo({
    full_name: 'UsamiVtuber/Usami-Core',
    private: false,
    default_branch: 'main',
    language: 'JavaScript',
  });
  assert.equal(repo.fullName, 'UsamiVtuber/Usami-Core');
  assert.equal(GIT_ASSISTANT_SCHEMA, 'usami.git.assistant.v1');
});

