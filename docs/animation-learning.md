# Sistema de animação autônoma e aprendizagem

Documento de entrega das Fases 3–5. O que está aqui é o que **roda neste
computador**, com o que foi **medido** — separado explicitamente do que ainda
depende de olho humano.

## Módulos e onde vivem

| Módulo do brief | Onde está | Estado |
| --- | --- | --- |
| A — Capability Registry | `src/capability-manifest.js` (Fase anterior) | em uso: o planner só oferece o que o manifesto declara |
| B — Runtime Controller determinístico | `src/motion-sequence.js`, `src/sequence-shapes.js`, `src/motion-director.js`, `src/vrm-*.js` | em uso: o avatar executa `play_sequence` pela allowlist |
| C — Planner Agent | `src/animation-planner.js` + `POST /api/plan` | determinístico, sem LLM, auditável |
| D — Tutorial Ingestion Pipeline | `tools/ingest/` (Python) → `data/ingest/<src-id>/ficha.json` | 38 testes; round-trip real feito com vídeo de 13 s |
| E — Knowledge Base de técnicas | `src/technique-schema.js`, `src/technique-store.js`, `src/technique-index.js`, `src/technique-docs.js` | JSON = verdade; SQLite = índice derivado; Obsidian = camada documental |
| F — Motor de experimentação/avaliação | `src/motion-evaluation.js`, `src/motion-experiments.js`, `scripts/run-motion-experiments.mjs` | métricas objetivas separadas do veredito visual |
| G — Memória de aprendizagem | `src/learning-memory.js` (`data/learning.json`) | separada de `data/memory.json` (conversa/afinidade) |
| n8n (assíncrono) | `infra/n8n-local/workflows/Usami - Revisao de Tecnicas (agendado).json` | criado, **inativo**; nunca emite movimento |

## Fluxo

```text
material externo (mp4/srt/txt/wav)
   │  tools/ingest (Python, ffmpeg + faster-whisper, CPU, local)
   ▼
data/ingest/src-<12hex>/ficha.json      ← contrato usami.ingest.v1, sha256, dedupe
   │  POST /api/technique {sourceId}    ← modelo só ESTRUTURA; sanitize valida
   ▼
data/techniques/tc-<12hex>.json         ← contrato usami.technique.v1 (fonte da verdade)
   ├─ data/techniques-index.sqlite      ← índice derivado, descartável (FTS5/LIKE)
   ├─ vault/.../Inbox/Automations/Techniques/<tc>.md   ← nota documental (opt-in)
   └─ POST /api/plan {intent,...}       ← planner determinístico lê a base
          │                                + data/learning.json (aprendizagem)
          ▼
      actions → motion director → avatar  (só o que o manifesto permite)

experimentos: scripts/run-motion-experiments.mjs --learn
   métricas objetivas → data/experiments.json → data/learning.json → score do planner
```

## Contratos

- **`usami.ingest.v1`** (ficha): `id` = `src-<12 hex>` derivado do sha256 do
  material; `source.path` é só o nome do arquivo; transcrição, frames e avisos
  são dados, nunca caminho.
- **`usami.technique.v1`** (técnica): `id` = `tc-<12 hex>` derivado de
  (sources ordenados + nome) — a mesma fonte e o mesmo nome dão o mesmo id, e
  **não existe técnica sem fonte**. Vocabulário aceito: `shape` (as shapes do
  runtime, com o `request` já clampado), `gesture` (allowlist) e `clip`. Keyframe
  cru, nome de osso ou gesto inventado não entram: no caminho do modelo são
  descartados com motivo; na leitura da base são **erro** (modo estrito).
- **Ciclo de vida**: `proposta → validada | rejeitada → obsoleta`. O planner só
  consome `validada`. Aprovar é ato de **pessoa**: `POST /api/technique` com
  `status: "validada"` reescreve a mesma id. Automação não aprova.

## Travas (e por que existem)

- Material externo é **dado**, não instrução: rotulado assim no prompt; a IA não
  executa código nem ordem vindo de tutorial.
- `sourceId`/`id` são validados por regex **antes** de virar caminho de arquivo
  (`../../vault/segredo` não abre porta nenhuma).
- Todo processo externo (ffmpeg/ffprobe) roda com `argv` + `shell=False`,
  timeout e teto de bytes; decodificação de áudio tem teto de 64 MB.
