#!/usr/bin/env node
/**
 * Usami QA Review - roda no self-hosted runner do notebook Linux
 * Usa BRAIN_MODEL (NVIDIA nemotron-3-ultra) via API NVIDIA direta para code review
 * Posta comentário na PR como Usamiin via gh CLI (token no keychain)
 */

import { readFile } from 'node:fs/promises';
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

function buildReviewPrompt(diff, prInfo) {
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
    console.log('📄 Diff obtido, chamando modelo...');

    const prompt = buildReviewPrompt(diff, prInfo);
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
// @ts-check
//! scripts/qa-review.mjs
//!
//! Gera um review de PR usando o modelo local de raciocínio (BRAIN_MODEL,
//! default `nvidia/nemotron-3-ultra-550b-a55b` via OpenRouter) e posta o
//! comentário no PR via `gh` (token do keychain do SO, não de env).
//!
//! Variáveis de ambiente:
//!   BRAIN_MODEL        modelo de raciocínio (padrão: nvidia/nemotron-3-ultra-550b-a55b)
//!   OPENROUTER_API_KEY chave da OpenRouter (obrigatória)
//!   PR_NUMBER          número do PR (fallback se GITHUB_EVENT_PATH não houver)
//!   GITHUB_REPOSITORY  repo no formato owner/name (padrão: UsamiVtuber/Usami-Core)

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const REPO = process.env.GITHUB_REPOSITORY || 'UsamiVtuber/Usami-Core';
const MODEL = process.env.BRAIN_MODEL || 'nvidia/nemotron-3-ultra-550b-a55b';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

if (!OPENROUTER_API_KEY) {
  console.error('[qa-review] OPENROUTER_API_KEY não definida.');
  process.exit(1);
}

// Resolve o número do PR: evento do GitHub Actions > env PR_NUMBER.
let prNumber = null;
const eventPath = process.env.GITHUB_EVENT_PATH;
if (eventPath) {
  try {
    const event = JSON.parse(readFileSync(eventPath, 'utf8'));
    prNumber = event.pull_request?.number ?? event.number;
  } catch {
    // ignora e tenta o env abaixo
  }
}
if (!prNumber) prNumber = Number(process.env.PR_NUMBER);
if (!prNumber) {
  console.error('[qa-review] Não foi possível determinar o número do PR.');
  process.exit(1);
}

function gh(args) {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

// Pega o diff do PR.
let diff;
try {
  diff = gh(['pr', 'diff', String(prNumber), '--repo', REPO]);
} catch (error) {
  console.error('[qa-review] Falha ao obter diff do PR:', error.message);
  process.exit(1);
}

if (!diff.trim()) {
  console.error('[qa-review] Diff vazio, não há o que revisar.');
  process.exit(0);
}

// Monta o prompt de review em português do Brasil.
const systemPrompt = `
Você é um engenheiro de QA sênior revisando um pull request.
Analise o diff a seguir e produza um review em markdown, em português do Brasil, com:
1. Resumo do que mudou (em até 4 bullets).
2. Pontos de atenção (bugs, regressões, segurança, performance).
3. Sugestões concretas de melhoria (code style, testes, documentação).
4. Veredito final: APROVAR / APROVAR COM RESSALVAS / SOLICITAR ALTERAÇÕES.

Seja conciso, objetivo e direto ao ponto. Não invente funções que não existam no diff.
Se o diff for inofensivo (docs, tipagem, formatação), diga que está OK.
`.trim();

const userPrompt = `
REPO: ${REPO}
PR: #${prNumber}

DIFF:
\`\`\`diff
${diff}
\`\`\`
`.trim();

// Chama a OpenRouter para gerar o review.
let review;
try {
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1200,
      temperature: 0.3,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    }),
    signal: AbortSignal.timeout(120000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    console.error(`[qa-review] OpenRouter HTTP ${response.status}: ${text}`);
    process.exit(1);
  }

  const data = await response.json();
  review = data?.choices?.[0]?.message?.content?.trim();
  if (!review) {
    console.error('[qa-review] OpenRouter devolveu conteúdo vazio.');
    process.exit(1);
  }
} catch (error) {
  console.error('[qa-review] Falha ao chamar a OpenRouter:', error.message);
  process.exit(1);
}

// Posta o comentário no PR via gh (usa o token do keychain do SO).
try {
  gh(['pr', 'comment', String(prNumber), '--repo', REPO, '--body', review]);
  console.log(`[qa-review] Comentário postado no PR #${prNumber}.`);
} catch (error) {
  console.error('[qa-review] Falha ao postar comentário:', error.message);
  process.exit(1);
}
