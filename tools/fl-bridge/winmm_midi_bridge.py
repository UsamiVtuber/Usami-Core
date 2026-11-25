import argparse
import ctypes
import json
import sys
import threading
import time

SYSEX_HEADER = bytes([0xF0, 0x7D, 0x55, 0x53, 0x4D])  # F0 7D 'USM'
SYSEX_END = 0xF7
CALLBACK_FUNCTION = 0x00030000
MIM_LONGDATA = 0x3C4
RECV_BUFFER_SIZE = 65536


class MIDIOUTCAPSW(ctypes.Structure):
    _pack_ = 1
    _fields_ = [
        ('wMid', ctypes.c_uint16),
        ('wPid', ctypes.c_uint16),
        ('vDriverVersion', ctypes.c_uint32),
        ('szPname', ctypes.c_wchar * 32),
        ('wTechnology', ctypes.c_uint16),
        ('wVoices', ctypes.c_uint16),
        ('wNotes', ctypes.c_uint16),
        ('wChannelMask', ctypes.c_uint16),
        ('dwSupport', ctypes.c_uint32),
    ]


class MIDIINCAPSW(ctypes.Structure):
    _pack_ = 1
    _fields_ = [
        ('wMid', ctypes.c_uint16),
        ('wPid', ctypes.c_uint16),
        ('vDriverVersion', ctypes.c_uint32),
        ('szPname', ctypes.c_wchar * 32),
        ('dwSupport', ctypes.c_uint32),
    ]


class MIDIHDR(ctypes.Structure):
    _pack_ = 1
    _fields_ = [
        ('lpData', ctypes.c_char_p),
        ('dwBufferLength', ctypes.c_uint32),
        ('dwBytesRecorded', ctypes.c_uint32),
        ('dwUser', ctypes.c_size_t),
        ('dwFlags', ctypes.c_uint32),
        ('lpNext', ctypes.c_void_p),
        ('reserved', ctypes.c_size_t),
        ('dwOffset', ctypes.c_uint32),
        ('dwReserved', ctypes.c_size_t * 8),
    ]


MIDIINPROC = ctypes.WINFUNCTYPE(
    None,
    ctypes.c_void_p,
    ctypes.c_uint32,
    ctypes.c_size_t,
    ctypes.c_size_t,
    ctypes.c_size_t,
)


def _load_winmm():
    if sys.platform != 'win32':
        raise RuntimeError('Bridge WinMM disponivel apenas no Windows.')
    winmm = ctypes.windll.winmm

    winmm.midiOutGetNumDevs.argtypes = []
    winmm.midiOutGetNumDevs.restype = ctypes.c_uint32
    winmm.midiInGetNumDevs.argtypes = []
    winmm.midiInGetNumDevs.restype = ctypes.c_uint32

    winmm.midiOutGetDevCapsW.argtypes = [ctypes.c_size_t, ctypes.POINTER(MIDIOUTCAPSW), ctypes.c_uint32]
    winmm.midiOutGetDevCapsW.restype = ctypes.c_uint32
    winmm.midiInGetDevCapsW.argtypes = [ctypes.c_size_t, ctypes.POINTER(MIDIINCAPSW), ctypes.c_uint32]
    winmm.midiInGetDevCapsW.restype = ctypes.c_uint32

    winmm.midiOutOpen.argtypes = [
        ctypes.POINTER(ctypes.c_void_p),
        ctypes.c_uint32,
        ctypes.c_size_t,
        ctypes.c_size_t,
        ctypes.c_uint32,
    ]
    winmm.midiOutOpen.restype = ctypes.c_uint32
    winmm.midiOutClose.argtypes = [ctypes.c_void_p]
    winmm.midiOutClose.restype = ctypes.c_uint32
    winmm.midiOutShortMsg.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
    winmm.midiOutShortMsg.restype = ctypes.c_uint32
    winmm.midiOutPrepareHeader.argtypes = [ctypes.c_void_p, ctypes.POINTER(MIDIHDR), ctypes.c_uint32]
    winmm.midiOutPrepareHeader.restype = ctypes.c_uint32
    winmm.midiOutUnprepareHeader.argtypes = [ctypes.c_void_p, ctypes.POINTER(MIDIHDR), ctypes.c_uint32]
    winmm.midiOutUnprepareHeader.restype = ctypes.c_uint32
    winmm.midiOutLongMsg.argtypes = [ctypes.c_void_p, ctypes.POINTER(MIDIHDR), ctypes.c_uint32]
    winmm.midiOutLongMsg.restype = ctypes.c_uint32

    winmm.midiInOpen.argtypes = [
        ctypes.POINTER(ctypes.c_void_p),
        ctypes.c_uint32,
        ctypes.c_size_t,
        ctypes.c_size_t,
        ctypes.c_uint32,
    ]
    winmm.midiInOpen.restype = ctypes.c_uint32
    winmm.midiInClose.argtypes = [ctypes.c_void_p]
    winmm.midiInClose.restype = ctypes.c_uint32
    winmm.midiInPrepareHeader.argtypes = [ctypes.c_void_p, ctypes.POINTER(MIDIHDR), ctypes.c_uint32]
    winmm.midiInPrepareHeader.restype = ctypes.c_uint32
    winmm.midiInUnprepareHeader.argtypes = [ctypes.c_void_p, ctypes.POINTER(MIDIHDR), ctypes.c_uint32]
    winmm.midiInUnprepareHeader.restype = ctypes.c_uint32
    winmm.midiInAddBuffer.argtypes = [ctypes.c_void_p, ctypes.POINTER(MIDIHDR), ctypes.c_uint32]
    winmm.midiInAddBuffer.restype = ctypes.c_uint32
    winmm.midiInStart.argtypes = [ctypes.c_void_p]
    winmm.midiInStart.restype = ctypes.c_uint32
    winmm.midiInStop.argtypes = [ctypes.c_void_p]
    winmm.midiInStop.restype = ctypes.c_uint32
    winmm.midiInReset.argtypes = [ctypes.c_void_p]
    winmm.midiInReset.restype = ctypes.c_uint32

    return winmm


