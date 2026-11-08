# Auditoria Multiagente Usami — 2026-11-08

Auditoria rigorosa de código-fonte e interface do runtime `usami/`, executada em três frentes paralelas sob supervisão do Agente Principal:

| Frente | Método | Entregável |
|---|---|---|
| Backend — Arquitetura, Desempenho, Segurança e Lógica | Agente especializado, leitura integral de `server.mjs` (2525 l.), 20+ módulos `src/`, `worker/index.js`, testes como evidência | Achados B1–B18 |
| Frontend — UI/UX, identidade visual, estados | Agente especializado, leitura integral de `usami.css` (1838 l.), `styles.css`, `Usami.jsx` (2259 l.), painéis e módulos de UX; contrastes calculados (WCAG) | Achados F1–F25 |
| Runtime visual | Agente Principal no navegador (app servido pelo Vite em `127.0.0.1:5173`, build corrente confirmado): load, console, rede, fluxo de chat completo, painéis, HUD idle | Achados R1–R9 + confirmações em runtime de F3, F6/F15, F8 |

Escopo: somente `usami/`. Fora do escopo: `usami-monitor/` e `infra/n8n-local/` (repos/stacks próprios), `vault/` (privado). Nenhuma alteração de código foi feita durante a auditoria. IDs preservam a origem do achado para rastreabilidade; F22–F25 vêm de uma segunda passada de frontend (itens únicos mesclados, duplicatas descartadas).

## Sumário executivo

- **1 falha crítica de segurança**: escrita arbitrária de arquivo via `filename` não sanitizado em `/api/media/analyze` (B1, confirmada por leitura direta do código).
- **Padrão-raiz de segurança**: a borda (token + allowlist de Host/Origin) é aplicada por rota, e as rotas mais novas (`media`, `technique`, `proactive`, `stt`) nasceram fora dela (B2–B5). Não são decisões documentadas.
- **Fluxo primário de conversa com dois defeitos de UX graves**: histórico sem auto-scroll (F3, confirmado em runtime: último turno 2325 px abaixo da dobra ao abrir) e erro de chat que se autodescarta em segundos sem retry (F2).
- **Conflito de identidade visual não resolvido**: nenhuma das 5 cores da paleta oficial (Deep Blue `#0B132B`, Vibrant Pink `#FF5E7E`, Soft Rose `#FFA6C9`, White/Ice `#F9F9FB`, Charcoal `#282D42`) aparece no código; o app implementa um sistema roxo/creme coeso ("MekaHime", endossado por `design-qa.md`). Dois source of truth em conflito — decisão de produto pendente (D1).
- **Pontos fortes verificados**: semáforo TTS 1-em-voo, hedge NVIDIA→OpenRouter com abort do perdedor, token fail-closed com `timingSafeEqual`, binding `127.0.0.1`, WAV intacto/streaming só cacheia áudio completo, SQL com parâmetros vinculados, fluxo chat→TTS→lip-sync funcionando ponta a ponta em runtime sem erros de console.

Totais: **1 Crítica · 12 Alta · 21 Média · 13 Baixa** (R2–R5 são confirmações em runtime de achados F, não contadas em duplicidade; R8 é positivo).

## 1. Falhas consolidadas

### Crítica

- **B1 · Segurança · `src/media-analyzer.js:179` + `server.mjs:2414-2417`** — `path.join(tempDir, filename || 'input_video.mp4')` usa `filename` cru do corpo HTTP; `../` escapa do `mkdtemp` e `fs.writeFile` grava bytes do atacante em qualquer caminho gravável (o `fs.rm` do finally não remove o arquivo escapado). Rota sem token (apenas allowlist de Origin). **Correção:** nome interno fixo (uuid + extensão allowlistada), como já faz `saveTempAudio` no STT.

### Alta

