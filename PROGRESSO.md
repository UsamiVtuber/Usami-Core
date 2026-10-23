# Usami — progresso inicial

## Implementado

- Interface local React/Vite, cenário original e campo de texto recolhível.
- Carregamento local de GLB e VRM com Three.js e plugin VRM; inspeção básica de meshes, bones, triângulos, animações e morph targets.
- O GLB Autumn fornecido pelo usuário foi renderizado no navegador. O modelo é provisório e não representa a personagem definitiva.
- Painel manual para selecionar e reproduzir clips, girar um bone por eixo, ajustar morph targets e restaurar a pose. As capacidades dependem de cada arquivo.
- Sets de animação do Autumn gerados em `../autumn-original-work/build/SAutu_004_anim.glb` (13 clips: dois idles, dança, cumprimentos, locomoção, emoção e atenção). O original em `source/` não é alterado; regenere com `node animations/build-anim-sets.mjs` e confira com `node animations/verify-motion.mjs`.
- Backend de chat refatorado e testável (`server.mjs`): validação de origem/CORS (localhost + same-origin em produção), content-type, tamanho de corpo, chave ausente, timeout e parsing do provedor. Testes em `tests/chat-server.test.mjs`. Scripts npm: `test`, `test:unit`, `test:chat`, `test:sites`.
- Director local (`src/motion-director.js`): filtro determinístico entre LLM e avatar. Whitelist de ações (`play_clip`, `gesture`, `set_morph`, `set_mesh_visible`), cooldowns por verbo, apenas acessórios mudam de visibilidade, clamp 0..1 nos morphs e limite de 5 ações por turno. `server.mjs` injeta o resumo das capacidades (via `sani tizeCapabilities`) no prompt de sistema e devolve `actions` (whitelist via `sanitizeActions`); o cliente (`Usami.jsx`) executa as ações pelo director. Testes em `tests/motion-director.test.mjs`; confirmado ponta a ponta no dev (Live2D).
- Manifesto de capacidades (`src/capability-manifest.js`): meshes (rig, triângulos, materiais, morphs), bones, clips, expressões e bounds serializáveis. Painel de rig agora lista as meshes com controle de visibilidade persistido por modelo em `localStorage` (`src/mesh-preferences.js`). Testes próprios incluídos.

## Limitações

- Esta é uma fatia inicial, não a conclusão das fases 0 e 1: faltam monorepo, contratos compartilhados, controle manual de expressões, blink, idle e look-at.
- O painel de meshes persiste por `sourceName`. Modelos carregados de arquivos com mesmo nome compartilham preferências; pode mudar para hash de arquivo se necessário.
- Texto integra OpenRouter via backend local com modelo gratuito estável (`nvidia/nemotron-3-ultra-550b-a55b:free`, configurável por `OPENROUTER_MODEL`); backend possui testes cobrindo validação, erros, timeout e parsing. Voz e memória não estão implementadas.
- No Live2D o director não tem nada além de `gesture` (e o modelo não executa gestos); ações de clip/morph/mesh só existem em modelos 3D carregados (GLB/VRM/FBX).
- As animações podem ser reproduzidas manualmente, mas não são mapeadas automaticamente. No Autumn, `MainAction` é um placeholder vazio (todas as 177 trilhas de rotação coincidem com a bind pose) e só `DEF-MainAction` tem movimento, com traduções de até 4 m que tiram o personagem do enquadramento; o clip gerado `Dance_Asset` reaproveita apenas as rotações cíclicas. Os controles faciais e VRM ainda não foram visualmente validados.
- Modelos de terceiros foram copiados para public/models apenas para desenvolvimento local. Não distribuir ou publicar sem verificar licença e atribuição. O build inclui esses arquivos.
- As fontes remotas podem solicitar conexão ao Google Fonts. Para uso offline e maior privacidade devem ser substituídas por fontes locais.

## Próximos passos

1. Classificador por frase (estilo Jev/motion-engine) em paralelo ao LLM principal, com FACS para VRM e canais de rosto.
2. Inspeção detalhada de capacidades, controle de expressões e testes com um VRM válido.
3. Blink, idle e look-at automáticos enquanto o director cuida de gestos maiores.

## Execução

No diretório `usami`, execute `npm install`, `npm run api` e `npm run dev` em terminais separados. A API usa somente `OPENROUTER_API_KEY` do arquivo `A:/Lira/LiraVtuber/.env`, ou do caminho indicado por `USAMI_KEYS_FILE`. Não copie o arquivo nem divulgue seu conteúdo. As mensagens enviadas são compartilhadas com a OpenRouter e o provedor escolhido. Rode `npm run build` antes de `npm run test:sites`.