def list_ports(winmm):
    inputs = []
    outputs = []
    for idx in range(winmm.midiInGetNumDevs()):
        caps = MIDIINCAPSW()
        if winmm.midiInGetDevCapsW(idx, ctypes.byref(caps), ctypes.sizeof(caps)) == 0:
            inputs.append({'index': idx, 'name': caps.szPname})
    for idx in range(winmm.midiOutGetNumDevs()):
        caps = MIDIOUTCAPSW()
        if winmm.midiOutGetDevCapsW(idx, ctypes.byref(caps), ctypes.sizeof(caps)) == 0:
            outputs.append({'index': idx, 'name': caps.szPname})
    return inputs, outputs


def find_port(ports, target_name):
    needle = str(target_name or '').strip().lower()
    if not needle:
        return None
    for port in ports:
        if port['name'].strip().lower() == needle:
            return port
    for port in ports:
        if needle in port['name'].strip().lower():
            return port
    return None


def _emit_json(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=True) + '\n')
    sys.stdout.flush()


def cmd_list(_args):
    winmm = _load_winmm()
    inputs, outputs = list_ports(winmm)
    _emit_json({'ok': True, 'inputs': inputs, 'outputs': outputs})


def cmd_request(args):
    winmm = _load_winmm()
    inputs, outputs = list_ports(winmm)
    out_port = find_port(outputs, args.out_port)
    in_port = find_port(inputs, args.in_port)

    if not out_port or not in_port:
        missing = []
        if not out_port:
            missing.append('saida "%s"' % args.out_port)
        if not in_port:
            missing.append('entrada "%s"' % args.in_port)
        _emit_json({
            'ok': False,
            'code': 'port_not_found',
            'error': 'Porta MIDI virtual nao encontrada (%s). Abra o loopMIDI e crie as portas "%s" e "%s".'
            % (', '.join(missing), args.out_port, args.in_port),
            'inputs': [p['name'] for p in inputs],
            'outputs': [p['name'] for p in outputs],
        })
        return

    payload = json.loads(args.payload)
    req_id = payload.get('id')
    encoded_json = json.dumps(payload, ensure_ascii=True, separators=(',', ':')).encode('ascii')
    sysex_bytes = SYSEX_HEADER + encoded_json + bytes([SYSEX_END])

    h_in = ctypes.c_void_p()
    h_out = ctypes.c_void_p()
    done_event = threading.Event()
    response_holder = {'data': None, 'parse_error': None}
    closing = {'flag': False}

    recv_buf = ctypes.create_string_buffer(RECV_BUFFER_SIZE)
    recv_hdr = MIDIHDR()
    recv_hdr.lpData = ctypes.cast(recv_buf, ctypes.c_char_p)
    recv_hdr.dwBufferLength = RECV_BUFFER_SIZE

    def on_midi_in(_handle, msg, _instance, param1, _param2):
        if msg != MIM_LONGDATA or closing['flag']:
            return
        try:
            hdr_ptr = ctypes.cast(param1, ctypes.POINTER(MIDIHDR))
            recorded = int(hdr_ptr.contents.dwBytesRecorded)
            if recorded > len(SYSEX_HEADER) + 2:
                raw = bytes(recv_buf.raw[:recorded])
                if raw.startswith(SYSEX_HEADER) and raw[-1] == SYSEX_END:
                    text = raw[len(SYSEX_HEADER):-1].decode('ascii', errors='strict')
                    parsed = json.loads(text)
                    if isinstance(parsed, dict) and (req_id is None or parsed.get('id') == req_id):
                        response_holder['data'] = parsed
                        done_event.set()
                        return
        except Exception as exc:
            response_holder['parse_error'] = str(exc)
        if not closing['flag'] and h_in.value:
            winmm.midiInAddBuffer(h_in, ctypes.byref(recv_hdr), ctypes.sizeof(recv_hdr))

    cb_ref = MIDIINPROC(on_midi_in)

    try:
        rc = winmm.midiInOpen(
            ctypes.byref(h_in),
            in_port['index'],
            ctypes.cast(cb_ref, ctypes.c_void_p).value,
            0,
            CALLBACK_FUNCTION,
        )
        if rc != 0:
            _emit_json({'ok': False, 'code': 'midi_in_open_failed', 'error': 'Falha ao abrir porta de entrada "%s" (codigo %d).' % (in_port['name'], rc)})
            return

        winmm.midiInPrepareHeader(h_in, ctypes.byref(recv_hdr), ctypes.sizeof(recv_hdr))
        winmm.midiInAddBuffer(h_in, ctypes.byref(recv_hdr), ctypes.sizeof(recv_hdr))
        winmm.midiInStart(h_in)

        rc_out = winmm.midiOutOpen(ctypes.byref(h_out), out_port['index'], 0, 0, 0)
        if rc_out != 0:
            _emit_json({'ok': False, 'code': 'midi_out_open_failed', 'error': 'Falha ao abrir porta de saida "%s" (codigo %d).' % (out_port['name'], rc_out)})
            return

        send_buf = ctypes.create_string_buffer(sysex_bytes, len(sysex_bytes))
        send_hdr = MIDIHDR()
        send_hdr.lpData = ctypes.cast(send_buf, ctypes.c_char_p)
        send_hdr.dwBufferLength = len(sysex_bytes)

        rc_prep = winmm.midiOutPrepareHeader(h_out, ctypes.byref(send_hdr), ctypes.sizeof(send_hdr))
        if rc_prep != 0:
            _emit_json({'ok': False, 'code': 'sysex_prepare_failed', 'error': 'midiOutPrepareHeader falhou (codigo %d).' % rc_prep})
            return

        rc_send = winmm.midiOutLongMsg(h_out, ctypes.byref(send_hdr), ctypes.sizeof(send_hdr))
        winmm.midiOutUnprepareHeader(h_out, ctypes.byref(send_hdr), ctypes.sizeof(send_hdr))
        if rc_send != 0:
            _emit_json({'ok': False, 'code': 'sysex_send_failed', 'error': 'midiOutLongMsg falhou (codigo %d).' % rc_send})
            return

        timeout_sec = max(0.2, float(args.timeout_ms) / 1000.0)
        if not done_event.wait(timeout_sec):
            _emit_json({
                'ok': False,
                'code': 'timeout',
                'error': 'FL Studio nao respondeu em %d ms. Verifique se o FL Studio esta aberto, com o script "Usami Companion Bridge" selecionado em "%s" e com o mesmo numero de Port nas portas "%s" e "%s".'
                % (args.timeout_ms, out_port['name'], out_port['name'], in_port['name']),
            })
            return

        if response_holder['data'] is not None:
            _emit_json(response_holder['data'])
        else:
            _emit_json({'ok': False, 'code': 'parse_error', 'error': response_holder['parse_error'] or 'Resposta SysEx invalida.'})
    finally:
        closing['flag'] = True
        if h_in.value:
            winmm.midiInStop(h_in)
            winmm.midiInReset(h_in)
            winmm.midiInUnprepareHeader(h_in, ctypes.byref(recv_hdr), ctypes.sizeof(recv_hdr))
            winmm.midiInClose(h_in)
        if h_out.value:
            winmm.midiOutClose(h_out)
        # Mantem referencia ao callback viva ate fechar midiInClose
        del cb_ref


