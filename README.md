# Usami Core

> Runtime local, motor de inteligência e cérebro da companion virtual **Usami**.

O **Usami-Core** é o núcleo do ecossistema Usami (`UsamiVtuber/Usami-Core`). Ele reúne o servidor HTTP na porta `8787` (bind padrão `0.0.0.0`, ajustável por `USAMI_API_HOST`), a interface web de desenvolvimento e prototipagem (React 19 + Three.js VRM), os subsistemas de inteligência agêntica (USAMI 2.0), memória persistente, vínculos estilo visual novel, síntese/reconhecimento de voz e comunicação autônoma com agentes de código externos.

---

## 🏛️ Visão Geral da Arquitetura

```
┌─────────────────────────────────┐           ┌─────────────────────────────────┐
│           Interfaces            │           │        External Coding Agents   │
│  • Web (React 19, Three.js VRM) │           │  • Antigravity / Coding Agents  │
│  • Desktop (Rust + GPUI, WGPU)  │           │  • MCP Stdio Server             │
└───────────────┬─────────────────┘           └────────────────┬────────────────┘
                │ HTTP (0.0.0.0:8787)                          │ JSON-RPC / HTTP
                ▼                                              ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│                              USAMI CORE SERVER                                │
│                                                                               │
│  ┌───────────────────────────┐  ┌──────────────────────────┐  ┌────────────┐  │
│  │       HTTP Routers        │  │       Domain Logic       │  │  Security  │  │
│  │  • agent-routes.js        │  │  • Agent Core (Router)   │  │  • Origin/ │  │
│  │  • memory-routes.js       │  │  • Task Planner          │  │    Host    │  │
│  │  • http-helpers.js        │  │  • Tool Executor (L1-L4) │  │  • Tokens  │  │
│  │  • server.mjs (Orchestrator)│• Skill Catalog & Manager │  │  • Guard   │  │
│  └─────────────┬─────────────┘  └────────────┬─────────────┘  └────────────┘  │
│                │                             │                                │
│  ┌─────────────▼─────────────┐  ┌────────────▼─────────────┐                  │
│  │       Memory Engine       │  │    Audio & Expression    │                  │
│  │  • Episodic & Semantic    │  │  • Gemini TTS + Prosody  │                  │
│  │  • Operational (Projects) │  │  • Local Whisper STT     │                  │
│  │  • Obsidian Vault RAG     │  │  • VRM Visemes & Motion  │                  │
│  │  • VN Bond & Affinity     │  │  • Emotion Classifier    │                  │
│  └───────────────────────────┘  └──────────────────────────┘                  │
└───────────────────────┬───────────────────────────────┬───────────────────────┘
                        ▼                               ▼
        ┌───────────────────────────────┐   ┌───────────────────────────┐
        │       LLM & Cloud APIs        │   │        Local Stack        │
        │  • OpenRouter / NVIDIA Nemotron│   │  • n8n Queue com Jitter   │
        │  • Gemini TTS / ElevenLabs    │   │  • SQLite FTS5 & LanceDB  │
        └───────────────────────────────┘   └───────────────────────────┘
```

---

## ✨ Principais Subsistemas

### 1. 🧠 USAMI 2.0 — Domínio Agêntico
- **Roteador Determinístico de Intenções (`src/agent-core.js`)**: Classifica mensagens em tempo constante entre *conversa*, *ações operacionais* e *tarefas complexas*, evitando chamadas desnecessárias a modelos externos.
- **Tool Executor & Permission Gate (`src/tool-executor.js`, `src/permission-gate.js`)**: Execução de ferramentas com quatro níveis de permissão (L1 Leitura até L4 Ações Críticas). Ações de nível 4 exigem confirmação escrita de uso único.
- **Task Planner (`src/task-planner.js`)**: Decomposição estruturada e determinação acíclica de planos de execução.
- **Skill Manager & Catalog (`src/skill-catalog.js`, `src/skill-manager.js`)**: Gerenciamento do ciclo de vida de habilidades (descoberta, proposta, sandbox de testes isolados e ativação).

### 2. 🤝 Code Agent Bridge & MCP Server
- **Bridge Bidirecional (`src/code-agent-bridge.js`)**: Permite que a Usami analise seu próprio código e emita propostas técnicas para agentes de IA externos.
- **Detecção de Presença em Tempo Real**: Rastreia agentes de código ativos com TTL de 60s.
- **Roteamento Inteligente**:
  - Se o agente estiver online: despacha propostas para a fila direta do MCP.
  - Se estiver offline: abre automaticamente uma GitHub Issue no repositório `UsamiVtuber/Usami-Core` com a etiqueta `[usami-proposal]`.
- **Servidor MCP Stdio (`scripts/usami-mcp.mjs`)**: Protocolo padrão compatível com Antigravity, Claude Code, Cursor e IDEs agênticas.

### 3. 💾 Memória, Vínculo e Persona
- **Memória Semântica e Consolidação Diária (`src/memory-store.js`, `src/memory-consolidation.js`)**: Extração de fatos, segregação por seções e resumos diários automáticos.
- **Memória Operacional (`src/operational-memory-store.js`)**: Rastreamento append-only de projetos (`op-*`), tarefas e compromissos com auditoria.
- **Vínculo estilo Visual Novel (`src/bond-store.js`)**: Medidores de carinho, companhia e humor com cálculo centralizado no Core, sistema de conquistas (`data/achievements.json`) e humor dinâmico.
- **RAG Local (`src/rag.js`, `src/vault-index.js`)**: Recuperação de contexto através de índice FTS5 do vault Obsidian local.

