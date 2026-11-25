"""
Exportador nao-destrutivo de amostras de voz da Usami a partir de `data/tts-cache`.

- Le `data/tts-cache/*.audio` SOMENTE LEITURA (nunca altera nem apaga nada do cache).
- Filtra apenas gravacoes a partir de 2026-10-28 (voz oficial atual `voice_ess199w2ioks`).
- Extrai estritamente o chunk `data` do RIFF/WAVE (removendo metadados `C2PA` que causam
  estouro/chiado no fim do arquivo).
- Aplica trim suave de silencio nas pontas, micro fade-in/out de 8 ms (zero cliques),
  upsample polifasico exato 24000 -> 44100 Hz (147/80) e normalizacao a -1.0 dBFS.
- Gera em `data/voice-samples/`:
    1) `singing-sites/`: pacotes concatenados de 30s, 1min, 3min e 10min;
    2) `fl-vocal-chops/`: 60 frases individuais limpas + `usami_slicex_megapack.wav`
       pronto para fatiamento automatico no Fruity Slicex / Serum 2.
"""
import argparse
import hashlib
import json
import os
import struct
import time
import wave
import numpy as np
from scipy.signal import resample_poly

# Data de corte da voz oficial atual (2026-10-28 00:00:00 UTC)
OFFICIAL_VOICE_MIN_MTIME = 1793145600
TARGET_SR = 44100


def read_clean_pcm_from_riff(file_path):
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
        body_start = pos + 8
        body_end = min(len(raw), body_start + csz)
        if cid == b'fmt ' and (body_end - body_start) >= 16:
            tag, ch, sr, _bps, _align, bits = struct.unpack('<HHIIHH', raw[body_start:body_start + 16])
            fmt_info = (tag, ch, sr, bits)
        elif cid == b'data':
            pcm_bytes = raw[body_start:body_end]
            break  # Ignora qualquer chunk C2PA apos o bloco data!
        pos = body_start + csz + (csz & 1)

    if not fmt_info or not pcm_bytes:
        return None
    tag, ch, sr, bits = fmt_info
    if tag != 1 or bits != 16:
        return None

    samples = np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32) / 32768.0
    if ch > 1:
        samples = samples.reshape(-1, ch).mean(axis=1)
    return samples, int(sr), hashlib.sha1(pcm_bytes).hexdigest()


