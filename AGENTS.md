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

- Resposta longa do chat vira **vários balões de ~60 caracteres, no máximo 5**, sem nunca descartar texto (`src/reply-parts.js`). Cada balão é um `POST /api/tts`: as sínteses são pedidas em paralelo e tocadas em série, para a voz da primeira parte sair antes do resto chegar. O `reply` tem teto de ~220 caracteres no servidor e instrução de brevidade no prompt.
- Execução de pontuação (`...`, `?!`) conta como **uma** fronteira de frase — cortar caractere por caractere produz balões picotados e artefatos na voz.
- O texto bruto de um JSON inválido/truncado **nunca** aparece no balão: `parseProviderRaw` recupera o valor de `reply` e descarta as `actions`; sem conteúdo recuperável, devolve erro amigável.
- A boca do VRM é escrita pelo `vrm.expressionManager` (`aa/ih/ou/ee/oh`), nunca em `morphTargetInfluences` direto: `VRMExpressionManager.update()`, dentro de `vrm.update(delta)`, zera toda expressão a cada frame e apagaria o visema. Escrita bruta em morphs continua apenas como fallback para GLB/FBX sem expressionManager.
- As `expressions` enviadas ao servidor passam por `curateExpressions` antes do corte de 20 nomes: na ordem crua do shiro os 13 presets (visemas, blink, look) ocupavam a lista e os prefabs de emoção eram filtrados em silêncio por `filterActionsByCatalog`.
