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
 ├─ GET/POST /api/personality → traços (0–100) e instruções extras; `data/personality.json`
 └─ GET /api/learning + POST /api/learning/verdict → memória de aprendizagem
        │
        ├─ data/memory.json            memória e afinidade (v2: fatos por seção, recentes, resumos)
        ├─ data/vault-index.sqlite     índice FTS5 do vault Inbox/Responses (derivado, descartável)
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

## Domínio agêntico (em construção)

O USAMI 2.0 adiciona um domínio operacional **ao lado** do caminho ativo, em
`src/agent-*.js` e no namespace `/api/agent/*`. Os contratos puros vivem em
`src/agent-contracts.js` (Intent, Plan/PlanStep, ToolSpec, SkillManifest,
PermissionLevel 1–4 e ExecutionRecord). As rotas publicadas hoje são as da
memória operacional, das ferramentas, das permissões, dos planos de tarefas e
do catálogo de skills; instalação de skills e confirmações de UI ainda não
estão publicadas.

`/api/plan` continua sendo o planner de **animação**; plano de tarefas mora em
`/api/agent/plans` (S6). O caminho de produção (`createChatHandler`) e o
contrato do chat não mudam.

A memória operacional (projetos, tarefas e compromissos) vive em
`data/operational-memory.json` (`src/operational-memory-store.js`) e é exposta
por `GET/POST/PATCH /api/agent/memory*`, sempre com `x-usami-token`. É separada
de `memory.json`, que continua sendo a memória semântica do chat.

Ferramentas rodam pelo `src/tool-registry.js` (ToolSpecs validados por
`agent-contracts.js`, descoberta por nome e validação de argumentos) e pelo
`src/tool-executor.js` (timeout, captura de erro e histórico). A única
ferramenta publicada é `memory.search` (somente leitura, sobre o `memory-store`;
o vault fica de fora por privacidade). `POST /api/agent/tools/:name/execute`
executa e `GET /api/agent/executions` lê o histórico, ambos com
`x-usami-token`. O sucesso só é reportado quando `verify(result)` aprova; cada
tentativa executada vira um `ExecutionRecord` em `data/executions.json`
(append-only, teto de 500, sem copiar os argumentos — só os nomes e, em falha,
a mensagem de erro da ferramenta).
Ferramenta desconhecida ou argumento inválido não executam nem gravam.

Permissões ficam no `src/permission-gate.js`. Revogação por ferramenta ou
integração (`namespace.*`) é durável em `data/permissions.json` e vence
qualquer outro estado; arquivo inválido falha fechado (execuções negadas e
escritas recusadas). Ferramenta de nível 4 exige confirmação humana de uso
único: `POST /api/agent/confirmations` só emite o token com a palavra escrita
`CONFIRMAR` no corpo, o token vale 120 s, fica só em memória e é consumido na
execução — argumento inválido não queima a confirmação. Negação vira
`ExecutionRecord` com status `denied` e motivo no histórico, sem executar a
ferramenta. `GET/POST /api/agent/permissions` lista, revoga e restaura escopos.
O executor consulta o gate; a política mora nele, não no executor.

O Planner Engine de tarefas fica em `src/task-planner.js` e é distinto do
planner de animação. O núcleo é determinístico: `generatePlan` é injetável e o
default não usa rede (LLM só por adapter). Um objetivo vira plano com passos,
dependências, esforço e prioridade; acima do limiar de passos
(`USAMI_PLAN_BRIEFING_THRESHOLD`, padrão 4) o plano ganha briefing com
`summary`, `missingInfo` e `risks`. Cada plano vive em
`data/plans/<pl-id>.json` com todas as versões: replanejar acrescenta versão e
progresso edita a corrente. `POST/GET /api/agent/plans`,
`GET /api/agent/plans/:id` e `PATCH /api/agent/plans/:id` exigem
`x-usami-token`; planejamento não entra no caminho crítico do chat. Arquivo de
plano inválido deixa só aquele plano indisponível, sem derrubar os demais.