- Toda escrita é atômica (tmp + rename): ficha, técnica, índice, nota, memória.
- Corpo HTTP com limite, origem na allowlist, `Content-Type` conferido, timeout
  no modelo (504) e ausência de provedor (503) — nunca espera indefinido.
- Obsidian: só escreve dentro de `.../vault/.../Inbox/Automations/Techniques`
  (a regra do vault é "automação escreve somente em `Inbox/Automations/`"), com
  nome de arquivo derivado do id + slug sanitizado, e só sobrescreve nota cujo
  frontmatter declare exatamente aquela técnica.
- SQL do índice usa sempre parâmetros vinculados; query do usuário vira texto
  normalizado `[a-z0-9]`.

## Rodando (tudo local, sem serviço externo obrigatório)

```bash
# 1) ingerir um material (venv com faster-whisper; ver tools/ingest/README.md)
python tools/ingest/ingest.py -i caminho/do/tutorial.mp4 --out data/ingest

# 2) ficha → técnica (com o modelo que já existe na máquina, ou sem modelo)
curl -s -X POST http://127.0.0.1:8787/api/technique \
  -H 'Content-Type: application/json' -H 'Origin: http://127.0.0.1:5173' \
  -d '{"sourceId":"src-24772342f063"}'
#   sem provedor de LLM configurado → 503; envie "technique":{...} estruturado
#   pelo operador e o resto do caminho (validação + gravação) é idêntico.

# 3) buscar na base (índice SQLite) e recuperar com proveniência
curl -s 'http://127.0.0.1:8787/api/techniques?q=aceno'      # score + motivo
curl -s 'http://127.0.0.1:8787/api/technique?id=tc-...&...'  # técnica completa

# 4) nota documental no vault (opt-in, explícito)
curl -s -X POST http://127.0.0.1:8787/api/technique/note \
  -H 'Content-Type: application/json' -H 'Origin: http://127.0.0.1:5173' \
  -d '{"id":"tc-...","sourceId":"src-..."}'

# 5) experimentos alimentando a aprendizagem (CPU, offline)
node scripts/run-motion-experiments.mjs --shape wave-arm --per-shape 6 --learn

# 6) o planner escolhe a partir da base + história (responde ações p/ o director)
curl -s -X POST http://127.0.0.1:8787/api/plan \
  -H 'Content-Type: application/json' -H 'Origin: http://127.0.0.1:5173' \
  -d '{"intent":"wave","text":"acena pra mim","capabilities":{"sequences":true,"gestures":["wave"],"clips":[]}}'

curl -s 'http://127.0.0.1:8787/api/learning' -H 'Origin: http://127.0.0.1:5173'   # auditoria
```

## Custo medido (não estimado)

| Item | Número |
| --- | --- |
| Ingestão de 1 vídeo de 13 s (transcrição + 4 frames) | 4,6 s, pico de **221 MB de RAM**, 61 KB por ficha+frames |
| Modelo de transcrição (`tiny`, CPU) | ~150 MB em cache de disco; **VRAM: zero** (roda em CPU por decisão de custo) |
| Rede na ingestão | nenhuma (`local_files_only=True`; baixar o modelo é ato explícito com `--baixar-modelo`) |
| Índice SQLite (1 técnica) | 64 KB em disco; ~1 MB de RSS para abrir/indexar no processo Node |
| Técnica JSON | 1,4 KB |
| `data/learning.json` (1 registro) | 818 B |
| Rodada de experimentos (13 candidatos) | 8 ms de CPU, zero rede, zero GPU |
| API de LLM | Nemotron via a chave **já existente** na máquina; nenhuma conta nova, nada pago introduzido por este trabalho. O caminho `technique` do operador funciona com zero rede. |

## Cobertura de testes

`npm test` roda tudo: **459 testes** (279 unit, 34 chat/n8n, 65 técnica+KB+planner,
39 memória+planner, 38 Python de ingestão, 4 sites). Por eixo:

