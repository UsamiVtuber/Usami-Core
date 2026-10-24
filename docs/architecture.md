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
 └─ POST /api/stt  → faster-whisper local (Python)
        │
        ├─ data/memory.json   memória e afinidade locais
        └─ data/tts-cache/    cache de áudio local
```

Chaves ficam fora do Git, em um arquivo apontado por `USAMI_KEYS_FILE` ou nos
locais configurados pelo servidor. `data/`, modelos 3D e assets Live2D também
não são versionados.

## Estado confirmado em 24 de outubro de 2026

- A suíte local passou com 198 testes e o build gerou o pacote de Sites.
- Uma chamada real para `/api/chat` retornou HTTP 200.
- Uma chamada real para `/api/tts` retornou um WAV válido (`RIFF`) via o
  provedor configurado.
- `faster_whisper` pode ser importado pelo Python local; uma transcrição real
  ainda precisa de captura de áudio pelo navegador.

## Fronteira de fluxo

`createChatHandler()` é o caminho ativo de produção local. Ele preserva
persona, memória e afinidade. `FlowExecutor` e `createFlowChatHandler()` estão
cobertos por testes, mas continuam experimentais até terem a mesma paridade
operacional do handler ativo. Não trocar a rota de produção por ele apenas
porque os testes unitários passam.

## Próxima integração no Nyarch

O n8n roda remotamente no Nyarch via Docker/SSH. A primeira integração deve
escrever somente em uma área explícita de automações do vault Obsidian, por
exemplo `Inbox/Automations/`; ele não deve receber acesso irrestrito ao vault
nem a credenciais do runtime da Usami.
