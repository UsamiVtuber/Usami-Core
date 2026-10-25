"""Fase 3: acesso a binários externos (ffprobe/ffmpeg) e ao whisper local.

Regras de segurança que este módulo não negocia:
  - subprocess SEMPRE com lista de argumentos e `shell=False`; o caminho do
    arquivo nunca é interpolado em string de shell;
  - timeout em toda chamada externa (um arquivo corrompido não pendura a coleta);
  - saída limitada: ffprobe tem teto de bytes lidos, frames têm teto de quantidade;
  - o modelo de transcrição é carregado com `local_files_only=True` por padrão —
    material de tutorial nenhum justifica download automático de pesos; baixar é
    decisão explícita de quem roda o comando.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

from ficha import sha256_of_file

FFPROBE_TIMEOUT_S = 30
FFMPEG_TIMEOUT_S = 60
FFMPEG_DECODE_TIMEOUT_S = 120
MAX_PROBE_OUTPUT = 2 * 1024 * 1024
# PCM float32 mono a 16 kHz = 64 kB/s; 64 MB cobrem ~17 min e são o teto de RAM
# que este pipeline admite pagar por um material de tutorial.
MAX_DECODED_AUDIO_BYTES = 64 * 1024 * 1024


class IngestError(RuntimeError):
    """Erro de operação esperado (binário ausente, timeout, modelo não baixado)."""


def _execute(argv: list[str], timeout_s: float) -> subprocess.CompletedProcess:
    if not argv:
        raise IngestError("comando vazio")
    return subprocess.run(argv, capture_output=True, timeout=timeout_s, check=False)


def _call(run, argv: list[str], timeout_s: float) -> subprocess.CompletedProcess:
    """Toda fronteira com processo externo falha como IngestError — inclusive
    quando o `run` é injetado por teste: o contrato do erro não muda."""
    try:
        return run(argv, timeout_s)
    except FileNotFoundError as error:
        raise IngestError(f"binário não encontrado: {argv[0]}") from error
    except subprocess.TimeoutExpired as error:
        raise IngestError(f"timeout após {timeout_s}s: {' '.join(argv[:3])}") from error


def probe(media_path: str | Path, *, binary: str = "ffprobe", run=_execute) -> dict:
    """Metadados mínimos (duração, largura, altura, fps) a partir do primeiro vídeo."""
    argv = [
        binary, "-hide_banner", "-loglevel", "error",
        "-print_format", "json", "-show_format", "-show_streams", str(media_path),
    ]
    result = _call(run, argv, FFPROBE_TIMEOUT_S)
    if result.returncode != 0:
        detail = (result.stderr or b"")[:400].decode("utf-8", "replace").strip()
        raise IngestError(f"ffprobe falhou ({result.returncode}): {detail}")
    raw = (result.stdout or b"")[:MAX_PROBE_OUTPUT]
    try:
        data = json.loads(raw.decode("utf-8", "replace"))
    except ValueError as error:
        raise IngestError(f"saída do ffprobe não é JSON: {error}") from error

    info: dict = {}
    duration = (data.get("format") or {}).get("duration")
    try:
        if duration is not None:
            info["durationMs"] = round(float(duration) * 1000)
    except (TypeError, ValueError):
        pass
    video = next((stream for stream in data.get("streams", []) if stream.get("codec_type") == "video"), None)
    if isinstance(video, dict):
        if isinstance(video.get("width"), int):
            info["width"] = video["width"]
        if isinstance(video.get("height"), int):
            info["height"] = video["height"]
        rate = video.get("avg_frame_rate") or video.get("r_frame_rate")
        if isinstance(rate, str) and rate not in ("0/0", ""):
            numerator, _, denominator = rate.partition("/")
            try:
                fps = float(numerator) / float(denominator or 1)
                if 0 < fps < 240:
                    info["fps"] = round(fps, 3)
            except (TypeError, ValueError, ZeroDivisionError):
                pass
    audio = next((stream for stream in data.get("streams", []) if stream.get("codec_type") == "audio"), None)
    info["hasAudio"] = isinstance(audio, dict)
    return info


def frame_times(duration_ms: int | None, max_frames: int, default_seconds: float = 3.0) -> list[float]:
    """Tempos (s) distribuídos ao longo do vídeo; sem duração, amostra os primeiros."""
    cap = max(1, max_frames)
    if not duration_ms or duration_ms <= 0:
        return [round(index * default_seconds, 3) for index in range(cap)]
    seconds = duration_ms / 1000
    if seconds <= cap:
        return [round(seconds * (index + 0.5) / cap, 3) for index in range(cap)]
    step = seconds / cap
    return [round(index * step, 3) for index in range(cap)]


def extract_frames(
    media_path: str | Path,
    out_dir: str | Path,
    *,
    times_s: list[float],
    binary: str = "ffmpeg",
    max_width: int = 640,
    run=_execute,
) -> list[dict]:
    """Um frame por tempo pedido, redimensionado. Retorna caminhos RELATIVOS ao
    diretório da ficha, com hash — a ficha é portátil e o índice sabe o que já viu."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    frames: list[dict] = []
    failures = 0
    last_error = ""
    for index, time_s in enumerate(times_s):
        target = out_dir / f"frame-{index:03d}.jpg"
        # as aspas dentro de -vf são do parser de filtergraph do ffmpeg: sem elas
        # a vírgula de min(640,iw) é lida como separador de filtro e o frame falha
        argv = [
            binary, "-hide_banner", "-loglevel", "error", "-y",
            "-ss", f"{float(time_s):.3f}", "-i", str(media_path),
            "-frames:v", "1", "-vf", f"scale='min({int(max_width)},iw)':-2",
            "-q:v", "3", str(target),
        ]
        result = _call(run, argv, FFMPEG_TIMEOUT_S)
        if result.returncode != 0 or not target.exists() or target.stat().st_size == 0:
            failures += 1
            last_error = (result.stderr or b"")[:300].decode("utf-8", "replace").strip()
            continue
        digest, _ = sha256_of_file(target)
        frames.append({"atMs": round(float(time_s) * 1000), "path": f"{out_dir.name}/{target.name}", "sha256": digest})
    if failures and not frames:
        raise IngestError(f"ffmpeg não produziu nenhum dos {len(times_s)} frames: {last_error}")
    return frames