| Eixo | Onde |
| --- | --- |
| contrato da técnica (ids, tetos, allowlist, round-trip, modo estrito) | `tests/technique-schema.test.mjs` (18) |
| rota HTTP: validação antes de gravar, dry-run, origem/content-type/tamanho, timeout, 502/503/504/422 | `tests/technique-server.test.mjs` (15) |
| índice: refresh incremental, arquivo adulterado reportado, injeção de SQL, filtros, FTS vs LIKE | `tests/technique-index.test.mjs` (22) |
| nota Obsidian: frontmatter escapado, nome de arquivo sanitizado, subárvore do vault, nota alheia intocável | `tests/technique-docs.test.mjs` (21) |
| integração KB→planner pelas rotas (busca, nota, plano, veredito humano) | `tests/kb-planner-server.test.mjs` (10) |
| memória de aprendizagem (validação de entrada, FIFO, arquivo corrompido preservado) | `tests/learning-memory.test.mjs` (18) |
| planner (determinismo, capacidades, teto de ações, rejeição com motivo, provider) | `tests/animation-planner.test.mjs` (21) |
| ingestão Python (dedupe, schema, ffmpeg sem shell, tetos, legendas, CLI) | `tools/ingest/tests/test_ingest.py` (38) |
| métricas objetivas e experimentos (Fase 2, já cobriam) | `tests/motion-evaluation.test.mjs`, `tests/motion-experiments.test.mjs` |

## O que foi verificado de verdade nesta máquina

- Ingestão real: `tmp/ingest-demo/tutorial.mp4` (13 s, 320×240) → ficha
  `src-24772342f063` com transcrição faster-whisper e 4 frames; reprocessar sem
  `--forcar` é deduplicado pelo sha256.
- Round-trip com o modelo real: `POST /api/technique` →
  `tc-9fe76b5b8d9e "Levantar e Acenar Braço Direito"` com `reach` + `wave-arm`
  clampados, gravado e recuperado por `GET /api/technique?id=` com proveniência.
- Índice: `refresh` → `{total:1, added:1, invalid:0}`, backend `fts5`; busca por
  tag/shape/sourceId respondendo; arquivo com shape inventada some do índice e o
  `GET` direto responde 404 "técnica armazenada inválida".
- Nota documental: escrita no vault **falso** em temp (`.../Inbox/Automations/
  Techniques/tc-9fe76b5b8d9e - levantar-e-acenar-braco-direito.md`); regravar a
  mesma técnica não cria arquivo paralelo. **Nenhuma nota foi escrita no vault
  real ainda.**
- Aprendizagem: `--learn` mediu o motion da própria técnica e registrou em
  `data/learning.json` (`tc-9fe76b5b8d9e`, tentativas 1, melhor 100).
- Planner: com a técnica em `proposta`, o plano vem `fallback` (determinístico) —
  travado por teste de rota; em teste, a mesma base promovida a `validada` produz
  `source: "kb"` e `play_sequence` de `wave-arm`.

## O que NÃO está provado (precisa de você)

1. **Validação visual.** Métrica alta não significa que ficou bom. O veredito
   humano (`aprovado | ajustar | reprovado`) ainda não foi dado para nenhuma
   técnica real: `GET /api/learning` mostra `visuallyJudged: 0` no aceno real.
   Rodar `npm run dev`, pedir "acena", ver o avatar e registrar o veredito em
   `POST /api/learning/verdict` é a etapa que fecha o loop de verdade.
2. **Aprovação humana da técnica real.** `tc-9fe76b5b8d9e` segue `proposta`; é
   decisão sua promovê-la a `validada` (enquanto isso o planner usa o fallback).
3. **Nota no vault real.** O mecanismo está testado contra um vault temporário;
   gravar no vault de verdade é seu (o alvo padrão é
   `Usami/Inbox/Automations/Techniques`).
4. **n8n.** O workflow está criado como export JSON e **não foi publicado nem
   executado** contra o servidor: a forma exata como o n8n entrega o erro de um
   `httpRequest` com `continueOnFail` e o comportamento do `readWriteFile` no
   mount do vault só confirmam em runtime.
5. **Escala.** Base com 1 técnica; índice, busca e planner não foram medidos com
   centenas de técnicas.
6. **Concorrência de escrita.** `learning.json` e o índice assumem um escritor;
   dois processos gravando ao mesmo tempo perdem uma escrita (last-write-wins).

## Decisões registradas

- **Sem LangGraph** e sem dependência nova: o runtime continua Node puro +
  `node:sqlite` embutido; o pipeline Python usa stdlib + faster-whisper.
- **Embeddings adiados**: a busca é FTS5/LIKE sobre texto normalizado. O ponto de
  entrada é `technique-index.search`, então trocar depois não reescreve a rota.
- **Modelos das APIs que já existiam**: nenhuma conta ou chave nova; o caminho
  completo também funciona offline pelo campo `technique` do operador.
- **n8n não move o avatar**: só tarefa agendada de casa da base, idempotente por
  data do lote + chave `id|status`, e nunca chama endpoint de escrita.
