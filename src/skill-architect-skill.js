/**
 * Skill operacional Skill Architect (Fase 3 local).
 *
 * Publica `skills/skill-architect` em `dataDir/skills` quando ausente e
 * registra:
 *  - `architect.blueprint` (nível 1): projeta e valida rascunho de manifesto
 *    `usami.agent.skill.v1` + layout de arquivos e riscos;
 *  - `architect.propose` (nível 2): registra proposta formal no Skill Manager
 *    (S8) para pacotes validados presentes em `data/skills/<id>/`.
 */
import { AGENT_SCHEMAS, validateSkillManifest } from './agent-contracts.js';
import { publishSkillPackage } from './skill-package.js';
import { ARCHITECT_SCHEMA, buildSkillBlueprint } from '../skills/skill-architect/architect-core.mjs';

export const SKILL_ARCHITECT_SKILL_ID = 'skill-architect';
export const SKILL_ARCHITECT_TOOLS = Object.freeze(['architect.blueprint', 'architect.propose']);

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export function publishSkillArchitectSkill({ dataDir, bundledDir } = {}) {
  return publishSkillPackage({ skillId: SKILL_ARCHITECT_SKILL_ID, dataDir, bundledDir });
}

export function createSkillArchitectTools({
  skillCatalog = null,
  skillManager = null,
  now = () => Date.now(),
} = {}) {
  const blueprintTool = {
    schema: AGENT_SCHEMAS.tool,
    name: 'architect.blueprint',
    version: '1.0.0',
    description: 'Projeta um manifesto usami.agent.skill.v1 validado, lista de ferramentas, riscos e layout de arquivos para uma nova skill.',
    origin: 'skill',
    permissionLevel: 1,
    timeoutMs: 5000,
    parameters: [
      { name: 'name', type: 'string', required: true, description: 'Nome legível da nova skill.' },
      { name: 'description', type: 'string', required: true, description: 'Descrição curta do propósito da skill.' },
      { name: 'id', type: 'string', required: false, description: 'Slug opcional (derivado de name quando omitido).' },
      { name: 'tools', type: 'array', required: false, description: 'Nomes das ferramentas (namespace.acao).' },
      { name: 'permissions', type: 'array', required: false, description: 'Níveis de permissão solicitados (1 a 4).' },
      { name: 'dependencies', type: 'array', required: false, description: 'Ids de skills dependentes.' },
      { name: 'instructions', type: 'string', required: false, description: 'Instruções operacionais da skill.' },
    ],
    verify(result) {
      if (!isPlainObject(result) || result.ok !== true || result.schema !== ARCHITECT_SCHEMA) return false;
      if (result.mode !== 'blueprint' || !isPlainObject(result.manifest)) return false;
      return validateSkillManifest(result.manifest).ok;
    },
    async execute(args = {}) {
      const knownSkills = skillCatalog && typeof skillCatalog.list === 'function'
        ? skillCatalog.list()
        : [];
      const blueprint = buildSkillBlueprint({
        id: args.id ?? null,
        name: args.name,
        description: args.description,
        tools: args.tools ?? null,
        permissions: args.permissions ?? null,
        dependencies: args.dependencies ?? [],
        instructions: args.instructions ?? null,
        knownSkills,
        nowMs: now(),
      });
      const checked = validateSkillManifest(blueprint.manifest);
      if (!checked.ok) {
        throw new Error(`manifesto projetado inválido: ${checked.errors.join('; ')}`);
      }
      return { ok: true, ...blueprint, manifest: checked.value };
    },
  };

  const proposeTool = {
    schema: AGENT_SCHEMAS.tool,
    name: 'architect.propose',
    version: '1.0.0',
    description: 'Registra uma proposta formal de instalação no Skill Manager (S8) para um pacote existente em data/skills/<id>/.',
    origin: 'skill',
    permissionLevel: 2,
    timeoutMs: 5000,
    parameters: [
      { name: 'skillId', type: 'string', required: true, description: 'Slug da skill presente em data/skills/<id>/.' },
      { name: 'benefit', type: 'string', required: true, description: 'Benefício prático da instalação.' },
      { name: 'risks', type: 'array', required: false, description: 'Lista opcional de riscos observados.' },
    ],
    verify(result) {
      return isPlainObject(result)
        && result.ok === true
        && result.schema === ARCHITECT_SCHEMA
        && result.mode === 'propose'
        && isPlainObject(result.proposal)
        && typeof result.proposal.id === 'string';
    },
    async execute(args = {}) {
      if (!skillManager || typeof skillManager.propose !== 'function') {
        throw new Error('skillManager indisponível.');
      }
      const proposed = skillManager.propose({
        skillId: args.skillId,
        benefit: args.benefit,
        risks: Array.isArray(args.risks) ? args.risks : [],
      });
      if (!proposed.ok) {
        throw new Error(proposed.error || 'falha ao registrar proposta da skill');
      }
      return {
        ok: true,
        schema: ARCHITECT_SCHEMA,
        mode: 'propose',
        proposal: proposed.proposal,
        skill: proposed.skill,
        summary: `Proposta ${proposed.proposal.id} registrada para ${args.skillId}; aguardando confirmação humana.`,
      };
    },
  };

  return [blueprintTool, proposeTool];
}

