# Diagnóstico 2026-11-17 — `test:unit` pendurado e QA Review mudo

Dois problemas independentes investigados após o PR #12. Nenhum dos dois era
causado pela memória episódica.

## 1. `npm run test:unit` não encerrava

**Sintoma.** Todos os testes passavam e o processo ficava vivo, sem sumário.

**Causa.** O worker Python persistente do faster-whisper (`src/stt.js`) existe
para manter o modelo quente em RAM, mas o `child` era criado com
`stdio: ['pipe','pipe','pipe']`. Esses pipes ficam ref'd no event loop, e o
único cleanup é `process.once('exit', stopActiveWorker)` — que nunca roda,
porque o processo nunca chega ao exit. Qualquer processo que faça uma
transcrição e não tenha outro handle aberto (teste, CLI) fica pendurado.

**Localização.** `tests/media-analyzer.test.mjs`, teste
`analyzeMedia para áudio transcreve fala e gera resposta`. Sozinho ele também
travava; o resto da suíte encerrava normalmente.

**Evidência.**

| comando | resultado |
|---|---|
| `timeout 90 npm run test:unit` (sem fix) | rc=124; 666 testes ok, processo vivo |
| `npm run test:unit` (com fix) | 666/666, fail 0, rc=0 em ~8,5 s |
| `node --test tests/media-analyzer.test.mjs` (com fix) | 8/8, rc=0 |

**Correção.** PR #13 (`fix/stt-worker-unref`), só `src/stt.js`: os pipes ficam
ref'd durante a requisição e voltam a unref quando a fila esvazia. O worker
continua quente entre transcrições.

## 2. QA Review não comentou no PR #12

`gh pr checks 12` → “no checks reported on the 'feat/episodic-memory' branch”.
Os runs recentes falhavam em 0 s, sem nenhum job criado.

**Causa A — workflow inválido.** `.github/workflows/qa-review.yml` está com a
chave `jobs:` duplicada (linha 15, job `qa-review`; linha 60, job `review`).
O merge `3e39c2e` juntou as duas versões do arquivo e o YAML passou a ter chave
repetida; o GitHub rejeita o arquivo inteiro, e o run morre com
“This run likely failed because of a workflow file issue” antes de qualquer
job existir. Isso vale para qualquer branch, `main` inclusive.

**Causa B — `gh` sem autenticação no runner.** Mesmo quando o arquivo era
válido, o review não chegaria ao comentário. No run 44134041024
(`feat/sleep-companion-mode`), o job chegou ao runner `luke`
(`self-hosted, linux, usami-notebook`) e falhou no passo
“Verifica gh autenticado como Usamiin”:

```
You are not logged into any GitHub hosts. To log in, run: gh auth login
```

Os passos seguintes foram pulados, então nem o `scripts/qa-review.mjs` rodou.

**Pendências.**

- Remover o bloco `jobs:` duplicado (manter o job `qa-review`; o job `review`
  é uma cópia antiga, roda `cd usami` e usa `OPENROUTER_API_KEY`).
- Autenticar o `gh` no runner (`gh auth login` com o usuário do bot) — ação
  manual no notebook, não é feita por CI.
