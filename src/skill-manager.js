/**
 * Gerenciador do ciclo de vida de Skills (S8): proposta, autorização humana (S5),
 * teste isolado em diretório temporário sem rede e ativar/desativar sem apagar
 * arquivos.
 *
 * Nesta versão a implementação da skill é do dev: o runtime valida pacotes já
 * presentes em `data/skills/<id>/` e nunca aceita código enviado pelo modelo no
 * corpo HTTP. Falha de teste nunca promove a skill para `installed`.
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { dataDir as resolveDataDir } from './data-paths.js';
import {
  AGENT_LIMITS,
  isPermissionLevel,
  validateSkillManifest,
} from './agent-contracts.js';

const PROPOSALS_FILE = 'skill-proposals.json';
const PROPOSALS_VERSION = 1;
const PROPOSALS_LIMIT = 200;
const MANIFEST_FILE = 'skill.json';
const MANIFEST_MAX_BYTES = 64 * 1024;
const DEFAULT_SKILL_TEST_TIMEOUT_MS = 15_000;

const SKILL_ID_RE = /^[a-z][a-z0-9-]{2,39}$/;
const PROPOSAL_ID_RE = /^sp-[0-9a-f]{12}$/;
const PROPOSAL_STATUSES = Object.freeze(['pending', 'installed', 'failed', 'superseded', 'disabled']);
const MAX_BENEFIT_CHARS = 600;
const MAX_RISKS = 10;
const MAX_RISK_CHARS = 200;
const MAX_TEST_SUMMARY_CHARS = 500;

const SAFE_ENV_KEYS = ['PATH', 'Path', 'SystemRoot', 'COMSPEC', 'PATHEXT', 'WINDIR', 'LANG', 'LC_ALL'];
const NO_NETWORK_PRELOAD = `import net from 'node:net';
import dgram from 'node:dgram';
import dns from 'node:dns';

const blocked = () => Object.assign(new Error('rede desabilitada no sandbox de skill'), { code: 'ERR_SKILL_NETWORK_DISABLED' });
const fail = () => { throw blocked(); };
const failAsync = async () => { throw blocked(); };

globalThis.fetch = failAsync;
globalThis.WebSocket = function BlockedWebSocket() { fail(); };
net.Socket.prototype.connect = function blockedConnect() { fail(); };
dgram.Socket.prototype.send = function blockedSend() { fail(); };
dgram.Socket.prototype.bind = function blockedBind() { fail(); };
dns.lookup = function blockedLookup(_host, _opts, cb) {
  const err = blocked();
  if (typeof _opts === 'function') return _opts(err);
  if (typeof cb === 'function') return cb(err);
  throw err;
};
if (dns.promises) dns.promises.lookup = failAsync;
`;

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const iso = ms => new Date(ms).toISOString();
const collapseText = value => String(value ?? '').trim().replace(/\s+/g, ' ');

function sanitizeSummary(raw) {
  const clean = collapseText(raw).slice(0, MAX_TEST_SUMMARY_CHARS);
  return clean || 'teste isolado da skill falhou';
}

function writeJsonAtomic(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  try {
    renameSync(temporary, filePath);
  } catch (error) {
    try { unlinkSync(temporary); } catch {}
    if (error?.code !== 'EEXIST' && error?.code !== 'EPERM') throw error;
  }
}

function sameSet(a, b) {
  if (a.length !== b.length) return false;
  const setA = new Set(a);
  return setA.size === b.length && b.every(item => setA.has(item));
}

function copyDirectoryWithoutSymlinks(srcDir, destDir) {
  mkdirSync(destDir, { recursive: true });
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = join(srcDir, entry.name);
    const destPath = join(destDir, entry.name);
    const stat = lstatSync(srcPath);
    if (stat.isSymbolicLink()) {
      throw new Error(`symlink não permitido no pacote da skill: ${entry.name}`);
    }
    if (stat.isDirectory()) {
      copyDirectoryWithoutSymlinks(srcPath, destPath);
    } else if (stat.isFile()) {
      writeFileSync(destPath, readFileSync(srcPath));
    }
  }
}

function verifyTestFilesExist(skillDir, testFiles) {
  const resolvedRoot = resolve(skillDir);
  for (const rel of testFiles) {
    const target = resolve(resolvedRoot, rel);
    const diff = relative(resolvedRoot, target);
    if (!diff || diff.startsWith('..') || isAbsolute(diff)) {
      return { ok: false, error: `arquivo de teste fora do pacote da skill: ${rel}` };
    }
    let stat;
    try {
      stat = lstatSync(target);
    } catch {
      return { ok: false, error: `arquivo de teste ausente: ${rel}` };
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return { ok: false, error: `arquivo de teste inválido: ${rel}` };
    }
  }
  return { ok: true };
}

function buildSandboxEnv(tempRoot, tempDataDir, tempHomeDir) {
  const env = {
    NODE_ENV: 'test',
    // Point temp dirs to tempDataDir so tmpdir() returns an allowed write path
    TEMP: tempDataDir,
    TMP: tempDataDir,
    TMPDIR: tempDataDir,
    HOME: tempHomeDir,
    USERPROFILE: tempHomeDir,
    USAMI_DATA_DIR: tempDataDir,
    USAMI_KEYS_FILE: join(tempRoot, 'no-keys.env'),
  };
  for (const key of SAFE_ENV_KEYS) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

/**
 * Executa os testes declarados no manifesto com `node --test` em diretório
 * temporário isolado, com timeout, ambiente sanitizado e rede bloqueada.
 */