O catálogo de Skills fica em `src/skill-catalog.js` e é somente leitura. Cada
skill é um diretório `data/skills/<id>/` com `skill.json` validado por
`validateSkillManifest`; o diretório ausente começa vazio e nunca é criado pelo
loader. O código da skill não é importado — só o manifesto é lido, com teto de
64 KiB. Ativação é derivada, não persistida: exige `state: installed`, todas as
ferramentas declaradas no `tool-registry` e todas as dependências presentes,
válidas e instaladas (sem ativação recursiva). Manifesto inválido, id divergente
do diretório ou arquivo ausente aparecem na listagem com `valid:false` e os
erros, sem afetar as demais skills. `GET /api/agent/skills` e
`GET /api/agent/skills/:id` exigem `x-usami-token` e recarregam o diretório a
cada consulta; a resposta traz `activation.canActivate`, os motivos e o que
falta (`missing.tools`/`missing.dependencies`).

O ciclo de instalação e ativação (S8) fica em `src/skill-manager.js`, usando
apenas pacotes já validados pelo dev em `data/skills/<id>/` (sem código enviado
pelo modelo): `POST /api/agent/skills/proposals` registra benefício, riscos,
dependências e permissões em `data/skill-proposals.json` e coloca a skill em
`pending`; `POST /api/agent/confirmations` (com `skill` e `confirm: CONFIRMAR`)
emite o token de uso único no `permission-gate`; e `POST /api/agent/skills/:id/install`
consome o token e roda `node --test` em diretório temporário isolado (`cwd`
temporário, `--permission` sem acesso a `data/` real nem segredos, timeout e
rede bloqueada). Teste aprovado promove `pending` → `installed`; falha ou timeout
mantém a skill `disabled` sem apagar arquivos. `POST /api/agent/skills/:id/disable`
e `POST /api/agent/skills/:id/enable` alternam `installed`/`disabled` preservando
os arquivos, exigindo autorização prévia e novo passe do teste isolado ao
reativar. `GET /api/agent/skills/proposals` e `GET /api/agent/skills/proposals/:id`
listam e consultam propostas, todos sob `x-usami-token`.

O roteamento de intenção e orquestração do Usami Core (S9) fica em
`src/agent-core.js`. O classificador determinístico roda primeiro (`conversation`,
`operational` ou `complex`) e aceita `classifyWithLlm` injetável apenas para
casos ambíguos, respeitando `USAMI_TURN_DEADLINE_MS` e caindo em `conversation`
se falhar. Pedidos operacionais vão para o `tool-executor` (ou retornam
`no_matching_tool` sem inventar ferramenta) e tarefas complexas vão para o
`task-planner` com briefing. `POST /api/agent/turn`, `GET /api/agent/turns` e
`GET /api/agent/turns/:id` exigem `x-usami-token`; no `/api/chat`, `createChatHandler`
permanece intacto (persona, hedge e latência do balão preservados): conversas
normais saem idênticas, enquanto pedidos operacionais/complexos disparam em
fire-and-forget pós-resposta e devolvem o campo opcional `agentTurn`.

A primeira skill operacional da Fase A é o **Personal Planner** (S10), versionado
em `skills/personal-planner/` (`skill.json`, `planner-core.mjs` e teste isolado
próprio) e ligado ao runtime em `src/personal-planner-skill.js`. No startup do
servidor, `publishPersonalPlannerSkill` copia o pacote para
`data/skills/personal-planner/` se ausente (sem tocar `data/` nos testes) e
registra as ferramentas `planner.upsert_task` (nível 2), `planner.prioritize`
(nível 2) e `planner.schedule` (nível 3), todas com `verify()`. A skill consome
exclusivamente `operational-memory-store` (S3) e `task-planner` (S6) via
`tool-executor` (S4) e `permission-gate` (S5), priorizando pendências e
apontando conflitos de horário; pedidos de organização semanal no `agent-core`
acionam `planner.schedule` quando a skill está ativa.