- **B2 · Segurança · `src/media-analyzer.js:271,356`** — chave Gemini na query string (`?key=`), contrariando a política do próprio projeto (TTS usa header `x-goog-api-key`); `error: err.message` cru repassado ao cliente pode vazá-la. **Correção:** header + erro genérico ao cliente.
- **B3 · Segurança · `src/technique-docs.js:74-85` + `server.mjs:2184-2196`** — contenção do vault por padrão de segmentos (`vault` em qualquer posição + terminar em `techniques`) aceita `vaultDir` fora da subárvore de automação documentada, com `mkdir recursive`. **Correção:** validar caminho resolvido como descendente do diretório de automação configurado.
- **B4 · Segurança/Lógica · `server.mjs:2078` + `src/technique-schema.js:252`** — `POST /api/technique` aceita `status:"validada"` do corpo sem token: o gate de aprovação humana é convenção do cliente; qualquer processo local injeta movimento aprovado no planner. **Correção:** exigir token para status ≠ `proposta`.
- **F1 · Responsividade · `src/usami.css:194-215,1807-1809` + `Usami.jsx:1968-2079`** — em 390 px o bloco esquerdo do header (≈130 px) e o corner (≈140 px) colidem com o pill de status central (≈130 px em chamada). Geometria CSS calculada; confirmação visual em device pendente. **Correção:** grid 3 colunas com `min-width:0` + ellipsis.
- **F2 · Estados · `Usami.jsx:1611-1621,2089,993`** — erro de `/api/chat` vira bolha com TTL 5–14 s e `message` que só renderiza em chamada; em modo texto o erro some sem registro nem retry, mensagem do usuário órfã. **Correção:** turno de sistema persistente + ação "tentar novamente".
- **F3 · Usabilidade · `Usami.jsx:2083-2086`** — `.chat-scroll` sem auto-scroll: confirmado em runtime (`scrollTop:0`, `scrollHeight:2583`, `clientHeight:258` ao abrir com histórico). **Correção:** ref no fim da lista + `scrollIntoView` em `conversation`/`busy`.
- **F4 · A11y · `Usami.jsx:2139-2148`** — painel de configurações sem `role="dialog"`, `aria-modal`, trap de foco ou Escape; abas `role="tab"` sem `aria-controls`/roving tabindex/setas. BondPanel tem Escape mas sem trap/foco inicial. **Correção:** diálogo modal + padrão WAI-ARIA de tabs.
- **F5 · Animação/Lógica · `Usami.jsx:1186-1188,1293,1709-1793`** — `speakReplyQueue` captura `quiet` do render (não `quietRef`): fala de abertura do modo dormir toca em velocidade normal e dispara VRMA `talking`; interval de inatividade usa `speakReply` do primeiro render para sempre. **Correção:** ler refs dentro da fila/interval.
- **F6 · Visual/Decisão · `usami.css:1810,934-938` + `Usami.jsx:918-924`** — crédito do modelo (obrigatório por decisão) some em ≤700 px (`display:none`) e no idle de 4,5 s em desktop, inclusive durante fala/chamada. Confirmado em runtime (header `opacity:0` até mousemove). **Correção:** crédito fora do conjunto auto-ocultável, compacto no mobile (sujeito a D3).
- **F7 · A11y/Usabilidade · `usami.css:174-178,976-980,1269-1271,1067-1072,1689-1697,387-394`** — alvos de toque 20–38 px (ícones, composer, remover mídia, excluir fato, fechar vínculo); só `.round` chega a 44 px no mobile. **Correção:** hit-area ≥44 px via padding/`::after`.
- **F22 · Lógica · `Usami.jsx` (sleepTimer, passada 2)** — closure do timer de adormecer captura `sleepCompanion` stale: o aviso/fala de adormecer pode disparar com estado velho após re-renders. **Correção:** ref ou rearme do effect com deps corretas.
- **R1 · Usabilidade · runtime (screenshot)** — drawer de conversa e BondPanel abertos simultaneamente se sobrepõem: o drawer corta títulos e linhas do BondPanel ("…O DO RELACIONAMENTO", "…RECENTE", histórico truncado) em 831 px. Sem coordenação de camadas entre painéis. **Correção:** painéis mutuamente exclusivos ou layout que reserve faixas (sujeito a D4).

### Média

