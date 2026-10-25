"""Testes do pipeline de ingestão (Fase 3) — stdlib apenas, sem ffmpeg nem whisper.

Rodar de tools/ingest:
    python -m unittest discover -s tests -t .
ou direto:
    python tests/test_ingest.py

Os binários externos e o modelo de transcrição são sempre injetados: um teste
nunca depende de rede, de peso baixado ou de um vídeo real.
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import ingest as ingest_mod  # noqa: E402
import media  # noqa: E402
from ficha import SCHEMA_VERSION, source_id, validate_ficha  # noqa: E402
from ingest import Options, build_ficha, classify, ingest_one, main, parse_subtitles  # noqa: E402

FAKE_SHA = "0" * 64


def write_tmp(directory: Path, name: str, content: str | bytes = "conteúdo de teste") -> Path:
    path = directory / name
    data = content.encode("utf-8") if isinstance(content, str) else content
    path.write_bytes(data)
    return path


def fake_probe(**overrides) -> dict:
    base = {"durationMs": 12_000, "width": 1280, "height": 720, "fps": 30.0, "hasAudio": True}
    base.update(overrides)
    return base


def fake_transcriber(path, **kwargs) -> dict:
    fake_transcriber.calls.append(dict(kwargs))
    return {
        "engine": "faster-whisper",
        "model": kwargs.get("model_name", "tiny"),
        "language": "pt",
        "text": "primeiro passo: levante o braço",
        "segments": [{"startMs": 0, "endMs": 2000, "text": "primeiro passo: levante o braço"}],
        "truncated": False,
    }


fake_transcriber.calls = []


def fake_extractor(path, out_dir, **kwargs) -> list[dict]:
    return [{"atMs": round(time * 1000), "path": "frames/frame-000.jpg", "sha256": FAKE_SHA}
            for time in (kwargs.get("times_s") or [])[:1]]


class ClassificacaoTest(unittest.TestCase):
    def test_extensoes(self):
        self.assertEqual(classify(Path("a/b.mp4")), "video")
        self.assertEqual(classify(Path("b.MOV")), "video")
        self.assertEqual(classify(Path("narra.mp3")), "audio")
        self.assertEqual(classify(Path("aula.srt")), "subtitles")
        self.assertEqual(classify(Path("notas.md")), "text")
        self.assertIsNone(classify(Path("malicioso.exe")))
        self.assertIsNone(classify(Path("sem-extensao")))


class LegendaTest(unittest.TestCase):
    def test_srt_com_indice_e_mili_segundos(self):
        cues = parse_subtitles(
            "1\n00:00:01,500 --> 00:00:03,250\nLevante o braço\n\n"
            "2\n00:00:04,000 --> 00:00:05,000\nGire o pulso\n"
        )
        self.assertEqual(len(cues), 2)
        self.assertEqual(cues[0]["startMs"], 1500)
        self.assertEqual(cues[0]["endMs"], 3250)
        self.assertEqual(cues[1]["text"], "Gire o pulso")

    def test_vtt_com_cabecalho(self):
        cues = parse_subtitles("WEBVTT\n\n00:00.500 --> 00:02.000\nOlá\n")
        self.assertEqual(cues[0]["startMs"], 500)
        self.assertEqual(cues[0]["endMs"], 2000)

    def test_lixo_vira_nada_mas_nao_quebra(self):
        self.assertEqual(parse_subtitles("isso não é legenda"), [])
        self.assertEqual(parse_subtitles(""), [])


class FichaSchemaTest(unittest.TestCase):
    def fixture(self, **overrides) -> dict:
        ficha = {
            "schema": SCHEMA_VERSION,
            "id": "src-abcdef123456",
            "createdAt": "2026-10-25T12:00:00Z",
            "source": {"kind": "video", "path": "tutorial.mp4", "sha256": "1" * 64, "bytes": 10, "title": "t"},
            "media": {"durationMs": 1000, "width": 640, "height": 360, "hasAudio": True},
            "transcript": {"engine": "faster-whisper", "model": "tiny", "language": "pt",
                            "text": "oi", "segments": [{"startMs": 0, "endMs": 500, "text": "oi"}]},
            "frames": [{"atMs": 500, "path": "frames/frame-000.jpg", "sha256": "2" * 64}],
            "technique": None,
            "warnings": [],
        }
        return {**ficha, **overrides}

    def test_ficha_bem_formada_passa(self):
        self.assertEqual(validate_ficha(self.fixture()), [])

    def test_id_forjado_recusado(self):
        errors = validate_ficha(self.fixture(id="src-ZZZZ"))
        self.assertTrue(any("id deve ter o formato" in error for error in errors))

    def test_caminho_de_origem_absoluto_vira_originalPath_e_nao_sourcePath(self):
        source = dict(self.fixture()["source"], path="C:/Windows/system32/evil.mp4")
        errors = validate_ficha(self.fixture(source=source))
        self.assertTrue(any("apenas o nome do arquivo" in error for error in errors))

    def test_escape_de_diretorio_no_frame_recusado(self):
        frames = [{"atMs": 0, "path": "../../etc/passwd.jpg", "sha256": "2" * 64}]
        errors = validate_ficha(self.fixture(frames=frames))
        self.assertTrue(any("subir do diretório" in error for error in errors))

    def test_frame_fora_do_teto(self):
        frames = [{"atMs": 0, "path": f"frames/f{i}.jpg", "sha256": "2" * 64} for i in range(65)]
        errors = validate_ficha(self.fixture(frames=frames))
        self.assertTrue(any("excede" in error for error in errors))

    def test_segmento_invertido_recusado(self):
        transcript = dict(self.fixture()["transcript"], segments=[{"startMs": 900, "endMs": 100, "text": "x"}])
        errors = validate_ficha(self.fixture(transcript=transcript))
        self.assertTrue(any("endMs antes de startMs" in error for error in errors))

    def test_engine_desconhecido_recusado(self):
        transcript = dict(self.fixture()["transcript"], engine="api-misteriosa")
        errors = validate_ficha(self.fixture(transcript=transcript))
        self.assertTrue(any("transcript.engine" in error for error in errors))

    def test_ficha_gigante_recusada(self):
        errors = validate_ficha(self.fixture(transcript={"engine": "arquivo", "text": "x" * 300_000, "segments": []}))
        self.assertTrue(errors)


class BuildFichaTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.out = self.root / "saida"
        self.out.mkdir()
        fake_transcriber.calls = []

    def tearDown(self):
        self.tmp.cleanup()

    def options(self, **overrides) -> Options:
        return Options(out_dir=self.out, **overrides)

    def test_video_produz_ficha_valida_com_limites_registrados(self):
        path = write_tmp(self.root, "tutorial.mp4", "bytes-falsos-de-video")
        ficha = build_ficha(
            path,
            self.options(max_frames=3, allow_model_download=True),
            prober=lambda *_a, **_k: fake_probe(),
            frame_extractor=fake_extractor,
            transcriber=fake_transcriber,
            now=lambda: "2026-10-25T12:00:00Z",
        )
        self.assertEqual(validate_ficha(ficha), [])
        self.assertEqual(ficha["id"], source_id(ficha["source"]["sha256"]))
        self.assertEqual(ficha["source"]["kind"], "video")
        self.assertEqual(ficha["frames"][0]["path"], "frames/frame-000.jpg")
        self.assertEqual(ficha["limits"]["localFilesOnly"], False)
        self.assertEqual(ficha["limits"]["maxFrames"], 3)
        self.assertEqual(ficha["createdAt"], "2026-10-25T12:00:00Z")

    def test_por_padrao_nao_baixa_modelo(self):
        path = write_tmp(self.root, "aula.mp4", "x")
        build_ficha(path, self.options(), prober=lambda *_a, **_k: fake_probe(),
                    frame_extractor=fake_extractor, transcriber=fake_transcriber)
        self.assertEqual(fake_transcriber.calls[-1]["local_files_only"], True)

    def test_material_llongo_demais_e_recusado(self):
        path = write_tmp(self.root, "longo.mp4", "x")
        with self.assertRaisesRegex(media.IngestError, "max-seconds"):
            build_ficha(path, self.options(max_seconds=5), prober=lambda *_a, **_k: fake_probe(durationMs=99_000),
                        frame_extractor=fake_extractor, transcriber=fake_transcriber)

    def test_teto_de_bytes(self):
        path = write_tmp(self.root, "grande.mp4", "x" * 100)
        with self.assertRaisesRegex(media.IngestError, "teto"):
            build_ficha(path, self.options(max_bytes=10), prober=lambda *_a, **_k: fake_probe(),
                        frame_extractor=fake_extractor, transcriber=fake_transcriber)

    def test_audio_sem_video_nao_gera_frames(self):
        path = write_tmp(self.root, "podcast.mp3", "x")
        ficha = build_ficha(path, self.options(), prober=lambda *_a, **_k: fake_probe(width=None, height=None, fps=None),
                           frame_extractor=fake_extractor, transcriber=fake_transcriber)
        self.assertEqual(ficha["source"]["kind"], "audio")
        self.assertEqual(ficha["frames"], [])

    def test_video_sem_audio_avisa_e_transcreve_nada(self):
        path = write_tmp(self.root, "mudo.mp4", "x")
        ficha = build_ficha(path, self.options(), prober=lambda *_a, **_k: fake_probe(hasAudio=False),
                           frame_extractor=fake_extractor, transcriber=fake_transcriber)
        self.assertIsNone(ficha["transcript"])
        self.assertTrue(any("sem faixa de áudio" in warning for warning in ficha["warnings"]))

    def test_legenda_vira_transcricao_sem_whisper(self):
        path = write_tmp(self.root, "aula.srt", "1\n00:00:00,000 --> 00:00:02,000\nAjoelhe o cotovelo\n")
        ficha = build_ficha(path, self.options(), prober=lambda *_a, **_k: fake_probe(),
                           frame_extractor=fake_extractor, transcriber=fake_transcriber)
        self.assertEqual(ficha["source"]["kind"], "subtitles")
        self.assertEqual(ficha["transcript"]["engine"], "legenda")
        self.assertEqual(ficha["transcript"]["segments"][0]["text"], "Ajoelhe o cotovelo")
        self.assertEqual(fake_transcriber.calls, [], "legenda não deve chamar o whisper")

    def test_texto_invalido_utf8_nao_derruba(self):
        path = write_tmp(self.root, "notas.txt", b"\xff\xfe bytes soltos")
        ficha = build_ficha(path, self.options())
        self.assertEqual(ficha["transcript"]["engine"], "arquivo")
        self.assertEqual(validate_ficha(ficha), [])

    def test_extensao_nao_suportada_recusada(self):
        path = write_tmp(self.root, "script.exe", "x")
        with self.assertRaisesRegex(media.IngestError, "não suportado"):
            build_ficha(path, self.options())


class IngestaoTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.out = self.root / "saida"
        self.out.mkdir()
        self.video = write_tmp(self.root, "tutorial.mp4", "video-falso")

    def tearDown(self):
        self.tmp.cleanup()

    def options(self, **overrides) -> Options:
        return Options(out_dir=self.out, **overrides)

    def builder(self, options):
        return lambda path, opts: build_ficha(
            path, opts,
            prober=lambda *_a, **_k: fake_probe(),
            frame_extractor=fake_extractor,
            transcriber=fake_transcriber,
        )

    def test_escreve_ficha_e_indice(self):
        result = ingest_one(self.video, self.options(), builder=self.builder(self.options()))
        self.assertEqual(result["status"], "ingestado")
        ficha_path = self.out / result["id"] / "ficha.json"
        self.assertTrue(ficha_path.is_file())
        stored = json.loads(ficha_path.read_text(encoding="utf-8"))
        self.assertEqual(stored["schema"], SCHEMA_VERSION)
        index = json.loads((self.out / "index.json").read_text(encoding="utf-8"))
        self.assertIn(stored["source"]["sha256"], index["entries"])
        self.assertEqual(index["entries"][stored["source"]["sha256"]]["ficha"], f"{result['id']}/ficha.json")

    def test_duplicado_nao_retranscreve(self):
        first = ingest_one(self.video, self.options(), builder=self.builder(self.options()))
        calls_after_first = len(fake_transcriber.calls)
        second = ingest_one(self.video, self.options(), builder=self.builder(self.options()))
        self.assertEqual(second["status"], "duplicado")
        self.assertEqual(second["id"], first["id"])
        self.assertEqual(len(fake_transcriber.calls), calls_after_first, "dedupe deve acontecer antes do trabalho pesado")

    def test_forcar_reingere(self):
        ingest_one(self.video, self.options(), builder=self.builder(self.options()))
        result = ingest_one(self.video, self.options(force=True), builder=self.builder(self.options()))
        self.assertEqual(result["status"], "ingestado")

    def test_seco_nao_escreve_nada(self):
        result = ingest_one(self.video, self.options(dry_run=True), builder=self.builder(self.options()))
        self.assertEqual(result["status"], "dry-run")
        self.assertFalse((self.out / "index.json").exists())
        self.assertEqual(list(self.out.glob("src-*")), [])

    def test_indice_corrompido_e_tolerado_sem_apagar_arquivos(self):
        (self.out / "index.json").write_text("{ nao é json", encoding="utf-8")
        result = ingest_one(self.video, self.options(), builder=self.builder(self.options()))
        self.assertEqual(result["status"], "ingestado")
        index = json.loads((self.out / "index.json").read_text(encoding="utf-8"))
        self.assertEqual(len(index["entries"]), 1)

    def test_cli_por_pasta_processa_so_o_que_conhece(self):
        pasta = self.root / "materiais"
        pasta.mkdir()
        write_tmp(pasta, "a.txt", "texto")
        write_tmp(pasta, "b.srt", "1\n00:00:00,000 --> 00:00:01,000\noi\n")
        write_tmp(pasta, "ignore.exe", "x")
        code = main(["--input", str(pasta), "--out", str(self.out)])
        self.assertEqual(code, 0)
        index = json.loads((self.out / "index.json").read_text(encoding="utf-8"))
        self.assertEqual(len(index["entries"]), 2)

    def test_cli_max_files_protege_contra_varredura_enorme(self):
        pasta = self.root / "muitos"
        pasta.mkdir()
        for index in range(6):
            write_tmp(pasta, f"n{index}.txt", "x")
        code = main(["--input", str(pasta), "--out", str(self.out), "--max-files", "3"])
        self.assertEqual(code, 1)

    def test_cli_falha_em_um_arquivo_nao_derruba_o_lote(self):
        good = write_tmp(self.root, "bom.txt", "nota")
        bad = write_tmp(self.root, "ruim.mp4", "x")
        original = ingest_mod.build_ficha

        def sabotage(path, options):
            if path.name == "ruim.mp4":
                raise media.IngestError("ffmpeg quebrou")
            return original(path, options)

        ingest_mod.build_ficha = sabotage
        ingest_one.__globals__["build_ficha"] = sabotage
        try:
            code = main(["--input", str(good), "--input", str(bad), "--out", str(self.out)])
        finally:
            ingest_mod.build_ficha = original
            ingest_one.__globals__["build_ficha"] = original
        self.assertEqual(code, 1)
        index = json.loads((self.out / "index.json").read_text(encoding="utf-8"))
        self.assertEqual(len(index["entries"]), 1, "o arquivo bom entrou mesmo com o ruim falhando")


class MediaSeguroTest(unittest.TestCase):
    def test_comando_sem_shell_e_com_timeout(self):
        captured = {}

        def fake_run(argv, timeout_s):
            captured["argv"] = argv
            captured["timeout"] = timeout_s
            return type("R", (), {"returncode": 0, "stdout": b'{"format":{"duration":"12.5"},"streams":[]}', "stderr": b""})()

        info = media.probe("video.mp4", run=fake_run)
        self.assertEqual(captured["argv"][0], "ffprobe")
        self.assertNotIn(True, [isinstance(item, str) and ("&&" in item or ";" in item) for item in captured["argv"]])
        self.assertEqual(info["durationMs"], 12500)
        self.assertEqual(info["hasAudio"], False)
        self.assertLess(captured["timeout"], 120)

    def test_ffprobe_com_saida_lixa_vira_ingesterror(self):
        def fake_run(argv, timeout_s):
            return type("R", (), {"returncode": 0, "stdout": b"lixo que nao e json", "stderr": b""})()

        with self.assertRaises(media.IngestError):
            media.probe("video.mp4", run=fake_run)

    def test_timeout_do_ffmpeg_vira_ingesterror(self):
        import subprocess as sp

        def fake_run(argv, timeout_s):
            raise sp.TimeoutExpired(argv, timeout_s)

        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(media.IngestError):
                media.extract_frames("v.mp4", Path(tmp) / "frames", times_s=[1.0], run=fake_run)

    def test_binario_ausente_vira_ingesterror(self):
        def fake_run(argv, timeout_s):
            raise FileNotFoundError(argv[0])

        with self.assertRaisesRegex(media.IngestError, "não encontrado"):
            media.probe("v.mp4", run=fake_run)

    def test_frame_times_espalhado_e_limitado(self):
        times = media.frame_times(60_000, 4)
        self.assertEqual(len(times), 4)
        self.assertEqual(times[0], 0.0)
        self.assertTrue(all(a < b for a, b in zip(times, times[1:])))
        self.assertEqual(media.frame_times(None, 2), [0.0, 3.0])

    def test_decode_de_audio_sem_pyav_usa_ffmpeg_sem_shell(self):
        captured = {}

        def fake_run(argv, timeout_s):
            captured["argv"] = argv
            return type("R", (), {"returncode": 0, "stdout": b"\x00" * 16, "stderr": b""})()

        payload = media.decode_audio("v.mp4", run=fake_run)
        self.assertEqual(len(payload), 16)
        argv = captured["argv"]
        self.assertEqual(argv[0], "ffmpeg")
        self.assertIn("-f", argv)
        self.assertIn("f32le", argv)
        self.assertIn("-", argv)  # saída por pipe, nunca arquivo solto na pasta do material
        self.assertFalse(any(token in item for item in argv if isinstance(item, str)
                             for token in ("&&", ";", "|")))

    def test_decode_vazio_ou_gigante_recusado(self):
        def empty_run(argv, timeout_s):
            return type("R", (), {"returncode": 0, "stdout": b"", "stderr": b""})()

        with self.assertRaisesRegex(media.IngestError, "vazia"):
            media.decode_audio("v.mp4", run=empty_run)

        def huge_run(argv, timeout_s):
            return type("R", (), {
                "returncode": 0,
                "stdout": b"\x00" * (media.MAX_DECODED_AUDIO_BYTES + 1),
                "stderr": b"",
            })()

        with self.assertRaisesRegex(media.IngestError, "teto"):
            media.decode_audio("v.mp4", run=huge_run)

    def test_filtro_de_scale_escapa_a_virgula_para_o_ffmpeg(self):
        captured = {}

        def fake_run(argv, timeout_s):
            captured["argv"] = argv
            return type("R", (), {"returncode": 1, "stdout": b"", "stderr": b"boom"})()

        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(media.IngestError):
                media.extract_frames("v.mp4", Path(tmp) / "frames", times_s=[0.5],
                                     run=fake_run, max_width=480)
        self.assertIn("scale='min(480,iw)':-2", captured["argv"])

    def test_transcribe_recebe_audio_decodificado_nao_caminho(self):
        """A ficha sai do mesmo caminho mesmo sem PyAV: quem decodifica é o ffmpeg."""
        seen = {}

        class FakeModel:
            def transcribe(self, audio, **kwargs):
                seen["type"] = type(audio).__name__
                seen["size"] = audio.size
                info = type("I", (), {"model_name": "tiny", "language": "pt"})()
                seg = type("S", (), {"start": 0.0, "end": 1.5, "text": " gire o pulso "})()
                return iter([seg]), info

        result = media.transcribe("v.mp4", model=FakeModel(),
                                  decoder=lambda _path: b"\x00\x00\x80?" * 2)
        self.assertEqual(seen["type"], "ndarray")
        self.assertEqual(seen["size"], 2)
        self.assertEqual(result["segments"], [{"startMs": 0, "endMs": 1500, "text": "gire o pulso"}])
        self.assertEqual(result["engine"], "faster-whisper")


if __name__ == "__main__":
    unittest.main(verbosity=2)
