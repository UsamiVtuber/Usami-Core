"""Fase 3: pipeline de ingestão de tutoriais → ficha de conhecimento.

Uso normal (a partir de tools/ingest):

    python ingest.py --input ../../tmp/tutorial.mp4
    python ingest.py --input ../downloads --max-files 20 --modelo tiny
    python ingest.py --input legenda.srt --titulo "VRM rig: hand tracking"

O que isto faz, e o que se recusa a fazer:
  - aceita vídeo, áudio, legenda (.srt/.vtt) e texto (.txt/.md) LOCAIS;
  - transcreve em CPU com faster-whisper, usando o modelo que já está em cache
    (`local_files_only` por padrão — baixar peso é decisão explícita, --baixar-modelo);
  - extrai poucos frames com ffmpeg (teto de quantidade e de largura);
  - dedupe por sha256 do material: o mesmo arquivo nunca vira duas fichas;
  - escreve `<saida>/<id>/ficha.json` + `<saida>/index.json`, ambos validados
    antes de tocar no disco e com escrita atômica;
  - NÃO executa nada que venha do material, NÃO baixa da internet, NÃO toca no
    avatar e NÃO lê chave de API. A estruturação em técnica (o passo que usa LLM)
    é outra etapa: `POST /api/technique` no servidor local da Usami.
"""

from __future__ import annotations

import argparse
import sys
from dataclasses import dataclass, field
from pathlib import Path

from ficha import (
    SCHEMA_VERSION,
    read_json,
    source_id,
    sha256_of_file,
    utc_now,
    validate_ficha,
    write_json_atomic,
)
from media import IngestError, extract_frames, frame_times, probe, transcribe