- **B5 · Segurança · `server.mjs:2506-2519`** — `/api/proactive/trigger` e `/state` despachados inline sem `isAllowedOrigin`/Host/token (únicas rotas fora da borda); `technique`, `plan`, `learning/verdict`, `stt`, `media/analyze` sem token. **Correção:** borda única aplicada a todas as rotas de escrita.
- **B6 · Lógica · `server.mjs:1145-1148,115-119`** — fila n8n global drenada por GET sem consumidor identificado: duas abas roubam comandos uma da outra (inclui refino de animação do próprio turno); sem ack, resposta perdida = comando perdido; POST pode sobrescrever `id`/`timestamp` via spread. **Correção:** fila por sessão + ack; spread antes dos carimbos.
- **B7 · Lógica · `src/memory-store.js:94-99,28,109-111`** — migração v1→v2 aplica FIFO de `SECTION_LIMITS.other=8` durante a migração: v1 com >8 fatos perde os mais antigos, contrariando "a migração nunca perde fato". **Correção:** migrar sem aplicar teto de seção.
- **B8 · Desempenho · `src/tts-cache.js:39-66,27-28` + `server.mjs:300,1505`** — cache TTS em disco sem eviction/TTL; `rate`/`pitch` entram na chave mas não são enviados ao Gemini (cliente aplica playbackRate) → N entradas de áudio idêntico por frase e crescimento ilimitado. **Correção:** LRU/TTL por bytes; remover rate/pitch da chave no provider gemini.
- **B9 · Lógica · `server.mjs:1650,1949,2099,2279-2281`** — `USAMI_DATA_DIR` honrado só por memory/personality/vault-index; tts-cache, stt tmp, technique/planner/learning usam defaults próprios → reincidência possível do incidente de testes escrevendo em `data/` real. **Correção:** default único `process.env.USAMI_DATA_DIR || 'data'`.
- **B10 · Desempenho · `server.mjs:1745-1755,1777-1815,1534-1615`** — desconexão do cliente não cancela a síntese TTS: `closed.signal` só remove da fila; após acquire, fetch/reader não recebem o signal → slot único ocupado até 30 s+ com aba fechada. **Correção:** `AbortSignal.any([closed.signal, timeout])` no fetch e no loop do reader.
- **B11 · Desempenho/Segurança · `server.mjs:1938-2030,2396-2402` + `src/stt.js:64`** — `/api/stt` spawna WhisperModel por POST sem semáforo; `/api/media/analyze` acumula até 60 MB em string + JSON.parse + base64 (~3× payload em RAM) sem gate. DoS local trivial. **Correção:** semáforo + limite por bytes lidos.
- **B12 · Arquitetura · `src/flow-services.js:8` ↔ `server.mjs:52-55,154-164`** — import circular com efeitos colaterais no import (stores criados, chave exportada p/ `process.env`); só não quebra por hoisting. **Correção:** extrair `parseProviderRaw`/`sanitizeActions` para módulo puro em `src/`.
- **B13 · Lógica · `server.mjs:707-715` (e demais leitores de body)** — `break` no `for await (chunk of req)` destrói o socket: o `send(413)` seguinte escreve em socket morto (não confirmado em runtime); `body += chunk` decodifica Buffer isolado → multibyte partido na fronteira vira U+FFFD (acentos pt-BR). **Correção:** `req.resume()` + concatenação de Buffers com decode único/StringDecoder.
- **F8 · Estados · `Usami.jsx:2195`** — "Carregando modelo..." só existe dentro do painel fechado; load do VRM (segundos) mostra palco vazio sem spinner/progresso/erro visível. Confirmado em runtime (palco sem feedback durante espera do chat). **Correção:** overlay de loading/erro no palco.
- **F9 · Visual/A11y · `usami.css:18,972-974,1181-1186,615,555`** — placeholder `--faint` ≈3,6:1 (reprova AA); `.privacy-note` 9 px em `--faint`; rosa `#e2559f` sobre lilás ≈2,8:1. **Correção:** `--faint` ≥.55; escurecer rosa textual.
- **F10 · Animação · `usami.css:1833-1838`** — `prefers-reduced-motion` cobre só mic-pulse/beacon e transições avatar/bubble; `pulse-dot`, `typing`, `bondFade/bondRise`, `chatDrawerIn`, `mediaSlideUp` continuam. **Correção:** bloco global de redução.
- **F11 · Arquitetura/Decisão · `Usami.jsx:34,831` + `usami.css:646-719,1778-1780`** — `VoiceBeacon` importado e nunca renderizado (CSS o esconde com `!important`), divergindo de AGENTS.md; `sceneOpen`/`.stage-panel` são código morto. **Correção:** remover ou reativar conforme decisão.
- **F12 · Estados · `Usami.jsx:693,770-771` + `PersonalityPanel.jsx:53,78-79`** — `.memory-error`, `.memory-notice`, `.bond-meters` sem regra CSS: erro/success idênticos a texto comum, sem `role="alert"`. **Correção:** estilos semânticos + aria-live.
- **F13 · Responsividade · `usami.css:77-79` + `ErrorBoundary.jsx:30`** — sem `env(safe-area-inset-*)`; `.stage{min-height:560px}` empurra composer fora da área visível com teclado virtual; ErrorBoundary em `100vh`. **Correção:** safe-areas + `min-height:min(560px,100dvh)`.
- **F14 · A11y · `index.html:2` + `usami.css:934-938`** — `lang="en"` em UI 100% pt-BR; header oculto por idle continua tabbable (`opacity:0` sem `inert`) → foco em botões invisíveis. **Correção:** `lang="pt-BR"` + `inert`.
- **F15 · Usabilidade · `Usami.jsx:918-924,1948` + `usami.css:940-948`** — em chamada, idle de 4,5 s esmaece dock (hangup incluso) a 0.15 e oculta timer; restauração é `:hover`, inexistente em touch. **Correção:** suspender idle enquanto `call || busy || speaking`.
- **F23 · Robustez · passada 2** — canvas WebGL sem ErrorBoundary dedicado nem tratamento de `webglcontextlost`: perda de contexto deixa palco morto sem recuperação. **Correção:** listener de contextlost/restored + fallback de recarga.
- **F24 · Robustez · passada 2** — escritas em localStorage (conversa, intimidade, histórico) sem try/catch de quota: storage cheio quebra o turno em vez de degradar. **Correção:** wrapper com poda/aviso.
- **F25 · Estados · passada 2** — falha no load do VRM não oferece retry (cai no mesmo painel fechado de F8). **Correção:** botão "recarregar modelo" no overlay.
- **R9 · Usabilidade · runtime (screenshot configurações)** — abas do painel quebram em duas linhas já em 831 px; linhas de XP ≈10 px; ações destrutivas ("Limpar histórico", "Zerar medidores") com o mesmo peso visual das neutras. **Correção:** abas roláveis/compactas, type-scale mínimo 11 px, peso visual de perigo + confirmação consistente.

