"""
Criador nativo de presets `.SerumPreset` (Xfer Serum 2) via CBOR + Zstandard + MD5.

Le um preset-base real da biblioteca do Serum 2 (preservando 100% da estrutura interna
e wavetables compativeis com Serum 2.0.x), modifica osciladores, unison, detune, filtro,
sub, parametros globais, macros e metadados no CBOR, recomprime em Zstandard, calcula
o hash MD5 exato do bloco comprimido e grava em `Presets/User/<bankName>/<presetName>.SerumPreset`.
"""
import argparse
import glob
import hashlib
import json
import os
import re
import struct
import sys

try:
    import cbor2
    import zstandard as zstd
except ImportError as exc:
    sys.stdout.write(json.dumps({
        'ok': False,
        'error': f'Dependencia Python ausente para criar .SerumPreset ({exc}). Rode: pip install zstandard cbor2',
    }) + '\n')
    sys.exit(1)

XFER_MAGIC = b'XferJson\x00'

STYLE_ARCHETYPES = {
    'supersaw': {
        'baseKeywords': ['supersaw', 'saw', 'trance', 'chord', 'future', 'lead'],
        'tags': ['Wavetable', 'Poly', 'Chords', 'Usami'],
        'description': 'Supersaw largo estilo Future Bass / Melodic Dubstep gerado pela Usami.',
        'unison': 7,
        'detune': 0.34,
        'unisonStereo': 1.0,
        'octave': 0,
        'filterEnable': True,
        'filterFreq': 0.78,
        'filterReso': 0.14,
        'filterDrive': 0.18,
        'subEnable': True,
        'subOctave': -1,
        'subVolume': 0.45,
        'mono': False,
        'macros': [('Saw Detune', 0.45), ('Filter Cut', 0.78), ('OTT / Air', 0.55), ('Sub Mix', 0.45)],
    },
    'growl': {
        'baseKeywords': ['growl', 'grit', 'monster', 'dubstep', 'fm', 'acid'],
        'tags': ['Wavetable', 'Mono', 'Bass', 'Usami'],
        'description': 'Growl agressivo de Dubstep / Brostep gerado pela Usami.',
        'unison': 3,
        'detune': 0.22,
        'unisonStereo': 0.45,
        'octave': -1,
        'filterEnable': True,
        'filterFreq': 0.42,
        'filterReso': 0.48,
        'filterDrive': 0.62,
        'subEnable': True,
        'subOctave': -2,
        'subVolume': 0.65,
        'mono': True,
        'macros': [('Growl Warp', 0.52), ('Formant', 0.42), ('Drive', 0.62), ('Sub Weight', 0.65)],
    },
    'riddim_square4': {
        'baseKeywords': ['riddim', 'square', 'metallic', 'comb', 'wobble', 'bass'],
        'tags': ['Wavetable', 'Mono', 'Bass', 'Riddim', 'Usami'],
        'description': 'Bass metalico estilo Riddim Square 4 gerado pela Usami.',
        'unison': 2,
        'detune': 0.14,
        'unisonStereo': 0.3,
        'octave': -1,
        'filterEnable': True,
        'filterFreq': 0.55,
        'filterReso': 0.62,
        'filterDrive': 0.55,
        'subEnable': True,
        'subOctave': -2,
        'subVolume': 0.68,
        'mono': True,
        'macros': [('Comb Rate', 0.5), ('Metallic', 0.62), ('Drive', 0.55), ('Sub', 0.68)],
    },
    'colour_bass': {
        'baseKeywords': ['spectral', 'colour', 'prism', 'granular', 'crystal', 'chord'],
        'tags': ['Spectral', 'Poly', 'Bass', 'Usami'],
        'description': 'Timbre harmonico brilhante para Colour Bass / Vocodex gerado pela Usami.',
        'unison': 5,
        'detune': 0.26,
        'unisonStereo': 0.85,
        'octave': 0,
        'filterEnable': True,
        'filterFreq': 0.68,
        'filterReso': 0.28,
        'filterDrive': 0.35,
        'subEnable': True,
        'subOctave': -2,
        'subVolume': 0.4,
        'mono': False,
        'macros': [('Prism', 0.65), ('Bright', 0.68), ('Width', 0.85), ('Sub', 0.4)],
    },
    'kawaii_pluck': {
        'baseKeywords': ['kawaii', 'pluck', 'bell', 'blip', 'cute', 'arp', 'lead'],
        'tags': ['Wavetable', 'Poly', 'Plucked', 'Lead', 'Usami'],
        'description': 'Pluck / Lead fofo estilo Kawaii Future Bass gerado pela Usami.',
        'unison': 4,
        'detune': 0.18,
        'unisonStereo': 0.72,
        'octave': 1,
        'filterEnable': True,
        'filterFreq': 0.72,
        'filterReso': 0.20,
        'filterDrive': 0.12,
        'subEnable': False,
        'subOctave': -1,
        'subVolume': 0.2,
        'mono': False,
        'macros': [('Sparkle', 0.72), ('Detune', 0.18), ('Stereo', 0.72), ('Tone', 0.5)],
    },
    'reese': {
        'baseKeywords': ['reese', 'neuro', 'sub', 'acid', 'dark'],
        'tags': ['Wavetable', 'Mono', 'Bass', 'Usami'],
        'description': 'Reese Bass continuo com detune pesado gerado pela Usami.',
        'unison': 6,
        'detune': 0.42,
        'unisonStereo': 0.65,
        'octave': -1,
        'filterEnable': True,
        'filterFreq': 0.38,
        'filterReso': 0.25,
        'filterDrive': 0.58,
        'subEnable': True,
        'subOctave': -2,
        'subVolume': 0.72,
        'mono': True,
        'macros': [('Detune', 0.42), ('Cutoff', 0.38), ('Drive', 0.58), ('Sub', 0.72)],
    },
}


