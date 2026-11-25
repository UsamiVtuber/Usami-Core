import os
os.environ.setdefault('OPENBLAS_NUM_THREADS', '1')
os.environ.setdefault('OMP_NUM_THREADS', '1')

import argparse
import ctypes
import json
import math
import struct
import sys
import time
import uuid
import wave
import numpy as np


class GUID(ctypes.Structure):
    _fields_ = [
        ('Data1', ctypes.c_uint32),
        ('Data2', ctypes.c_uint16),
        ('Data3', ctypes.c_uint16),
        ('Data4', ctypes.c_ubyte * 8),
    ]

    @classmethod
    def from_str(cls, text):
        return cls.from_buffer_copy(uuid.UUID(text).bytes_le)


class WAVEFORMATEX(ctypes.Structure):
    _pack_ = 1
    _fields_ = [
        ('wFormatTag', ctypes.c_uint16),
        ('nChannels', ctypes.c_uint16),
        ('nSamplesPerSec', ctypes.c_uint32),
        ('nAvgBytesPerSec', ctypes.c_uint32),
        ('nBlockAlign', ctypes.c_uint16),
        ('wBitsPerSample', ctypes.c_uint16),
        ('cbSize', ctypes.c_uint16),
    ]


class WAVEFORMATEXTENSIBLE(ctypes.Structure):
    _pack_ = 1
    _fields_ = [
        ('Format', WAVEFORMATEX),
        ('wValidBitsPerSample', ctypes.c_uint16),
        ('dwChannelMask', ctypes.c_uint32),
        ('SubFormat', GUID),
    ]


CLSID_MMDeviceEnumerator = GUID.from_str('BCDE0395-E52F-467C-8E3D-C4579291692E')
IID_IMMDeviceEnumerator = GUID.from_str('A95664D2-9614-4F35-A746-DE8DB63617E6')
IID_IAudioClient = GUID.from_str('1CB9AD4C-DBFA-4c32-B178-C2F568A703B2')
IID_IAudioCaptureClient = GUID.from_str('C8ADBD64-E71E-48a0-A4DE-185C395CD317')
SUBTYPE_IEEE_FLOAT = GUID.from_str('00000003-0000-0010-8000-00aa00389b71')
SUBTYPE_PCM = GUID.from_str('00000001-0000-0010-8000-00aa00389b71')

CLSCTX_ALL = 23
AUDCLNT_SHAREMODE_SHARED = 0
AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000
AUDCLNT_BUFFERFLAGS_SILENT = 0x2