### Baixa

- **B14 · Lógica · `server.mjs:438-448` + `src/streaming-parser.js:197-199,238-240`** — sanitização de JSON vazado duplicada em 3 lugares com drift já visível; strip de code-fence repetido em 4 parsers. **Correção:** módulo único de limpeza.
- **B15 · Lógica · `server.mjs:2395,2404` + `media-analyzer.js:299,345`** — limite 60 MB com mensagem "45MB"; corpo de erro do provedor ao cliente; `actions` do media saem sem `sanitizeActions`/`filterActionsByCatalog` (prompt injection via OCR → ação não filtrada; mitigação no cliente não confirmada). **Correção:** alinhar copy, erro genérico, sanitizar actions.
- **B16 · Desempenho · `src/vault-index.js:140-197,245` + `src/rag.js:37-42`** — `refresh()` com readdir/stat sync por arquivo a cada turno (incremental e documentado, mas bloqueia event loop com milhares de `.md`); `Promise.all` de stat rejeita inteiro se um arquivo some. **Correção:** throttle por mtime do diretório + catch individual.
- **B17 · Lógica · `server.mjs:999-1003,724,1041`** — `.catch(()=>{})` silencia falha de disco no summarize; busy booleano compartilhado: finally do primeiro chat libera proatividade durante o segundo. **Correção:** log no catch + contagem de busy.
- **B18 · Segurança · `server.mjs:1221-1223`** — headers `x-rag-max-*` com `Number()` sem clamp (rota tokenizada, risco baixo). **Correção:** clamp como no vault-index.
- **F16 · Visual · `ErrorBoundary.jsx:31-62`** — paleta marrom-quente alheia à identidade; branco sobre `#e06666` ≈3,3:1. **Correção:** reestilizar com tokens do palco.
- **F17 · Decisão · `Usami.jsx:1976`** — copy "sua vez ·" vs "chamada ·" documentado; `pitch 0.95` do companion não existe no cliente. **Correção:** alinhar copy/doc ou implementar.
- **F18 · Visual · `usami.css` passim** — px mágicos de tipografia (9–14.5 em meios pontos) e durações inconsistentes (.15–.45 s). **Correção:** tokens de type-scale/duration/easing.
- **F19 · Arquitetura · `Usami.jsx` (2259 l., ~50 hooks)** — god-component; `callSeconds` re-renderiza a árvore a cada 1 s em chamada (cena Three.js não reconstrói — deps estáveis, ponto positivo); localStorage com convenções mistas (`usami.x.v1`, `usami_stage_bg`, `usami:meshes:`). **Correção:** extrair hooks/store, unificar chaves.
- **F20 · Decisão · `Usami.jsx:1222-1231`** — no mudo, partes viram uma bolha concatenada (~220 chars), divergindo do formato ~60/balão sem registro no AGENTS. **Correção:** documentar decisão ou segmentar.
- **F21 · Visual · `usami.css:4,25`** — 4 famílias via Google Fonts CDN em app local-first (offline → fallback silencioso); `design-qa.md` cita Playfair, código usa Fraunces. **Correção:** self-host + alinhar doc.
- **R6 · Desempenho/rede · runtime** — poll de `/api/n8n/commands` a cada 2 s contínuo mesmo idle (~90 GETs numa sessão curta de auditoria). Decisão documentada, mas candidato a long-poll/SSE quando houver fila por cliente (B6).
- **R7 · Assets · console runtime** — warnings recorrentes do loader VRMA (`specVersion` indefinido, `VRMLookAtQuaternionProxy` ausente) em todos os clipes. **Correção:** reexportar VRMAs com specVersion e proxy, ou criar proxy manualmente.

