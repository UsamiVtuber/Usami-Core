# USAMI 2.0 — mapa da arquitetura atual e ordem de implementação

**Status:** S1 — auditoria somente leitura concluída em 2026-11-11, para revisão.
**Fonte da proposta:** [`.agent/plan-usami-2.0.json`](../.agent/plan-usami-2.0.json) (15 stories, S1–S15).
**Escopo:** runtime em `usami/`. Integrações externas e skills das Fases B–D ficam para a Fase 3.
**Método:** leitura de `server.mjs`, `src/`, `tests/`, `docs/` e manifests; nenhum arquivo de runtime foi alterado. `data/`, `vault/` e `.env` não foram lidos.

---

## 1. Resumo executivo

O runtime atual é maduro como **companion**: avatar VRM, voz (Gemini TTS + STT), persona, vínculo, memória semântica e episódica, RAG do vault, proatividade por inatividade e uma borda de segurança fechada. Ele **não é agêntico**: não existe camada operacional.

| Lacuna central | Estado |
|---|---|
| Roteamento de intenção (conversa × operacional × tarefa complexa) | Inexistente; `/api/chat` faz um único turno de persona |
| Planner de tarefas | Inexistente; `/api/plan` é o planner **de animação** |
| Memória operacional (projetos, tarefas, compromissos) | Inexistente |
| Tool Executor (registro, validação, verificação, histórico) | Inexistente |
| Skill Manager (manifesto, catálogo, proposta, instalação) | Inexistente |
| Self-Introspection | Inexistente; `capability-manifest.js` descreve só o avatar |
| Permissões em 4 níveis, confirmação de uso único, revogação | Só borda Host/Origin + token compartilhado |
| Sugestões proativas contextuais | Só idle/DND/afinidade + fila de eventos |
| UI de Skills, execuções, permissões e briefings | Inexistente |

A construção pode ser feita **ao lado** do caminho ativo, sem trocar `createChatHandler` e sem reutilizar `/api/plan`. O namespace novo é `/api/agent/*`.

---

## 2. Runtime atual

### 2.1 Fronteiras

- `Usami-Core` é o runtime local de referência: interface, avatar, API e módulos de companion vivem juntos enquanto os contratos evoluem (`docs/architecture.md:3-14`).
- O navegador fala com o Node via proxy do Vite (`vite.config.mjs:22-25`); a API escuta em `127.0.0.1:8787` (`src/api-security.js:6`).
- `createChatHandler()` é o caminho ativo de produção (`server.mjs:475`, instanciado em `server.mjs:2637`). `FlowExecutor`/`createFlowChatHandler()` são experimentais (`server.mjs:900`, `docs/architecture.md:80-85`).
- O n8n fica no Nyarch e recebe o webhook `usami.response`; ele não emite movimento nem muda `status` de técnica (`docs/architecture.md:108-146`).

### 2.2 Superfície HTTP

O despacho é **exato por URL** (`server.mjs:2651-2679`); só quatro rotas aceitam query string via `startsWith`. Rota desconhecida retorna 404 JSON (`server.mjs:2677`).

| Domínio | Rotas | Auth | Persistência | Evidência |
|---|---|---|---|---|
| Chat | `POST /api/chat` | Host/Origin | `memory.json`, índice do vault | `server.mjs:2659`, `475-519` |
| Voz | `POST /api/tts`, `POST /api/stt` | tts: origem; stt: origem + token | cache TTS, tmp de STT | `server.mjs:2661-2662` |
| Memória | `GET /api/memory`, `POST /api/memory/forget` | origem + token; forget exige `APAGAR` | `memory.json` | `server.mjs:2668`, `1201-1290` |
| Vínculo | `GET /api/bond`, `POST /api/bond/event\|import\|reset` | origem + token; reset exige `APAGAR` | `bond.json`, `achievements.json` | `server.mjs:2669`, `1297-1385` |
| Personalidade | `GET/POST /api/personality` | origem + token | `personality.json` | `server.mjs:2671` |
| Conquistas | `GET /api/achievements` | origem + token | `achievements.json` | `server.mjs:2670` |
| RAG | `GET /api/rag/context` | origem + token | leitura do vault | `server.mjs:2667` |
| Técnicas | `GET /api/technique[s]`, `POST /api/technique`, `POST /api/technique/note` | GET: origem; POST: token, exceto `status: proposta` | `techniques/*.json`, índice, nota no vault | `server.mjs:2672-2673`, `2134-2290` |
| Animação | `POST /api/plan`, `GET /api/learning`, `POST /api/learning/verdict` | plan/verdict: token; learning: origem | `learning.json`, técnicas | `server.mjs:2674-2675` |
| Proativo | `GET/POST /api/proactive/events`, `POST .../ack`, `POST /api/proactive/trigger`, `GET /api/proactive/state` | origem + token | `proactive-events.json` | `server.mjs:2676` |
| n8n | `POST/GET/DELETE /api/n8n/commands`, `POST .../ack` | origem + token | fila em memória | `server.mjs:2663-2666` |
| Mídia | `POST /api/media/analyze` | origem + token | `memory.json` | `server.mjs:2660` |
| Estáticos | `/models/*`, `/animations/*`, `/live2d/*` | nenhuma | `public/` | `server.mjs:2653-2657` |

