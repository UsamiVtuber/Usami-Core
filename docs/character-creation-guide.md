# Guia de Criação e Alternância de Personagens (White-Label / Fase 0)

Com o desacoplamento Core & Config-Driven (`RFC-001 §1`), o runtime `usami/` deixou de amarrar identidade, voz e memória a um único personagem hardcoded. Agora qualquer companion ou AI VTuber pode ser carregada de forma declarativa e isolada.

---

## 1. Estrutura de Diretórios por Personagem

Cada personagem possui seu próprio diretório isolado dentro do diretório de dados (`data/` ou o caminho apontado por `USAMI_DATA_DIR`):

```text
data/
└── characters/
    ├── usami-classic/
    │   └── character.manifest.json
    └── luna-cyber/
        ├── character.manifest.json
        ├── memory.json
        ├── personality.json
        ├── bond.json
        ├── mood.json
        └── memory/
            └── lancedb/           # Tabela isolada: memories_luna_cyber
```

---

## 2. Schema Declarativo (`character.manifest.json`)

Schema oficial (`character.manifest.v1`), validado por `src/character-manifest-schema.js` via `CharacterManifestSchema.safeParse(...)`:

```json
{
  "id": "character.manifest.v1",
  "metadata": {
    "id": "luna-cyber",
    "name": "Luna",
    "displayName": "Luna Cyber",
    "version": "1.0.0",
    "author": "Seu Nome",
    "description": "Astronauta hacker especialista em telemetria orbital"
  },
  "identity": {
    "archetype": "hacker_astronaut",
    "systemPrompt": {
      "identityBlock": "Você é Luna, uma astronauta hacker objetiva e curiosa.",
      "dialogueRules": [
        "Use analogias sutis de espaço e telemetria",
        "Mantenha respostas curtas para leitura natural no TTS"
      ],
      "bannedWords": ["coelho"],
      "operationalLimits": {
        "maxResponseTokens": 250,
        "temperature": 0.75,
        "topP": 0.92,
        "rateLimitMessagesPerMinute": 30
      }
    }
  },
  "voice": {
    "engine": "gemini_multimodal",
    "defaultVoice": "Aoede",
    "model": "gemini-2.5-flash-preview-tts",
    "baseInstruction": "[em português do Brasil, voz calma, cristalina e ligeiramente técnica] ",
    "pitchOffset": -1.0,
    "speakingRate": 1.0,
    "prosodyMap": {
      "angry": { "voice": "Puck", "pitchOffset": 1.5, "rate": 1.15 }
    }
  },
  "avatar": {
    "vrmPath": "/models/luna.vrm",
    "modelFormat": "vrm1.0",
    "defaultPose": "idle",
    "scale": 1.0,
    "cameraOffset": [0, 1.35, 0.8],
    "armClearanceCorrection": true,
    "credit": "Model by Community Creator"
  },
  "memory": {
    "ragEnabled": false,
    "storageBackend": "none",
    "isolatedNamespace": true,
    "embeddingModel": "Xenova/all-MiniLM-L6-v2",
    "similarityThreshold": 0.25,
    "maxContextChunks": 4,
    "decayFactorPerDay": 0.05
  },
  "personality": {
    "traits": {
      "extroversion": 0.5,
      "tsundere": 0.2,
      "empathy": 0.7,
      "chaos": 0.3
    },
    "bondSystem": {
      "enabled": true,
      "initialScore": 0,
      "levels": [
        { "level": 1, "threshold": 0, "title": "Conhecidos" },
        { "level": 2, "threshold": 50, "title": "Parceiros" }
      ]
    }
  }
}
```

### Toggle Opt-In de Memória Semântica (`memory.ragEnabled`)

- **`ragEnabled: true`** (`storageBackend: "lancedb"`): ativa `LanceDbMemoryProvider` com banco isolado em `data/characters/<id>/memory/lancedb` e tabela `memories_<id>`. O modelo de embeddings ONNX (`local-embedder.js`) compartilha pesos em cache global estático (`globalThis.__SHARED_EMBEDDER_CACHE__`) para evitar duplicação de RAM.
- **`ragEnabled: false`** (ou `storageBackend: "none"`): ativa `NullMemoryProvider` (Null Object Pattern). Nenhuma busca vetorial ou leitura de vault ocorre nos turnos de chat, zerando I/O de disco e inferência ONNX para bots leves.

---

## 3. Como Selecionar ou Isolar um Personagem em Runtime

Há duas formas suportadas pelas rotas da API (`/api/chat`, `/api/tts`, `/api/memory*`, `/api/personality`, `/api/bond*`, `/api/mood*`, `/api/agent/memory*`):

1. **Por requisição (Multi-Tenant concorrente)** — envie o cabeçalho HTTP `x-character-id: <characterId>`:
   ```http
   POST /api/chat
   x-character-id: luna-cyber
   Content-Type: application/json

   { "message": "Status da órbita?" }
   ```
   - Um `x-character-id` inválido (ex.: contendo `../`) retorna HTTP `400`.
   - Omitir o cabeçalho usa o personagem ativo no servidor (`usami-classic` por padrão).

2. **Alternância Global via Endpoints `/api/characters*`** (requer `x-usami-token`):
   - `GET /api/characters`: lista todos os manifestos válidos encontrados em `data/characters/` e o `activeCharacterId` atual.
   - `GET /api/characters/active`: devolve o `characterId` e o manifesto ativo.
   - `POST /api/characters/active` com `{ "characterId": "luna-cyber" }`: troca o personagem ativo sem reiniciar o processo Node.js.
   - No cliente desktop (`usami-desktop`), `UsamiApiClient::set_active_character("luna-cyber")` ou `USAMI_CHARACTER_ID=luna-cyber` configura automaticamente o cabeçalho `x-character-id`.
