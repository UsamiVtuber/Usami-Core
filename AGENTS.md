# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.

## Créditos do modelo

O avatar é o modelo 白ー (shiro), arte por **Sweet_nya555**. O crédito é um texto pequeno no canto superior direito do palco (`.credit`, dentro do header), no estilo "Model by ..." do mock de referência vertical — não remover.

## Chamada, modo companion e intimidade

- Botão de chamada no dock (ícone Phone) entra em modo chamada: timer no pill de status (`chamada · 00:42`), botão vira vermelho com PhoneOff e encerra. Voz real via Web Speech API — `SpeechRecognition` (pt-BR, interim) escuta e `speechSynthesis` (voz pt-BR, ~400 chars) responde. Firefox não tem reconhecimento: cai para texto; sem `speechSynthesis`, resposta só em texto.
- Lua = modo companion: adiciona `companion` ao `.stage` (overlay escuro `::after` simulando tela desligada, controles continuam visíveis) e reduz a taxa da fala (`rate` 0.8 / pitch 0.95); status vira "modo companion".
- Intimidade estilo visual novel: 3 medidores (carinho, humor, companhia), pill `♥ Nível N` no canto superior direito junto do crédito (crédito permanece), barras VN no painel de configurações. XP em `localStorage['usami.intimidade.v1']`, thresholds `LEVELS = [0,25,60,110,180]`.

## Layout (decisão do usuário)

Usuário escolheu um HUD minimalista, baseado no mock de referência: sem texto de marca no topo (o botão de configurações fica à esquerda), status centralizado, crédito à direita, e bloco de boas-vindas removido. O dock de botões fica abaixo do composer e a hint "SUA COMPANHIA, NO SEU RITMO" foi removida. Não reintroduzir esses elementos sem pedido.

## Modos de conversa (decisão do usuário)

- Em chamada de voz, manter a Shiro como foco central, compositor de texto disponível e controles circulares da chamada abaixo dele. Voz na chamada usa `speechSynthesis` e não passa pela fila de TTS em partes.
- Em conversa apenas por texto, mostrar o histórico em painel lateral esquerdo e o compositor na base, sem retirar o avatar do palco.
- A troca entre voz e texto deve acontecer na mesma tela; configurações e ferramentas de rig permanecem recolhidas e secundárias.

## Respostas em balões e boca do avatar (decisão do usuário)

- Resposta longa do chat vira **vários balões de ~60 caracteres, no máximo 5**, sem nunca descartar texto (`src/reply-parts.js`). Os balões são **segmentados e sincronizados com a fala**: o balão N aparece quando o áudio N começa, toca, e só então o balão N+1 aparece — nunca "tudo de uma vez". Com streaming, o balão nasce na **primeira amostra de áudio** (`onFirstAudio`), não no header da resposta. **O provedor de TTS não tolera síntese concorrente** (5 `POST /api/tts` em paralelo = 5×504; com uma requisição em voo todas voltam 200), então `speakReply` mantém **exatamente uma requisição em voo**: no caminho de elemento a próxima síntese é pedida antes de tocar a parte atual; no streaming ela é pedida quando a **rede** da parte atual terminou (`onStreamEnd`), nunca enquanto o PCM ainda está chegando. O `reply` tem teto de ~220 caracteres no servidor e instrução de brevidade no prompt.
- Execução de pontuação (`...`, `?!`) conta como **uma** fronteira de frase — cortar caractere por caractere produz balões picotados e artefatos na voz.
- Sem áudio (mudo ligado ou síntese quebrada) as `actions` com timing são **executadas**, não descartadas: sem fala não há com que sincronizar, mas o corpo ainda precisa reagir. Se a Usami "não se mexe", checar primeiro o `/api/tts` antes do director.
- O texto bruto de um JSON inválido/truncado **nunca** aparece no balão: `parseProviderRaw` recupera o valor de `reply` e descarta as `actions`; sem conteúdo recuperável, devolve erro amigável.
- A boca do VRM é escrita pelo `vrm.expressionManager` (`aa/ih/ou/ee/oh`), nunca em `morphTargetInfluences` direto: `VRMExpressionManager.update()`, dentro de `vrm.update(delta)`, zera toda expressão a cada frame e apagaria o visema. Escrita bruta em morphs continua apenas como fallback para GLB/FBX sem expressionManager.
- As `expressions` enviadas ao servidor passam por `curateExpressions` antes do corte de 20 nomes: na ordem crua do shiro os 13 presets (visemas, blink, look) ocupavam a lista e os prefabs de emoção eram filtrados em silêncio por `filterActionsByCatalog`.

