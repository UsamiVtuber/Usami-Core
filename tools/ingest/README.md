# Ingestão de tutoriais (Fase 3)

Transforma material que já está no disco — vídeo, áudio, legenda, texto — em uma
**ficha de ingestão** (`ficha.json`) válida e registrada em índice. A ficha é o
único objeto que a base de conhecimento (Fase 4) aceita como entrada.

## O que este pipeline faz, e o que se recusa a fazer

| faz | recusa |
| --- | --- |
| lê arquivos LOCAIS listados na linha de comando | baixar material da internet |
| transcreve em CPU com faster-whisper (modelo já em cache) | baixar pesos sem `--baixar-modelo` |
| extrai poucos frames com ffmpeg (teto de quantidade e largura) | gerar vídeo/foto por IA |
| dedupe por sha256 **antes** de qualquer trabalho pesado | retranscrever o mesmo material |
| valida a ficha e só então escreve (tmp + rename) | escrever ficha inválida no índice |
| registra os limites usados na própria ficha | confiar no conteúdo do material |

O material externo é **dado não confiável**. Nada aqui executa instruções de
tutorial, scripts embutidos, links ou código que venha do arquivo — o pipeline
nem abre o conteúdo como coisa executável. A etapa que usa LLM (transformar
transcript em técnica) é outra: `POST /api/technique` no servidor local da Usami,
que só recebe texto já validado.

## Instalação

```bash
cd tools/ingest
python -m venv .venv && .venv/Scripts/activate      # Windows
pip install -r requirements.txt
ffmpeg -version && ffprobe -version                  # binários de sistema, no PATH
```

Requisitos verificados: Python 3.12.10, faster-whisper 1.2.1, numpy 2.5.3,
ffmpeg/ffprobe 9.0.2. `faster-whisper` puxa `ctranslate2`/`onnxruntime` sozinho.
O PyAV (`av`) vem como dependência transitória mas **não é usado**: a decodificação
de áudio é feita pelo ffmpeg do passo acima (ver `media.decode_audio`), o que nos
libera de uma incompatibilidade real entre `av 19.0.2` e `faster-whisper 1.2.1`.

## Uso

```bash
# um vídeo, saída padrão em usami/data/ingest/ (gitignored)
python ingest.py --input ../../tmp/tutorial.mp4 --titulo "VRM rig: aceno" --max-frames 6

# só ver o que seria escrito (nada toca o disco)
python ingest.py --input ../../tmp/tutorial.mp4 --seco

# uma pasta inteira, com teto de varredura
python ingest.py --input ../../tmp --max-files 20 --threads 4

# legenda/texto: nenhuma transcrição, nenhum frame, custo quase zero
python ingest.py --input legenda.srt --titulo "notas do curso"

# tempos de frame explícitos (segundos) quando o tutorial tem passos conhecidos
python ingest.py --input aula.mp4 --tempos 2,17,41,58
```

Flag `--forcar` reingerir material já no índice. `--sem-transcricao` e
`--sem-frames` reduzem o custo quando só interessa um dos canais. Ajustes de
saída e de modelo: `--out` (padrão `usami/data/ingest`), `--modelo` (`tiny`),
`--idioma` (`pt`, vazio = detectar) e `--max-largura` (640 px).

## Custo medido (não estimado)

Num notebook Windows x64, com `tiny` em cache e vídeo sintético de 13 s (320x240,
15 fps, com fala):

| métrica | valor medido |
| --- | --- |
| tempo de `ingest.py` completo (probe + transcrição + 4 frames) | 4,6 s |
| pico de RAM do processo | 221 MB |
| footprint do modelo `tiny` no cache Hugging Face | ~150 MB |
| resultado de uma ficha de vídeo (ficha + 4 frames jpg) | 61 KB |
| rede usada | nenhuma |

Extrapolação (não medida): `base` ~2x o RAM de `tiny`, `small` ~4x; 16 kHz mono
float32 são 64 kB por segundo de áudio, e o teto de decode é 64 MB (~17 min de
áudio por material). `--max-segundos` (padrão 900) e `--max-bytes` (padrão 500 MB)
cortam antes de qualquer trabalho pesado.

VRAM: **zero** — tudo roda em CPU/int8 de propósito.

## Saída

```
usami/data/ingest/
  index.json                 # {version: 1, entries: {sha256: {...}}}
                             # sha256 -> {id, kind, title, createdAt, ficha, bytes}
  src-24772342f063/
    ficha.json
    frames/frame-000.jpg ... # só quando há vídeo
```

`index.json` é a memória de dedupe. Se ele estiver corrompido, o pipeline parte
de um índice vazio **sem apagar as fichas existentes** — reingerir é sempre
seguro, e `id` é derivado do sha256, então a mesma ficha cai no mesmo lugar.

## Contrato da ficha (`usami.ingest.v1`)

Campos: `schema`, `id` (`src-<12 hex do sha256>`), `createdAt` (ISO-8601 UTC),
`source{kind,path,originalPath,sha256,bytes,title}`, `media{durationMs,width,
height,fps,hasAudio}` (null = não se aplica, ex.: largura em áudio), `transcript
{engine,model,language,text,segments,truncated}`, `frames[{atMs,path,sha256}]`,
`technique` (sempre `null` aqui; preenchido pela etapa de estruturação),
`warnings`, `limits`.

Travas do schema (`ficha.py`), todas rejeitando a ficha inteira antes de escrever:
ficha ≤ 5 MB, ≤ 2000 segmentos, ≤ 64 frames, ≤ 200 000 caracteres de texto,
`engine` restrito a `faster-whisper|arquivo|legenda`, caminhos de frame sempre
relativos ao diretório da ficha (absoluto ou `..` = erro), `source.path` é só o
nome do arquivo, `endMs >= startMs`, id com formato exato.

## Testes

```bash
python tests/test_ingest.py            # ou: python -m unittest discover -s tests -t .
```

38 testes, stdlib puro, sem ffmpeg nem whisper reais: ffprobe/ffmpeg/whisper são
injetados. Cobrem o schema (rejeições forjadas), o parser de legenda, os tetos de
bytes/duração/frames, dedupe antes do trabalho pesado, escrita atômica, índice
corrompido, isolamento de falha por arquivo no lote, `--seco`, `--forcar`, e o
contrato de segurança dos subprocessos (sem shell, com timeout, erro amigável
para binário ausente/timeout).

O que os testes **não** provam: a qualidade da transcrição (depende do material e
do modelo) e o conteúdo visual dos frames — isso é julgamento humano, registrado
na Fase 4, não aqui.

## Limitações conhecidas

- Áudio 16 kHz mono é o que o whisper quer; qualquer outra coisa é o ffmpeg quem
  converte. Se o material não tiver faixa de áudio, a ficha fica só com frames e
  um aviso.
- `tiny` erra termos técnicos. A ficha guarda o texto cru com `engine` e `model`
  registrados, então a Fase 4 pode decidir re-transcrever com modelo maior.
- Este pipeline não toca o avatar, não conhece `motion-sequence.js` e não decide
  movimento nenhum. Ele só produz documento.