### Confirmações e positivos do runtime (não contados como falhas novas)

- **R2** = F3 confirmado com medição de scroll; **R3** = F8 confirmado (palco sem feedback durante espera); **R4** = F6/F15 confirmados (header `opacity:0` idle, restauração só por mousemove); **R5** = conflito de paleta confirmado por cores computadas (body `rgb(17,7,20)`, texto `rgb(245,235,228)`).
- **R8 · Positivo** — fluxo dourado completo: `POST /api/chat` 200 → `POST /api/tts` 200 (`audio/l16`, streaming) → VRMA `talking` → balões no histórico; console sem erros (só warnings R7); BondPanel e configurações renderizam corretamente; crédito e pill de nível presentes no desktop.

## 2. Decisões pendentes (do Lucas, travam fases do roadmap)

**Resolvidas em 2026-11-08** (registradas em `usami/AGENTS.md`, seção "Decisões da auditoria multiagente"):

| ID | Decisão | Resolução |
|---|---|---|
| D1 | Paleta oficial vs sistema roxo atual | **Migrar** para a paleta oficial; MekaHime aposentado incl. BondPanel (anatomia mantida) |
| D2 | Borda de segurança nas rotas novas | **Fechar todas**: borda em toda rota + token em escritas sensíveis e proactive; GETs de leitura do n8n permanecem só com borda de origem (token neles = credential no Nyarch, pendente) |
| D3 | Crédito do modelo em mobile/idle | **Sempre visível**, compacto no mobile |
| D4 | Painéis simultâneos | **Mutuamente exclusivos** |