A **Self-Introspection somente leitura** (S11) fica em `src/self-introspection.js`,
construindo o retrato de módulos (`src/`), ferramentas reais (`tool-registry`),
skills (`skill-catalog`), versão (`package.json`), erros recentes sem stack ou
credenciais (`tool-executor` / `permission-gate`) e limitações explícitas usando
apenas fontes em allowlist (`package.json`, `docs/*.md` permitidos e `src/`; nunca
lê `.env`, `USAMI_KEYS_FILE` nem `vault/`). A ferramenta `self.describe` (nível 1)
e a rota `GET /api/agent/self` (atrás de `x-usami-token` + Host/Origin) devolvem
o retrato sem reutilizar o termo `capabilities`.

As **Sugestões proativas contextuais** (S12) vivem em
`src/proactive-suggestions.js` e conectam-se ao `proactive-engine.js` sem
alterar `proactive_say`. Quatro fontes injetáveis observam tarefa atrasada,
reunião próxima, projeto parado e lacuna de skill; `data/suggestions.json`
persiste o ciclo `suggested → planned → authorized → verified` (além de
`dismissed`) sob DND (`isQuietHours`), teto de 1 sugestão não respondida e
throttle escalado por relevância. As rotas `GET /api/agent/suggestions` e
`POST /api/agent/suggestions/:id/accept|dismiss` exigem token + Host/Origin;
aceitar cria e aprova um plano em `task-planner` sem executar ferramentas.

A skill operacional **Daily Briefing** (S13) vive em `skills/daily-briefing/` e
`src/daily-briefing-skill.js`. Seu manifesto declara permissão nível 1
(leitura local) e o teste isolado `test/daily-briefing.test.mjs`, expondo a
ferramenta `briefing.build` (também acionável pelo `agent-core`) e a rota
`GET /api/agent/briefing` com borda Host/Origin + token. Compromissos,
tarefas prioritárias, pendências (itens atrasados/bloqueados, planos ativos e
falhas recentes de execução) e projetos em andamento são montados de forma
determinística sem inventar dados na base vazia e sem ficar presos ao teto de
~220 caracteres do chat; redação por LLM entra apenas como adapter opcional e
injetável.

A **Central de Skills e Histórico de Execuções** (S14) foi entregue no cliente
nativo `usami-desktop/` (`src/agent_center.rs`, `src/api.rs`, `src/main.rs` via
`ActiveDrawer::Skills` e botão `#top-skills-btn`), consumindo
`GET /api/agent/skills`, `POST /api/agent/skills/:id/enable|disable` e
`GET /api/agent/executions?limit=50` com exclusividade entre drawers e sem
placeholders.

A **Central de Permissões, Confirmações e Sugestões/Briefing** (S15) estendeu o
mesmo drawer (`ActiveDrawer::Skills`) com as abas **Permissões**,
**Confirmações** e **Sugestões**, consumindo `GET /api/agent/self?focus=tools`,
`GET / POST /api/agent/permissions`, `GET /api/agent/skills/proposals`,
`POST /api/agent/confirmations`, `POST /api/agent/skills/:id/install`,
`GET /api/agent/plans`, `GET / POST /api/agent/suggestions` e
`GET /api/agent/briefing`, com armamento em 2 passos para confirmações de uso
único (sem expor tokens), respeito a DND (`23:30–08:30`) e throttle (`unansweredCount`),
e indicador discreto no botão `#top-skills-btn`.

## Módulos extraídos na auditoria de 2026-11-08

- `src/provider-parse.js` concentra limpeza/parse da resposta do provedor
  (`parseProviderRaw`, `sanitizeActions`, `stripLeakedJson`, `stripCodeFence`,
  `parseJsonLoosely`). `server.mjs`, `flow-services.js`, `llm-router.js` e
  `media-analyzer.js` importam daqui; o ciclo `server.mjs ↔ flow-services.js`
  foi cortado.
