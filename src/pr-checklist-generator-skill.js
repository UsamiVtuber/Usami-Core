/**
 * Skill operacional PR Checklist Generator.
 *
 * Publica o manifesto `pr-checklist-generator` em `dataDir/skills/pr-checklist-generator`
 * quando ausente e registra:
 *  - `pr.checklist.generate` (nível 3/4): gera e salva checklist (local ou GitHub)
 *  - `pr.checklist.preview` (nível 1): apenas retorna o conteúdo Markdown sem salvar
 */
import { publishSkillPackage } from './skill-package.js';
import { generateChecklist, PR_CHECKLIST_SCHEMA } from '../skills/pr-checklist-generator/pr-checklist-core.mjs';
import { AGENT_SCHEMAS } from './agent-contracts.js';

export const PR_CHECKLIST_GENERATOR_SKILL_ID = 'pr-checklist-generator';
export const PR_CHECKLIST_GENERATOR_TOOLS = Object.freeze([
  'pr.checklist.generate',
  'pr.checklist.preview',
]);

export function publishPrChecklistGeneratorSkill({ dataDir, bundledDir } = {}) {
  return publishSkillPackage({ skillId: PR_CHECKLIST_GENERATOR_SKILL_ID, dataDir, bundledDir });
}

export function createPrChecklistGeneratorTools({} = {}) {
  const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

  const generateTool = {
    schema: AGENT_SCHEMAS.tool,
    name: 'pr.checklist.generate',
    version: '1.0.0',
    description: 'Gera checklist de testes automatizado para um PR e salva (local ou GitHub). Usa git-assistant + document-creator.',
    origin: 'skill',
    permissionLevel: 3,
    timeoutMs: 30000,
    parameters: [
      { name: 'prNumber', type: 'number', required: true, description: 'Número do PR no GitHub.' },
      { name: 'repo', type: 'string', required: false, description: 'Repositório GitHub (owner/repo). Padrão: UsamiVtuber/Usami-Core' },
      { name: 'includeCommits', type: 'array', required: false, description: 'Lista de hashes de commits específicos para analisar (ex.: ["f7cd015", "d17eee1"]).' },
      { name: 'format', type: 'string', required: false, enum: ['checklist', 'adr', 'summary', 'note'], description: 'Formato do documento.' },
      { name: 'outputDir', type: 'string', required: false, description: 'Diretório local para salvar (padrão: data/documents).' },
      { name: 'filename', type: 'string', required: false, description: 'Nome do arquivo (.md ou .txt).' },
      { name: 'saveToGithub', type: 'boolean', required: false, description: 'Se true, salva direto no GitHub via github.write_file.' },
      { name: 'githubRepo', type: 'string', required: false, description: 'Repositório destino no GitHub (owner/repo) se saveToGithub=true.' },
      { name: 'githubBranch', type: 'string', required: false, description: 'Branch alvo no GitHub se saveToGithub=true.' },
    ],
    verify(result) {
      return isPlainObject(result)
        && result.ok === true
        && result.schema === PR_CHECKLIST_SCHEMA
        && typeof result.title === 'string'
        && typeof result.filename === 'string'
        && result.saveResult && (result.saveResult.location === 'local' || result.saveResult.location === 'github');
    },
    async execute(args = {}) {
      return generateChecklist({
        prNumber: args.prNumber,
        repo: args.repo || 'UsamiVtuber/Usami-Core',
        includeCommits: args.includeCommits || [],
        format: args.format || 'checklist',
        outputDir: args.outputDir,
        filename: args.filename,
        saveToGithub: args.saveToGithub === true,
        githubRepo: args.githubRepo,
        githubBranch: args.githubBranch,
      });
    },
  };

  const previewTool = {
    schema: AGENT_SCHEMAS.tool,
    name: 'pr.checklist.preview',
    version: '1.0.0',
    description: 'Gera preview do checklist (Markdown) sem salvar em disco. Útil para revisar antes de gravar.',
    origin: 'skill',
    permissionLevel: 1,
    timeoutMs: 30000,
    parameters: [
      { name: 'prNumber', type: 'number', required: true, description: 'Número do PR no GitHub.' },
      { name: 'repo', type: 'string', required: false, description: 'Repositório GitHub (owner/repo).' },
      { name: 'includeCommits', type: 'array', required: false, description: 'Lista de hashes de commits específicos.' },
      { name: 'format', type: 'string', required: false, enum: ['checklist', 'adr', 'summary', 'note'], description: 'Formato do documento.' },
    ],
    verify(result) {
      return isPlainObject(result)
        && result.ok === true
        && result.schema === PR_CHECKLIST_SCHEMA
        && typeof result.content === 'string'
        && result.content.length > 0;
    },
    async execute(args = {}) {
      const result = await generateChecklist({
        prNumber: args.prNumber,
        repo: args.repo || 'UsamiVtuber/Usami-Core',
        includeCommits: args.includeCommits || [],
        format: args.format || 'checklist',
        persist: false,
      });
      return {
        ok: true,
        schema: PR_CHECKLIST_SCHEMA,
        title: result.title,
        format: result.format,
        content: result.content,
        sectionsCount: result.sectionsCount,
        detectedSkills: result.detectedSkills,
      };
    },
  };

  return [generateTool, previewTool];
}
