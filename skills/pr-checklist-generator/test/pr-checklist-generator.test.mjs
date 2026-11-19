/**
 * Testes da skill PR Checklist Generator
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildDocumentDraft } from '../../document-creator/document-core.mjs';
import { dataDir } from '../../../src/data-paths.js';

// Testa apenas a lógica de construção de sections (não integração completa)
function buildSectionsFromData({ prInfo, commits, diffStat, diffPatch, includeCommits = [] }) {
  const sections = [];

  sections.push({
    heading: 'Origem dos Dados',
    body: 'Gerado automaticamente via git-assistant (github.repos + git.diff) + document-creator (pr-checklist-generator)'
  });

  if (prInfo) {
    sections.push({
      heading: `PR #${prInfo.number || '?'} - ${prInfo.title || 'Merge Commit'}`,
      body: `${prInfo.mergeCommit?.hash || ''} ${prInfo.mergeCommit?.subject || ''}\nInclui: ${prInfo.skills?.join(', ') || 'skills não detectadas'}`
    });
  }

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

  const skillNames = ['time-tracker', 'habit-garden', 'note-linker', 'focus-guardian', 'document-creator', 'git-assistant'];
  const detectedSkills = skillNames.filter(s => diffStat.includes(s) || diffPatch.includes(s));
  if (detectedSkills.length > 0) {
    sections.push({
      heading: 'Skills Afetadas',
      body: detectedSkills.map(s => `- ${s}`).join('\n')
    });
  }

  const skillSections = {
    'time-tracker': { heading: 'Time Tracker', items: ['timer.start', 'timer.stop', 'timer.export', 'timer.tags'] },
    'habit-garden': { heading: 'Habit Garden', items: ['habit.upsert', 'habit.log', 'habit.streak'] },
    'note-linker': { heading: 'Note Linker', items: ['note.upsert', 'note.get', 'note.link'] },
    'focus-guardian': { heading: 'Focus Guardian', items: ['focus.start', 'focus.stop', 'focus.checkBlocked'] },
    'document-creator': { heading: 'Document Creator', items: ['document.draft', 'document.write'] },
    'git-assistant': { heading: 'Git Assistant', items: ['git.status', 'git.diff', 'github.repos'] },
  };

  for (const skill of detectedSkills) {
    if (skillSections[skill]) {
      sections.push({
        heading: skillSections[skill].heading,
        body: skillSections[skill].items.map(i => `- ${i}`).join('\n')
      });
    }
  }

  sections.push({
    heading: 'Integração & Arquitetura',
    body: ['- server.mjs registra skills/tools', '- Manifestos auto-publicados', '- Stores JSON dedicados', '- Permissions levels 1-4'].join('\n')
  });

  sections.push({
    heading: 'Testes de Regressão',
    body: '- Total de testes passando: verificar via `npm test`'
  });

  return { sections, detectedSkills };
}

describe('pr-checklist-generator core logic', () => {
  const mockCommits = [
    { hash: '031b575', subject: 'Merge pull request #18 from UsamiVtuber/feat/phase1-skills' },
    { hash: 'f7cd015', subject: 'feat(time-tracker): add export, tags, and session tag management tools' },
    { hash: 'd17eee1', subject: 'feat(document-creator): add store, versioning, templates' },
  ];

  const mockDiffStat = 'skills/time-tracker/skill.json | 6 +-\nskills/time-tracker/time-tracker-core.mjs | 166 ++++++++\nskills/document-creator/document-core.mjs | 50 +++\n';
  const mockDiffPatch = 'diff --git a/skills/time-tracker/skill.json\n+    "timer.export",\n+    "timer.tags"';

  test('buildSectionsFromData inclui PR info', () => {
    const prInfo = { number: 18, title: 'Test PR', mergeCommit: mockCommits[0], skills: ['time-tracker'] };
    const { sections } = buildSectionsFromData({ prInfo, commits: mockCommits, diffStat: mockDiffStat, diffPatch: mockDiffPatch });

    assert.ok(sections.some(s => s.heading.includes('PR #18')));
    assert.ok(sections.some(s => s.body.includes('Merge pull request')));
  });

  test('buildSectionsFromData inclui commits analisados', () => {
    const { sections } = buildSectionsFromData({ commits: mockCommits, diffStat: mockDiffStat, diffPatch: mockDiffPatch, includeCommits: ['f7cd015'] });

    assert.ok(sections.some(s => s.heading === 'Commits Analisados'));
    assert.ok(sections.some(s => s.body.includes('f7cd015')));
  });

  test('buildSectionsFromData detecta skills do diff', () => {
    const { sections, detectedSkills } = buildSectionsFromData({ commits: mockCommits, diffStat: mockDiffStat, diffPatch: mockDiffPatch });

    assert.ok(detectedSkills.includes('time-tracker'));
    assert.ok(detectedSkills.includes('document-creator'));
    assert.ok(sections.some(s => s.heading === 'Skills Afetadas'));
    assert.ok(sections.some(s => s.heading === 'Time Tracker'));
    assert.ok(sections.some(s => s.heading === 'Document Creator'));
  });

  test('buildSectionsFromData não detecta skills ausentes no diff', () => {
    const emptyDiff = 'README.md | 2 +-\n';
    const { detectedSkills } = buildSectionsFromData({ commits: mockCommits, diffStat: emptyDiff, diffPatch: '' });

    assert.strictEqual(detectedSkills.length, 0);
  });

  test('buildDocumentDraft gera checklist válido', () => {
    const { sections } = buildSectionsFromData({ commits: mockCommits, diffStat: mockDiffStat, diffPatch: mockDiffPatch, includeCommits: ['f7cd015'] });

    const draft = buildDocumentDraft({
      title: 'Checklist Teste',
      format: 'checklist',
      sections,
      tags: ['test'],
    });

    assert.strictEqual(draft.schema, 'usami.document.v1');
    assert.strictEqual(draft.format, 'checklist');
    assert.ok(draft.content.includes('Time Tracker'));
    assert.ok(draft.content.includes('timer.export'));
    assert.ok(draft.content.includes('- [ ]'));
  });

  test('buildDocumentDraft suporta format adr', () => {
    const { sections } = buildSectionsFromData({ commits: mockCommits, diffStat: mockDiffStat, diffPatch: mockDiffPatch });

    const draft = buildDocumentDraft({
      title: 'ADR Teste',
      format: 'adr',
      sections,
    });

    assert.strictEqual(draft.format, 'adr');
    assert.ok(draft.content.includes('## Skills Afetadas'));
  });

  test('buildDocumentDraft suporta format summary', () => {
    const { sections } = buildSectionsFromData({ commits: mockCommits, diffStat: mockDiffStat, diffPatch: mockDiffPatch });

    const draft = buildDocumentDraft({
      title: 'Summary Teste',
      format: 'summary',
      sections,
    });

    assert.strictEqual(draft.format, 'summary');
  });
});