### 2.3 Padrão de handler

Todo handler segue `createXHandler({ deps })` e recebe store, token e dependências por injeção — p.ex. `createMemoryHandler({ allowedOrigins, memoryStore })` (`server.mjs:1201-1203`) e `createBondHandler({ allowedOrigins, bondStore, achievementsStore })` (`server.mjs:1297-1302`). O token vem de `options.apiToken`; quando o servidor não tem token, a rota tokenizada falha fechada com 503 (`src/api-security.js:70-76`).

Esse é o único formato seguro de inserção no `server.mjs` (2.682 linhas, 122 KB).

### 2.4 Módulos por domínio

| Domínio | Módulos principais | Contrato relevante |
|---|---|---|
| Chat/persona/LLM | `persona.js`, `llm-router.js`, `provider-parse.js`, `nvidia-client.js`, `reply-parts.js`, `streaming-parser.js` | `{ reply, gesture, actions, remember }`; teto de ~220 caracteres; `chatJson` |
| Memória/RAG | `memory-store.js`, `memory-summaries.js`, `vault-index.js`, `rag.js`, `conversation-storage.js` | 6 seções fixas; resumos diários; FTS5 do `Inbox/Responses` |
| Vínculo/personalidade | `bond-core.js`, `bond-store.js`, `personality-store.js`, `achievements-store.js` | Regras puras no core; store no servidor |
| Animação/avatar | `motion-director.js`, `motion-sequence.js`, `vrma-manager.js`, `vrm-gesture-layer.js`, `capability-manifest.js` | Verbos do diretor; manifesto só do avatar |
| Proatividade | `proactive-engine.js`, `proactive-events.js` | Idle/DND/afinidade; fila de eventos com quota |
| Segurança | `api-security.js` | Host/Origin allowlist + token + HMAC do webhook |
| Flow (experimental) | `flow-executor.js`, `flow-domain.js`, `flow-services.js`, `flow-nodes.js` | Grafo testado, não usado em produção |
| UI | `Usami.jsx`, `BondPanel.jsx`, `PersonalityPanel.jsx`, `voice-ui.jsx` | Abas Conversa, Voz, Avatar, Memória, Jeito, Sobre |

### 2.5 Persistência

| Arquivo | Dono | Natureza |
|---|---|---|
| `data/memory.json` | `memory-store.js` | Fonte da verdade (fatos + histórico + resumos + afinidade) |
| `data/bond.json` | `bond-store.js` | Fonte da verdade |
| `data/personality.json` | `personality-store.js` | Fonte da verdade |
| `data/achievements.json` | `achievements-store.js` | Derivado do vínculo, com timestamps |
| `data/proactive-events.json` | `proactive-events.js` | Fonte da verdade (quotas/tombstones) |
| `data/techniques/*.json` | `technique-store.js` | Fonte da verdade |
| `data/learning.json` | `learning-memory.js` | Fonte da verdade (tentativas/vereditos) |
| `data/techniques-index.sqlite` | `technique-index.js` | Derivado, descartável |
| `data/vault-index.sqlite` | `vault-index.js` | Derivado do vault |
| `data/tts-cache/`, `data/tmp/` | `tts-cache.js`, `stt.js` | Derivado/efêmero |
| `data/experiments.json` | `motion-experiments.js` | Log de execuções, reconstruível |
| **Operacional** | — | **Não existe** |
| Conversa | `conversation-storage.js` | `localStorage` do navegador, não é `data/` |

