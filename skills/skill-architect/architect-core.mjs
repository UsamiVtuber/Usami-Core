export const ARCHITECT_SCHEMA = 'usami.skill.architect.v1';
const SKILL_ID_RE = /^[a-z][a-z0-9-]{2,39}$/;
const TOOL_NAME_RE = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_-]*)+$/;

const collapse = value => String(value ?? '').trim().replace(/\s+/g, ' ');

export function slugifySkillId(raw) {
  const slug = collapse(raw)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  if (SKILL_ID_RE.test(slug)) return slug;
  return '';
}

export function buildSkillBlueprint({
  id = null,
  name,
  description,
  tools = null,
  permissions = null,
  dependencies = [],
  instructions = null,
  knownSkills = [],
  nowMs = Date.now(),
} = {}) {
  const cleanName = collapse(name);
  if (cleanName.length < 2 || cleanName.length > 80) {
    throw new Error('name deve ter entre 2 e 80 caracteres.');
  }
  const cleanDescription = collapse(description);
  if (cleanDescription.length < 5 || cleanDescription.length > 400) {
    throw new Error('description deve ter entre 5 e 400 caracteres.');
  }

  const resolvedId = id ? collapse(id).toLowerCase() : slugifySkillId(cleanName);
  if (!SKILL_ID_RE.test(resolvedId)) {
    throw new Error('id inválido: use slug minúsculo com 3 a 40 caracteres (ex.: reading-tracker).');
  }

  const defaultNamespace = resolvedId.replace(/-/g, '_').replace(/^([a-z]+).*$/, '$1');
  const rawTools = Array.isArray(tools) && tools.length > 0
    ? tools.map(t => collapse(t).toLowerCase())
    : [`${defaultNamespace}.run`];
  const validTools = [...new Set(rawTools)].filter(t => TOOL_NAME_RE.test(t));
  if (validTools.length === 0) {
    throw new Error('tools inválido: informe nomes no formato namespace.acao.');
  }

  const rawPerms = Array.isArray(permissions) && permissions.length > 0
    ? permissions
    : [1];
  const safePerms = [...new Set(rawPerms.filter(p => Number.isInteger(p) && p >= 1 && p <= 4))].sort((a, b) => a - b);
  if (safePerms.length === 0) {
    throw new Error('permissions deve conter níveis inteiros de 1 a 4.');
  }

  const cleanDeps = Array.isArray(dependencies)
    ? [...new Set(dependencies.map(d => collapse(d).toLowerCase()).filter(d => SKILL_ID_RE.test(d) && d !== resolvedId))]
    : [];

  const knownIds = new Set(Array.isArray(knownSkills) ? knownSkills.map(s => s?.id).filter(Boolean) : []);
  const missingDependencies = cleanDeps.filter(dep => !knownIds.has(dep));

  const safeInstructions = collapse(instructions || `Executar ${cleanName} respeitando permissões declaradas e sem acessar segredos ou rede fora do escopo.`);
  const testFile = `test/${resolvedId}.test.mjs`;

  const manifest = {
    schema: 'usami.agent.skill.v1',
    id: resolvedId,
    name: cleanName,
    version: '1.0.0',
    description: cleanDescription,
    state: 'available',
    origin: 'dev',
    createdAt: new Date(nowMs).toISOString(),
    tools: validTools,
    permissions: safePerms,
    dependencies: cleanDeps,
    parameters: [],
    instructions: safeInstructions,
    tests: {
      files: [testFile],
      timeoutMs: 10000,
    },
  };

  const risks = [];
  if (safePerms.includes(4)) risks.push('Contém permissão nível 4: exige confirmação humana de uso único antes de executar.');
  if (safePerms.includes(3)) risks.push('Contém permissão nível 3: requer política clara para efeitos reversíveis.');
  if (missingDependencies.length > 0) risks.push(`Dependências ainda ausentes no catálogo: ${missingDependencies.join(', ')}.`);
  if (risks.length === 0) risks.push('Escopo somente leitura/local sem efeitos externos.');

  const filesLayout = [
    `skills/${resolvedId}/skill.json`,
    `skills/${resolvedId}/core.mjs`,
    `skills/${resolvedId}/${testFile}`,
    `src/${resolvedId}-skill.js`,
  ];

  return {
    schema: ARCHITECT_SCHEMA,
    mode: 'blueprint',
    manifest,
    missingDependencies,
    risks,
    filesLayout,
    summary: `Blueprint ${resolvedId} projetado com ${validTools.length} ferramenta(s) e permissões [${safePerms.join(', ')}].`,
  };
}

