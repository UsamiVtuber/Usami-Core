"""
Ponte Zero-Dependency (stdlib Python 3.12) para Singing Voice Conversion (SVC)
estilo Neuro-sama via Seed-VC (`Plachta/Seed-VC` no Hugging Face Spaces — GPU gratuita).

Converte qualquer guia vocal cantada `.wav` (ex.: exportada do OpenUTAU DiffSinger
ou gravada no microfone/NewTone) no timbre exato da Usami usando:
  - `f0_condition = True` (modo de canto com extracao melodica RMVPE/F0)
  - `auto_f0_adjust = False` (preserva a afinacao e tom exatos da guia musical)
  - `diffusion_steps` configuravel (padrao 30)
  - `pitch_shift` em semitons (-24 a +24)
"""
import argparse
import json
import os
import shutil
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

DEFAULT_SPACE_HOST = 'https://plachta-seed-vc.hf.space'
ALLOWED_SPACE_HOSTS = frozenset(
    h.strip().lower()
    for h in os.environ.get('SEED_VC_ALLOWED_HOSTS', 'plachta-seed-vc.hf.space').split(',')
    if h.strip()
)


def validate_space_url(url, allowed_hosts=ALLOWED_SPACE_HOSTS):
    parsed = urllib.parse.urlparse(str(url or '').strip())
    if parsed.scheme != 'https' or not parsed.hostname:
        raise ValueError(f'Host Seed-VC invalido (exige https): {url}')
    hostname = parsed.hostname.lower()
    if hostname not in allowed_hosts:
        raise PermissionError(f'Host Seed-VC fora da allowlist: {hostname}')
    return f'https://{parsed.netloc}'