### 2.6 Testes e scripts

- 88 arquivos em `tests/`, 81 referenciados por `package.json`; 7 estão fora dos scripts: `facs-apply`, `facs-classifier`, `vowel-driver`, `speech-timing`, `proactive-events`, `proactive-server`, `vrm-bone-calibration`.
- Grupos: `test:unit`, `test:chat`, `test:technique`, `test:planner` (animação), `test:ingest`, `test:sites`.
- Regra de isolamento: testes injetam stores e apontam `USAMI_DATA_DIR` para `mkdtemp` (`tests/chat-server.test.mjs:16-23`, `tests/memory-server.test.mjs:10-12`). Qualquer store novo que importe o caminho padrão de `data/` reabre a poluição descrita em `AGENTS.md:94-96`.

---

## 3. Componentes propostos × estado atual

| Componente | Hoje | Falta | Evidência |
|---|---|---|---|
| **Usami Core** | Um turno de persona por `/api/chat`; classificação só de emoção para o webhook | Classificador conversa/operacional/complexo, orquestração e estado de turno | `server.mjs:475,538,702-706`; `flow-domain.js:191-229` |
| **Planner Engine** | Planner de animação determinístico (`wave/greet/idle/custom`) | Decomposição de tarefas, dependências, briefing, versões, replanejamento | `animation-planner.js:1-45`; `server.mjs:2336-2386` |
| **Memória de curto prazo** | Transcrição no navegador + histórico do dia no prompt | Camada server-side entre dispositivos | `conversation-storage.js:5-50`; `memory-store.js:174-177` |
| **Memória episódica** | Histórico diário + resumos (LLM ou determinístico) | Busca/recuperação estruturada de episódios | `memory-summaries.js:26-35`; `server.mjs:847-855` |
| **Memória semântica** | Fatos em 6 seções + índice FTS do vault | Consolidação de fatos (Fase 2 segue pendente) | `memory-store.js:25,321-360`; `vault-index.js:69` |
| **Memória operacional** | Ausente | Projetos, tarefas, compromissos, status, `dueAt`, trilha | busca por `operational` não encontra store |
| **Memória de preferências** | Traços 0–100 + instruções extras + seção `preferences` | Serviço consultável unificado | `personality-store.js:18-102`; `memory-store.js:25` |
| **Tool Executor** | Execução interna de grafo (`executeFlow`) | Registro, validação, timeout, `verify()`, histórico | `flow-nodes.js:97-119`; sem registry |
| **Skill Manager** | Catálogo de técnicas validado (padrão de schema/store) | Manifesto, estados, proposta, instalação, testes isolados | `technique-schema.js`; `technique-store.js:37` |
| **Self-Introspection** | Manifesto do avatar (malhas, ossos, morphs, clipes) | Retrato de módulos, ferramentas, skills, configs e limitações | `capability-manifest.js:6-81` |
| **Proatividade** | Idle 3 min, DND 23:30–08:30, afinidade ≥ 20, eventos com quota | Fontes contextuais, ciclo sugestão→execução, persistência de sugestões | `proactive-engine.js:14-104,203-380` |
| **Permissões** | Host/Origin + token compartilhado + confirmação escrita | 4 níveis, escopo por ferramenta, token de uso único, revogação, auditoria | `api-security.js:56-77`; `server.mjs:317-321` |
| **UI operacional** | Abas de configuração, histórico e BondPanel exclusivos | Skills, execuções, permissões, confirmações, sugestões, briefing | `Usami.jsx:845-847,2072-2081` |
| **Integrações externas** | Nenhuma | Agenda, e-mail, finanças, documentos | busca não encontra código de integração |

---

## 4. Contratos a preservar

