# Spotify Player Skill (`spotify-player`)

Skill de controle e integração musical com o Spotify via OAuth2 PKCE, histórico/scrobbles via n8n e recomendações inteligentes de músicas semelhantes via Last.fm.

## Ferramentas Disponíveis

1. `spotify.now_playing`: Consulta faixa/episódio tocando agora, artista, progresso e dispositivo ativo.
2. `spotify.search`: Busca faixas, álbuns, artistas ou playlists no catálogo do Spotify.
3. `spotify.playlists`: Lista as playlists da conta conectada.
4. `spotify.control`: Controla o player (play, pause, next, previous, volume, shuffle). Suporta tocar uma URI específica ou uma lista sequencial de URIs (`uris`) diretamente na fila do player.
5. `spotify.stats`: Consulta estatísticas de scrobbles (top faixas, top artistas) por período (`24h`, `7d`, `30d`, `all`).
6. `spotify.similar`: Encontra músicas semelhantes/parecidas com um artista ou faixa e inicia a reprodução da fila no Spotify automaticamente.

## Variáveis de Ambiente

| Variável | Obrigatória | Descrição |
| :--- | :--- | :--- |
| `SPOTIFY_CLIENT_ID` | Sim (p/ Spotify) | Client ID do Spotify Developer App para fluxo OAuth2 PKCE. |
| `LASTFM_API_KEY` | Recomendada | Chave de API pública do Last.fm para busca de artistas e faixas semelhantes. |
| `LASTFM_SHARED_SECRET` | Opcional | Secret da API do Last.fm. |
| `N8N_SPOTIFY_STATS_URL` | Opcional | Webhook do n8n para histórico de scrobbles no Postgres. |

## Fluxo de Recomendação e Fallback (`spotify.similar`)

1. **Last.fm (Primeira Escolha):**
   - Se `LASTFM_API_KEY` estiver configurada, consulta `artist.getsimilar` (e `track.getsimilar` se uma faixa de referência for fornecida).
   - Para cada artista similar, obtém as faixas mais populares (`artist.gettoptracks`) respeitando um rate limiter de 5 requisições por segundo.
   - Cada faixa candidata é localizada no Spotify com busca direcionada (`track:"..." artist:"..."`).
2. **Fallback Spotify Search:**
   - Caso `LASTFM_API_KEY` não esteja presente, ou a API do Last.fm esteja inacessível/não retorne resultados, o sistema aciona fallback automático buscando no Spotify termos como `<artista> mix` ou playlists relacionadas.
3. **Reprodução em Fila:**
   - As faixas identificadas têm seus URIs enviados em lote para o endpoint de playback do Spotify (`PUT /v1/me/player/play` com `{ uris: [...] }`), garantindo reprodução contínua sem necessidade de criar ou poluir playlists do usuário.