## 3. Roadmap de execução

Ordem recomendada: **F0 → F1 → F2 → F3 → F4 → F5**. F2 (frontend) pode correr em paralelo com F1 (backend) porque toca arquivos disjoint; dentro de `server.mjs`, respeitar a ordem das fases para evitar conflitos.

### Fase 0 — Decisões e preparação (custo: S · trava: nenhuma)
1. Resolver D1–D4 com o Lucas.
2. Para D2: levantar quais workflows n8n chamam rotas sem token antes de fechar a borda.
3. Criar branch de auditoria e snapshot do estado atual (`data/` incluído em backup local) antes de qualquer correção.
- **Aceite:** decisões registradas em `usami/AGENTS.md` (convenção do repo para decisões duráveis).

### Fase 1 — Segurança crítica e borda única (custo: M · trava: D2)
1. **B1**: nome interno uuid + extensão allowlistada em `media-analyzer.js`; teste de regressão com `filename: "../../x.mp4"` asserting escrita contida no temp.
2. **B2**: chave Gemini via header `x-goog-api-key`; erro cru nunca ao cliente.
3. **B3**: contenção por descendência do diretório de automação resolvido (`path.resolve` + prefix check), teste com `vaultDir` hostil.
4. **B4**: status ≠ `proposta` exige token; teste sem token → 403.
5. **B5**: middleware único de borda (`isAllowedRequest` + token por classe de rota) aplicado a `proactive`, `technique`, `plan`, `learning`, `stt`, `media`; **B18** clamp de headers RAG no mesmo passe.
- **Aceite:** `npm run test:chat` e `npm run test:technique` verdes + 4 testes de regressão novos; nenhuma rota de escrita fora da borda (grep de dispatch).

### Fase 2 — Confiabilidade do fluxo primário e desempenho (custo: M · trava: nenhuma)
Backend:
1. **B10**: propagar `closed.signal` ao fetch/reader do TTS (`AbortSignal.any`).
2. **B11**: semáforo no STT e gate de bytes no media (ler Buffers, contar bytes, não string).
3. **B13**: leitor de body único com `req.resume()` no excesso + decode UTF-8 único (StringDecoder).
4. **B8**: eviction LRU/TTL por bytes no tts-cache; remover rate/pitch da chave gemini (incrementar `CACHE_VERSION`).
Frontend (paralelo):
5. **F3**: auto-scroll do `.chat-scroll` (ref fim da lista, `scrollIntoView` em novo turno/busy).
6. **F2**: erro de chat persistente no histórico + retry.
7. **F8/F25**: overlay de loading/erro/retry do VRM no palco.
8. **F5/F22**: refs (`quietRef`, sleepTimer) dentro das filas/intervals.
9. **F24**: wrapper de localStorage com try/catch de quota e poda do histórico.
- **Aceite:** runtime: abrir histórico com >10 turnos → último visível; API parada → erro persistente com retry; fechar aba durante TTS → slot livre (log do semáforo); `npm run test:unit` verde.

### Fase 3 — Lógica e arquitetura estrutural (custo: L · trava: F1 concluída em server.mjs)
1. **B12/B14**: extrair parse/sanitize para módulo puro; eliminar import circular; parsers usam limpeza única.
2. **B9**: default único de data dir em todos os stores/handlers.
3. **B6**: fila n8n por id de sessão + ack; spread antes de carimbos; avaliar long-poll (**R6**) no mesmo passe.
4. **B7**: migração v1→v2 sem teto de seção; teste com v1 de 12 fatos.
5. **B15**: sanitizar actions do media + copy de limite correta + erro genérico.
6. **B16/B17**: throttle do refresh do vault, catch individual no rag, log nos catch de summarize, busy por contagem.
7. **F19/F11**: extrair hooks do god-component (call timer, storage), remover código morto (`VoiceBeacon`/`.stage-panel` conforme decisão).
- **Aceite:** suíte completa (`npm test`) verde com `USAMI_DATA_DIR` de tmp; teste de duas sessões drenando filas distintas; grep sem import de `server.mjs` dentro de `src/`.