def _vtbl(ptr, index, restype, *argtypes):
    vt = ctypes.cast(ptr, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents
    proto = ctypes.WINFUNCTYPE(restype, ctypes.c_void_p, *argtypes)
    return proto(vt[index])


def _com_release(ptr):
    if ptr and ptr.value:
        _vtbl(ptr, 2, ctypes.c_uint32)(ptr)
        ptr.value = None


def _guid_eq(a, b):
    return bytes(a) == bytes(b)


def capture_wasapi_loopback(duration_sec=2.5):
    if sys.platform != 'win32':
        raise RuntimeError('Captura WASAPI Loopback disponivel apenas no Windows.')

    duration_sec = max(0.4, min(8.0, float(duration_sec)))
    ole32 = ctypes.windll.ole32
    ole32.CoInitializeEx(None, 0)

    enum_ptr = ctypes.c_void_p()
    dev_ptr = ctypes.c_void_p()
    ac_ptr = ctypes.c_void_p()
    cap_ptr = ctypes.c_void_p()
    wfx_ptr = ctypes.c_void_p()
    started = False

    try:
        hr = ole32.CoCreateInstance(
            ctypes.byref(CLSID_MMDeviceEnumerator),
            None,
            CLSCTX_ALL,
            ctypes.byref(IID_IMMDeviceEnumerator),
            ctypes.byref(enum_ptr),
        )
        if hr != 0:
            raise RuntimeError('CoCreateInstance IMMDeviceEnumerator falhou (0x%08X).' % (hr & 0xFFFFFFFF))

        hr = _vtbl(enum_ptr, 4, ctypes.c_int32, ctypes.c_int32, ctypes.c_int32, ctypes.POINTER(ctypes.c_void_p))(
            enum_ptr, 0, 0, ctypes.byref(dev_ptr)
        )
        if hr != 0:
            raise RuntimeError('Nenhum dispositivo padrao de saida de audio encontrado (0x%08X).' % (hr & 0xFFFFFFFF))

        hr = _vtbl(dev_ptr, 3, ctypes.c_int32, ctypes.POINTER(GUID), ctypes.c_uint32, ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p))(
            dev_ptr, ctypes.byref(IID_IAudioClient), CLSCTX_ALL, None, ctypes.byref(ac_ptr)
        )
        if hr != 0:
            raise RuntimeError('Falha ao ativar IAudioClient (0x%08X).' % (hr & 0xFFFFFFFF))

        hr = _vtbl(ac_ptr, 8, ctypes.c_int32, ctypes.POINTER(ctypes.c_void_p))(ac_ptr, ctypes.byref(wfx_ptr))
        if hr != 0 or not wfx_ptr.value:
            raise RuntimeError('GetMixFormat falhou (0x%08X).' % (hr & 0xFFFFFFFF))

        wfx = ctypes.cast(wfx_ptr, ctypes.POINTER(WAVEFORMATEX)).contents
        channels = int(wfx.nChannels)
        sample_rate = int(wfx.nSamplesPerSec)
        bits = int(wfx.wBitsPerSample)
        block_align = int(wfx.nBlockAlign)
        is_float = (wfx.wFormatTag == 3)
        if wfx.wFormatTag == 0xFFFE:
            wfext = ctypes.cast(wfx_ptr, ctypes.POINTER(WAVEFORMATEXTENSIBLE)).contents
            if _guid_eq(wfext.SubFormat, SUBTYPE_IEEE_FLOAT):
                is_float = True
            elif _guid_eq(wfext.SubFormat, SUBTYPE_PCM):
                is_float = False

        hr = _vtbl(
            ac_ptr,
            3,
            ctypes.c_int32,
            ctypes.c_int32,
            ctypes.c_uint32,
            ctypes.c_int64,
            ctypes.c_int64,
            ctypes.c_void_p,
            ctypes.c_void_p,
        )(ac_ptr, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK, 10_000_000, 0, wfx_ptr, None)
        if hr != 0:
            raise RuntimeError('IAudioClient::Initialize Loopback falhou (0x%08X).' % (hr & 0xFFFFFFFF))

        hr = _vtbl(ac_ptr, 14, ctypes.c_int32, ctypes.POINTER(GUID), ctypes.POINTER(ctypes.c_void_p))(
            ac_ptr, ctypes.byref(IID_IAudioCaptureClient), ctypes.byref(cap_ptr)
        )
        if hr != 0:
            raise RuntimeError('GetService IAudioCaptureClient falhou (0x%08X).' % (hr & 0xFFFFFFFF))

        hr = _vtbl(ac_ptr, 10, ctypes.c_int32)(ac_ptr)
        if hr != 0:
            raise RuntimeError('IAudioClient::Start falhou (0x%08X).' % (hr & 0xFFFFFFFF))
        started = True

        get_next_packet = _vtbl(cap_ptr, 5, ctypes.c_int32, ctypes.POINTER(ctypes.c_uint32))
        get_buffer = _vtbl(
            cap_ptr,
            3,
            ctypes.c_int32,
            ctypes.POINTER(ctypes.c_void_p),
            ctypes.POINTER(ctypes.c_uint32),
            ctypes.POINTER(ctypes.c_uint32),
            ctypes.POINTER(ctypes.c_uint64),
            ctypes.POINTER(ctypes.c_uint64),
        )
        release_buffer = _vtbl(cap_ptr, 4, ctypes.c_int32, ctypes.c_uint32)

        target_frames = int(sample_rate * duration_sec)
        captured_chunks = []
        frames_collected = 0
        deadline = time.monotonic() + duration_sec + 0.25

        while frames_collected < target_frames and time.monotonic() < deadline:
            pkt_len = ctypes.c_uint32(0)
            if get_next_packet(cap_ptr, ctypes.byref(pkt_len)) != 0:
                break
            if pkt_len.value == 0:
                time.sleep(0.015)
                continue

            while pkt_len.value > 0 and frames_collected < target_frames:
                data_ptr = ctypes.c_void_p()
                num_frames = ctypes.c_uint32(0)
                flags = ctypes.c_uint32(0)
                dev_pos = ctypes.c_uint64(0)
                qpc_pos = ctypes.c_uint64(0)

                hr_buf = get_buffer(
                    cap_ptr,
                    ctypes.byref(data_ptr),
                    ctypes.byref(num_frames),
                    ctypes.byref(flags),
                    ctypes.byref(dev_pos),
                    ctypes.byref(qpc_pos),
                )
                if hr_buf != 0:
                    break

                n_fr = int(num_frames.value)
                if n_fr > 0:
                    if flags.value & AUDCLNT_BUFFERFLAGS_SILENT or not data_ptr.value:
                        chunk = np.zeros((n_fr, channels), dtype=np.float32)
                    else:
                        raw_bytes = ctypes.string_at(data_ptr.value, n_fr * block_align)
                        if is_float and bits == 32:
                            chunk = np.frombuffer(raw_bytes, dtype=np.float32).reshape(-1, channels).copy()
                        elif not is_float and bits == 16:
                            chunk = (np.frombuffer(raw_bytes, dtype=np.int16).astype(np.float32) / 32768.0).reshape(-1, channels)
                        elif not is_float and bits == 32:
                            chunk = (np.frombuffer(raw_bytes, dtype=np.int32).astype(np.float32) / 2147483648.0).reshape(-1, channels)
                        else:
                            chunk = np.zeros((n_fr, channels), dtype=np.float32)
                    captured_chunks.append(chunk)
                    frames_collected += n_fr

                release_buffer(cap_ptr, num_frames.value)
                if get_next_packet(cap_ptr, ctypes.byref(pkt_len)) != 0:
                    break

        if not captured_chunks:
            return np.zeros((int(sample_rate * 0.5), max(1, channels)), dtype=np.float32), sample_rate

        audio = np.concatenate(captured_chunks, axis=0)[:target_frames]
        return audio, sample_rate
    finally:
        if started and ac_ptr.value:
            _vtbl(ac_ptr, 11, ctypes.c_int32)(ac_ptr)
        if wfx_ptr.value:
            ole32.CoTaskMemFree(wfx_ptr)
            wfx_ptr.value = None
        _com_release(cap_ptr)
        _com_release(ac_ptr)
        _com_release(dev_ptr)
        _com_release(enum_ptr)


