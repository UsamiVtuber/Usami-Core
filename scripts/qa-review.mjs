#!/usr/bin/env node
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