def resolve_presets_root():
    home = os.path.expanduser('~')
    for candidate in [
        os.path.join(home, 'OneDrive', 'Documentos', 'Xfer', 'Serum 2 Presets', 'Presets'),
        os.path.join(home, 'Documents', 'Xfer', 'Serum 2 Presets', 'Presets'),
    ]:
        if os.path.isdir(candidate):
            return candidate
    return None


def find_base_preset(presets_root, keywords):
    all_files = glob.glob(os.path.join(presets_root, '**', '*.SerumPreset'), recursive=True)
    if not all_files:
        raise FileNotFoundError(f'Nenhum .SerumPreset encontrado em {presets_root}')
    # Evita usar presets ja gerados na subpasta User/Usami como base se houver Factory
    factory_first = [p for p in all_files if f'{os.sep}User{os.sep}Usami{os.sep}' not in p]
    pool = factory_first or all_files

    best_path = pool[0]
    best_score = -1
    for p in pool:
        low = p.lower()
        score = sum(3 if kw in os.path.basename(low) else (1 if kw in low else 0) for kw in keywords)
        if score > best_score:
            best_score = score
            best_path = p
    return best_path


def read_serum2_preset(file_path):
    with open(file_path, 'rb') as fh:
        raw = fh.read()
    if not raw.startswith(XFER_MAGIC):
        raise ValueError(f'Cabecalho XferJson ausente em {file_path}')
    hdr_len = struct.unpack('<Q', raw[9:17])[0]
    hdr_obj = json.loads(raw[17:17 + hdr_len].decode('utf-8'))
    after = raw[17 + hdr_len:]
    uncomp_len, version_tag = struct.unpack('<II', after[:8])
    cbor_bytes = zstd.ZstdDecompressor().decompress(after[8:])
    cbor_obj = cbor2.loads(cbor_bytes)
    return hdr_obj, version_tag, cbor_obj


def _set_plain(section_dict, key, value):
    if not isinstance(section_dict, dict):
        return
    pp = section_dict.setdefault('plainParams', {})
    if isinstance(pp, dict):
        pp[key] = float(value)


