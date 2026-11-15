# Superfície de transmissão — S18

Página autônoma de captura para OBS (browser source): avatar VRM da Usami com fundo transparente + legenda da última mensagem do chat ao vivo. Sem controles, sem painéis e sem token de API no bundle.

## 1. Acessar a página

Em desenvolvimento (Vite):

```
http://127.0.0.1:5173/index-live.html
```

Em produção, usar o artefato gerado em `dist/client/index-live.html` servido pelo host estático de destino.

O Vite descobre automaticamente qualquer `*.html` na raiz de `usami/` como entry point; não é preciso alterar `vite.config.mjs` para adicionar a página. O proxy `/api` já injeta o `x-usami-token` nas chamadas do navegador e o token nunca chega ao bundle.

## 2. Configurar no OBS

1. Adicionar fonte → **Navegador** (Browser).
2. URL: `http://127.0.0.1:5173/index-live.html` (dev) ou o endereço do build publicado.
3. Marcar **Transparent background** (fundo transparente) — a página renderiza com `alpha: true` e `clearColor(0, 0, 0, 0)`.
4. Largura/Altura: usar a resolução do canvas do overlay (ex.: 1280×720). A página redimensiona o Three.js ao mudar a janela.
5. Desmarcar controlsh above / interatividade não é necessária: a página não tem botões nem captura clique.

A legenda exibe a última mensagem ingerida pelo store do chat ao vivo (`POST /api/live/session` → adapter conecta ao IRC da Twitch → `store.ingestMessage`). O status no canto superior esquerdo alterna entre `ao vivo` e `sem sessão`.

## 3. Endpoints envolvidos

| Endpoint | Método | Propósito |
|---|---|---|
| `GET /api/live/messages?limit=N` | GET | Lê as últimas mensagens já sanitizadas pelo store (só leitura, sem efeito na fila). Usado pela página a cada 3 s. |
| `GET /api/live/status` | GET | Estado da sessão + estatísticas da fila de ingestão. |
| `POST /api/live/session` | POST | `start` inicia a ingestão (injeta adapter) e `stop` encerra. Exige token (escrita sensível). |

O poll da página usa `apiFetch('/api/live/messages?limit=1')`, que envia `x-usami-client` (sessionStorage da aba). O servidor aplica a borda D2 (`isAllowedOrigin` + `x-usami-token`) antes de responder.

## 4. Limites de projeto

- **Exposição:** o servidor da API escuta em `0.0.0.0:8787` por padrão, configurável por `USAMI_API_HOST` (ex.: `127.0.0.1` para restringir ao loopback). Host e Origin seguem limitados pela allowlist (`USAMI_ALLOWED_HOSTS` / `USAMI_ALLOWED_ORIGINS`). Não publicar serviços além do previsto.
- **Read-only na captura:** a página do OBS só lê mensagens. Start/stop de sessão é feito por outro cliente (painel do operador), nunca pelo browser source.
- **Sem controles na página:** sem botões, painéis ou exibição de token. Se o avatar não carregar, a legenda continua visível (falha silenciosa, captura nunca fica quebrada).
- **Estado explícito "sem sessão":** quando não há mensagem recente, o status mostra `sem sessão` em vez de ficar em branco ou simular atividade.
- **Não medir com o avatar do palco principal:** a página carrega `/models/companion-a.vrm` de forma independente. O custo de renderização é só deste overlay.

## 5. Medição no OBS (CPU/GPU)

Antes de considerar o ensaio pronto, medir com OBS aberto e a fonte navegador ativa:

1. OBS → Ferramentas → Monitor de estatísticas ou sobreposição de desempenho (`View > Stats`).
2. Anotar % de CPU da fonte "Navegador" e uso de GPU do render Three.js (painel de desempenho do navegador, aba Performance, com a página aberta isolada).
3. Comparar com e sem a fonte navegador ativa para isolar o custo do overlay.

Valores de referência a registrar no ensaio:
- CPU da fonte navegador (ousar número real da máquina do operador).
- Taxa de quadros do canvas (requestAnimationFrame estável ~60 fps ou alvo da captura).
- Memória da aba do navegador após 10 min de poll contínuo (deve se manter plana; sem vazar avatares — o effect limpa `vrm.dispose()` e `renderer.dispose()` ao desmontar).

## 6. Ensaio em live privada (Twitch)

Checklist antes de qualquer transmissão pública:

- [ ] Sessão de ingestão iniciada com sucesso (`POST /api/live/session` `{action:'start'}`) e `GET /api/live/status` retorna sessão ativa.
- [ ] Mensagem de teste no chat da Twitch aparece na legenda do overlay em ≤ ~2 s (latência ponta a ponta: IRC → adapter → store → poll da página).
- [ ] Queda de rede: desligar o adapter/sair da sessão e confirmar que o status volta a `sem sessão` sem travar a página.
- [ ] Silêncio seguro: sem mensagem no chat, a legenda não exibe texto antigo indefinidamente (poll retorna vazio → status `sem sessão`, legenda mantida ou limpa por política do operador).
- [ ] Parada de emergência: `POST /api/live/session` `{action:'stop'}` encerra a ingestão; o OBS continua exibindo a última frame sem travar.
- [ ] Fundo transparente confirmado no OBS (apenas avatar + legenda sobre a cena, sem retângulo preto).
- [ ] Crédito do modelo visível, se exigido pelo contrato do avatar (ver `public/models/CREDITS-animations.md`).

O ensaio não deve ser executado por este agente — requer máquina do usuário, conta Twitch e OBS local. Registrar os números reais de CPU/GPU e latência após rodar.
