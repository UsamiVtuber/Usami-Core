"""Fase 3: contrato da ficha de ingestão (schema v1).

A ficha é o único objeto que sai do pipeline de ingestão e o único que a base de
conhecimento (Fase 4) aceita. Material externo (vídeo, áudio, legenda, texto
colado da internet) é DADO NÃO CONFIÁVEL: nada aqui interpreta, executa ou
confia no conteúdo — só valida forma, tamanho e caminhos.

Validação é estrita e devolve lista de erros (nunca lança, nunca "conserta"
silencioso): quem chama decide descartar ou avisar. Caminhos são sempre
relativos ao diretório da ficha; caminho absoluto ou `..` é erro, porque a ficha
pode ser movida de máquina e lida por outro processo.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
from datetime import datetime, timezone

SCHEMA_VERSION = "usami.ingest.v1"
KINDS = ("video", "audio", "text", "subtitles")
TRANSCRIPT_ENGINES = ("faster-whisper", "arquivo", "legenda")

MAX_BYTES = 5 * 1024 * 1024            # uma ficha não é um banco de dados
MAX_SEGMENTS = 2000
MAX_FRAMES = 64
MAX_TEXT_CHARS = 200_000
ID_RE = re.compile(r"^src-[0-9a-f]{12}$")
SHA_RE = re.compile(r"^[0-9a-f]{64}$")
ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}")
REL_PATH_RE = re.compile(r"^(?:[\w.\- ]+/)*[\w.\- ]+$")

IMAGE_EXTENSIONS = (".jpg", ".jpeg", ".png")


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def sha256_of_file(path: str, chunk_size: int = 1024 * 1024) -> tuple[str, int]:
    """Hash em streaming: arquivos de vídeo não cabem na memória de propósito."""
    digest = hashlib.sha256()
    total = 0
    with open(path, "rb") as handle:
        while chunk := handle.read(chunk_size):
            total += len(chunk)
            digest.update(chunk)
    return digest.hexdigest(), total


def source_id(sha256: str) -> str:
    return f"src-{sha256[:12]}"


def stable_json(value) -> str:
    """JSON canônico (chaves ordenadas) — usado em assinaturas e dedupe."""
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def _is_number(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _check_relative_path(value: str) -> str | None:
    if os.path.isabs(value) or value.startswith("/") or "\\" in value:
        return "caminho deve ser relativo ao diretório da ficha"
    if ".." in value.split("/"):
        return "caminho não pode subir do diretório da ficha (..)"
    if not REL_PATH_RE.match(value):
        return "caminho tem caracteres não permitidos"
    return None


def validate_ficha(ficha) -> list[str]:
    """Devolve a lista de problemas; lista vazia = ficha aceitável."""
    errors: list[str] = []
    if not isinstance(ficha, dict):
        return ["ficha deve ser um objeto JSON"]
    if len(json.dumps(ficha, ensure_ascii=False)) > MAX_BYTES:
        errors.append(f"ficha excede {MAX_BYTES} bytes")

    if ficha.get("schema") != SCHEMA_VERSION:
        errors.append(f"schema deve ser {SCHEMA_VERSION!r}")
    if not isinstance(ficha.get("id"), str) or not ID_RE.match(ficha["id"]):
        errors.append("id deve ter o formato src-<12 hex>")
    if not isinstance(ficha.get("createdAt"), str) or not ISO_RE.match(ficha["createdAt"]):
        errors.append("createdAt deve ser ISO-8601 UTC")

    source = ficha.get("source")
    if not isinstance(source, dict):
        errors.append("source ausente")
    else:
        if source.get("kind") not in KINDS:
            errors.append(f"source.kind deve ser um de {KINDS}")
        if not isinstance(source.get("sha256"), str) or not SHA_RE.match(source["sha256"]):
            errors.append("source.sha256 inválido")
        path = source.get("path")
        if not isinstance(path, str) or not path:
            errors.append("source.path ausente")
        elif "/" in path or "\\" in path or path in (".", ".."):
            # só o nome do arquivo: a ficha não carrega a árvore de quem forneceu
            # o material, e caminho de origem fica no campo explícito originalPath
            errors.append("source.path deve ser apenas o nome do arquivo")
        else:
            problem = _check_relative_path(path)
            if problem:
                errors.append(f"source.path: {problem}")
        original = source.get("originalPath")
        if original is not None and (not isinstance(original, str) or len(original) > 1000):
            errors.append("source.originalPath deve ser texto de até 1000 caracteres")
        if not _is_number(source.get("bytes")) or source["bytes"] < 0:
            errors.append("source.bytes inválido")
        title = source.get("title")
        if title is not None and (not isinstance(title, str) or len(title) > 200):
            errors.append("source.title deve ser texto de até 200 caracteres")

    media = ficha.get("media")
    if not isinstance(media, dict):
        errors.append("media ausente")
    else:
        # null é válido e significa "não se aplica" (áudio não tem largura de vídeo)
        for key in ("durationMs", "width", "height", "fps"):
            if key in media and media[key] is not None and not _is_number(media[key]):
                errors.append(f"media.{key} deve ser número ou null")
        if "hasAudio" in media and not isinstance(media["hasAudio"], bool):
            errors.append("media.hasAudio deve ser booleano")

    transcript = ficha.get("transcript")
    if transcript is not None:
        if not isinstance(transcript, dict):
            errors.append("transcript deve ser objeto ou null")
        else:
            if transcript.get("engine") not in TRANSCRIPT_ENGINES:
                errors.append(f"transcript.engine deve ser um de {TRANSCRIPT_ENGINES}")
            text = transcript.get("text")
            if not isinstance(text, str):
                errors.append("transcript.text deve ser string")
            elif len(text) > MAX_TEXT_CHARS:
                errors.append(f"transcript.text excede {MAX_TEXT_CHARS} caracteres")
            for key in ("model", "language"):
                if key in transcript and not isinstance(transcript[key], str):
                    errors.append(f"transcript.{key} deve ser string")
            segments = transcript.get("segments")
            if not isinstance(segments, list):
                errors.append("transcript.segments deve ser lista")
            elif len(segments) > MAX_SEGMENTS:
                errors.append(f"transcript.segments excede {MAX_SEGMENTS}")
            else:
                for index, segment in enumerate(segments):
                    if not isinstance(segment, dict):
                        errors.append(f"segmento {index} não é objeto")
                        continue
                    if not isinstance(segment.get("text"), str) or len(segment["text"]) > 2000:
                        errors.append(f"segmento {index}: text inválido")
                    for key in ("startMs", "endMs"):
                        if not _is_number(segment.get(key)) or segment[key] < 0:
                            errors.append(f"segmento {index}: {key} inválido")
                    if _is_number(segment.get("startMs")) and _is_number(segment.get("endMs")):
                        if segment["endMs"] < segment["startMs"]:
                            errors.append(f"segmento {index}: endMs antes de startMs")

    frames = ficha.get("frames")
    if not isinstance(frames, list):
        errors.append("frames deve ser lista (pode ser vazia)")
    elif len(frames) > MAX_FRAMES:
        errors.append(f"frames excede {MAX_FRAMES}")
    else:
        for index, frame in enumerate(frames):
            if not isinstance(frame, dict):
                errors.append(f"frame {index} não é objeto")
                continue
            if not _is_number(frame.get("atMs")) or frame["atMs"] < 0:
                errors.append(f"frame {index}: atMs inválido")
            path = frame.get("path")
            if not isinstance(path, str) or not path.lower().endswith(IMAGE_EXTENSIONS):
                errors.append(f"frame {index}: path deve ser .jpg/.jpeg/.png")
            else:
                problem = _check_relative_path(path)
                if problem:
                    errors.append(f"frame {index}: {problem}")
            if not isinstance(frame.get("sha256"), str) or not SHA_RE.match(frame["sha256"]):
                errors.append(f"frame {index}: sha256 inválido")

    for key in ("warnings", "limits"):
        if key in ficha and not isinstance(ficha[key], (list, dict)):
            errors.append(f"{key} tem tipo errado")
    if "technique" in ficha and ficha["technique"] is not None and not isinstance(ficha["technique"], dict):
        errors.append("technique deve ser objeto ou null")
    return errors


def write_json_atomic(path: str, payload) -> None:
    """tmp + rename: um crash no meio nunca deixa ficha pela metade no índice."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    temporary = f"{path}.{os.getpid()}.tmp"
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2, sort_keys=True)
    os.replace(temporary, path)


def read_json(path: str, default=None):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return default