## Memória (decisão do usuário)

- Fatos duráveis moram em seções fixas: `user`, `preferences`, `hobbies`, `relationship`, `dates`, `other` (`src/memory-store.js`, `memory.json` v2). O modelo devolve `remember: {section, fact}`; string antiga ou seção inventada cai em `other`. A migração v1 → v2 nunca perde fato e não reescreve o disco no load.
- Exclusão é granular e sempre exige confirmação escrita (`APAGAR`) no corpo de `POST /api/memory/forget`; a aba **Memória** do painel só habilita os botões depois que a palavra é digitada. Não trocar por `confirm()` do navegador.
- Resumos diários em background, consolidação de fatos e busca FTS5 no vault estão decididos para as próximas fases e **ainda não implementados**. O campo `summaries` já existe no schema, mas fica vazio até a Fase 1 — não descrever como pronto.

## Chamadas NVIDIA (por que a Usami "não reage")

- Toda chamada que pede JSON usa `sharedClient.chatJson` (`response_format: json_object`) e `jsonText`: o NEMOTRON escreve o raciocínio em `reasoning_content`, mas quando esse raciocínio estoura o orçamento ele **transborda para `content` e o JSON nunca nasce** — a resposta vem como prosa ("The user wants me to create animation actions...") e as `actions` voltam `[]`. Com `json_object` o modelo vai direto ao JSON (3–12 s, contra 19 s medidos). `chat_template_kwargs.enable_thinking` deixa de pensar mas fica mais lento, e `thinking_cost` é recusado (400) — não tentar de novo.
- Sinônimos do diretor são normalizados em `filterActionsByCatalog` (`expression`/`emote` → `set_expression`, `morph` → `set_morph`): o modelo inventa esses nomes, a ação passava pelo filtro e morria no `motion-director` (verbos válidos são só os de `DIRECTOR_VERBS`).
- `classifyUserMessage` saiu do caminho crítico do `/api/chat`: ela nunca participou da resposta (o cliente deriva a emoção do texto localmente, `src/reply-emotion.js`) e só alimenta o webhook `usami.response` do n8n — o handler dispara em fire-and-forget e espera a classificação apenas para montar o payload. `generateReplyWithActions` é **uma chamada só** que devolve `{reply, gesture, actions, remember}`: o catálogo de capacidades do avatar é anexado ao prompt de persona (`withCapabilities`) porque sem ele o modelo inventa nomes que `filterActionsByCatalog` descarta. Quando as `actions` vêm vazias, `refineAnimationInBackground` roda o diretor DEPOIS da resposta e empurra o refino pela fila de comandos (poll de 2 s do cliente) — nunca bloqueia o balão. Orçamento da chamada mesclada: `maxTokens` 1100; com 700 o raciocínio + actions + remember não cabem e `actions` volta `[]`.
- Latência medida por turno é logada pelo servidor (`[chat] llm=… animacao=… contexto=… total=…`) e devolvida em `timing` na resposta. Sem isso a latência é caixa-preta e otimização vira chute.
- Rede para os provedores é **intermitente nesta máquina**: `fetch failed (causa: UND_ERR_CONNECT_TIMEOUT)` e abort de 45 s aparecem em sondas reais. Todo aviso de erro de rede usa `describeFetchError`, que revela `error.cause` — sem ele o log só dizia "fetch failed" e o 502 ficava indecifrável. Concorrência de 2 chamadas NVIDIA funciona; não há limite de concorrência no NVIDIA (há no TTS).

## Voz (Gemini TTS): o que ela fala e o que ela só lê

