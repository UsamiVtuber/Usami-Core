import test from 'node:test';
import assert from 'node:assert/strict';
import { createGitAssistantClient, createGitAssistantTools } from '../src/git-assistant-skill.js';
import { DEFAULT_TOOL_MATCHERS, formatExecutedTurnFallbackReply } from '../src/agent-core.js';

test('createGitAssistantClient: createRepo e createOrUpdateFile chamam endpoints do GitHub e retornam resultado normalizado', async () => {
  const calls = [];
  const fakeFetch = async (url, opts = {}) => {
    calls.push({ url, method: opts.method, body: opts.body ? JSON.parse(opts.body) : null });
    if (url.endsWith('/user/repos') && opts.method === 'POST') {
      return {
        ok: true,
        json: async () => ({
          name: 'Usamiin',
          full_name: 'Usamiin/Usamiin',
          html_url: 'https://github.com/Usamiin/Usamiin',
          private: false,
          default_branch: 'main',
        }),
      };
    }
    if (url.includes('/contents/README.md') && opts.method === 'GET') {
      return {
        ok: false,
        status: 404,
        json: async () => ({ message: 'Not Found' }),
      };
    }
    if (url.includes('/contents/README.md') && opts.method === 'PUT') {
      return {
        ok: true,
        json: async () => ({
          commit: { sha: 'abc1234' },
          content: { html_url: 'https://github.com/Usamiin/Usamiin/blob/main/README.md' },
        }),
      };
    }
    return { ok: true, json: async () => ({}) };
  };

  const client = createGitAssistantClient({
    envProvider: name => (name === 'GITHUB_TOKEN' ? 'fake-token' : (name === 'GITHUB_USERNAME' ? 'Usamiin' : '')),
    fetchImpl: fakeFetch,
  });

  const repoRes = await client.createRepo({
    name: 'Usamiin',
    description: 'Perfil da Usami',
    isPrivate: false,
    autoInit: true,
  });

  assert.equal(repoRes.created, true);
  assert.equal(repoRes.name, 'Usamiin');
  assert.equal(repoRes.fullName, 'Usamiin/Usamiin');
  assert.equal(repoRes.htmlUrl, 'https://github.com/Usamiin/Usamiin');

  const fileRes = await client.createOrUpdateFile({
    repo: 'Usamiin/Usamiin',
    path: 'README.md',
    content: '# Olá da Usami!',
    message: 'Initial README',
  });

  assert.equal(fileRes.updated, true);
  assert.equal(fileRes.repo, 'Usamiin/Usamiin');
  assert.equal(fileRes.path, 'README.md');
  assert.equal(fileRes.commitSha, 'abc1234');
});

test('createGitAssistantTools: github.create_repo e github.write_file ferramentas operacionais nível 3 verificadas', async () => {
  let createdPayload = null;
  let filePayload = null;

  const mockGitClient = {
    async createRepo(args) {
      createdPayload = args;
      return {
        created: true,
        name: args.name,
        fullName: `Usamiin/${args.name}`,
        htmlUrl: `https://github.com/Usamiin/${args.name}`,
        isPrivate: args.isPrivate,
        defaultBranch: 'main',
      };
    },
    async createOrUpdateFile(args) {
      filePayload = args;
      return {
        updated: true,
        repo: args.repo,
        path: args.path,
        commitSha: 'commit-sha-99',
        htmlUrl: `https://github.com/${args.repo}/blob/main/${args.path}`,
      };
    },
  };

  const tools = createGitAssistantTools({ gitClient: mockGitClient });
  const createRepoTool = tools.find(t => t.name === 'github.create_repo');
  const writeFileTool = tools.find(t => t.name === 'github.write_file');

  assert.ok(createRepoTool, 'github.create_repo deve existir');
  assert.equal(createRepoTool.permissionLevel, 3);

  assert.ok(writeFileTool, 'github.write_file deve existir');
  assert.equal(writeFileTool.permissionLevel, 3);

  const res = await createRepoTool.execute({
    name: 'Usamiin',
    description: 'Perfil oficial',
    readmeContent: '# Usami Profile',
  });

  assert.equal(res.ok, true);
  assert.equal(res.created, true);
  assert.equal(res.name, 'Usamiin');
  assert.equal(res.readmeUpdated, true);
  assert.equal(createdPayload.name, 'Usamiin');
  assert.equal(filePayload.content, '# Usami Profile');
});

test('agent-core matcher: "cria um readme so pra voce no seu github" dispara github.create_repo para perfil Usamiin', () => {
  const matchCreateRepo = DEFAULT_TOOL_MATCHERS.find(t => t.toolName === 'github.create_repo');
  assert.ok(matchCreateRepo, 'matcher de github.create_repo deve existir');

  const userPrompt = 'boa, que tal vc criar um readme só pra voce no seu github, pode ficar a vontade pra criar do jeito que quiser';
  const matches = matchCreateRepo.matches(userPrompt.toLowerCase());
  assert.equal(matches, true);

  const args = matchCreateRepo.buildArgs(userPrompt);
  assert.equal(args.name, 'Usamiin');
  assert.ok(typeof args.readmeContent === 'string');
  assert.ok(args.readmeContent.includes('Usami'));

  const fallback = formatExecutedTurnFallbackReply({
    status: 'executed',
    tool: 'github.create_repo',
    result: {
      created: true,
      name: 'Usamiin',
      fullName: 'Usamiin/Usamiin',
      htmlUrl: 'https://github.com/Usamiin/Usamiin',
      readmeUpdated: true,
    },
  });
  assert.ok(fallback.includes('Usamiin/Usamiin'));
  assert.ok(fallback.includes('README'));
});