- `src/data-paths.js` é a fonte única de caminhos de dados: `dataDir()` lê
  `USAMI_DATA_DIR` a cada chamada (`process.env` pode mudar antes de instanciar
  handlers em teste), `dataPath()` compõe, e `ttsCacheDir()`/`sttTmpDir()`
  mantêm overrides específicos com prioridade.
- `src/n8n-queue.js` é a fila de comandos por cliente (`x-usami-client`):
  `poll` marca entregue sem reentregar, `acknowledge` remove só os ids
  confirmados daquele cliente, POST sem cliente faz fanout para clientes ativos
  (<60 s) ou fica pendente até o primeiro poll, entregue não confirmado é podado
  em 120 s com log. O limite de 50 comandos por cliente descarta o mais antigo.
- A borda de segurança (`src/api-security.js`) permanece o único ponto de
  entrada: toda rota `/api` passa por `isAllowedRequest`; escritas sensíveis
  exigem token. Rotas de leitura usadas pelo n8n (`/api/techniques`) ficam só
  com a borda de origem até existir uma credencial no Nyarch.

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
- Exigem o header `X-Usami-Token` igual a `USAMI_API_TOKEN` (env ou `.env` do projeto): `/api/memory*`, `/api/agent/memory*`, `/api/agent/executions`, `POST /api/agent/tools/*/execute`, `/api/agent/confirmations`, `/api/agent/permissions`, `/api/agent/plans*`, `/api/agent/skills*`, `/api/personality`, `/api/rag/context`; toda escrita sensível de `/api/technique` (inclui `note` e status ≠ `proposta`), `/api/plan`, `POST /api/learning/verdict`, `/api/stt`, `/api/media/analyze`, `/api/proactive/*` e `/api/n8n/command(s)` + `/ack`. Sem o token no servidor a resposta é 503 (fail-closed); token errado/ausente é 401. O proxy do Vite injeta o header em todo `/api` do navegador, então o token não chega ao bundle; o n8n precisa enviá-lo quando chamar rota tokenizada.
- Ficam só com a borda de Host/Origin (sem token): GETs de leitura usados pelo n8n (`/api/techniques`, `/api/technique?id`) e `GET /api/learning` — token neles exigiria credencial no Nyarch. O poll `GET /api/n8n/commands` **continua tokenizado** (é o frontend/proxy que o chama).
- O `.env` é `USAMI_KEYS_FILE` ou `../.env` relativo ao projeto; não há mais caminhos fixos de `A:\` nem fallback para outro projeto.
- Webhook para o n8n: com `N8N_WEBHOOK_SECRET` sai com `X-Usami-Timestamp` e `X-Usami-Signature` (`sha256=` + HMAC-SHA256 de `<timestamp>.<corpo>`); `N8N_WEBHOOK_OMIT_TEXT=true` remove `userMessage` e `reply`.

## Resiliência das chamadas ao LLM e ao TTS

- `src/nvidia-client.js`: rate limiter com fila FIFO (`maxQueue` 100, espera máxima 30 s; estourou → `UpstreamUnavailable` 503), retry de 429/408/5xx/timeout com backoff + jitter respeitando `Retry-After` (1 retry), circuit breaker (5 falhas seguidas abrem por 30 s; depois uma chamada de prova) e `signal` do chamador, que cancela sem repetir e sem contar como falha do provedor.
- Turno do chat: deadline total `USAMI_TURN_DEADLINE_MS` (40 s) e fatia da NVIDIA `USAMI_NVIDIA_BUDGET_MS` (25 s); o OpenRouter fica com o restante (mínimo 8 s), em vez de 45 s + 45 s. Cliente que fecha a conexão cancela a chamada ao provedor e o turno não é respondido nem gravado.
- A classificação que alimenta o webhook do n8n agora é local (determinística): não gasta chamada nem slot do limite de 40 req/min.
- `POST /api/tts`: semáforo no servidor (`src/semaphore.js`, uma síntese por vez, fila de 4, espera até `timeoutMs`; cheia → 429, esgotada → 503). Quem esperou confere o cache de novo, então a mesma frase pedida em paralelo sintetiza uma vez só (com cache ligado).
