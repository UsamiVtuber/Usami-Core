#!/usr/bin/env node
// Coleta checagens determinísticas para o QA Review antes de chamar o modelo.
// Roda no runner, que não tem node_modules: nada aqui pode depender do projeto.
//
// Uso:
//   QA_BASE_REF=origin/main QA_CHECKS_OUT=/tmp/qa-checks.json node scripts/qa-checks.mjs
//
// Saída: JSON com versão do Node, arquivos alterados e resultado de
// `node --check` em cada arquivo JS/ESM que ainda existe na branch.
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';

const base = process.env.QA_BASE_REF || 'origin/main';
const outPath = process.env.QA_CHECKS_OUT || '';

const result = {
  base,
  node: process.version,
  changedFiles: 0,
  diffError: null,
  syntax: [],
  unit: { ran: false, reason: '' },
};

try {
  const changed = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).split('\n').filter(Boolean);
  result.changedFiles = changed.length;

  for (const file of changed) {
    if (!/\.(c|m)?js$/.test(file)) continue;
    if (!existsSync(file)) continue; // removido pela PR
    try {
      execFileSync(process.execPath, ['--check', file], { stdio: ['ignore', 'ignore', 'pipe'] });
      result.syntax.push({ file, ok: true });
    } catch (error) {
      const detail = String(error.stderr || error.message || '')
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .slice(0, 3)
        .join(' ')
        .slice(0, 400);
      result.syntax.push({ file, ok: false, error: detail });
    }
  }
} catch (error) {
  result.diffError = String(error.stderr || error.message || '').trim().slice(0, 400);
}

result.unit.reason = existsSync('node_modules')
  ? 'não executada neste workflow'
  : 'não executada neste workflow (runner sem node_modules)';

const text = JSON.stringify(result, null, 2);
if (outPath) writeFileSync(outPath, text, 'utf8');
console.log(text);