### Fase 4 — UX, acessibilidade e responsividade (custo: M · trava: D3, D4)
1. **R1/D4**: coordenação de painéis (exclusivos ou faixas).
2. **F1**: header em grid 3 colunas <700 px; **F13** safe-areas + dvh; validar em 390×844 real.
3. **F6/D3**: crédito sempre visível compacto; **F15** suspender idle em call/busy/speaking; **F14** `lang="pt-BR"` + `inert` no header oculto.
4. **F4**: dialog modal com trap/Escape + tabs WAI-ARIA nos painéis.
5. **F7**: hit-areas ≥44 px; **R9** abas compactas, type-scale mínimo, peso visual de perigo nas ações destrutivas.
6. **F23**: ErrorBoundary do canvas + `webglcontextlost/restored`.
7. **F12**: estilos semânticos de erro/sucesso + aria-live.
- **Aceite:** checklist manual em 390×844 e 831×778 (sem colisão/clip/overflow), navegação só por teclado pelos painéis, axe sem violations críticas.

### Fase 5 — Identidade visual e refinamento (custo: M–L conforme D1 · trava: D1)
1. Executar D1: tokens de cor únicos (migração ou oficialização), grep de hardcoded zerado fora dos tokens.
2. **F9**: contrastes AA (placeholder, privacy-note, rosa textual); **F16** ErrorBoundary com tokens do palco; hues do MicBadge derivados da paleta decidida.
3. **F18**: tokens de type-scale/duration/easing; **F10** reduced-motion global.
4. **F21**: self-host das fontes + alinhar `design-qa.md`; **F17/F20** alinhar copy/decisões no AGENTS.
5. **R7**: reexportar VRMAs (specVersion + LookAt proxy) ou criar proxy no load.
- **Aceite:** screenshots desktop/mobile comparados ao antes; razões de contraste ≥4,5:1 nos pares de texto; console sem warnings VRMA; `npm run build` + `npm run test:sites` verdes (handoff Sites preservado).

## 4. Verificações executadas nesta auditoria

- Leitura integral dos escopos pelos agentes especializados (evidência arquivo:linha em cada achado).
- Confirmação direta do Agente Principal: B1 (`media-analyzer.js:179`, `server.mjs:2414-2417`), F3 (medição de scroll), F6/F15 (opacity idle), R1/R9 (screenshots), fluxo dourado chat→TTS→balões (rede + console).
- **Não executado:** suíte de testes (auditoria read-only), indução de erro com API desligada, viewport mobile real (browser in-app bloqueia `resizeTo`/popup — F1/F13 seguem como geometria CSS calculada), comportamento runtime do B13.

## 5. Limitações e riscos remanescentes

- Achados marcados "suspeita — requer confirmação" nos relatórios de origem: mitigação client-side de actions do media (B15) e socket morto no 413 (B13).
- A auditoria não cobre `usami-monitor/` (3 falhas de segurança conhecidas ainda não decididas, registradas em memória do projeto) nem a stack n8n em si.
- Correções de segurança em rotas usadas por automações (D2) exigem checagem dos chamadores antes do deploy local, para não quebrar workflows existentes.

## 6. Execução do roadmap (2026-11-08)

As fases abaixo foram executadas após as decisões D1–D4 (registradas em `usami/AGENTS.md`). Nenhum commit/push foi feito; o estado está no working tree.