def trim_and_fade(samples, sr, threshold_lin=0.0025):
    if len(samples) < int(sr * 0.4):
        return samples
    abs_s = np.abs(samples)
    active = np.where(abs_s > threshold_lin)[0]
    if len(active) == 0:
        return np.zeros(0, dtype=np.float32)

    pad = int(sr * 0.035)
    start = max(0, int(active[0]) - pad)
    end = min(len(samples), int(active[-1]) + pad)
    clipped = samples[start:end].copy()

    fade_len = min(int(sr * 0.008), len(clipped) // 4)
    if fade_len > 4:
        ramp = np.linspace(0.0, 1.0, fade_len, dtype=np.float32)
        clipped[:fade_len] *= ramp
        clipped[-fade_len:] *= ramp[::-1]
    return clipped


def resample_to_target(samples, sr, target_sr=TARGET_SR):
    if sr == target_sr:
        return samples
    if sr == 24000 and target_sr == 44100:
        return resample_poly(samples, 147, 80).astype(np.float32)
    from math import gcd
    g = gcd(target_sr, sr)
    return resample_poly(samples, target_sr // g, sr // g).astype(np.float32)


def normalize_peak(samples, target_dbfs=-1.0):
    if len(samples) == 0:
        return samples
    peak = float(np.max(np.abs(samples)))
    if peak < 1e-5:
        return samples
    target_lin = 10.0 ** (target_dbfs / 20.0)
    return np.clip(samples * (target_lin / peak), -0.999, 0.999)


def write_wav_16bit(file_path, samples, sr=TARGET_SR):
    os.makedirs(os.path.dirname(os.path.abspath(file_path)), exist_ok=True)
    pcm16 = np.round(np.clip(samples, -1.0, 1.0) * 32767.0).astype(np.int16)
    with wave.open(file_path, 'wb') as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(pcm16.tobytes())
    return {
        'file': os.path.basename(file_path),
        'path': file_path,
        'durationSec': round(len(pcm16) / float(sr), 2),
        'sizeBytes': os.path.getsize(file_path),
    }


def build_concatenated(clips_44k, target_sec, gap_sec=0.25, sr=TARGET_SR):
    gap = np.zeros(int(sr * gap_sec), dtype=np.float32)
    pieces = []
    acc_frames = 0
    limit_frames = int(sr * target_sec)

    for clip in clips_44k:
        if acc_frames >= limit_frames:
            break
        if pieces:
            pieces.append(gap)
            acc_frames += len(gap)
        pieces.append(clip)
        acc_frames += len(clip)

    if not pieces:
        return np.zeros(0, dtype=np.float32)
    return np.concatenate(pieces)


def export_voice_pack(cache_dir, out_dir, min_mtime=OFFICIAL_VOICE_MIN_MTIME, max_chops=60):
    if not os.path.isdir(cache_dir):
        raise FileNotFoundError('Diretorio tts-cache nao encontrado: %s' % cache_dir)

    candidates = []
    for name in os.listdir(cache_dir):
        if not name.endswith('.audio'):
            continue
        full = os.path.join(cache_dir, name)
        try:
            st = os.stat(full)
        except OSError:
            continue
        if st.st_mtime < min_mtime:
            continue
        candidates.append((st.st_mtime, full))

    # Mais recentes primeiro (garante consistencia maxima da voz atual)
    candidates.sort(key=lambda item: item[0], reverse=True)

    seen_hashes = set()
    clean_clips = []

    for mtime, fpath in candidates:
        parsed = read_clean_pcm_from_riff(fpath)
        if not parsed:
            continue
        samples, sr, pcm_hash = parsed
        if pcm_hash in seen_hashes:
            continue
        seen_hashes.add(pcm_hash)

        trimmed = trim_and_fade(samples, sr)
        dur = len(trimmed) / float(max(1, sr))
        if dur < 1.2 or dur > 25.0:
            continue
        rms = float(np.sqrt(np.mean(trimmed * trimmed)))
        if rms < 0.008:
            continue

        clean_clips.append({
            'samples_raw': trimmed,
            'sr': sr,
            'duration': dur,
            'rms': rms,
            'mtime': mtime,
        })

    if not clean_clips:
        raise RuntimeError('Nenhuma amostra valida encontrada no tts-cache.')

    # Prioriza clipes limpos de 2.5s a 12s para datasets de canto; ordena por qualidade/clareza
    singing_pool = sorted(
        clean_clips,
        key=lambda c: (0 if 2.5 <= c['duration'] <= 12.0 else 1, -c['mtime']),
    )

    # Faz upsample dos necessarios ate cobrir 11 minutos + 60 chops
    upsampled_singing = []
    acc_sec = 0.0
    for item in singing_pool:
        up = normalize_peak(resample_to_target(item['samples_raw'], item['sr'], TARGET_SR), -1.0)
        upsampled_singing.append(up)
        acc_sec += len(up) / float(TARGET_SR)
        if acc_sec >= 660.0 and len(upsampled_singing) >= max_chops:
            break

    singing_dir = os.path.join(out_dir, 'singing-sites')
    chops_dir = os.path.join(out_dir, 'fl-vocal-chops')
    os.makedirs(singing_dir, exist_ok=True)
    os.makedirs(chops_dir, exist_ok=True)

    singing_outputs = []
    for label, secs in [('30s', 30), ('1min', 60), ('3min', 180), ('10min', 600)]:
        merged = build_concatenated(upsampled_singing, secs, gap_sec=0.25, sr=TARGET_SR)
        if len(merged) > 0:
            out_file = os.path.join(singing_dir, 'usami_voice_%s.wav' % label)
            singing_outputs.append(write_wav_16bit(out_file, merged, TARGET_SR))

    # Frases curtas e energeticas (1.3s a 5.5s) para Vocal Chops / Slicex no FL Studio
    chop_candidates = [c for c in clean_clips if 1.3 <= c['duration'] <= 5.5]
    if len(chop_candidates) < max_chops:
        chop_candidates = clean_clips

    chop_outputs = []
    slicex_slices = []
    for idx, item in enumerate(chop_candidates[:max_chops], start=1):
        up = normalize_peak(resample_to_target(item['samples_raw'], item['sr'], TARGET_SR), -1.0)
        out_file = os.path.join(chops_dir, 'usami_phrase_%03d.wav' % idx)
        chop_outputs.append(write_wav_16bit(out_file, up, TARGET_SR))
        if len(slicex_slices) < 20 and len(up) <= TARGET_SR * 3.5:
            slicex_slices.append(up)

    megapack_info = None
    if slicex_slices:
        # Silencio de 350 ms entre frases permite auto-slice perfeito no Fruity Slicex!
        megapack_audio = build_concatenated(slicex_slices, 90, gap_sec=0.35, sr=TARGET_SR)
        megapack_info = write_wav_16bit(
            os.path.join(chops_dir, 'usami_slicex_megapack.wav'),
            megapack_audio,
            TARGET_SR,
        )

    manifest = {
        'generatedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'sampleRateHz': TARGET_SR,
        'bitDepth': 16,
        'channels': 1,
        'c2paStripped': True,
        'officialVoiceCandidatesScanned': len(candidates),
        'uniqueCleanClipsValid': len(clean_clips),
        'singingDatasets': singing_outputs,
        'slicexMegapack': megapack_info,
        'individualPhrasesCount': len(chop_outputs),
        'outputRoot': os.path.abspath(out_dir),
    }

    manifest_path = os.path.join(out_dir, 'manifest.json')
    with open(manifest_path, 'w', encoding='utf-8') as fh:
        json.dump(manifest, fh, indent=2)

    return manifest


def main():
    repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
    parser = argparse.ArgumentParser(description='Export clean Usami voice WAVs for singing AI & FL Studio.')
    parser.add_argument('--cache-dir', default=os.path.join(repo_root, 'data', 'tts-cache'))
    parser.add_argument('--out-dir', default=os.path.join(repo_root, 'data', 'voice-samples'))
    parser.add_argument('--max-chops', type=int, default=60)
    args = parser.parse_args()

    summary = export_voice_pack(args.cache_dir, args.out_dir, max_chops=args.max_chops)
    print(json.dumps(summary, indent=2))


if __name__ == '__main__':
    main()
