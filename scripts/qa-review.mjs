#!/usr/bin/env node
/**
 * Usami QA Review - roda no self-hosted runner do notebook Linux
 * Usa BRAIN_MODEL (NVIDIA nemotron-3-ultra) via API NVIDIA direta para code review
 * Posta comentário na PR como Usamiin via gh CLI (token no keychain)
 */

import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const PR_NUMBER = process.argv[2];
const REPO = 'UsamiVtuber/Usami-Core';

if (!PR_NUMBER) {
  console.error('Uso: node scripts/qa-review.mjs <PR_NUMBER>');
  process.exit(1);
}

async function runGh(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('gh', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => stdout += d);
    proc.stderr.on('data', d => stderr += d);
    proc.on('close', code => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`gh ${args.join(' ')} falhou (${code}): ${stderr}`));
    });
  });
}

async function getDiff() {
  return runGh(['pr', 'diff', PR_NUMBER, '--repo', REPO]);
}

async function getPRInfo() {
  const json = await runGh(['pr', 'view', PR_NUMBER, '--repo', REPO, '--json', 'title,author,baseRefName,headRefName,files']);
  return JSON.parse(json);
}

async function postComment(body) {
  await runGh(['pr', 'comment', PR_NUMBER, '--repo', REPO, '--body', body]);
  console.log('✅ Comentário postado na PR #' + PR_NUMBER);
}