| Fase | Status | Itens |
|---|---|---|
| 0 — Decisões e preparação | **Concluída** | D1–D4 registradas em `AGENTS.md`; snapshot do estado deixado ao encargo do usuário (sem commit nesta sessão) |
| 1 — Segurança crítica e borda única | **Concluída** | B1 (nome interno + extensão allowlistada), B2 (chave só no header), B3 (contenção por descendência resolvida), B4 (status ≠ `proposta` exige token), B5 (borda + token em `proactive`/`technique`/`plan`/`learning`/`stt`/`media`), B18 (clamp RAG) |
| 2 — Fluxo primário e desempenho | **Concluída** | B10 (`AbortSignal.any` no TTS), B11 (semáforo STT + gate de bytes no media), B13 (leitor de body único, buffers + `req.resume`), B8 (cache TTS com eviction e chave sem rate/pitch no Gemini), F3 (auto-scroll), F2 (erro persistente + retry), F8/F25 (overlay de loading/erro/retry do VRM), F5/F22 (refs nas filas/timers), F24 (`storage-safe`) |
| 3 — Lógica e arquitetura | **Concluída, exceto F19/F11 e R6** | B12/B14 (`src/provider-parse.js` puro, sem import circular), B9 (`src/data-paths.js`), B6 (`src/n8n-queue.js` por cliente + ack), B7 (migração v1 sem teto), B15 (actions sanitizadas, copy 48MB, erro genérico), B16 (throttle por mtime do diretório), B17 (busy por contagem + log nos catch) |
| 4 — UX, acessibilidade e responsividade | **Concluída, exceto safe-areas (F13) e validação em device real** | R1/D4 (painéis exclusivos), F1 (header em grid 3 colunas), F6/D3 (crédito sempre visível), F15 (idle suspenso em call/busy/speaking/painéis), F14 (`lang="pt-BR"` + `inert`), F4 (dialog modal com trap/Escape/tabs WAI-ARIA), F7 (alvos ≥44 px), R9 (abas compactas, type-scale mínimo, confirmação de ações destrutivas), F23 (StageErrorBoundary + `webglcontextlost`), F12 (estilos semânticos + aria-live) |
| 5 — Identidade visual | **Concluída, exceto F21, F17/F20 e R7** | D1 (paleta oficial, incl. backdrop com hue shift), F9 (`--faint` 0.55 e rosa textual), F16 (ErrorBoundary com paleta oficial), F18 (tokens de type-scale/duração/easing), F10 (`prefers-reduced-motion` global) |

### Verificações reais executadas após a execução

- `npm run test:unit` — 516/516; `npm run test:chat` — 84/84 (inclui os 11 de `n8n-commands`); `npm run test:technique` — 69/69; `npm run test:planner` — 39/39; `npm run test:sites` — 4/4.
- `npm run build` — OK (2064 módulos; warning de chunk >500 kB pré-existente), com `dist/client/index.html`, `dist/server/index.js` e `dist/.openai/hosting.json`.
- Runtime (Vite em `127.0.0.1:5173` + API em `127.0.0.1:8787`): paleta aplicada e conferida em palco, drawer, BondPanel, configurações e PersonalityPanel; console limpo; Escape devolve foco ao gatilho; `inert` no HUD idle; idle suspenso com painel aberto; `POST /api/n8n/command` → poll aplica → `POST /api/n8n/commands/ack` 200; poll via proxy 200 JSON; `GET /api/n8n/commands` sem token 401; `/api/techniques` com Origin 200.
- O único `500` visto na rede durante a validação foi o **proxy do Vite** respondendo `500 text/plain` enquanto a API reiniciava (upstream fora do ar) — código do próprio proxy, não do handler; não se repetiu depois do restart e não deixa stack nos logs da API.

### Pendências explícitas (não executadas)

- **F19/F11**: god-component e código morto (`VoiceBeacon` importado e não renderizado, `.stage-panel`) — refatoração estrutural deixada para uma frente própria.
- **F21**: fontes continuam via Google Fonts CDN; self-host não feito.
- **R7**: VRMAs seguem emitindo warnings de `specVersion`/`LookAtQuaternionProxy`.
- **F13**: `100dvh` aplicado, mas `env(safe-area-inset-*)` não; validação em viewport mobile real (390×844) não executada — browser in-app bloqueia emulação confiável.
- **R6**: poll de 2 s continua; long-poll/SSE não implementado.
- **F17/F20**: copy "sua vez ·"/"chamada ·" e segmentação de bolhas no mudo continuam apenas documentadas como decisão.
- **D2 no n8n real**: token em `/api/techniques` para o n8n do Nyarch continua pendente de credencial; os GETs de leitura seguem só com borda de origem.