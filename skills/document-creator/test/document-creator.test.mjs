import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DOCUMENT_SCHEMA,
  buildDocumentDraft,
  validateDocumentFilename,
  writeSafeDocument,
} from '../document-core.mjs';

test('buildDocumentDraft gera markdown válido e validateDocumentFilename bloqueia traversal', () => {
  const draft = buildDocumentDraft({
    title: 'Checklist de Lançamento',
    format: 'checklist',
    sections: [{ heading: 'Pré-voo', body: 'Rodar testes\nConferir build' }],
    tags: ['release'],
    nowMs: Date.parse('2026-11-11T12:00:00.000Z'),
  });

  assert.equal(draft.schema, DOCUMENT_SCHEMA);
  assert.equal(draft.filename, 'checklist-de-lancamento.md');
  assert.match(draft.content, /- \[ \] Rodar testes/);

  assert.equal(validateDocumentFilename('../fora.md').ok, false);
  assert.equal(validateDocumentFilename('.env').ok, false);
  assert.equal(validateDocumentFilename('sub/nota.md').ok, false);
  assert.equal(validateDocumentFilename('nota-ok.md').ok, true);
});

test('writeSafeDocument respeita pasta permitida e impede sobrescrita acidental', t => {
  const baseRoot = process.env.USAMI_DATA_DIR || tmpdir();
  const dir = mkdtempSync(join(baseRoot, 'doc-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const first = writeSafeDocument({
    allowedDir: dir,
    filename: 'resumo.md',
    content: '# Resumo\n\nConteúdo inicial.\n',
  });
  assert.equal(first.written, true);
  assert.equal(first.overwritten, false);
  assert.match(readFileSync(join(dir, 'resumo.md'), 'utf8'), /Conteúdo inicial/);

  assert.throws(() => writeSafeDocument({
    allowedDir: dir,
    filename: 'resumo.md',
    content: '# Novo\n',
    overwrite: false,
  }), /já existe/);

  const second = writeSafeDocument({
    allowedDir: dir,
    filename: 'resumo.md',
    content: '# Novo\n',
    overwrite: true,
  });
  assert.equal(second.overwritten, true);
});

