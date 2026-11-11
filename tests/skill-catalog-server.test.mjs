import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSkillCatalog } from '../src/skill-catalog.js';
import { AGENT_SCHEMAS } from '../src/agent-contracts.js';

// O server.mjs cria os depósitos padrão na avaliação do módulo; o diretório é
// trocado ANTES do import para nenhum teste encostar em data/.
const scratchDir = mkdtempSync(join(tmpdir(), 'usami-skills-api-'));
process.env.USAMI_DATA_DIR = scratchDir;
process.env.USAMI_KEYS_FILE = process.env.USAMI_KEYS_FILE || join(scratchDir, 'no-keys.env');

const { createSkillsHandler } = await import('../server.mjs');

const TEST_TOKEN = 'token-de-teste';

function mockReq({ method = 'GET', url = '/api/agent/skills', headers = {} } = {}) {
  return {
    method,
    url,
    headers: { host: '127.0.0.1:8787', 'x-usami-token': TEST_TOKEN, ...headers },
  };
}

function mockRes() {
  const res = { statusCode: null, headers: null, body: '' };
  res.writeHead = (status, headers) => { res.statusCode = status; res.headers = headers; };
  res.end = (data) => { res.body = data; };
  return res;
}

async function call(handler, req) {
  const res = mockRes();
  await handler(req, res);
  return { status: res.statusCode, data: JSON.parse(res.body) };
}

function manifest(id, patch = {}) {
  return {
    schema: AGENT_SCHEMAS.skill,
    id,
    name: `Skill ${id}`,
    version: '1.0.0',
    description: 'Skill de teste',
    state: 'installed',
    origin: 'dev',
    createdAt: '2026-11-11T00:00:00.000Z',
    tools: ['memory.search'],
    permissions: [],
    dependencies: [],
    parameters: [],
    instructions: 'Execute a tarefa declarada.',
    tests: { files: ['test/skill.test.mjs'] },
    ...patch,
  };
}

function writeSkill(root, id, patch = {}) {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'skill.json'), JSON.stringify(manifest(id, patch)));
}

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'usami-skills-api-seed-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const catalog = createSkillCatalog({
    dataDir: join(dir, 'unused'),
    skillsDir: dir,
    registry: { has: tool => tool === 'memory.search' },
    onLoadError: () => {},
  });
  catalog.load();
  return { dir, catalog, handler: createSkillsHandler({ catalog, apiToken: TEST_TOKEN }) };
}

test('borda: token e Host/Origin', async t => {
  const { catalog, handler } = setup(t);

  const noToken = await call(createSkillsHandler({ catalog, apiToken: TEST_TOKEN }), {
    ...mockReq(),
    headers: { host: '127.0.0.1:8787' },
  });
  assert.equal(noToken.status, 401);

  const closed = await call(createSkillsHandler({ catalog, apiToken: null }), mockReq());
  assert.equal(closed.status, 503);

  const badHost = await call(handler, mockReq({ headers: { host: 'evil.example' } }));
  assert.equal(badHost.status, 403);

  const badOrigin = await call(handler, mockReq({ headers: { origin: 'http://evil.example' } }));
  assert.equal(badOrigin.status, 403);
});

test('GET lista skills e busca por id', async t => {
  const { dir, handler } = setup(t);
  writeSkill(dir, 'base-skill');
  writeSkill(dir, 'full-skill', { dependencies: ['base-skill'] });

  const list = await call(handler, mockReq());
  assert.equal(list.status, 200);
  assert.equal(list.data.ok, true);
  assert.equal(list.data.count, 2);
  assert.deepEqual(list.data.skills.map(skill => skill.id), ['base-skill', 'full-skill']);
  assert.equal(list.data.skills.every(skill => skill.activation.canActivate), true);

  const withQuery = await call(handler, mockReq({ url: '/api/agent/skills?limit=5' }));
  assert.equal(withQuery.status, 200);

  const fetched = await call(handler, mockReq({ url: '/api/agent/skills/full-skill' }));
  assert.equal(fetched.status, 200);
  assert.equal(fetched.data.ok, true);
  assert.equal(fetched.data.skill.manifest.id, 'full-skill');
  assert.equal(fetched.data.skill.activation.canActivate, true);

  const missing = await call(handler, mockReq({ url: '/api/agent/skills/ghost-skill' }));
  assert.equal(missing.status, 404);

  assert.equal((await call(handler, mockReq({ url: '/api/agent/skills/Bad_ID' }))).status, 404);
  assert.equal((await call(handler, mockReq({ url: '/api/agent/skills/full-skill/extra' }))).status, 404);
});

test('skill com manifesto inválido aparece na listagem e no GET com valid:false', async t => {
  const { dir, handler } = setup(t);
  writeSkill(dir, 'good-skill');
  mkdirSync(join(dir, 'bad-skill'));
  writeFileSync(join(dir, 'bad-skill', 'skill.json'), '{ nope');

  const list = await call(handler, mockReq());
  assert.equal(list.status, 200);
  assert.equal(list.data.count, 2);
  const bad = list.data.skills.find(skill => skill.id === 'bad-skill');
  assert.equal(bad.valid, false);
  assert.equal(bad.activation.canActivate, false);

  const fetched = await call(handler, mockReq({ url: '/api/agent/skills/bad-skill' }));
  assert.equal(fetched.status, 200);
  assert.equal(fetched.data.skill.valid, false);
  assert.equal(fetched.data.skill.errors.length > 0, true);
  assert.equal('manifest' in fetched.data.skill, false);
});

test('a ativação usa o registry real e reflete arquivos novos sem recriar o handler', async t => {
  const { dir, handler } = setup(t);
  writeSkill(dir, 'tool-skill', { tools: ['memory.search', 'web.fetch'] });
  const before = await call(handler, mockReq({ url: '/api/agent/skills/tool-skill' }));
  assert.deepEqual(before.data.skill.missing.tools, ['web.fetch']);

  writeSkill(dir, 'late-skill');
  const list = await call(handler, mockReq());
  assert.deepEqual(list.data.skills.map(skill => skill.id), ['late-skill', 'tool-skill']);
});

test('métodos de escrita e rotas vizinhas respondem 404', async t => {
  const { handler } = setup(t);
  assert.equal((await call(handler, mockReq({ method: 'POST' }))).status, 404);
  assert.equal((await call(handler, mockReq({ method: 'DELETE' }))).status, 404);
  assert.equal((await call(handler, mockReq({ url: '/api/agent/skills/' }))).status, 404);
});

test('catálogo ilegível responde 500 sem derrubar o processo', async t => {
  const root = mkdtempSync(join(tmpdir(), 'usami-skills-api-broken-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const notADir = join(root, 'skills');
  writeFileSync(notADir, 'não é diretório');
  const catalog = createSkillCatalog({
    dataDir: root,
    registry: { has: () => true },
    onLoadError: () => {},
  });
  const handler = createSkillsHandler({ catalog, apiToken: TEST_TOKEN });

  const list = await call(handler, mockReq());
  assert.equal(list.status, 500);
  assert.match(list.data.error, /indisponível/);
});