def create_serum_preset(
    presets_root,
    preset_name,
    style='supersaw',
    bank_name='Usami',
    overrides=None,
):
    if style not in STYLE_ARCHETYPES:
        raise ValueError(f'Estilo desconhecido: {style}. Disponiveis: {", ".join(STYLE_ARCHETYPES.keys())}')

    spec = dict(STYLE_ARCHETYPES[style])
    if isinstance(overrides, dict):
        for k, v in overrides.items():
            if v is not None:
                spec[k] = v

    base_path = find_base_preset(presets_root, spec['baseKeywords'])
    hdr_obj, version_tag, cbor_obj = read_serum2_preset(base_path)

    clean_name = re.sub(r'[<>:"/\\|?*]+', '_', str(preset_name).strip()).strip(' .') or f'Usami - {style}'
    clean_bank = re.sub(r'[<>:"/\\|?*]+', '_', str(bank_name).strip()).strip(' .') or 'Usami'

    # Atualiza metadados dentro do CBOR
    cbor_obj['presetName'] = clean_name
    cbor_obj['presetAuthor'] = 'Usami Co-Producer'
    cbor_obj['presetDescription'] = spec['description']
    cbor_obj['tags'] = list(spec['tags'])

    # Oscilador A (Oscillator0)
    osc0 = cbor_obj.setdefault('Oscillator0', {})
    _set_plain(osc0, 'kParamEnable', 1.0)
    _set_plain(osc0, 'kParamUnison', max(1, min(16, int(spec['unison']))))
    _set_plain(osc0, 'kParamDetune', max(0.0, min(1.0, float(spec['detune']))))
    _set_plain(osc0, 'kParamUnisonStereo', max(0.0, min(1.0, float(spec['unisonStereo']))))
    _set_plain(osc0, 'kParamOctave', max(-4, min(4, int(spec['octave']))))

    # Sub Oscilador (Oscillator4)
    osc4 = cbor_obj.setdefault('Oscillator4', {})
    _set_plain(osc4, 'kParamEnable', 1.0 if spec['subEnable'] else 0.0)
    _set_plain(osc4, 'kParamOctave', max(-4, min(2, int(spec['subOctave']))))
    _set_plain(osc4, 'kParamVolume', max(0.0, min(1.0, float(spec['subVolume']))))

    # Filtro principal (VoiceFilter0)
    vf0 = cbor_obj.setdefault('VoiceFilter0', {})
    _set_plain(vf0, 'kParamEnable', 1.0 if spec['filterEnable'] else 0.0)
    _set_plain(vf0, 'kParamFreq', max(0.0, min(1.0, float(spec['filterFreq']))))
    _set_plain(vf0, 'kParamReso', max(0.0, min(1.0, float(spec['filterReso']))))
    _set_plain(vf0, 'kParamDrive', max(0.0, min(1.0, float(spec['filterDrive']))))

    # Global (Mono / Legato)
    glob0 = cbor_obj.setdefault('Global0', {})
    _set_plain(glob0, 'kParamMonoToggle', 1.0 if spec['mono'] else 0.0)
    _set_plain(glob0, 'kParamLegato', 1.0 if spec['mono'] else 0.0)

    # Macros 1..4
    for idx, (m_name, m_val) in enumerate(spec.get('macros', [])[:4]):
        macro_sec = cbor_obj.setdefault(f'Macro{idx}', {})
        if isinstance(macro_sec, dict):
            macro_sec['name'] = str(m_name)
            _set_plain(macro_sec, 'kParamValue', float(m_val))

    # Re-serializa CBOR + Zstandard + MD5 do bloco comprimido
    new_cbor = cbor2.dumps(cbor_obj)
    cctx = zstd.ZstdCompressor(level=10)
    comp_bytes = cctx.compress(new_cbor)
    comp_md5 = hashlib.md5(comp_bytes).hexdigest()

    new_hdr = {
        'fileType': 'SerumPreset',
        'hash': comp_md5,
        'presetAuthor': 'Usami Co-Producer',
        'presetDescription': spec['description'],
        'presetName': clean_name,
        'product': hdr_obj.get('product', 'Serum2'),
        'productVersion': hdr_obj.get('productVersion', '2.0.13'),
        'tags': list(spec['tags']),
        'url': 'https://xferrecords.com/',
        'vendor': 'Xfer Records',
        'version': float(hdr_obj.get('version', 5.0)),
    }
    hdr_bytes = json.dumps(new_hdr, ensure_ascii=False, separators=(',', ':')).encode('utf-8')

    out_dir = os.path.join(presets_root, 'User', clean_bank)
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, f'{clean_name}.SerumPreset')

    full_bytes = (
        XFER_MAGIC
        + struct.pack('<Q', len(hdr_bytes))
        + hdr_bytes
        + struct.pack('<II', len(new_cbor), version_tag)
        + comp_bytes
    )
    with open(out_path, 'wb') as fh:
        fh.write(full_bytes)

    # Verificacao imediata de integridade round-trip
    chk_hdr, _chk_ver, chk_cbor = read_serum2_preset(out_path)
    if chk_hdr.get('hash') != comp_md5 or chk_cbor.get('presetName') != clean_name:
        raise RuntimeError('Falha na verificacao de integridade do .SerumPreset gerado.')

    return {
        'ok': True,
        'presetName': clean_name,
        'style': style,
        'bankName': clean_bank,
        'outPath': os.path.abspath(out_path),
        'basePresetUsed': os.path.basename(base_path),
        'bytesWritten': len(full_bytes),
        'md5': comp_md5,
        'tags': spec['tags'],
        'appliedParams': {
            'unison': spec['unison'],
            'detune': spec['detune'],
            'octave': spec['octave'],
            'filterFreq': spec['filterFreq'],
            'filterReso': spec['filterReso'],
            'filterDrive': spec['filterDrive'],
            'subEnable': spec['subEnable'],
            'mono': spec['mono'],
        },
    }


def main():
    parser = argparse.ArgumentParser(description='Create native Xfer Serum 2 .SerumPreset files.')
    parser.add_argument('--payload', required=True, help='JSON payload with presetName, style, bankName, presetsRoot, overrides')
    args = parser.parse_args()

    try:
        req = json.loads(args.payload)
        root = req.get('presetsRoot') or resolve_presets_root()
        if not root or not os.path.isdir(root):
            raise FileNotFoundError('Pasta de presets do Serum 2 nao encontrada.')
        res = create_serum_preset(
            presets_root=root,
            preset_name=req.get('presetName') or f'Usami - {req.get("style", "supersaw")}',
            style=req.get('style') or 'supersaw',
            bank_name=req.get('bankName') or 'Usami',
            overrides=req.get('overrides') or {},
        )
        sys.stdout.write(json.dumps(res) + '\n')
    except Exception as exc:
        sys.stdout.write(json.dumps({'ok': False, 'error': str(exc)[:300]}) + '\n')
        sys.exit(1)


if __name__ == '__main__':
    main()