1. **`createChatHandler` é produção.** Não trocar por `FlowExecutor` só porque os testes passam (`docs/architecture.md:80-85`).
2. **Despacho por URL exata.** `/api/agent/*` precisa ser adicionado explicitamente no despacho; o curinga de hoje só cobre `/api/proactive/`.
3. **Borda em duas camadas.** Toda rota passa por `isAllowedRequest`; escritas sensíveis exigem `x-usami-token`. Sem token no servidor, a rota tokenizada responde 503 (fail-closed).
4. **Não relaxar a exceção de `status: proposta`.** Ela sustenta o fluxo de ingestão humana de técnicas.
5. **Stores injetados + `USAMI_DATA_DIR`.** Nenhum módulo novo deve importar o caminho padrão de `data/` em teste.
6. **`/api/plan` continua sendo animação.** O planner de tarefas vive em `/api/agent/plans`.
7. **Contrato do chat não muda.** `{ reply, gesture, actions, remember }`, teto de ~220 caracteres, deadline de 40 s, fatia NVIDIA de 25 s e hedge de 7 s. Trabalho agêntico não entra no caminho crítico do balão.
8. **`/api/memory` é memória semântica.** Memória operacional é store e rotas separados.
9. **Proatividade existente não é duplicada.** `proactive_say`, quotas, tombstones e DND continuam; sugestões são um ciclo novo por cima.
10. **Paleta oficial e drawers exclusivos.** Deep Blue/Charcoal/Ice/Pink/Rose; abrir um painel fecha os demais (D1/D4 de `AGENTS.md:78-85`).
11. **Fila n8n é at-most-once e em memória.** Não transformar em barramento do agente sem decisão explícita (`AGENTS.md:87-92`).
12. **Token do navegador vem do proxy do Vite.** A UI usa `apiFetch`; token não entra no bundle.

---

## 5. Colisões de nome e vocabulário

| Termo | Hoje | Uso novo | Regra |
|---|---|---|---|
| `plan` | Planner de animação (`/api/plan`, `animation-planner.js`) | Plano de tarefas | Rotas `/api/agent/plans`; módulo `task-planner.js` |
| `planner` | Técnica de animação | Orquestração de tarefas | Nunca chamar o novo módulo de `planner.js` |
| `memory` | `/api/memory` = fatos semânticos | Camada operacional | Store/rotas `/api/agent/memory/*` |
| `proactive` | Idle/DND/eventos com quotas | Sugestões contextuais | Reutilizar engine, mas `suggestions` é ciclo separado |
| `capabilities` | Manifesto do avatar | Ferramentas do sistema | Self-Introspection não reutiliza esse nome |
| `technique` | Conhecimento de animação validado | Skill operacional | Skill tem manifesto e estados próprios |
| `agent` | Não existe | Domínio novo | Namespace `/api/agent/*` |

---

## 6. Skills priorizadas: viabilidade e waves

O §5 do briefing lista **10 skills**.

| Skill | Dependência | Viabilidade agora | Wave / story |
|---|---|---|---|
| Personal Planner | Memória operacional + Planner + Tool Executor | Local | Wave 2 / S10 |
| Daily Briefing | Memória operacional + planos + execuções | Local | Wave 3 / S13 |
| Calendar Manager | Provedor + OAuth + leitura/escrita de agenda | Externa não verificada | Fase 3 |
| Email Assistant | Provedor + OAuth + envio autorizado | Externa não verificada | Fase 3 |
| Finance Observer | Provedor/agregador + leitura somente | Externa não verificada | Fase 3 |
| Research Agent | RAG local + ferramenta de busca web | Parcial (falta busca web) | Fase 3 |
| Study Companion | LLM + memória + planos | Local | Fase 3 |
| Document Creator | Escrita de arquivos + permissão de workspace | Local, mas exige política de escrita | Fase 3 |
| Code Inspector | Self-Introspection + allowlist de arquivos | Local, somente leitura | Fase 3 |
| Skill Architect | Skill Manager (S8) | Local, depende do fluxo de propostas | Fase 3 |

---

## 7. Riscos e dependências