export async function defaultRunSkillTests({ skillId, skillDir, manifest }) {
  const checkedFiles = verifyTestFilesExist(skillDir, manifest.tests.files);
  if (!checkedFiles.ok) {
    return {
      ok: false,
      timedOut: false,
      durationMs: 0,
      files: [...manifest.tests.files],
      summary: checkedFiles.error,
    };
  }

  const effectiveTimeout = Math.min(
    manifest.tests.timeoutMs ?? DEFAULT_SKILL_TEST_TIMEOUT_MS,
    AGENT_LIMITS.maxSkillTestTimeoutMs,
  );
  const tempRoot = mkdtempSync(join(tmpdir(), `usami-skill-run-${skillId}-`));
  const stagedPkgDir = join(tempRoot, 'pkg');
  const tempDataDir = join(tempRoot, 'data');
  const tempHomeDir = join(tempRoot, 'home');
  const hookPath = join(tempRoot, 'no-network.mjs');
  const startedAt = Date.now();

  try {
    copyDirectoryWithoutSymlinks(skillDir, stagedPkgDir);
    mkdirSync(tempDataDir, { recursive: true });
    mkdirSync(tempHomeDir, { recursive: true });
    writeFileSync(hookPath, NO_NETWORK_PRELOAD, 'utf8');

    const args = [];
    // Use --permission on all platforms where supported; raw paths work on Windows
    // Network isolation is also provided by the no-network preload script
    if (process.allowedNodeEnvironmentFlags.has('--permission')) {
      args.push(
        '--permission',
        `--allow-fs-read=${stagedPkgDir}`,
        `--allow-fs-read=${hookPath}`,
        `--allow-fs-read=${tempDataDir}`,
        `--allow-fs-write=${tempDataDir}`,
      );
    }
    args.push(`--import=${pathToFileURL(hookPath).href}`, '--test', '--test-isolation=none', ...manifest.tests.files);

    const env = buildSandboxEnv(tempRoot, tempDataDir, tempHomeDir);
    return await new Promise((resolvePromise) => {
      execFile(
        process.execPath,
        args,
        {
          cwd: stagedPkgDir,
          env,
          timeout: effectiveTimeout,
          killSignal: 'SIGKILL',
          maxBuffer: 256 * 1024,
        },
        (error, stdout, stderr) => {
          const durationMs = Math.max(0, Date.now() - startedAt);
          if (!error) {
            resolvePromise({
              ok: true,
              timedOut: false,
              durationMs,
              files: [...manifest.tests.files],
            });
            return;
          }
          const timedOut = Boolean(error.killed || error.code === 'ETIMEDOUT');
          resolvePromise({
            ok: false,
            timedOut,
            durationMs,
            files: [...manifest.tests.files],
            summary: timedOut
              ? `tempo esgotado após ${effectiveTimeout} ms`
              : sanitizeSummary(stderr || stdout || error.message),
          });
        },
      );
    });
  } catch (error) {
    return {
      ok: false,
      timedOut: false,
      durationMs: Math.max(0, Date.now() - startedAt),
      files: [...manifest.tests.files],
      summary: sanitizeSummary(error?.message || error),
    };
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function validateProposalInput(input) {
  if (!isPlainObject(input)) return { ok: false, errors: ['payload: deve ser um objeto JSON'] };
  const errors = [];

  const skillId = typeof input.skillId === 'string' ? input.skillId.trim() : '';
  if (!SKILL_ID_RE.test(skillId)) errors.push('skillId: slug inválido');

  let benefit = '';
  if (typeof input.benefit !== 'string') {
    errors.push('benefit: deve ser texto');
  } else {
    benefit = collapseText(input.benefit);
    if (benefit.length < 3) errors.push('benefit: deve ter ao menos 3 caracteres');
    else if (benefit.length > MAX_BENEFIT_CHARS) errors.push(`benefit: excede ${MAX_BENEFIT_CHARS} caracteres`);
  }

  const risks = [];
  if (!Array.isArray(input.risks)) {
    errors.push('risks: deve ser uma lista');
  } else {
    if (input.risks.length > MAX_RISKS) errors.push(`risks: excede ${MAX_RISKS} itens`);
    for (const [index, item] of input.risks.slice(0, MAX_RISKS).entries()) {
      if (typeof item !== 'string') {
        errors.push(`risks[${index}]: deve ser texto`);
        continue;
      }
      const clean = collapseText(item);
      if (clean.length < 3) errors.push(`risks[${index}]: deve ter ao menos 3 caracteres`);
      else if (clean.length > MAX_RISK_CHARS) errors.push(`risks[${index}]: excede ${MAX_RISK_CHARS} caracteres`);
      else risks.push(clean);
    }
  }

  let dependencies;
  if (input.dependencies !== undefined) {
    if (!Array.isArray(input.dependencies)) {
      errors.push('dependencies: deve ser uma lista');
    } else {
      dependencies = [];
      const seen = new Set();
      for (const dep of input.dependencies) {
        if (typeof dep !== 'string' || !SKILL_ID_RE.test(dep)) {
          errors.push(`dependencies: id inválido (${JSON.stringify(dep)})`);
          continue;
        }
        if (dep === skillId) errors.push('dependencies: skill não pode depender de si mesma');
        if (seen.has(dep)) errors.push(`dependencies: duplicada (${dep})`);
        seen.add(dep);
        dependencies.push(dep);
      }
    }
  }

  let permissions;
  if (input.permissions !== undefined) {
    if (!Array.isArray(input.permissions)) {
      errors.push('permissions: deve ser uma lista de níveis 1..4');
    } else {
      permissions = [];
      const seen = new Set();
      for (const level of input.permissions) {
        if (!isPermissionLevel(level)) {
          errors.push(`permissions: nível inválido ${JSON.stringify(level)}`);
          continue;
        }
        if (seen.has(level)) {
          errors.push(`permissions: nível duplicado ${level}`);
          continue;
        }
        seen.add(level);
        permissions.push(level);
      }
      permissions.sort((a, b) => a - b);
    }
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { skillId, benefit, risks, dependencies, permissions } };
}

export function createSkillManager({
  catalog,
  gate = null,
  dataDir = resolveDataDir(),
  skillsDir = catalog?.skillsDir || join(dataDir, 'skills'),
  filePath = join(dataDir, PROPOSALS_FILE),
  now = () => Date.now(),
  runTests = defaultRunSkillTests,
  onLoadError = message => console.error(message),
} = {}) {
  if (!catalog || typeof catalog.load !== 'function' || typeof catalog.get !== 'function') {
    throw new Error('createSkillManager: catalog é obrigatório.');
  }
  if (!dataDir || typeof dataDir !== 'string') throw new Error('createSkillManager: dataDir é obrigatório.');

  const isoNow = () => iso(now());
  const defaultData = () => ({ version: PROPOSALS_VERSION, proposals: [], updatedAt: isoNow() });
  let data = defaultData();
  let loadFailed = false;

  function assertWritable() {
    if (loadFailed) throw new Error('propostas de skills: arquivo inválido não foi carregado; escrita recusada');
  }

  function persist() {
    data.updatedAt = isoNow();
    writeJsonAtomic(filePath, data);
    return data;
  }

  function normalizeProposals(input) {
    if (!isPlainObject(input)) throw new Error('propostas de skills: arquivo deve ser um objeto JSON');
    if (input.version !== PROPOSALS_VERSION) {
      throw new Error(`propostas de skills: versão ${JSON.stringify(input.version)} não suportada`);
    }
    if (!Array.isArray(input.proposals)) throw new Error('propostas de skills: campo proposals deve ser uma lista');
    const proposals = [];
    const ids = new Set();
    for (const [index, raw] of input.proposals.entries()) {
      if (!isPlainObject(raw)) throw new Error(`propostas de skills: item ${index} deve ser um objeto`);
      if (typeof raw.id !== 'string' || !PROPOSAL_ID_RE.test(raw.id) || ids.has(raw.id)) {
        throw new Error(`propostas de skills: item ${index} com id inválido ou duplicado`);
      }
      if (typeof raw.skillId !== 'string' || !SKILL_ID_RE.test(raw.skillId)) {
        throw new Error(`propostas de skills: item ${index} com skillId inválido`);
      }
      if (!PROPOSAL_STATUSES.includes(raw.status)) {
        throw new Error(`propostas de skills: item ${index} com status inválido`);
      }
      ids.add(raw.id);
      proposals.push({ ...raw });
    }
    return {
      version: PROPOSALS_VERSION,
      proposals: proposals.slice(-PROPOSALS_LIMIT),
      updatedAt: typeof input.updatedAt === 'string' ? input.updatedAt : isoNow(),
    };
  }

  function readSkillManifestFromDisk(skillId) {
    if (!SKILL_ID_RE.test(skillId)) return { ok: false, notFound: true };
    const skillDir = join(skillsDir, skillId);
    const manifestPath = join(skillDir, MANIFEST_FILE);
    let stat;
    try {
      stat = lstatSync(manifestPath);
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { ok: false, notFound: true };
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return { ok: false, invalidManifest: true, errors: [`${MANIFEST_FILE} inválido ou symlink`] };
    }
    if (stat.size > MANIFEST_MAX_BYTES) {
      return { ok: false, invalidManifest: true, errors: [`${MANIFEST_FILE} excede ${MANIFEST_MAX_BYTES} bytes`] };
    }
    let raw;
    try {
      raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch {
      return { ok: false, invalidManifest: true, errors: ['skill.json não é um JSON válido'] };
    }
    const validated = validateSkillManifest(raw);
    if (!validated.ok) return { ok: false, invalidManifest: true, errors: validated.errors };
    if (validated.value.id !== skillId) {
      return { ok: false, invalidManifest: true, errors: [`id (${validated.value.id}) não corresponde ao diretório (${skillId})`] };
    }
    return { ok: true, skillDir, manifestPath, manifest: validated.value };
  }

  function writeManifestState(manifestPath, manifest, nextState) {
    const next = { ...manifest, state: nextState, updatedAt: isoNow() };
    const checked = validateSkillManifest(next);
    if (!checked.ok) throw new Error(`manifesto inválido ao gravar estado: ${checked.errors.join('; ')}`);
    writeJsonAtomic(manifestPath, checked.value);
    return checked.value;
  }

  function cloneProposal(proposal) {
    return {
      ...proposal,
      risks: [...(proposal.risks || [])],
      dependencies: [...(proposal.dependencies || [])],
      permissions: [...(proposal.permissions || [])],
      ...(proposal.lastTest ? { lastTest: { ...proposal.lastTest, files: [...proposal.lastTest.files] } } : {}),
    };
  }

  function findLatestProposal(skillId, { status } = {}) {
    for (let i = data.proposals.length - 1; i >= 0; i -= 1) {
      const entry = data.proposals[i];
      if (entry.skillId !== skillId) continue;
      if (status && entry.status !== status) continue;
      return entry;
    }
    return null;
  }

  function hasAuthorizationHistory(skillId, manifest) {
    for (let i = data.proposals.length - 1; i >= 0; i -= 1) {
      const entry = data.proposals[i];
      if (entry.skillId !== skillId) continue;
      if (!entry.authorizedAt) return false;
      return entry.version === manifest.version && sameSet(entry.permissions || [], manifest.permissions || []);
    }
    return false;
  }

  function load() {
    loadFailed = false;
    try {
      data = normalizeProposals(JSON.parse(readFileSync(filePath, 'utf8')));
    } catch (error) {
      if (error?.code === 'ENOENT') {
        data = defaultData();
      } else {
        loadFailed = true;
        onLoadError(`Aviso: arquivo de propostas de skills inválido (${error?.message || error}); escritas recusadas.`);
        throw error;
      }
    }
    catalog.load();
    return { proposals: listProposals() };
  }

  function listProposals() {
    return [...data.proposals].reverse().map(cloneProposal);
  }

  function getProposal(id) {
    if (typeof id !== 'string' || !PROPOSAL_ID_RE.test(id)) return { ok: false, notFound: true };
    const found = data.proposals.find(entry => entry.id === id);
    if (!found) return { ok: false, notFound: true };
    return { ok: true, proposal: cloneProposal(found) };
  }

  function propose(input) {
    assertWritable();
    const parsed = validateProposalInput(input);
    if (!parsed.ok) return { ok: false, invalidInput: true, errors: parsed.errors };

    const { skillId, benefit, risks, dependencies, permissions } = parsed.value;
    const loaded = readSkillManifestFromDisk(skillId);
    if (!loaded.ok) return loaded;

    const { skillDir, manifestPath, manifest } = loaded;
    if (manifest.origin === 'model') {
      return {
        ok: false,
        forbiddenOrigin: true,
        error: 'Nesta versão, apenas pacotes validados pelo dev podem ser propostos.',
      };
    }
    if (manifest.state === 'installed') {
      return { ok: false, conflict: true, error: 'Skill já está instalada.' };
    }
    if (dependencies !== undefined && !sameSet(dependencies, manifest.dependencies)) {
      return { ok: false, invalidInput: true, errors: ['dependencies: diverge das dependências do manifesto'] };
    }
    if (permissions !== undefined && !sameSet(permissions, manifest.permissions)) {
      return { ok: false, invalidInput: true, errors: ['permissions: diverge das permissões do manifesto'] };
    }
    const checkedFiles = verifyTestFilesExist(skillDir, manifest.tests.files);
    if (!checkedFiles.ok) {
      return { ok: false, invalidManifest: true, errors: [checkedFiles.error] };
    }

    const timestamp = isoNow();
    for (const prior of data.proposals) {
      if (prior.skillId === skillId && prior.status === 'pending') {
        prior.status = 'superseded';
        prior.updatedAt = timestamp;
      }
    }

    if (manifest.state !== 'pending') {
      writeManifestState(manifestPath, manifest, 'pending');
    }

    const proposal = {
      id: `sp-${randomBytes(6).toString('hex')}`,
      skillId,
      version: manifest.version,
      benefit,
      risks,
      dependencies: [...manifest.dependencies],
      permissions: [...manifest.permissions],
      status: 'pending',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    data.proposals.push(proposal);
    if (data.proposals.length > PROPOSALS_LIMIT) {
      data.proposals.splice(0, data.proposals.length - PROPOSALS_LIMIT);
    }
    persist();
    catalog.load();

    return {
      ok: true,
      proposal: cloneProposal(proposal),
      skill: catalog.get(skillId).skill,
    };
  }

  async function install(skillId, { confirmation } = {}) {
    assertWritable();
    const loaded = readSkillManifestFromDisk(skillId);
    if (!loaded.ok) return loaded;

    const { skillDir, manifestPath, manifest } = loaded;
    if (!gate) {
      return { ok: false, denied: true, error: 'gate de permissões indisponível' };
    }
    const gateCheck = gate.check({ name: `skill.${skillId}` });
    if (!gateCheck.ok) return { ok: false, denied: true, error: gateCheck.reason };

    if (manifest.state !== 'pending') {
      return { ok: false, wrongState: true, error: 'Skill precisa estar no estado pending para ser instalada.' };
    }

    const auth = gate.authorizeSkill(skillId, confirmation);
    if (!auth.ok) return { ok: false, denied: true, error: auth.reason };

    const authTimestamp = isoNow();
    let proposal = findLatestProposal(skillId, { status: 'pending' });
    if (!proposal) {
      proposal = {
        id: `sp-${randomBytes(6).toString('hex')}`,
        skillId,
        version: manifest.version,
        benefit: manifest.description,
        risks: [],
        dependencies: [...manifest.dependencies],
        permissions: [...manifest.permissions],
        status: 'pending',
        createdAt: authTimestamp,
        updatedAt: authTimestamp,
      };
      data.proposals.push(proposal);
      if (data.proposals.length > PROPOSALS_LIMIT) {
        data.proposals.splice(0, data.proposals.length - PROPOSALS_LIMIT);
      }
    }
    proposal.authorizedAt = authTimestamp;
    proposal.updatedAt = authTimestamp;
    persist();

    const testResult = await runTests({ skillId, skillDir, manifest });
    const finishedAt = isoNow();
    proposal.lastTest = { ...testResult, files: [...(testResult.files || manifest.tests.files)], ranAt: finishedAt };
    proposal.updatedAt = finishedAt;

    if (!testResult.ok) {
      writeManifestState(manifestPath, manifest, 'disabled');
      proposal.status = 'failed';
      persist();
      catalog.load();
      return {
        ok: false,
        testFailed: true,
        error: testResult.summary || 'Teste isolado da skill falhou; skill mantida desativada.',
        skill: catalog.get(skillId).skill,
        testResult,
        proposal: cloneProposal(proposal),
      };
    }

    writeManifestState(manifestPath, manifest, 'installed');
    proposal.status = 'installed';
    persist();
    catalog.load();
    return {
      ok: true,
      installed: true,
      skill: catalog.get(skillId).skill,
      testResult,
      proposal: cloneProposal(proposal),
    };
  }

  async function enable(skillId) {
    assertWritable();
    const loaded = readSkillManifestFromDisk(skillId);
    if (!loaded.ok) return loaded;

    const { skillDir, manifestPath, manifest } = loaded;
    if (gate) {
      const gateCheck = gate.check({ name: `skill.${skillId}` });
      if (!gateCheck.ok) return { ok: false, denied: true, error: gateCheck.reason };
    }
    if (manifest.state === 'installed') {
      catalog.load();
      return { ok: true, unchanged: true, skill: catalog.get(skillId).skill };
    }
    if (manifest.state !== 'disabled' || !hasAuthorizationHistory(skillId, manifest)) {
      return {
        ok: false,
        wrongState: true,
        error: 'Skill precisa ser proposta e autorizada antes de ativar.',
      };
    }

    const testResult = await runTests({ skillId, skillDir, manifest });
    const finishedAt = isoNow();
    const proposal = findLatestProposal(skillId);
    if (proposal) {
      proposal.lastTest = { ...testResult, files: [...(testResult.files || manifest.tests.files)], ranAt: finishedAt };
      proposal.updatedAt = finishedAt;
    }

    if (!testResult.ok) {
      if (proposal) persist();
      catalog.load();
      return {
        ok: false,
        testFailed: true,
        error: testResult.summary || 'Teste isolado da skill falhou; skill mantida desativada.',
        skill: catalog.get(skillId).skill,
        testResult,
      };
    }

    writeManifestState(manifestPath, manifest, 'installed');
    if (proposal) {
      proposal.status = 'installed';
      persist();
    }
    catalog.load();
    return {
      ok: true,
      unchanged: false,
      skill: catalog.get(skillId).skill,
      testResult,
    };
  }

  function disable(skillId) {
    assertWritable();
    const loaded = readSkillManifestFromDisk(skillId);
    if (!loaded.ok) return loaded;

    const { manifestPath, manifest } = loaded;
    if (manifest.state === 'disabled') {
      catalog.load();
      return { ok: true, unchanged: true, skill: catalog.get(skillId).skill };
    }
    if (manifest.state !== 'installed') {
      return { ok: false, wrongState: true, error: 'Apenas skills instaladas podem ser desativadas.' };
    }

    const timestamp = isoNow();
    if (!hasAuthorizationHistory(skillId, manifest)) {
      data.proposals.push({
        id: `sp-${randomBytes(6).toString('hex')}`,
        skillId,
        version: manifest.version,
        benefit: manifest.description,
        risks: [],
        dependencies: [...manifest.dependencies],
        permissions: [...manifest.permissions],
        status: 'disabled',
        authorizedAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      if (data.proposals.length > PROPOSALS_LIMIT) {
        data.proposals.splice(0, data.proposals.length - PROPOSALS_LIMIT);
      }
      persist();
    } else {
      const latest = findLatestProposal(skillId);
      if (latest) {
        latest.status = 'disabled';
        latest.updatedAt = timestamp;
        persist();
      }
    }

    writeManifestState(manifestPath, manifest, 'disabled');
    catalog.load();
    return { ok: true, unchanged: false, skill: catalog.get(skillId).skill };
  }

  return {
    load,
    listProposals,
    getProposal,
    propose,
    install,
    enable,
    disable,
  };
}
