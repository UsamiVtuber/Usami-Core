import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVaultIndex } from '../src/vault-index.js';

function scratchDirs() {
  const root = mkdtempSync(join(tmpdir(), 'usami-vault-'));
  return { root, vaultDir: join(root, 'vault'), dataDir: join(root, 'data') };
}

function writeNote(vaultDir, name, content, { minutesAgo = 0 } = {}) {
  mkdirSync(vaultDir, { recursive: true });
  const filePath = join(vaultDir, name);
  writeFileSync(filePath, content, 'utf8');
  const stamp = (Date.now() - minutesAgo * 60_000) / 1000;
  utimesSync(filePath, stamp, stamp);
  return filePath;
}

function withIndex(options, fn) {
  const dirs = scratchDirs();
  const index = createVaultIndex({ ...dirs, ...options });
  try {
    return fn(dirs, index);
  } finally {
    index.close();
    rmSync(dirs.root, { recursive: true, force: true });
  }
}

test('busca FTS5 encontra o arquivo certo pelo assunto, não só os recentes', () => withIndex({}, (dirs, index) => {
  writeNote(dirs.vaultDir, 'antigo.md', '---\ntags: [memoria]\n---\nConversamos sobre violão e escalas.', { minutesAgo: 300 });
  writeNote(dirs.vaultDir, 'novo.md', 'Hoje falamos de culinária e pão.', { minutesAgo: 1 });

  const context = index.search({ query: 'quero aprender violão' });
  assert.match(context, /### antigo\.md/);
  assert.match(context, /violão e escalas/);
  assert.doesNotMatch(context, /### novo\.md/);
  assert.equal(index.backend, 'fts5');
}));

test('sem termos úteis (stopwords) ou sem match, cai para os mais recentes', () => withIndex({}, (dirs, index) => {
  writeNote(dirs.vaultDir, 'a.md', 'assunto de astronomia', { minutesAgo: 90 });
  writeNote(dirs.vaultDir, 'b.md', 'assunto de jardinagem', { minutesAgo: 1 });

  const stopwords = index.search({ query: 'e aí, tudo bem com você?' });
  assert.match(stopwords, /### b\.md/);
  assert.match(stopwords, /### a\.md/);

  const noMatch = index.search({ query: 'xilofone' });
  assert.match(noMatch, /assunto de jardinagem/);
}));

test('refresh é incremental: arquivo alterado troca de conteúdo no índice', () => withIndex({ throttleMs: 0 }, (dirs, index) => {
  const filePath = writeNote(dirs.vaultDir, 'nota.md', 'primeiro assunto: culinária', { minutesAgo: 5 });
  assert.match(index.search({ query: 'culinária' }), /primeiro assunto/);

  writeFileSync(filePath, 'segundo assunto: astronomia', 'utf8');
  const later = (Date.now() + 60_000) / 1000;
  utimesSync(filePath, later, later);

  assert.match(index.search({ query: 'astronomia' }), /segundo assunto/);
  const stale = index.search({ query: 'culinária' });
  assert.doesNotMatch(stale, /primeiro assunto/);
}));

test('arquivo apagado sai do índice no próximo refresh', () => withIndex({}, (dirs, index) => {
  const keep = writeNote(dirs.vaultDir, 'fica.md', 'conteúdo sobre gatos', { minutesAgo: 10 });
  const gone = writeNote(dirs.vaultDir, 'sai.md', 'conteúdo sobre cachorros', { minutesAgo: 5 });
  index.search({ query: 'cachorros' });

  unlinkSync(gone);
  const context = index.search({ query: 'cachorros' });
  assert.doesNotMatch(context, /cachorros/);
  assert.equal(typeof keep, 'string');
}));

test('allowFts:false mantém o mesmo resultado pelo caminho LIKE, sem acento', () => withIndex({ allowFts: false }, (dirs, index) => {
  writeNote(dirs.vaultDir, 'musica.md', 'Ele toca violão todas as noites.', { minutesAgo: 3 });
  const context = index.search({ query: 'violao' });
  assert.match(context, /### musica\.md/);
  assert.match(context, /violão todas as noites/);
  assert.equal(index.backend, 'like');
}));

test('pasta do vault ausente não apaga o índice nem explode', () => withIndex({}, (dirs, index) => {
  const stats = index.refresh();
  assert.equal(stats.available, false);
  assert.equal(index.search({ query: 'qualquer coisa' }), null);
}));

test('B16: refresh é throttled quando o mtime do diretório não mudou', () => withIndex({}, (dirs, index) => {
  const filePath = writeNote(dirs.vaultDir, 'nota.md', 'primeiro assunto: culinária', { minutesAgo: 5 });
  assert.match(index.search({ query: 'culinária' }), /primeiro assunto/);

  // Editar o CONTEÚDO não muda o mtime do diretório: dentro da janela de
  // throttle o refresh é pulado (era um readdir+stat por arquivo a cada turno).
  writeFileSync(filePath, 'segundo assunto: astronomia', 'utf8');
  const later = (Date.now() + 60_000) / 1000;
  utimesSync(filePath, later, later);
  const skipped = index.refresh();
  assert.equal(skipped.skipped, true);
  assert.match(index.search({ query: 'culinária' }), /primeiro assunto/);

  // force ignora a janela e reconcilia.
  index.refresh({ force: true });
  assert.match(index.search({ query: 'astronomia' }), /segundo assunto/);

  // Criar arquivo MUDA o mtime do diretório: o próximo refresh roda mesmo
  // dentro da janela e a nota nova entra.
  writeNote(dirs.vaultDir, 'nova.md', 'conteúdo sobre xilofone', { minutesAgo: 1 });
  assert.match(index.search({ query: 'xilofone' }), /conteúdo sobre xilofone/);
}));
