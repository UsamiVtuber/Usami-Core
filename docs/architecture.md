# Usami Core — arquitetura atual

## Papel dos repositórios

`Usami-Core` é o runtime local de referência: interface, avatar, API e módulos
de companion vivem aqui enquanto os contratos entre serviços ainda evoluem.

- `Usami-frontend`: fatias isoladas de interface e avatar.
- `Usami-AI`: módulos puros de persona, memória e afinidade.
- `Usami-Backend`: API HTTP estável; ainda não recebe o fluxo experimental.
- `Usami-Contracts`: contratos compartilhados quando uma fronteira estiver
  estável o suficiente para ser extraída.

O repositório público `Usami` é somente o showcase; não é a fonte do runtime.

## Runtime local

```text
Browser (Vite :5173 ou preview :4173)
        │ /api proxy
        ▼
Node API (127.0.0.1:8787)
 ├─ POST /api/chat → OpenRouter
 ├─ POST /api/tts  → Gemini TTS, com fallback ElevenLabs
 ├─ POST /api/stt  → faster-whisper local (Python)
 ├─ POST /api/ingest → pipeline Python de ficha de tutorial (FFmpeg + Whisper)
 ├─ GET/POST /api/technique[s] + /api/technique/note → base de técnicas
 ├─ POST /api/plan → planner de animação (determinístico, sem LLM)
 ├─ GET/POST /api/memory + POST /api/memory/forget → memória v2 (seções, exclusão com confirmação)
 └─ GET /api/learning + POST /api/learning/verdict → memória de aprendizagem
        │
        ├─ data/memory.json            memória e afinidade (v2: fatos por seção, recentes, resumos)
        ├─ data/techniques/*.json      técnicas validadas (fonte da verdade)
        ├─ data/techniques-index.sqlite  índice derivado, descartável
        ├─ data/learning.json            histórico de tentativas por técnica
        ├─ data/experiments.json         medidas do motor de experimentação
        ├─ data/ingest/src-*/            fichas ingeridas (não versionadas)
        └─ data/tts-cache/               cache de áudio local
```

Chaves ficam fora do Git, em um arquivo apontado por `USAMI_KEYS_FILE` ou nos
locais configurados pelo servidor. `data/`, modelos 3D e assets Live2D também
não são versionados.

## Estado confirmado em 25 de outubro de 2026

- `npm test` passou com 459 testes (421 em Node + 38 em Python) e o build gerou
  o pacote de Sites.
- Uma chamada real para `/api/chat` retornou HTTP 200.
- Uma chamada real para `/api/tts` retornou um WAV válido (`RIFF`) via o
  provedor configurado.
- `faster_whisper` pode ser importado pelo Python local; uma transcrição real
  ainda precisa de captura de áudio pelo navegador.
- O ciclo ingestão → técnica → índice → planner → aprendizagem foi exercitado
  com dados reais (uma ficha, `tc-9fe76b5b8d9e`); a seleção do planner ainda
  depende de aprovação humana da técnica, e o veredito visual continua manual.

## Subsistema de animação autônoma

Movimento nunca vem de LLM: o único vocabulário aceito são os shapes
paramétricos e os clipes do VRM, orquestrados por contrato de sequências
validado antes de executar. A pipeline de conhecimento (tutorial → ficha →
técnica → experimentos → planner) está em
[`docs/animation-learning.md`](animation-learning.md); o que precisa ficar
aqui é a fronteira:

- `data/techniques/*.json` é a fonte da verdade. O índice SQLite é derivado e
  pode ser apagado a qualquer momento — nunca é autoridade.
- Só técnica com `status: "validada"` alimenta o planner. `proposta` fica
  indexada e revisável, mas nunca vira movimento.
- `data/learning.json` é a memória de aprendizagem, separada de
  `data/memory.json`. Métrica objetiva não substitui veredito humano; ela o
  pondera.
- O n8n só lê e agenda (revisão de propostas, notas no vault). Ele não emite
  movimento nem muda `status` de técnica.

## Fronteira de fluxo

`createChatHandler()` é o caminho ativo de produção local. Ele preserva
persona, memória e afinidade. `FlowExecutor` e `createFlowChatHandler()` estão
cobertos por testes, mas continuam experimentais até terem a mesma paridade
operacional do handler ativo. Não trocar a rota de produção por ele apenas
porque os testes unitários passam.

## Integração Nyarch via SSH

O projeto opera em ambiente híbrido Windows + Nyarch Linux, com comunicação via
SSH tunnel. O n8n roda remotamente no Nyarch via Docker/SSH.

### Túnel SSH

Para acessar o n8n (porta 5678) do Windows:

```bash
ssh -N -L 5678:127.0.0.1:5678 luke@10.42.0.1
```

- `-N`: apenas encaminha portas, sem executar comando remoto
- `-L 5678:127.0.0.1:5678`: túnel local → porta 5678 no Nyarch
- `luke@10.42.0.1`: usuário e IP do Nyarch Linux

Após estabelecer o túnel, o n8n fica acessível em `http://localhost:5678`.

Para o runtime, porém, o túnel não é o caminho: o `usami/server.mjs` publica o
evento `usami.response` direto em `http://10.42.0.1:5678/webhook/usami-events`
( valor de `N8N_WEBHOOK_URL` no `A:/Usami Project/.env`, lido na inicialização
porque nada popula `process.env` a partir desse arquivo). O serviço escuta em
`127.0.0.1:8787` — ou seja, o Nyarch **não** alcança a API da Usami; workflows
que precisem ler `/api/...` precisam de uma decisão de exposição antes de serem
publicados.

### Workflow Obsidian

O workflow **"Usami - Obsidian Inbox"** (`/workflow/NnWm0PoOh4IBjtQS`) recebe
eventos da Usami e salva notas no vault Obsidian. A integração deve escrever
somente em uma área explícita de automações, por exemplo `Inbox/Automations/`;
ele não deve receber acesso irrestrito ao vault nem a credenciais do runtime da
Usami.

Os exports versionados e a descrição de cada workflow (incluindo o agendado
"Usami - Revisao de Tecnicas", que só lê `/api/techniques` e produz nota de
revisão) estão em `../../infra/n8n-local/workflows/README.md` do workspace.
Nenhum deles é publicado nem ativado sem autorização explícita.

## Segurança de borda da API local

- `Host` e `Origin` passam por allowlist fechada (`src/api-security.js`): `127.0.0.1:8787`, `localhost:8787`, os hosts das origens do front e `USAMI_ALLOWED_HOSTS`. A regra antiga "Origin == Host" foi removida (DNS rebinding). Origens extras (LAN, `terminal.local`): `USAMI_ALLOWED_ORIGINS` e `USAMI_ALLOWED_HOSTS`, separadas por vírgula.
- `/api/memory*`, `/api/rag/context` e `/api/n8n/command(s)` exigem o header `X-Usami-Token` igual a `USAMI_API_TOKEN` (env ou `.env` do projeto). Sem o token no servidor a resposta é 503 (fail-closed). O proxy do Vite injeta o header, então o token não chega ao navegador; o n8n precisa enviá-lo.
- O `.env` é `USAMI_KEYS_FILE` ou `../.env` relativo ao projeto; não há mais caminhos fixos de `A:\` nem fallback para outro projeto.
- Webhook para o n8n: com `N8N_WEBHOOK_SECRET` sai com `X-Usami-Timestamp` e `X-Usami-Signature` (`sha256=` + HMAC-SHA256 de `<timestamp>.<corpo>`); `N8N_WEBHOOK_OMIT_TEXT=true` remove `userMessage` e `reply`.