VIDEO_EXT = {".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v", ".mpg", ".mpeg", ".gif"}
AUDIO_EXT = {".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".wma"}
SUBTITLE_EXT = {".srt", ".vtt"}
TEXT_EXT = {".txt", ".md"}

MAX_BYTES_DEFAULT = 500 * 1024 * 1024
MAX_SECONDS_DEFAULT = 900
MAX_FRAMES_DEFAULT = 8
MAX_TEXT_CHARS = 200_000
MAX_FILES_DEFAULT = 50
INDEX_VERSION = 1


@dataclass
class Options:
    out_dir: Path
    whisper_model: str = "tiny"
    language: str = "pt"
    allow_model_download: bool = False
    with_transcribe: bool = True
    with_frames: bool = True
    max_seconds: float = MAX_SECONDS_DEFAULT
    max_bytes: int = MAX_BYTES_DEFAULT
    max_frames: int = MAX_FRAMES_DEFAULT
    max_width: int = 640
    times: list[float] | None = None
    title: str | None = None
    force: bool = False
    dry_run: bool = False
    cpu_threads: int = 4


def classify(path: Path) -> str | None:
    suffix = path.suffix.lower()
    if suffix in VIDEO_EXT:
        return "video"
    if suffix in AUDIO_EXT:
        return "audio"
    if suffix in SUBTITLE_EXT:
        return "subtitles"
    if suffix in TEXT_EXT:
        return "text"
    return None


def read_text(path: Path, max_chars: int = MAX_TEXT_CHARS) -> str:
    # erros="replace": material externo é dado, não contrato de encoding.
    text = path.read_text(encoding="utf-8", errors="replace")
    return text[:max_chars]


def parse_subtitles(raw: str) -> list[dict]:
    """Parser tolerante de SRT/VTT. Nunca lança: o que não é timing não é legenda."""
    segments: list[dict] = []
    buffer: list[str] = []
    start_ms = 0
    end_ms = 0
    timing_seen = False

    def stamp(value: str) -> int:
        # "00:01:02,500" (srt) ou "00:01:02.500" (vtt), com ou sem hora
        head, _, tail = value.replace(",", ".").partition(".")
        parts = head.split(":")
        seconds = 0
        for part in parts:
            if part.isdigit():
                seconds = seconds * 60 + int(part)
        millis = int((tail[:3] or "0").ljust(3, "0")) if tail[:3].isdigit() else 0
        return seconds * 1000 + millis

    def flush() -> None:
        if not timing_seen:
            buffer.clear()  # prosa sem nenhum timing: não é uma cue, é lixo
            return
        text = " ".join(buffer).strip()
        buffer.clear()
        if text:
            segments.append({"startMs": start_ms, "endMs": end_ms or start_ms, "text": text[:2000]})

    for line in raw.splitlines():
        stripped = line.strip()
        if not stripped or stripped.upper() == "WEBVTT" or stripped.startswith(("NOTE", "STYLE", "Kind:", "Language:")):
            if stripped == "" and buffer:
                flush()
            continue
        if "-->" in stripped:
            if buffer:
                flush()
            left, _, right = stripped.partition("-->")
            start_ms = stamp(left.strip().split(" ")[-1])
            end_ms = stamp(right.strip().split(" ")[0])
            timing_seen = True
            continue
        if stripped.isdigit() and not buffer:
            continue  # índice de cue do SRT
        buffer.append(stripped)
    flush()
    return segments[:2000]


def load_index(out_dir: Path) -> dict:
    index = read_json(out_dir / "index.json", default=None)
    if not isinstance(index, dict) or not isinstance(index.get("entries"), dict):
        return {"version": INDEX_VERSION, "entries": {}}
    return index


def update_index(out_dir: Path, sha256: str, entry: dict) -> dict:
    index = load_index(out_dir)
    index["entries"][sha256] = entry
    write_json_atomic(str(out_dir / "index.json"), index)
    return index


def build_ficha(
    source_path: Path,
    options: Options,
    *,
    prober=probe,
    frame_extractor=extract_frames,
    transcriber=transcribe,
    now=utc_now,
) -> dict:
    """Uma ficha validada. Qualquer problema de forma aborta antes de escrever."""
    kind = classify(source_path)
    if kind is None:
        raise IngestError(f"tipo de arquivo não suportado: {source_path.suffix or source_path.name}")
    if not source_path.is_file():
        raise IngestError(f"arquivo não encontrado: {source_path}")

    digest, size = sha256_of_file(source_path)
    if size > options.max_bytes:
        raise IngestError(f"material com {size} bytes acima do teto de {options.max_bytes} (--max-bytes)")

    identifier = source_id(digest)
    warnings: list[str] = []
    media: dict = {}

    if kind in ("video", "audio"):
        media = prober(source_path)
        duration_ms = media.get("durationMs")
        if isinstance(duration_ms, (int, float)) and duration_ms > options.max_seconds * 1000:
            raise IngestError(
                f"duração {round(duration_ms / 1000)}s acima do teto de {options.max_seconds}s "
                "(--max-seconds); corte o trecho antes de ingerir"
            )
        if kind == "audio" and media.get("width"):
            kind = "video"

        transcript = None
        if options.with_transcribe:
            if media.get("hasAudio"):
                transcript = transcriber(
                    source_path,
                    model_name=options.whisper_model,
                    language=options.language or None,
                    local_files_only=not options.allow_model_download,
                    cpu_threads=options.cpu_threads,
                )
                if transcript.get("truncated"):
                    warnings.append("transcrição cortada no teto de segmentos")
            else:
                warnings.append("sem faixa de áudio: ficha fica só com frames")
        frames = []
        if options.with_frames and kind == "video":
            times = options.times if options.times else frame_times(media.get("durationMs"), options.max_frames)
            times = list(times)[: options.max_frames]
            if len(times) < len(options.times or []):
                warnings.append("tempos pedidos cortados pelo teto de frames")
            frames = frame_extractor(
                source_path,
                Path(options.out_dir) / identifier / "frames",
                times_s=times,
                max_width=options.max_width,
            )
    else:
        raw = read_text(source_path)
        if kind == "subtitles":
            segments = parse_subtitles(raw)
            text = " ".join(segment["text"] for segment in segments)[:MAX_TEXT_CHARS]
            transcript = {"engine": "legenda", "language": options.language or "", "text": text, "segments": segments}
            if not segments:
                warnings.append("legenda sem cues reconhecidas")
        else:
            transcript = {
                "engine": "arquivo",
                "language": options.language or "",
                "text": raw,
                "segments": [{"startMs": 0, "endMs": 0, "text": raw[:2000] or "(vazio)"}],
            }
        if options.with_frames:
            warnings.append("material sem vídeo: nenhum frame extraído")
        media = {"durationMs": 0, "hasAudio": False}

    ficha = {
        "schema": SCHEMA_VERSION,
        "id": identifier,
        "createdAt": now(),
        "source": {
            "kind": kind,
            "path": source_path.name,
            "originalPath": str(source_path.resolve())[:1000],
            "sha256": digest,
            "bytes": size,
            "title": (options.title or source_path.stem)[:200],
        },
        "media": media,
        "transcript": transcript,
        "frames": frames if kind == "video" else [],
        "technique": None,
        "warnings": warnings,
        "limits": {
            "maxBytes": options.max_bytes,
            "maxSeconds": options.max_seconds,
            "maxFrames": options.max_frames,
            "maxWidth": options.max_width,
            "whisperModel": options.whisper_model if options.with_transcribe else None,
            "localFilesOnly": not options.allow_model_download,
        },
    }
    errors = validate_ficha(ficha)
    if errors:
        raise IngestError("ficha inválida, nada foi escrito: " + "; ".join(errors))
    return ficha


def ingest_one(source_path: Path, options: Options, *, builder=None) -> dict:
    builder = builder or build_ficha
    out_dir = options.out_dir
    # O hash é barato comparado a transcrever um vídeo: o dedupe acontece antes
    # de qualquer trabalho pesado.
    digest, _ = sha256_of_file(source_path)
    existing = load_index(out_dir)["entries"].get(digest)
    if existing and not options.force:
        return {"status": "duplicado", "id": existing.get("id"), "sha256": digest, "ficha": existing.get("ficha")}

    built = builder(source_path, options)
    sha256 = built["source"]["sha256"]

    target_dir = out_dir / built["id"]
    target = target_dir / "ficha.json"
    if options.dry_run:
        return {"status": "dry-run", "id": built["id"], "sha256": sha256, "ficha": str(target)}
    write_json_atomic(str(target), built)
    update_index(out_dir, sha256, {
        "id": built["id"],
        "kind": built["source"]["kind"],
        "title": built["source"]["title"],
        "createdAt": built["createdAt"],
        "ficha": f"{built['id']}/ficha.json",
        "bytes": built["source"]["bytes"],
    })
    return {"status": "ingestado", "id": built["id"], "sha256": sha256, "ficha": str(target), "warnings": built["warnings"]}


def collect_inputs(inputs: list[str], max_files: int) -> list[Path]:
    found: list[Path] = []
    for item in inputs:
        path = Path(item)
        if path.is_dir():
            for child in sorted(path.iterdir()):
                if child.is_file() and classify(child) is not None:
                    found.append(child)
        elif path.is_file():
            found.append(path)
        else:
            raise IngestError(f"caminho não existe: {path}")
    if len(found) > max_files:
        raise IngestError(f"{len(found)} arquivos acima de --max-files ({max_files})")
    return found


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Ingestão local de tutoriais para a base de conhecimento da Usami.")
    parser.add_argument("--input", "-i", nargs="+", action="extend", required=True,
                        help="arquivo(s) ou pasta(s) de material (pode repetir a flag)")
    parser.add_argument("--out", "-o", default=str(Path(__file__).resolve().parents[2] / "data" / "ingest"))
    parser.add_argument("--modelo", default="tiny", help="modelo faster-whisper já em cache (tiny, base, small…)")
    parser.add_argument("--idioma", default="pt", help="código de idioma para a transcrição (vazio = detectar)")
    parser.add_argument("--titulo", default=None)
    parser.add_argument("--baixar-modelo", action="store_true", help="permitir download de pesos do whisper (padrão: proibido)")
    parser.add_argument("--sem-transcricao", action="store_true")
    parser.add_argument("--sem-frames", action="store_true")
    parser.add_argument("--max-segundos", type=float, default=MAX_SECONDS_DEFAULT)
    parser.add_argument("--max-bytes", type=int, default=MAX_BYTES_DEFAULT)
    parser.add_argument("--max-frames", type=int, default=MAX_FRAMES_DEFAULT)
    parser.add_argument("--max-largura", type=int, default=640)
    parser.add_argument("--max-files", type=int, default=MAX_FILES_DEFAULT)
    parser.add_argument("--tempos", default=None, help="tempos de frame em segundos, separados por vírgula")
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--forcar", action="store_true", help="reingerir material já no índice")
    parser.add_argument("--seco", action="store_true", help="não escreve nada no disco")
    return parser.parse_args(argv)


def _protect_streams() -> None:
    # Console Windows (cp1252) nao codifica todo UTF-8; saida esquisita do ffmpeg
    # nao pode derrubar o lote inteiro no meio de uma coleta.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except (AttributeError, ValueError):
            pass


def main(argv: list[str] | None = None) -> int:
    _protect_streams()
    args = parse_args(argv)
    times = None
    if args.tempos:
        try:
            times = [float(item) for item in args.tempos.split(",") if item.strip()]
        except ValueError:
            print("ERRO: --tempos deve ser lista de segundos separada por vírgula", file=sys.stderr)
            return 1
    options = Options(
        out_dir=Path(args.out),
        whisper_model=args.modelo,
        language=args.idioma,
        allow_model_download=args.baixar_modelo,
        with_transcribe=not args.sem_transcricao,
        with_frames=not args.sem_frames,
        max_seconds=args.max_segundos,
        max_bytes=args.max_bytes,
        max_frames=args.max_frames,
        max_width=args.max_largura,
        times=times,
        title=args.titulo,
        force=args.forcar,
        dry_run=args.seco,
        cpu_threads=max(1, args.threads),
    )
    options.out_dir.mkdir(parents=True, exist_ok=True)

    try:
        inputs = collect_inputs(args.input, args.max_files)
    except IngestError as error:
        print(f"ERRO: {error}", file=sys.stderr)
        return 1
    if not inputs:
        print("nenhum material reconhecido na entrada", file=sys.stderr)
        return 1

    failures = 0
    for path in inputs:
        try:
            result = ingest_one(path, options)
        except IngestError as error:
            failures += 1
            print(f"falha  {path.name}: {error}", file=sys.stderr)
            continue
        except Exception as error:  # nunca derruba o lote inteiro por um arquivo esquisito
            failures += 1
            print(f"falha  {path.name}: erro inesperado: {error}", file=sys.stderr)
            continue
        print(f"{result['status']:<10} {result['id']}  {path.name}  -> {result['ficha']}")
        for warning in result.get("warnings") or []:
            print(f"           aviso: {warning}")
    print(f"\n{len(inputs) - failures}/{len(inputs)} processados | índice: {options.out_dir / 'index.json'}")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