def _short_msg(status, data1, data2):
    return (int(status) & 0xFF) | ((int(data1) & 0x7F) << 8) | ((int(data2) & 0x7F) << 16)


def cmd_notes(args):
    winmm = _load_winmm()
    inputs, outputs = list_ports(winmm)
    out_port = find_port(outputs, args.out_port)
    if not out_port:
        _emit_json({
            'ok': False,
            'code': 'port_not_found',
            'error': 'Porta MIDI de saida "%s" nao encontrada. Verifique o loopMIDI.' % args.out_port,
            'inputs': [p['name'] for p in inputs],
            'outputs': [p['name'] for p in outputs],
        })
        return

    payload = json.loads(args.payload)
    channel = max(0, min(15, int(payload.get('channel', 0))))
    events = payload.get('events') or []

    h_out = ctypes.c_void_p()
    active_notes = set()
    notes_sent = 0
    events_played = 0

    try:
        rc_out = winmm.midiOutOpen(ctypes.byref(h_out), out_port['index'], 0, 0, 0)
        if rc_out != 0:
            _emit_json({'ok': False, 'code': 'midi_out_open_failed', 'error': 'Falha ao abrir porta de saida "%s" (codigo %d).' % (out_port['name'], rc_out)})
            return

        note_on_status = 0x90 | channel
        note_off_status = 0x80 | channel

        for evt in events:
            delay_ms = max(0, int(evt.get('delayMs', 0)))
            if delay_ms > 0:
                time.sleep(delay_ms / 1000.0)
            notes = [max(0, min(127, int(n))) for n in (evt.get('notes') or [])]
            vel = max(1, min(127, int(evt.get('velocity', 100))))
            dur_ms = max(40, min(4000, int(evt.get('durationMs', 350))))

            for note in notes:
                winmm.midiOutShortMsg(h_out, _short_msg(note_on_status, note, vel))
                active_notes.add(note)
                notes_sent += 1

            time.sleep(dur_ms / 1000.0)

            for note in notes:
                winmm.midiOutShortMsg(h_out, _short_msg(note_off_status, note, 0))
                active_notes.discard(note)

            events_played += 1

        _emit_json({
            'ok': True,
            'port': out_port['name'],
            'channel': channel,
            'notesSent': notes_sent,
            'eventsPlayed': events_played,
        })
    finally:
        if h_out.value:
            note_off_status = 0x80 | channel
            for note in list(active_notes):
                winmm.midiOutShortMsg(h_out, _short_msg(note_off_status, note, 0))
            winmm.midiOutClose(h_out)


def main():
    parser = argparse.ArgumentParser(description='WinMM MIDI/SysEx bridge for FL Studio.')
    sub = parser.add_subparsers(dest='command', required=True)

    sub.add_parser('list')

    req_p = sub.add_parser('request')
    req_p.add_argument('--out', dest='out_port', required=True)
    req_p.add_argument('--in', dest='in_port', required=True)
    req_p.add_argument('--payload', required=True)
    req_p.add_argument('--timeout-ms', type=int, default=4000)

    notes_p = sub.add_parser('notes')
    notes_p.add_argument('--out', dest='out_port', required=True)
    notes_p.add_argument('--payload', required=True)

    args = parser.parse_args()
    try:
        if args.command == 'list':
            cmd_list(args)
        elif args.command == 'request':
            cmd_request(args)
        elif args.command == 'notes':
            cmd_notes(args)
    except Exception as exc:
        _emit_json({'ok': False, 'code': 'bridge_error', 'error': str(exc)})


if __name__ == '__main__':
    main()