### 4. 🎭 Voz, Expressão e Avatar
- **Síntese de Voz Expressiva (`src/tts-prosody.js`)**: Gemini TTS com controle fino de prosódia via style tags injetadas, cache local e segmentação de balões com lip-sync.
- **Reconhecimento de Voz (`src/stt.js`)**: Suporte a `faster-whisper` em Python para transcrição local rápida e segura.
- **Motion Director & VRM Expression (`src/motion-director.js`, `src/vrm-gesture-layer.js`)**: Orquestração de animações VRMA, blendshapes e expressões sincronizadas ao áudio.

---

## 📁 Estrutura de Diretórios

```text
usami/
├── data/                      # Dados locais (memory.json, bond.json, propostas, etc.)
├── docs/                      # Documentação de arquitetura e auditoria
├── public/                    # Assets estáticos, modelos VRM e animações
├── scripts/                   # Scripts auxiliares e MCP Server stdio
│   └── usami-mcp.mjs          # Servidor MCP para o Code Agent
├── skills/                    # Manifestos e definições de skills do ecossistema
├── src/
│   ├── routes/                # Handlers HTTP modulares
│   │   ├── agent-routes.js    # /api/agent/* (turnos, self, sugestões, briefing)
│   │   ├── memory-routes.js   # /api/memory, /api/bond, /api/mood, RAG
│   │   └── http-helpers.js    # Validação de origens, tokens e buffers
│   ├── agent-core.js          # Roteamento e orquestração de turnos
│   ├── agent-contracts.js     # Tipagem e contratos do sistema agêntico
│   ├── code-agent-bridge.js   # Motor de integração com o Code Agent
│   ├── n8n-queue.js           # Fila n8n com exponential backoff e full jitter
│   ├── personality-store.js   # Traços e persona
│   └── ...                    # Módulos de domínio puros
├── tests/                     # Suíte de testes automatizados (>630 testes)
├── server.mjs                 # Servidor HTTP central e roteador da porta 8787
├── package.json               # Configurações, scripts e dependências Node.js
└── jsconfig.json              # Configurações de tipagem estrita NodeNext
```

---

## 🌐 Superfície da API HTTP (`0.0.0.0:8787`)

| Rota | Método | Autenticação | Descrição |
| :--- | :--- | :--- | :--- |
| `/api/chat` | `POST` | Host/Origin | Conversa principal com a Usami (texto, persona e avatar) |
| `/api/agent/turn` | `POST` | Host/Origin + Token | Processamento agêntico de turnos operacionais e ferramentas |
| `/api/agent/self` | `GET` | Host/Origin + Token | Introspecção do sistema, ferramentas ativas e limitações |
| `/api/agent/suggestions`| `GET`, `POST`| Host/Origin + Token | Sugestões proativas contextuais |
| `/api/agent/briefing` | `GET` | Host/Origin + Token | Daily Briefing matinal consolidado |
| `/api/agent/proposals`| `GET`, `POST`| Host/Origin + Token | Propostas de código geradas pela Usami |
| `/api/agent/presence` | `GET`, `POST`| Host/Origin + Token | Heartbeat de presença de agentes de código externos |
| `/api/tts` | `POST` | Host/Origin | Síntese de áudio (Gemini TTS / ElevenLabs) com streaming e cache |
| `/api/stt` | `POST` | Host/Origin + Token | Transcrição de áudio via Whisper |
| `/api/memory` | `GET`, `POST` | Host/Origin + Token | Inspeção, esquecimento e manutenção da memória semântica |
| `/api/bond` | `GET`, `POST` | Host/Origin + Token | Medidores de vínculo e histórico estilo VN |
| `/api/mood` | `GET`, `POST` | Host/Origin + Token | Leitura e atualização do humor contínuo da companion |
| `/api/n8n/command` | `POST` | Host/Origin + Token | Comandos de animação e eventos oriundos de automações n8n |

> **Bind:** a API escuta em `0.0.0.0:8787` por padrão, então fica acessível na rede local. Para restringir ao loopback, defina `USAMI_API_HOST=127.0.0.1` (variável de ambiente ou `.env`). `Host` e `Origin` continuam limitados pela allowlist (`USAMI_ALLOWED_HOSTS` / `USAMI_ALLOWED_ORIGINS`).

---

## 🚀 Como Executar

### Pré-requisitos
- **Node.js**: v22+ (recomendado Node 22 ou 24 com suporte a ES Modules nativo).
- **Python**: 3.10+ (opcional, para pipeline de ingestão de vídeos e Whisper local).
- **Chaves de API**: Definidas em arquivo `.env` ou apontadas via `USAMI_KEYS_FILE` (Gemini, OpenRouter, etc.).

### Instalação
```bash
# Entrar no diretório do core
cd usami

# Instalar dependências Node.js
npm install
```

### Executar o Servidor de API
```bash
# Inicia a API na porta 8787 (bind padrão 0.0.0.0)
node server.mjs
```

### Executar a Interface Web (Vite Dev Server)
```bash
# Inicia a interface de desenvolvimento na porta 5173
npm run dev
```

---

## 🧪 Testes Automatizados

A base de código possui rigorosa cobertura de testes unitários e de integração:

```bash
# Executa todos os testes (Unitários, Chat, Planner, Técnicas, Ingestão e Sites)
npm test

# Executa testes específicos do fluxo de conversa e do domínio agêntico
npm run test:chat

# Executa testes de técnicas e planos de animação
npm run test:technique
npm run test:planner
```

---

## 📜 Licença e Créditos

- **Avatar 3D**: Modelo 白ー (Shiro), arte por **Sweet_nya555**.
- **Desenvolvimento**: Desenvolvido com carinho pelo time **UsamiVtuber** e aprimorado com colaboração contínua de IA Companion & Coding Agents.