def load_whisper(model_name: str, *, local_files_only: bool = True, cpu_threads: int = 4):
    """Carrega o modelo em CPU/int8. `local_files_only` é a trava anti-download."""
    try:
        from faster_whisper import WhisperModel
    except ImportError as error:
        raise IngestError(
            "faster-whisper não está instalado; rode `pip install -r requirements.txt` em tools/ingest"
        ) from error
    try:
        return WhisperModel(
            model_name,
            device="cpu",
            compute_type="int8",
            cpu_threads=cpu_threads,
            local_files_only=local_files_only,
        )
    except Exception as error:  # huggingface_hub lança vários tipos quando falta o peso
        hint = ""
        if local_files_only:
            hint = f" (modelo {model_name!r} não está em cache; baixe de propósito com --baixar-modelo)"
        raise IngestError(f"não consegui carregar o modelo {model_name!r}{hint}: {error}") from error


def decode_audio(media_path: str | Path, *, binary: str = "ffmpeg", sample_rate: int = 16000,
                 run=_execute) -> bytes:
    """Faixa de áudio decodificada em PCM float32 mono, crua (sem numpy aqui).

    Decodificamos nós mesmos em vez de usar o atalho do faster-whisper (PyAV): o
    par faster-whisper/av tem incompatibilidades de versão conhecidas e o decode
    pelo ffmpeg nos dá timeout e teto de tamanho controlados por este pipeline.
    """
    argv = [
        binary, "-hide_banner", "-loglevel", "error", "-i", str(media_path),
        "-vn", "-ac", "1", "-ar", str(int(sample_rate)), "-f", "f32le", "-",
    ]
    result = _call(run, argv, FFMPEG_DECODE_TIMEOUT_S)
    if result.returncode != 0:
        detail = (result.stderr or b"")[:400].decode("utf-8", "replace").strip()
        raise IngestError(f"ffmpeg não decodificou o áudio ({result.returncode}): {detail}")
    payload = result.stdout or b""
    if not payload:
        raise IngestError("faixa de áudio vazia")
    if len(payload) > MAX_DECODED_AUDIO_BYTES:
        raise IngestError(
            f"áudio decodificado com {len(payload)} bytes acima do teto de "
            f"{MAX_DECODED_AUDIO_BYTES} (--max-segundos menor, ou corte o material)"
        )
    return payload


def transcribe(
    media_path: str | Path,
    *,
    model_name: str = "tiny",
    language: str | None = "pt",
    local_files_only: bool = True,
    max_segments: int = 600,
    cpu_threads: int = 4,
    model=None,
    decoder=decode_audio,
) -> dict:
    """Transcrição local. O gerador do whisper é materializado com teto de
    segmentos: um vídeo longo não pode estourar a memória nem o tamanho da ficha."""
    import numpy as np  # já é dependência do faster-whisper; só no caminho de transcrição

    model = model if model is not None else load_whisper(
        model_name, local_files_only=local_files_only, cpu_threads=cpu_threads
    )
    audio = np.frombuffer(decoder(media_path), dtype=np.float32)
    raw_segments, info = model.transcribe(
        audio,
        language=language,
        beam_size=1,
        vad_filter=True,
        word_timestamps=False,
    )
    segments: list[dict] = []
    truncated = False
    for segment in raw_segments:
        if len(segments) >= max_segments:
            truncated = True
            break
        text = (segment.text or "").strip()
        if not text:
            continue
        segments.append({
            "startMs": round(float(segment.start) * 1000),
            "endMs": round(float(segment.end) * 1000),
            "text": text[:2000],
        })
    return {
        "engine": "faster-whisper",
        "model": getattr(info, "model_name", None) or model_name,
        "language": getattr(info, "language", None) or language or "",
        "text": " ".join(segment["text"] for segment in segments)[: 200_000],
        "segments": segments,
        "truncated": truncated,
    }