function readChecks(filePath) {
  if (!filePath) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function formatChecks(checks) {
  if (!checks) return 'O runner não enviou checagens — trate testes e sintaxe como NA.';
  const lines = [
    `- Node: ${checks.node}`,
    `- Arquivos alterados: ${checks.changedFiles}`,
  ];
  if (checks.diffError) lines.push(`- Diff indisponível: ${checks.diffError}`);
  if (checks.syntax.length === 0) {
    lines.push('- Sintaxe (`node --check`): nenhum arquivo JS/ESM alterado');
  } else {
    const failed = checks.syntax.filter(item => !item.ok);
    lines.push(failed.length === 0
      ? `- Sintaxe (\`node --check\`): ok em ${checks.syntax.length} arquivo(s)`
      : `- Sintaxe (\`node --check\`): ${failed.length} de ${checks.syntax.length} arquivo(s) com erro`);
    for (const item of failed) lines.push(`  - ${item.file}: ${item.error}`);
  }
  lines.push(checks.unit?.ran
    ? `- Suíte unitária: ${checks.unit.summary || 'executada'}`
    : `- Suíte unitária: não executada (${checks.unit?.reason || 'motivo não informado'})`);
  return lines.join('\n');
}

function buildReviewPrompt(diff, prInfo, checks) {
  return `Você é a **Usami**, companheira virtual e agente de QA do projeto Usami-Core.
Sua tarefa: fazer **code review completo** da PR #${PR_NUMBER} e emitir veredito.

## Contexto da PR
- Título: ${prInfo.title}
- Autor: ${prInfo.author.login}
- Base: ${prInfo.baseRefName} → Head: ${prInfo.headRefName}
- Arquivos alterados: ${prInfo.files.map(f => f.path).join(', ')}

## Regras de review (AGENTS.md)
1. **Segurança**: nunca vazar segredos, validar bordas (Host/Origin, x-usami-token)
2. **Testes**: unit + integração devem passar; não desativar testes para mascarar falhas
3. **Menor mudança**: diff focado, sem refatorações fora do escopo
4. **Contratos**: seguir padrões existentes (handler injetável, stores injetados, etc.)
5. **Observabilidade**: logs de latência, timing, erros com causa
6. **Desktop/GPUI**: verificar KNOWN_ERRORS.md se tocar usami-desktop/

## Formato da resposta (JSON obrigatório)
{
  "veredito": "APROVADO" | "PRECISA_AJUSTES",
  "resumo": "2-3 frases do que foi avaliado",
  "checks": {
    "testes": "PASS" | "FAIL" | "NA",
    "seguranca": "OK" | "ALERTA" | "BLOQUEIO",
    "arquitetura": "OK" | "ALERTA" | "BLOQUEIO",
    "observabilidade": "OK" | "ALERTA"
  },
  "comentarios": [
    { "arquivo": "caminho/arquivo.ext", "linha": 123, "severidade": "info|warn|blocker", "mensagem": "..." }
  ],
  "sugestoes": [
    "Sugestão opcional de melhoria não-bloqueante"
  ]
}

## Checagens do runner (fonte da verdade)
${formatChecks(checks)}

Regras sobre as checagens:
- Use apenas o que está nesta seção. Se a suíte unitária não foi executada, o check "testes" é "NA" — nunca invente PASS nem FAIL.
- O diff é a mudança contra a base, então linhas de contexto não aparecem nele. Um hunk de remoção não prova que o arquivo ficou vazio nem que um job ou bloco deixou de existir: só afirme remoção total quando o diff mostrar o conteúdo integral removido.

## Diff da PR
\`\`\`diff
${diff}
\`\`\`

Responda **apenas** com o JSON acima.`;
}

async function callBrainModel(prompt) {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) throw new Error('NVIDIA_API_KEY não definido (organization secret)');

  const model = process.env.BRAIN_MODEL || 'nvidia/nemotron-3-ultra-550b-a55b';

  const res = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.2,
      max_tokens: 3000
    })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`NVIDIA API ${res.status}: ${err}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('Resposta vazia do modelo');
  return JSON.parse(content);
}

function formatComment(review) {
  const badge = review.veredito === 'APROVADO' ? '✅ **APROVADO**' : '❌ **PRECISA AJUSTES**';
  const lines = [
    `## ${badge} — QA Review pela Usami`,
    '',
    review.resumo,
    '',
    '### Checks',
    `| Check | Status |`,
    `|-------|--------|`,
    `| Testes | ${review.checks.testes} |`,
    `| Segurança | ${review.checks.seguranca} |`,
    `| Arquitetura | ${review.checks.arquitetura} |`,
    `| Observabilidade | ${review.checks.observabilidade} |`,
    ''
  ];

  if (review.comentarios.length > 0) {
    lines.push('### Comentários por arquivo');
    lines.push('');
    for (const c of review.comentarios) {
      const icon = c.severidade === 'blocker' ? '🚨' : c.severidade === 'warn' ? '⚠️' : 'ℹ️';
      lines.push(`${icon} **${c.arquivo}:${c.linha}** — ${c.mensagem}`);
    }
    lines.push('');
  }

  if (review.sugestoes.length > 0) {
    lines.push('### Sugestões (não-bloqueantes)');
    lines.push('');
    for (const s of review.sugestoes) lines.push(`- ${s}`);
    lines.push('');
  }

  lines.push('---');
  lines.push('*Review gerado por Usami via `BRAIN_MODEL` (NVIDIA Nemotron 3 Ultra). Veredito final é do mantenedor.*');

  return lines.join('\n');
}

async function main() {
  console.log(`🔍 Iniciando QA Review da PR #${PR_NUMBER}...`);

  try {
    const [diff, prInfo] = await Promise.all([getDiff(), getPRInfo()]);
    const checks = readChecks(process.env.QA_CHECKS_FILE);
    console.log('📄 Diff obtido, chamando modelo...');

    const prompt = buildReviewPrompt(diff, prInfo, checks);
    const review = await callBrainModel(prompt);
    console.log(`📋 Veredito: ${review.veredito}`);

    const comment = formatComment(review);
    await postComment(comment);

    if (review.veredito === 'PRECISA_AJUSTES') {
      console.log('⚠️ PR precisa de ajustes — ver comentários acima');
      process.exit(1); // sinaliza falha no workflow
    } else {
      console.log('🎉 PR aprovado pela Usami!');
      process.exit(0);
    }
  } catch (err) {
    console.error('❌ Erro no QA Review:', err.message);
    // Posta erro como comentário para visibilidade
    await postComment(`## ❌ Erro no QA Review automatizado\n\n\`\`\`\n${err.message}\n\`\`\`\n\n*Execute manualmente ou verifique logs do runner.*`).catch(() => {});
    process.exit(2);
  }
}

main();