def load_wav_file(file_path, allowed_root=None):
    if not file_path or not isinstance(file_path, str):
        raise ValueError('Caminho WAV invalido.')
    real_path = os.path.realpath(file_path)
    if not real_path.lower().endswith('.wav'):
        raise ValueError('Apenas arquivos .wav sao permitidos.')
    if allowed_root:
        real_root = os.path.realpath(allowed_root)
        if os.path.commonpath([real_root, real_path]) != real_root:
            raise PermissionError('Caminho WAV fora do diretorio permitido.')
    if not os.path.isfile(real_path):
        raise FileNotFoundError('Arquivo WAV nao encontrado: %s' % real_path)

    # Suporta PCM 8/16/24/32 bits e IEEE Float 32 bits sem depender de scipy
    with open(real_path, 'rb') as fh:
        riff = fh.read(12)
        if len(riff) < 12 or riff[:4] != b'RIFF' or riff[8:12] != b'WAVE':
            raise ValueError('Arquivo WAV invalido (cabecalho RIFF/WAVE ausente).')
        fmt_tag = 1
        channels = 2
        sr = 48000
        bits = 16
        data_bytes = b''
        while True:
            hdr = fh.read(8)
            if len(hdr) < 8:
                break
            cid = hdr[:4]
            csz = struct.unpack('<I', hdr[4:8])[0]
            body = fh.read(csz)
            if csz & 1:
                fh.read(1)
            if cid == b'fmt ' and len(body) >= 16:
                fmt_tag, channels, sr, _bps, _align, bits = struct.unpack('<HHIIHH', body[:16])
                if fmt_tag == 0xFFFE and len(body) >= 40:
                    sub_guid = body[24:40]
                    if sub_guid == bytes(SUBTYPE_IEEE_FLOAT):
                        fmt_tag = 3
                    else:
                        fmt_tag = 1
            elif cid == b'data':
                data_bytes = body
                break

    if not data_bytes:
        return np.zeros((0, max(1, channels)), dtype=np.float32), int(sr)

    if fmt_tag == 3 and bits == 32:
        arr = np.frombuffer(data_bytes, dtype=np.float32)
    elif bits == 16:
        arr = np.frombuffer(data_bytes, dtype=np.int16).astype(np.float32) / 32768.0
    elif bits == 24:
        raw_u8 = np.frombuffer(data_bytes, dtype=np.uint8).reshape(-1, 3)
        signed = (
            raw_u8[:, 0].astype(np.int32)
            | (raw_u8[:, 1].astype(np.int32) << 8)
            | (raw_u8[:, 2].astype(np.int8).astype(np.int32) << 16)
        )
        arr = signed.astype(np.float32) / 8388608.0
    elif bits == 32:
        arr = np.frombuffer(data_bytes, dtype=np.int32).astype(np.float32) / 2147483648.0
    elif bits == 8:
        arr = (np.frombuffer(data_bytes, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
    else:
        raise ValueError('Formato WAV nao suportado (tag=%d, bits=%d).' % (fmt_tag, bits))

    frames = len(arr) // max(1, channels)
    return arr[: frames * channels].reshape(frames, channels), int(sr)


def _dbfs(val, floor=-120.0):
    if val <= 1e-6:
        return floor
    return round(max(floor, 20.0 * math.log10(float(val))), 2)


def _welch_psd_numpy(sig, sr, nperseg=4096):
    n = len(sig)
    seg = min(nperseg, max(256, n))
    step = max(1, seg // 2)
    win = np.hanning(seg).astype(np.float32)
    win_norm = float(np.sum(win * win)) * float(sr)
    if win_norm <= 0:
        win_norm = 1.0

    acc = None
    count = 0
    for start in range(0, max(1, n - seg + 1), step):
        chunk = sig[start:start + seg]
        if len(chunk) < seg:
            padded = np.zeros(seg, dtype=np.float32)
            padded[:len(chunk)] = chunk
            chunk = padded
        spec = np.fft.rfft(chunk * win)
        p = (np.abs(spec) ** 2) / win_norm
        if seg % 2 == 0 and len(p) > 2:
            p[1:-1] *= 2.0
        elif len(p) > 1:
            p[1:] *= 2.0
        acc = p if acc is None else (acc + p)
        count += 1

    freqs = np.fft.rfftfreq(seg, d=1.0 / float(sr))
    psd = acc / float(max(1, count))
    return freqs, psd


def _approx_lufs_fft(audio, sr):
    # K-weighting no dominio da frequencia via teorema de Parseval (zero scipy, ultra rapido!)
    n = audio.shape[0]
    freqs = np.fft.rfftfreq(n, d=1.0 / float(sr))
    # High-pass 2a ordem em 38 Hz: |H_hp|^2 = (f^4) / (f^4 + 38^4)
    f4 = freqs ** 4
    hp_sq = f4 / (f4 + (38.0 ** 4) + 1e-12)
    # High-shelf ~1500 Hz (+4 dB -> ganho de potencia 10^(4/10) = 2.5119)
    f2 = freqs ** 2
    shelf_sq = 1.0 + 1.5119 * (f2 / (f2 + (1500.0 ** 2)))
    k_weight_sq = hp_sq * shelf_sq

    total_power = 0.0
    for ch in range(min(2, audio.shape[1])):
        spec = np.fft.rfft(audio[:, ch])
        mag_sq = (np.abs(spec) ** 2) / float(max(1, n) ** 2)
        if n % 2 == 0 and len(mag_sq) > 2:
            mag_sq[1:-1] *= 2.0
        elif len(mag_sq) > 1:
            mag_sq[1:] *= 2.0
        total_power += float(np.sum(mag_sq * k_weight_sq))

    if total_power <= 1e-12:
        return -120.0
    return round(-0.691 + 10.0 * math.log10(total_power), 2)


GENRE_TARGETS = {
    'future_bass': {'lufs': (-7.5, -4.5), 'sub_min_rel': -6.5, 'lowmid_max_rel': 4.0, 'highmid_max_rel': 3.0, 'air_min_rel': -11.0, 'crest_min': 5.0},
    'kawaii': {'lufs': (-8.0, -5.0), 'sub_min_rel': -8.0, 'lowmid_max_rel': 3.5, 'highmid_max_rel': 2.5, 'air_min_rel': -9.0, 'crest_min': 6.0},
    'dubstep': {'lufs': (-6.5, -3.5), 'sub_min_rel': -5.0, 'lowmid_max_rel': 4.2, 'highmid_max_rel': 4.2, 'air_min_rel': -12.0, 'crest_min': 4.2},
    'riddim': {'lufs': (-5.8, -3.0), 'sub_min_rel': -4.0, 'lowmid_max_rel': 4.0, 'highmid_max_rel': 4.5, 'air_min_rel': -13.0, 'crest_min': 4.2},
    'brostep': {'lufs': (-5.8, -3.0), 'sub_min_rel': -5.0, 'lowmid_max_rel': 4.2, 'highmid_max_rel': 4.8, 'air_min_rel': -11.5, 'crest_min': 4.0},
    'colour_bass': {'lufs': (-6.8, -4.0), 'sub_min_rel': -5.5, 'lowmid_max_rel': 3.8, 'highmid_max_rel': 3.8, 'air_min_rel': -9.5, 'crest_min': 4.8},
    'melodic_dubstep': {'lufs': (-6.8, -4.0), 'sub_min_rel': -6.0, 'lowmid_max_rel': 3.8, 'highmid_max_rel': 3.5, 'air_min_rel': -10.5, 'crest_min': 4.8},
}


def analyze_audio(audio, sr, genre_hint='future_bass'):
    if audio.ndim == 1:
        audio = audio[:, None]
    n_frames = int(audio.shape[0])
    channels = int(audio.shape[1])

    peak_lin = float(np.max(np.abs(audio))) if n_frames > 0 else 0.0
    rms_lin = float(np.sqrt(np.mean(audio * audio))) if n_frames > 0 else 0.0

    if peak_lin < 1e-4 or n_frames < 256:
        return {
            'silent': True,
            'sampleRate': sr,
            'channels': channels,
            'durationSec': round(n_frames / float(max(1, sr)), 2),
            'peakDbfs': -120.0,
            'rmsDbfs': -120.0,
            'lufsApprox': -120.0,
            'crestDb': 0.0,
            'clipping': False,
            'bandsDb': {},
            'stereo': {'correlation': 1.0, 'subCorrelation': 1.0, 'sideToMidDb': -120.0},
            'warnings': ['Sinal em silencio — de play no FL Studio antes de chamar fl.listen.'],
        }

    peak_db = _dbfs(peak_lin)
    rms_db = _dbfs(rms_lin)
    lufs = _approx_lufs_fft(audio, sr)
    crest_db = round(peak_db - rms_db, 2)
    clipping = peak_lin >= 0.995

    # Media da energia espectral (PSD) por canal (evita que cancelamento L+R esconda energia fora de fase!)
    if channels >= 2:
        freqs, psd_l = _welch_psd_numpy(audio[:, 0], sr, nperseg=4096)
        _, psd_r = _welch_psd_numpy(audio[:, 1], sr, nperseg=4096)
        psd = 0.5 * (psd_l + psd_r)
    else:
        freqs, psd = _welch_psd_numpy(audio[:, 0], sr, nperseg=4096)
    df = float(freqs[1] - freqs[0]) if len(freqs) > 1 else 1.0

    band_defs = [
        ('sub', 20.0, 60.0),
        ('bass', 60.0, 200.0),
        ('lowMid', 200.0, 500.0),
        ('mid', 500.0, 2000.0),
        ('highMid', 2000.0, 6000.0),
        ('air', 6000.0, min(18000.0, sr * 0.48)),
    ]
    bands_db = {}
    for name, f_lo, f_hi in band_defs:
        mask = (freqs >= f_lo) & (freqs < f_hi)
        if np.any(mask):
            power = float(np.sum(psd[mask]) * df)
            bands_db[name] = round(10.0 * math.log10(max(1e-12, power)), 2)
        else:
            bands_db[name] = -120.0

    corr = 1.0
    sub_corr = 1.0
    side_to_mid_db = -120.0
    if channels >= 2:
        left = audio[:, 0]
        right = audio[:, 1]
        denom = float(np.sqrt(np.sum(left * left) * np.sum(right * right)))
        if denom > 1e-9:
            corr = round(float(np.sum(left * right) / denom), 3)
        mid_sig = 0.5 * (left + right)
        side_sig = 0.5 * (left - right)
        mid_rms = float(np.sqrt(np.mean(mid_sig * mid_sig)))
        side_rms = float(np.sqrt(np.mean(side_sig * side_sig)))
        if mid_rms > 1e-6:
            side_to_mid_db = _dbfs(side_rms / mid_rms)

        # Correlacao espectral exata na faixa Sub (20-120 Hz) via RFFT
        spec_freqs = np.fft.rfftfreq(n_frames, d=1.0 / float(sr))
        sub_mask = (spec_freqs >= 20.0) & (spec_freqs <= 120.0)
        if np.any(sub_mask):
            xl = np.fft.rfft(left)[sub_mask]
            xr = np.fft.rfft(right)[sub_mask]
            sub_denom = float(np.sqrt(np.sum(np.abs(xl) ** 2) * np.sum(np.abs(xr) ** 2)))
            if sub_denom > 1e-8:
                sub_corr = round(float(np.real(np.sum(xl * np.conj(xr))) / sub_denom), 3)

    target = GENRE_TARGETS.get(genre_hint, GENRE_TARGETS['future_bass'])
    lufs_lo, lufs_hi = target['lufs']
    mid_db = bands_db.get('mid', -120.0)
    sub_rel = round(bands_db.get('sub', -120.0) - mid_db, 2)
    lowmid_rel = round(bands_db.get('lowMid', -120.0) - mid_db, 2)
    highmid_rel = round(bands_db.get('highMid', -120.0) - mid_db, 2)
    air_rel = round(bands_db.get('air', -120.0) - mid_db, 2)

    warnings = []
    suggestions = []
    if clipping:
        warnings.append('Clipping detectado na saida (pico >= 0 dBFS). Abaixe os faders ou coloque Soft Clipper/Limiter no Master.')
    if channels >= 2 and bands_db.get('sub', -120) > -45 and sub_corr < 0.90:
        warnings.append('Sub grave (20-120 Hz) fora de mono (correlacao %.2f). Use fl.eq com preset sub_mono_clean no Sub.' % sub_corr)
    if channels >= 2 and corr < 0.15:
        warnings.append('Correlacao estereo geral muito baixa (%.2f) — risco de cancelamento de fase em mono.' % corr)
    if lowmid_rel > target['lowmid_max_rel']:
        warnings.append('Acumulo em 200-500 Hz (+%.1f dB vs medios) — possivel lama nos acordes/synths para %s.' % (lowmid_rel, genre_hint))
        suggestions.append('Aplique corte de 3 a 4.5 dB em ~300 Hz no Chord/Bass Bus (fl.eq preset=mud_cut).')
    if highmid_rel > target['highmid_max_rel']:
        warnings.append('Excesso em 2-6 kHz (+%.1f dB vs medios) — pode soar rispido para %s.' % (highmid_rel, genre_hint))
        suggestions.append('Suavize ressonancias entre 2.8 e 4.5 kHz nos supersaws/growls ou reduza o High do OTT.')
    if sub_rel < target['sub_min_rel']:
        warnings.append('Sub (20-60 Hz) abaixo do alvo de %s (%.1f dB vs medios).' % (genre_hint, sub_rel))
        suggestions.append('Reforce o canal de Sub senoidal Mono ou confira se um HPF cortou demais abaixo de 80 Hz.')
    if air_rel < target['air_min_rel']:
        suggestions.append('Brilho/Air (6-18 kHz) discreto para %s — considere camada de top noise, shimmer ou high-shelf suave (+2 dB).' % genre_hint)
    if crest_db < target['crest_min'] and lufs > lufs_hi:
        suggestions.append('Dinamica muito esmagada (Crest %.1f dB com %.1f LUFS) — Kick e Snare podem perder punch.' % (crest_db, lufs))

    return {
        'silent': False,
        'genre': genre_hint,
        'sampleRate': sr,
        'channels': channels,
        'durationSec': round(n_frames / float(sr), 2),
        'peakDbfs': peak_db,
        'rmsDbfs': rms_db,
        'lufsApprox': lufs,
        'targetLufsRange': [lufs_lo, lufs_hi],
        'crestDb': crest_db,
        'clipping': clipping,
        'bandsDb': bands_db,
        'stereo': {
            'correlation': corr,
            'subCorrelation': sub_corr,
            'sideToMidDb': side_to_mid_db,
        },
        'warnings': warnings,
        'suggestions': suggestions,
    }


def main():
    parser = argparse.ArgumentParser(description='WASAPI Loopback & WAV spectral analyzer for Usami FL Studio.')
    parser.add_argument('--source', choices=['loopback', 'file'], default='loopback')
    parser.add_argument('--duration', type=float, default=2.5)
    parser.add_argument('--file', dest='file_path', default='')
    parser.add_argument('--allowed-root', dest='allowed_root', default=os.environ.get('USAMI_ALLOWED_WAV_ROOT', ''))
    parser.add_argument('--genre', default='future_bass')
    args = parser.parse_args()

    try:
        if args.source == 'file':
            audio, sr = load_wav_file(args.file_path, allowed_root=args.allowed_root or None)
        else:
            audio, sr = capture_wasapi_loopback(args.duration)
        report = analyze_audio(audio, sr, genre_hint=args.genre)
        sys.stdout.write(json.dumps({'ok': True, 'source': args.source, **report}, ensure_ascii=True) + '\n')
    except Exception as exc:
        sys.stdout.write(json.dumps({'ok': False, 'error': str(exc)}, ensure_ascii=True) + '\n')
    sys.stdout.flush()


if __name__ == '__main__':
    main()
