"""
Gera o pacote limpo de treinamento RVC v2 da Usami (`usami_rvc_dataset.zip`).

- Le `data/tts-cache/*.audio` SOMENTE LEITURA (voz oficial `voice_ess199w2ioks`, pos 2026-10-28).
- Remove chunks finais `C2PA` (que causam cliques de fundo de escala e estragam o treino RVC).
- Seleciona ate ~30 minutos dos clipes mais limpos (2.0s a 14.0s), faz upsample polifasico
  para 40000 Hz (taxa nativa recomendada do RVC v2 / Applio), normaliza a -1.5 dBFS e
  empacota como arquivos individuais `clip_0001.wav ... clip_NNNN.wav` dentro de
  `data/rvc/usami_rvc_dataset_30min.zip`, pronto para subir no Google Colab.
"""
import argparse
import hashlib
import io
import json
import os
import struct
import time
import wave
import zipfile
import numpy as np
from scipy.signal import resample_poly

OFFICIAL_VOICE_MIN_MTIME = 1793145600
RVC_TARGET_SR = 40000  # Taxa nativa v2 do RVC / Applio (40k preserva formantes agudos com treino mais rapido e estavel que 48k)


def read_clean_pcm(file_path):
    with open(file_path, 'rb') as fh:
        raw = fh.read()
    if len(raw) < 44 or raw[:4] != b'RIFF' or raw[8:12] != b'WAVE':
        return None
    pos = 12
    fmt_info = None
    pcm_bytes = None
    while pos + 8 <= len(raw):
        cid = raw[pos:pos + 4]
        csz = struct.unpack('<I', raw[pos + 4:pos + 8])[0]
        b0 = pos + 8
        b1 = min(len(raw), b0 + csz)
        if cid == b'fmt ' and (b1 - b0) >= 16:
            tag, ch, sr, _bps, _align, bits = struct.unpack('<HHIIHH', raw[b0:b0 + 16])
            fmt_info = (tag, ch, sr, bits)
        elif cid == b'data':
            pcm_bytes = raw[b0:b1]
            break
        pos = b0 + csz + (csz & 1)
    if not fmt_info or not pcm_bytes:
        return None
    tag, ch, sr, bits = fmt_info
    if tag != 1 or bits != 16:
        return None
    samples = np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32) / 32768.0
    if ch > 1:
        samples = samples.reshape(-1, ch).mean(axis=1)
    return samples, int(sr), hashlib.sha1(pcm_bytes).hexdigest()


def trim_and_prepare_40k(samples, sr):
    abs_s = np.abs(samples)
    active = np.where(abs_s > 0.003)[0]
    if len(active) == 0:
        return None
    pad = int(sr * 0.045)
    s0 = max(0, int(active[0]) - pad)
    s1 = min(len(samples), int(active[-1]) + pad)
    clipped = samples[s0:s1].copy()
    dur = len(clipped) / float(sr)
    if dur < 1.8 or dur > 15.0:
        return None
    rms = float(np.sqrt(np.mean(clipped * clipped)))
    if rms < 0.012:
        return None

    fade = min(int(sr * 0.010), len(clipped) // 4)
    if fade > 4:
        r = np.linspace(0.0, 1.0, fade, dtype=np.float32)
        clipped[:fade] *= r
        clipped[-fade:] *= r[::-1]

    if sr == 24000:
        up = resample_poly(clipped, 5, 3).astype(np.float32)  # 24000 * 5 / 3 = 40000 exato!
    elif sr != RVC_TARGET_SR:
        from math import gcd
        g = gcd(RVC_TARGET_SR, sr)
        up = resample_poly(clipped, RVC_TARGET_SR // g, sr // g).astype(np.float32)
    else:
        up = clipped

    peak = float(np.max(np.abs(up)) + 1e-9)
    target_lin = 10.0 ** (-1.5 / 20.0)
    up = np.clip(up * (target_lin / peak), -0.999, 0.999)
    return up


def wav_bytes_16bit(samples, sr=RVC_TARGET_SR):
    pcm16 = np.round(samples * 32767.0).astype(np.int16)
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(pcm16.tobytes())
    return buf.getvalue()


def build_rvc_dataset(cache_dir, out_zip_path, target_minutes=30.0):
    if not os.path.isdir(cache_dir):
        raise FileNotFoundError(f'tts-cache nao encontrado: {cache_dir}')

    candidates = []
    for name in os.listdir(cache_dir):
        if not name.endswith('.audio'):
            continue
        full = os.path.join(cache_dir, name)
        try:
            st = os.stat(full)
        except OSError:
            continue
        if st.st_mtime >= OFFICIAL_VOICE_MIN_MTIME:
            candidates.append((st.st_mtime, full))

    candidates.sort(key=lambda x: x[0], reverse=True)
    os.makedirs(os.path.dirname(os.path.abspath(out_zip_path)), exist_ok=True)

    seen = set()
    total_sec = 0.0
    limit_sec = target_minutes * 60.0
    clip_count = 0

    with zipfile.ZipFile(out_zip_path, 'w', compression=zipfile.ZIP_DEFLATED) as zf:
        for _mtime, fpath in candidates:
            if total_sec >= limit_sec:
                break
            parsed = read_clean_pcm(fpath)
            if not parsed:
                continue
            samples, sr, h = parsed
            if h in seen:
                continue
            seen.add(h)

            ready = trim_and_prepare_40k(samples, sr)
            if ready is None:
                continue

            clip_count += 1
            dur_sec = len(ready) / float(RVC_TARGET_SR)
            total_sec += dur_sec
            zf.writestr(f'clip_{clip_count:04d}.wav', wav_bytes_16bit(ready, RVC_TARGET_SR))

    return {
        'ok': True,
        'zipPath': os.path.abspath(out_zip_path),
        'zipSizeMb': round(os.path.getsize(out_zip_path) / 1048576.0, 2),
        'clipsIncluded': clip_count,
        'totalMinutes': round(total_sec / 60.0, 2),
        'sampleRateHz': RVC_TARGET_SR,
        'generatedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
    }


def main():
    repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
    parser = argparse.ArgumentParser(description='Export clean 40kHz RVC v2 training dataset zip for Usami.')
    parser.add_argument('--cache-dir', default=os.path.join(repo_root, 'data', 'tts-cache'))
    parser.add_argument('--out-zip', default=os.path.join(repo_root, 'data', 'rvc', 'usami_rvc_dataset_30min.zip'))
    parser.add_argument('--minutes', type=float, default=30.0)
    args = parser.parse_args()
    res = build_rvc_dataset(args.cache_dir, args.out_zip, target_minutes=args.minutes)
    print(json.dumps(res, indent=2))


if __name__ == '__main__':
    main()
