/**
 * PR Checklist Generator Skill Core
 * Gera checklist de testes automatizado a partir de PR/commits do GitHub.
 * Combina git-assistant (github.repos + git.diff) + document-creator.
 */
import { createGitAssistantClient } from '../../src/git-assistant-skill.js';
import {
  buildDocumentDraft,
  writeSafeDocument,
  validateDocumentFilename,
} from '../document-creator/document-core.mjs';
import { dataDir } from '../../src/data-paths.js';
import { join } from 'node:path';

export const PR_CHECKLIST_SCHEMA = 'usami.pr-checklist.v1';
export const PR_CHECKLIST_FORMATS = Object.freeze(['checklist', 'adr', 'summary', 'note']);

const DEFAULT_OUTPUT_DIR = join(dataDir(), 'documents');
const REPO_SLUG_RE = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;

function slugify(title) {
  return String(title ?? 'checklist')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'checklist';
}

function formatDate(iso) {
  return new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function extractPrInfo(commits, targetPrNumber) {
  const mergeCommit = commits.find(c =>
    c.subject.includes(`#${targetPrNumber}`) || c.subject.includes(`pull request #${targetPrNumber}`)
  );
  return mergeCommit || commits[0];
}

function validateRepoSlug(repo) {
  if (!REPO_SLUG_RE.test(repo)) {
    throw new Error(`repo inválido: "${repo}". Esperado formato owner/nome (ex.: UsamiVtuber/Usami-Core)`);
  }
}

export function buildSectionsFromData({ prInfo, commits, diffStat, diffPatch, includeCommits = [] }) {
  const sections = [];

  // Origem
  sections.push({
    heading: 'Origem dos Dados',
    body: 'Gerado automaticamente via git-assistant (github.repos + git.diff) + document-creator (pr-checklist-generator)'
  });

  // PR Info
  if (prInfo) {
    sections.push({
      heading: `PR #${prInfo.number || '?'} - ${prInfo.title || 'Merge Commit'}`,
      body: `${prInfo.mergeCommit?.hash || ''} ${prInfo.mergeCommit?.subject || ''}\nInclui: ${prInfo.skills?.join(', ') || 'skills não detectadas'}`
    });
  }

  // Commits específicos
  if (includeCommits.length > 0) {
    const commitDetails = includeCommits.map(hash => {
      const commit = commits.find(c => c.hash.startsWith(hash.slice(0, 7))) || commits.find(c => c.hash === hash);
      if (!commit) return `- ${hash}: não encontrado`;
      const files = diffStat.split('\n').filter(l => l.includes('.mjs') || l.includes('.js') || l.includes('.json'));
      return `- ${commit.hash} ${commit.subject}\n  ${files.slice(0, 5).join('\n  ') || 'arquivos não listados no stat'}`;
    }).join('\n');
    sections.push({
      heading: 'Commits Analisados',
      body: commitDetails
    });
  }

  // Skills detectadas (heurística simples)
  const skillNames = ['time-tracker', 'habit-garden', 'note-linker', 'focus-guardian', 'document-creator', 'git-assistant'];
  const detectedSkills = skillNames.filter(s => diffStat.includes(s) || diffPatch.includes(s));
  if (detectedSkills.length > 0) {
    sections.push({
      heading: 'Skills Afetadas',
      body: detectedSkills.map(s => `- ${s}`).join('\n')
    });
  }

  // Seções padrão por skill
  const skillSections = {
    'time-tracker': {
      heading: 'Time Tracker',
      items: [
        'timer.start (foco, pomodoro, block)',
        'timer.stop',
        'timer.status',
        'timer.report (day/week/all, projectId filter)',
        'timer.pomodoro (work/break minutes)',
        'timer.block (startAt/endAt agendado)',
        'timer.export (csv/json)',
        'timer.tags / timer.session_add_tags / timer.session_remove_tags',
        'Persistência timer-session-store + operational-memory',
        'ToolSpecs verify functions',
        'Testes passando'
      ]
    },
    'habit-garden': {
      heading: 'Habit Garden',
      items: [
        'habit.upsert (daily/weekly, category, targetPerPeriod)',
        'habit.log (date, count, streak auto-calc)',
        'habit.streak (current, longest, heatmap, isDueToday)',
        'habit.heatmap (consolidado)',
        'habit.suggestMicro (baseado em hábitos existentes)',
        'habit.list (filtro category)',
        'Timezone fix: parseDateKey local (não UTC)',
        'Testes passando'
      ]
    },
    'note-linker': {
      heading: 'Note Linker',
      items: [
        'note.upsert (title, content, tags, links auto-extracted [[wiki]])',
        'note.get (id ou title)',
        'note.search (query, tag, limit)',
        'note.link / note.unlink (bidirecional)',
        'note.backlinks (quem linka para nota)',
        'note.graph (nodes + edges)',
        'note.listTags / note.list / note.delete',
        'Backlinks sincronizados automaticamente',
        'Testes passando'
      ]
    },
    'focus-guardian': {
      heading: 'Focus Guardian',
      items: [
        'focus.start/pause/resume/stop/cancel/break/distraction',
        'focus.status (progresso, tempo restante, pausas, distrações)',
        'focus.sessions (filtros status, profileId)',
        'focus.stats (agregado, opcional profileId)',
        'Perfis: upsert/list/delete (Deep Work, Pomodoro, Light Focus defaults)',
        'Blocklists: upsert/get/list/delete (domínios, enabled)',
        'Settings get/update',
        'focus.check-blocked (URL + profileId → blocked boolean)',
        'Blocklists padrão: Redes Sociais + Entretenimento',
        'Testes passando'
      ]
    },
    'document-creator': {
      heading: 'Document Creator',
      items: [
        'document.draft (note, checklist, adr, summary)',
        'document.write (nível 4, pasta permitida, overwrite)',
        'document.list/get/update/search/delete',
        'document.history/version',
        'document.tags/stats',
        'Templates: upsert/get/list/delete',
        'Validação filename (sem traversal, .md/.txt apenas)',
        'Testes passando'
      ]
    },
    'git-assistant': {
      heading: 'Git Assistant',
      items: [
        'git.status/log/diff (nível 1, leitura local)',
        'github.repos (nível 3, GITHUB_TOKEN)',
        'git.commit/push/github.pr (nível 4, confirmação humana)',
        'github.issue/create_repo/write_file (nível 3)',
        'code.propose/proposals (code agent bridge)',
        'Redação de segredos em diff/log',
        'Testes passando'
      ]
    }
  };

  for (const skill of detectedSkills) {
    if (skillSections[skill]) {
      sections.push({
        heading: skillSections[skill].heading,
        body: skillSections[skill].items.map(i => `- ${i}`).join('\n')
      });
    }
  }

  // Arquitetura
  sections.push({
    heading: 'Integração & Arquitetura',
    body: [
      '- server.mjs registra todas as skills/tools no startup',
      '- Manifestos auto-publicados em dataDir/skills/<id>/',
      '- Stores JSON dedicados (lazy loading, atomic writes)',
      '- Permissions levels 1-4 respeitados',
      '- Tool Registry contracts (usami.agent.tool.v1)',
      '- Operational memory schema (usami.agent.operational.v1)',
      '- Skill manifests (usami.agent.skill.v1)'
    ].join('\n')
  });

  // Testes
  sections.push({
    heading: 'Testes de Regressão',
    body: '- Total de testes passando: verificar via `npm test`\n- Cada skill tem sua suíte isolada\n- Testes de persistência entre instâncias\n- Casos de borda validados'
  });

  return { sections, detectedSkills };
}

export async function generateChecklist({
  prNumber,
  repo = 'UsamiVtuber/Usami-Core',
  includeCommits = [],
  format = 'checklist',
  outputDir = DEFAULT_OUTPUT_DIR,
  filename = null,
  saveToGithub = false,
  githubRepo = null,
  githubBranch = null,
  persist = true,
  baseRef = null,
} = {}) {
  // Validação early-return
  validateRepoSlug(repo);
  if (saveToGithub && !githubRepo) {
    throw new Error('githubRepo é obrigatório quando saveToGithub=true');
  }
  if (saveToGithub && githubRepo) {
    validateRepoSlug(githubRepo);
  }

  const gitClient = createGitAssistantClient();

  // 1. Busca repo info (commits, PRs) - com try/catch e latency logging
  const listReposStart = Date.now();
  let repoData;
  try {
    repoData = await gitClient.listRepos({ repo, limit: 20 });
  } catch (error) {
    console.warn('[pr-checklist] listRepos falhou:', error?.message || error);
    throw error;
  } finally {
    console.info('[pr-checklist] listRepos latencyMs=' + (Date.now() - listReposStart));
  }
  const commits = (repoData.commits || []).sort((a, b) => new Date(a.date) - new Date(b.date));
  const openPRs = repoData.openPullRequests || [];

  // 2. Encontra PR alvo
  const targetPR = openPRs.find(pr => pr.number === prNumber) || null;
  const prInfo = targetPR ? {
    number: targetPR.number,
    title: targetPR.title,
    htmlUrl: targetPR.htmlUrl,
    head: targetPR.head,
    base: targetPR.base,
    mergeCommit: extractPrInfo(commits, prNumber),
    skills: ['time-tracker', 'habit-garden', 'note-linker', 'focus-guardian', 'document-creator']
  } : null;

  // 3. Busca diff dos commits incluídos - com try/catch e latency logging
  let diffStat = '';
  let diffPatch = '';
  if (includeCommits.length > 0) {
    const ref = baseRef || includeCommits[includeCommits.length - 1];
    const diffStart = Date.now();
    let diffData;
    try {
      diffData = await gitClient.diff({ target: 'usami', ref });
    } catch (error) {
      console.warn('[pr-checklist] diff falhou:', error?.message || error);
      throw error;
    } finally {
      console.info('[pr-checklist] diff latencyMs=' + (Date.now() - diffStart));
    }
    diffStat = diffData.stat;
    diffPatch = diffData.diff;
  } else if (prInfo?.mergeCommit) {
    const mergeIdx = commits.findIndex(c => c.hash === prInfo.mergeCommit.hash);
    if (mergeIdx >= 0 && mergeIdx + 1 < commits.length) {
      const diffStart = Date.now();
      let diffData;
      try {
        diffData = await gitClient.diff({ target: 'usami', ref: commits[mergeIdx + 1].hash });
      } catch (error) {
        console.warn('[pr-checklist] diff falhou:', error?.message || error);
        throw error;
      } finally {
        console.info('[pr-checklist] diff latencyMs=' + (Date.now() - diffStart));
      }
      diffStat = diffData.stat;
      diffPatch = diffData.diff;
    }
  }

  // 4. Monta seções
  const { sections, detectedSkills } = buildSectionsFromData({ prInfo, commits, diffStat, diffPatch, includeCommits });

  // 5. Gera draft
  const title = `Checklist de Testes - PR #${prNumber}${includeCommits.length ? ` + ${includeCommits.length} commits` : ''}`;
  const resolvedFilename = filename || `${slugify(title)}.md`;

  const checkedName = validateDocumentFilename(resolvedFilename);
  if (!checkedName.ok) throw new Error(checkedName.error);

  const draft = buildDocumentDraft({
    title,
    format,
    sections,
    tags: ['pr', 'checklist', 'testes', 'automatizado', `pr-${prNumber}`],
    filename: checkedName.filename,
  });

  // 6. Salva
  let saveResult;
  if (!persist) {
    saveResult = { location: 'none' };
  } else if (saveToGithub && githubRepo) {
    const { createOrUpdateFile } = gitClient;
    const writeStart = Date.now();
    let res;
    try {
      res = await createOrUpdateFile({
        repo: githubRepo,
        path: resolvedFilename,
        content: draft.content,
        message: `chore: checklist automatizado PR #${prNumber}`,
        branch: githubBranch,
      });
    } catch (error) {
      console.warn('[pr-checklist] createOrUpdateFile falhou:', error?.message || error);
      throw error;
    } finally {
      console.info('[pr-checklist] createOrUpdateFile latencyMs=' + (Date.now() - writeStart));
    }
    saveResult = { ...res, location: 'github' };
  } else {
    const writeStart = Date.now();
    try {
      saveResult = writeSafeDocument({
        allowedDir: outputDir,
        filename: checkedName.filename,
        content: draft.content,
        overwrite: true,
      });
    } catch (error) {
      console.warn('[pr-checklist] writeSafeDocument falhou:', error?.message || error);
      throw error;
    } finally {
      console.info('[pr-checklist] writeSafeDocument latencyMs=' + (Date.now() - writeStart));
    }
    saveResult = { ...saveResult, location: 'local' };
  }

  return {
    ok: true,
    schema: PR_CHECKLIST_SCHEMA,
    prNumber,
    title: draft.title,
    format: draft.format,
    filename: draft.filename,
    sectionsCount: sections.length,
    detectedSkills,
    saveResult,
    content: draft.content,
  };
}