def upload_wav_to_gradio(host, file_path, timeout=60):
    host = validate_space_url(host)
    boundary = f'----UsamiSeedVCBoundary{uuid.uuid4().hex}'
    filename = os.path.basename(file_path)
    with open(file_path, 'rb') as fh:
        file_bytes = fh.read()

    header = (
        f'--{boundary}\r\n'
        f'Content-Disposition: form-data; name="files"; filename="{filename}"\r\n'
        f'Content-Type: audio/wav\r\n\r\n'
    ).encode('utf-8')
    footer = f'\r\n--{boundary}--\r\n'.encode('utf-8')
    body = header + file_bytes + footer

    url = f'{host.rstrip("/")}/gradio_api/upload'
    req = urllib.request.Request(
        url,
        data=body,
        method='POST',
        headers={
            'Content-Type': f'multipart/form-data; boundary={boundary}',
            'User-Agent': 'UsamiSingingBridge/1.0',
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        parsed = json.loads(resp.read().decode('utf-8'))
    if not isinstance(parsed, list) or not parsed:
        raise RuntimeError(f'Resposta inesperada no upload Gradio: {parsed}')
    return parsed[0]


def convert_singing_seed_vc(
    source_wav,
    reference_wav,
    output_wav,
    host=DEFAULT_SPACE_HOST,
    diffusion_steps=30,
    inference_cfg_rate=0.7,
    pitch_shift=0,
    auto_f0_adjust=False,
    timeout_sec=110,
):
    host = validate_space_url(host)
    source_wav = os.path.realpath(source_wav)
    reference_wav = os.path.realpath(reference_wav)
    output_wav = os.path.realpath(output_wav)
    for wav_p in (source_wav, reference_wav, output_wav):
        if not wav_p.lower().endswith('.wav'):
            raise ValueError(f'Apenas arquivos .wav sao permitidos: {wav_p}')
    if not os.path.isfile(source_wav):
        raise FileNotFoundError(f'Guia vocal nao encontrada: {source_wav}')
    if not os.path.isfile(reference_wav):
        raise FileNotFoundError(f'Amostra de referencia da Usami nao encontrada: {reference_wav}')

    started = time.time()
    src_remote = upload_wav_to_gradio(host, source_wav, timeout=60)
    ref_remote = upload_wav_to_gradio(host, reference_wav, timeout=60)

    call_payload = {
        'data': [
            {'path': src_remote, 'meta': {'_type': 'gradio.FileData'}},
            {'path': ref_remote, 'meta': {'_type': 'gradio.FileData'}},
            int(max(10, min(80, diffusion_steps))),
            1.0,  # length_adjust (1.0 preserva BPM exato do projeto!)
            float(max(0.0, min(1.5, inference_cfg_rate))),
            True,  # f0_condition = True (Singing Voice Conversion!)
            bool(auto_f0_adjust),
            int(max(-24, min(24, pitch_shift))),
        ],
    }

    call_url = f'{host.rstrip("/")}/gradio_api/call/predict_1'
    req = urllib.request.Request(
        call_url,
        data=json.dumps(call_payload).encode('utf-8'),
        method='POST',
        headers={
            'Content-Type': 'application/json',
            'User-Agent': 'UsamiSingingBridge/1.0',
        },
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        call_info = json.loads(resp.read().decode('utf-8'))

    event_id = call_info.get('event_id')
    if not event_id:
        raise RuntimeError(f'Gradio nao retornou event_id: {call_info}')

    sse_url = f'{host.rstrip("/")}/gradio_api/call/predict_1/{event_id}'
    sse_req = urllib.request.Request(sse_url, headers={'User-Agent': 'UsamiSingingBridge/1.0'})

    current_event = None
    final_data = None

    with urllib.request.urlopen(sse_req, timeout=timeout_sec) as sse_resp:
        for raw_line in sse_resp:
            if time.time() - started > timeout_sec:
                raise TimeoutError('Tempo limite excedido aguardando GPU do Seed-VC.')
            line = raw_line.decode('utf-8', errors='replace').strip()
            if not line:
                continue
            if line.startswith('event:'):
                current_event = line.split(':', 1)[1].strip()
            elif line.startswith('data:'):
                data_str = line.split(':', 1)[1].strip()
                if current_event == 'error':
                    raise RuntimeError(f'Seed-VC retornou erro na nuvem: {data_str}')
                if current_event == 'complete':
                    final_data = json.loads(data_str)
                    break

    if not isinstance(final_data, list) or len(final_data) < 2:
        raise RuntimeError(f'Seed-VC nao retornou audio completo esperado: {final_data}')

    full_audio_obj = final_data[1] or final_data[0]
    if not isinstance(full_audio_obj, dict):
        raise RuntimeError(f'Formato de audio inesperado: {full_audio_obj}')

    dl_url = full_audio_obj.get('url')
    if not dl_url and full_audio_obj.get('path'):
        quoted = urllib.parse.quote(full_audio_obj['path'], safe='/')
        dl_url = f'{host.rstrip("/")}/gradio_api/file={quoted}'
    if not dl_url:
        raise RuntimeError(f'URL de download ausente no retorno do Seed-VC: {full_audio_obj}')
    dl_parsed = urllib.parse.urlparse(dl_url)
    if dl_parsed.scheme != 'https' or (dl_parsed.hostname or '').lower() not in ALLOWED_SPACE_HOSTS:
        raise PermissionError(f'URL de download fora da allowlist Seed-VC: {dl_url}')

    os.makedirs(os.path.dirname(os.path.abspath(output_wav)), exist_ok=True)
    dl_req = urllib.request.Request(dl_url, headers={'User-Agent': 'UsamiSingingBridge/1.0'})
    with urllib.request.urlopen(dl_req, timeout=60) as dl_resp, open(output_wav, 'wb') as out_fh:
        shutil.copyfileobj(dl_resp, out_fh)

    elapsed = round(time.time() - started, 2)
    return {
        'ok': True,
        'engine': 'seed-vc-singing-f0',
        'spaceHost': host,
        'sourceWav': os.path.abspath(source_wav),
        'referenceWav': os.path.abspath(reference_wav),
        'outputWav': os.path.abspath(output_wav),
        'outputBytes': os.path.getsize(output_wav),
        'diffusionSteps': diffusion_steps,
        'pitchShiftSemitones': pitch_shift,
        'elapsedSec': elapsed,
    }


def main():
    parser = argparse.ArgumentParser(description='Convert singing guide WAV into Usami voice via Seed-VC F0.')
    parser.add_argument('--source', required=True, help='Path to input singing guide WAV')
    parser.add_argument('--reference', required=True, help='Path to Usami reference WAV (30s)')
    parser.add_argument('--output', required=True, help='Path to save converted Usami singing WAV')
    parser.add_argument('--steps', type=int, default=30)
    parser.add_argument('--cfg-rate', type=float, default=0.7)
    parser.add_argument('--pitch-shift', type=int, default=0)
    parser.add_argument('--auto-f0', action='store_true')
    parser.add_argument('--host', default=DEFAULT_SPACE_HOST)
    args = parser.parse_args()

    try:
        res = convert_singing_seed_vc(
            source_wav=args.source,
            reference_wav=args.reference,
            output_wav=args.output,
            host=args.host,
            diffusion_steps=args.steps,
            inference_cfg_rate=args.cfg_rate,
            pitch_shift=args.pitch_shift,
            auto_f0_adjust=args.auto_f0,
        )
        sys.stdout.write(json.dumps(res) + '\n')
    except Exception as exc:
        sys.stdout.write(json.dumps({
            'ok': False,
            'error': str(exc)[:300],
        }) + '\n')
        sys.exit(1)


if __name__ == '__main__':
    main()