1. **Monolito `server.mjs` (2.682 linhas).** Novas rotas inline pioram a auditabilidade; extrair handlers para `src/agent-*.js` no padrão `createXHandler`.
2. **Orçamento de latência do turno.** Planner e ferramentas não podem bloquear o balão; usar rota própria ou pós-resposta.
3. **Isolamento de testes.** Todo store novo precisa de injeção e `USAMI_DATA_DIR`; `npm test` não pode tocar `data/` real.
4. **Token fail-closed.** Rotas novas tokenizadas exigem seam de injeção para os testes que rodam sem `USAMI_API_TOKEN`.
5. **Estado proativo em memória.** `unansweredCount` e timers resetam no restart; sugestões precisam de persistência para não duplicar.
6. **Sandbox de Skill não existe.** O S8 pressupõe runner isolado com cwd temporário e timeout; hoje não há precedente em `scripts/` nem `tests/`.
7. **Integrações externas não verificadas.** Nenhum provedor de agenda/e-mail/finanças foi escolhido; não presumir SDK, OAuth ou escopo.
8. **Token da UI.** Painéis novos devem passar pelo proxy do Vite; `fetch` direto com token quebraria a decisão D2.
9. **Deriva de documentação.** `docs/architecture.md:26` lista `POST /api/ingest`, que não existe no despacho do `server.mjs`. Corrigir fora do S1.
10. **Testes fora dos scripts.** Sete suítes não rodam em `npm test`; relevante para proatividade e FACS.
11. **`createFlowChatHandler` não é injetável** (lê `flowExecutor` de módulo, `server.mjs:900-942`). Não usar como base do Core.

---

## 8. Ordem de implementação

| Wave | Stories | Entrega |
|---|---|---|
| 0 — Fundação | S1, S2 | Mapa aprovado + contratos puros do domínio |
| 1 — Operação | S3, S4, S5 | Memória operacional, Tool Executor, permissões/confirmações |
| 2 — Inteligência | S6, S7, S8, S9, S10 | Planner de tarefas, catálogo de Skills, instalação, Core, Personal Planner |
| 3 — Evolução | S11, S12, S13, S14, S15 | Self-Introspection, sugestões, Daily Briefing, UI de Skills/execuções e permissões |

Dependências: S2 → (S3, S4, S6, S7); S4 → S5; (S6, S8, S3) → S10; (S4, S6) → S9; (S9, S10) → S12; (S7, S8, S4) → S14; (S5, S12, S13) → S15.

Mapeamento dos critérios do §10: 1–2 (S6/S9), 3 (S4/S9), 4 (S11), 5 (S7), 6–7 (S8/S5), 8–9 (S4/S5/S10), 10–11 (S3/S10/S13), 12 (S12/S13).

---

## 9. Critérios de aceite por componente

| Componente | Considera pronto quando | Stories |
|---|---|---|
| Contratos | Intent/Plan/Tool/Skill/Permission validados e rejeitam entrada inválida | S2 |
| Memória operacional | CRUD com origem, data, relevância e trilha; testes isolados | S3 |
| Tool Executor | Ferramenta registrada, validada, executada com timeout e `verify()`; histórico | S4 |
| Permissões | Nível 4 exige confirmação de uso único; revogação e auditoria funcionam | S5 |
| Planner de tarefas | Objetivo vira plano com dependências, briefing e replanejamento | S6 |
| Catálogo de Skills | Manifesto válido lista skill por estado e explica lacunas | S7 |
| Instalação de Skill | Proposta só ativa após autorização + teste isolado | S8 |
| Usami Core | Conversa intacta; operacional gera execução/plano rastreável | S9 |
| Personal Planner | Cronograma com conflitos e tarefas persistidas | S10 |
| Self-Introspection | Lista módulos/ferramentas/skills reais sem expor segredo | S11 |
| Proatividade | Sugestão única por contexto, com aceite → plano autorizado | S12 |
| Daily Briefing | Briefing só com dados reais, inclusive base vazia | S13 |
| UI de Skills/execuções | Skills por estado e histórico real, sem placeholders | S14 |
| UI de permissões | Autorizar, ver execução e revogar pela interface | S15 |

---

## 10. Fora de escopo (Fase 3)

- Calendar Manager, Email Assistant, Finance Observer e Research Agent com provedores externos.
- Study Companion, Document Creator, Code Inspector e Skill Architect como skills instaláveis.
- Extração de contratos para os repositórios `Usami-backend`/`Usami-contracts`.
- Exposição da API local ao Nyarch (decisão de rede pendente).

---

## 11. Observações

- `npm run test:planner` refere-se ao planner de **animação**, não ao de tarefas.
- A paleta oficial e a exclusividade de drawers continuam valendo para qualquer tela nova.