- A direção de estilo vai em **tag entre colchetes** (`[em português do Brasil, voz de personagem de anime, muito aguda e brilhante, timbre leve e saltitante, sorriso na voz, dicção rápida, expressiva e travessa] `), nunca em frase: transcrevendo o áudio com o whisper local (`src/stt.js`), a instrução em prosa era **lida em voz alta** antes da fala — a Usami "anunciava o próprio prompt". A tag muda a prosódia e não aparece na transcrição. `systemInstruction` **não** está habilitado nesse modelo (`gemini-3.8-flash-tts` responde 400 "Developer instruction is not enabled"); não tentar de novo.
- **Voz oficial (2026-10-27):** `GEMINI_TTS_VOICE=voice_ess199w2ioks` no `.env` é o take "d" do Voice Design; substituiu `voice_cewhmedkmma9` porque a anterior ainda tinha ressonância adulta. O prompt que passou foi "A petite anime companion character with a very high, clear and sweet voice, bright and bouncy register, teasing and clingy tone, fast energetic pacing, crisp close-mic recording. Speaks Brazilian Portuguese in a lively anime style." O filtro bloqueia termos de idade ("girl", "youthful", "squeaky-cute"); `base_voice` responde 403 (remix desabilitado). A voz expira em 2027-10-27 e o uso renova. Não voltar para `Kore` sem pedido: era a voz adulta que motivou a troca.
- **Tags não-verbais:** o LLM pode terminar o reply com `<laugh>`, `<chuckle>`, `<sigh>` ou `<short pause>` (tags em ângulo, documentadas pelo Gemini 3.8; `[risada]` e `[suspiro]` são aliases). `parseProviderRaw` remove a tag do balão e devolve `speechTags` só quando existe; o cliente anexa ao **último** balão do `/api/tts` e usa `stripSpeechTags` no callback que exibe o balão. O modo chamada (`speechSynthesis`) ignora as tags. A transcrição local confirmou que as tags viram som e não são lidas; não colocá-las no meio da fala — a sincronia balão/áudio depende de ficarem no fim.
- O runtime usa `generateContent` com a tag de estilo no prefixo; a API `interactions` com `speech_metadata` existe e é a recomendada pela doc, mas trocar exigiria refazer o streaming (`streamGenerateContent`/SSE) — só migrar com medição de latência e transcrição.
- O provedor devolve um **WAV completo** (`mimeType: audio/wav`) com chunk `C2PA` (~6 KB de proveniência) depois do `data`. Esse payload passa **intacto**: embrulhá-lo no header de 44 bytes declarava os metadados como amostras e produzia ~63 ms de ruído em fundo de escala no fim de cada fala (o "estouro"). Só embrulha quando o payload é PCM cru.
- `CACHE_VERSION` (src/tts-cache.js) faz parte da chave: mudou a forma do áudio **ou** a direção de estilo → incrementa, senão o cache serve o áudio antigo para as frases já sintetizadas. A instrução também entra na chave (`instruction`): trocar só a cláusula de uma emoção invalidaria o áudio velho do `styleId` correspondente, e não o contrário.
- **Streaming de voz** (`stream: true` no `POST /api/tts`): `:streamGenerateContent?alt=sse` entrega PCM cru (`audio/l16; rate=24000; channels=1`, ~72 ms por pedaço) e o primeiro som sai ~1,0 s depois do pedido, contra ~5,3 s do WAV inteiro. O servidor responde Int16 LE sem header com `X-TTS-Stream: 1` e **não escreve nada antes do primeiro pedaço de áudio** — enquanto não há áudio o caminho normal ainda pode responder. O cliente (`src/stream-audio-player.js`) agrupa em quanta de ~100 ms (um `AudioBufferSourceNode` por quantum, não por chunk de rede) e conecta no **mesmo `AnalyserNode`** do lip-sync via `audioLipsync.getTap()` + `beginExternal()`: sem `beginExternal`, `update()` veria o `HTMLAudioElement` pausado e fecharia a boca no meio da fala. O HIT de cache **não** é stream (serve o WAV empacotado, sem o header), então o cliente decide pelo header, nunca pelo content-type. Áudio parcial (queda no meio) nunca entra no cache. O modo quieto continua pelo elemento: ele desacelera a voz com `playbackRate`, que o PCM não tem.
- Para decidir "o que ela realmente falou", use o oracle local: sintetize e transcreva com `transcribeAudio` (faster-whisper está instalado na máquina). Duração de áudio é proxy fraco — o TTS é estocástico.

## Testes não tocam em `data/`

- `npm test` já escreveu na memória real da companion: `createChatHandler` fechava sobre o `memoryStore` criado na avaliação do `server.mjs`, então cada rodada de testes empilhava turnos `oi`/`olá` em `data/memory.json`, movia a afinidade e fabricava fatos ("usuário cumprimenta compulsivamente") a partir desse lixo. O handler aceita `memoryStore` injetado e `USAMI_DATA_DIR` redireciona o depósito de módulo — os testes apontam ambos para `mkdtemp`. Ao adicionar rota com estado, injete o depósito no handler; não importe o caminho padrão.
