# name=Usami Companion Bridge
# url=https://github.com/UsamiVtuber/Usami-Core

import json
import device
import transport
import mixer
import channels
import patterns
import plugins
import arrangement
import general
import ui
import midi

SYSEX_HEADER = bytes([0xF0, 0x7D, 0x55, 0x53, 0x4D])  # F0 7D 'USM'
SYSEX_END = 0xF7
MAX_SYSEX_JSON_BYTES = 12000


def _safe(fn, default=None):
    try:
        return fn()
    except Exception:
        return default


def _send_response(req_id, ok, data=None, error=None):
    payload = {'id': req_id, 'ok': bool(ok)}
    if ok:
        payload['data'] = data if data is not None else {}
    else:
        payload['error'] = str(error or 'Erro desconhecido no FL Studio.')[:300]

    raw = json.dumps(payload, ensure_ascii=True, separators=(',', ':')).encode('ascii')
    if len(raw) > MAX_SYSEX_JSON_BYTES:
        fallback = {
            'id': req_id,
            'ok': False,
            'error': 'Resposta excedeu limite de SysEx (%d bytes). Reduza maxChannels/maxTracks/limit.' % len(raw),
        }
        raw = json.dumps(fallback, ensure_ascii=True, separators=(',', ':')).encode('ascii')

    device.midiOutSysex(SYSEX_HEADER + raw + bytes([SYSEX_END]))


def _resolve_track(args):
    track = args.get('track')
    track_name = args.get('trackName')
    total = _safe(mixer.trackCount, 127)
    if track is not None:
        idx = int(track)
        if idx < 0 or idx >= total:
            raise ValueError('Track %d fora do intervalo (0..%d).' % (idx, total - 1))
        return idx
    if track_name:
        needle = str(track_name).strip().lower()
        if not needle:
            raise ValueError('trackName vazio.')
        limit = min(total, 127)
        for i in range(limit):
            name = (_safe(lambda i=i: mixer.getTrackName(i), '') or '').strip().lower()
            if name == needle:
                return i
        for i in range(limit):
            name = (_safe(lambda i=i: mixer.getTrackName(i), '') or '').strip().lower()
            if needle in name:
                return i
        raise ValueError('Track "%s" nao encontrada no Mixer.' % track_name)
    return int(_safe(mixer.trackNumber, 0) or 0)


def _resolve_channel(args):
    ch = args.get('channel')
    ch_name = args.get('channelName')
    total = _safe(channels.channelCount, 0)
    if total <= 0:
        raise ValueError('Nenhum canal disponivel no Channel Rack.')
    if ch is not None:
        idx = int(ch)
        if idx < 0 or idx >= total:
            raise ValueError('Canal %d fora do intervalo (0..%d).' % (idx, total - 1))
        return idx
    if ch_name:
        needle = str(ch_name).strip().lower()
        if not needle:
            raise ValueError('channelName vazio.')
        for i in range(total):
            name = (_safe(lambda i=i: channels.getChannelName(i), '') or '').strip().lower()
            if name == needle:
                return i
        for i in range(total):
            name = (_safe(lambda i=i: channels.getChannelName(i), '') or '').strip().lower()
            if needle in name:
                return i
        raise ValueError('Canal "%s" nao encontrado no Channel Rack.' % ch_name)
    return int(_safe(lambda: channels.selectedChannel(1), 0) or 0)


def _transport_summary():
    bpm_raw = _safe(lambda: mixer.getCurrentTempo(0), 120000)
    bpm = round((bpm_raw or 120000) / 1000.0, 3)
    loop_mode = 'song' if _safe(lambda: transport.getLoopMode(), 0) == 1 else 'pattern'
    return {
        'bpm': bpm,
        'playing': bool(_safe(lambda: transport.isPlaying(), False)),
        'recording': bool(_safe(lambda: transport.isRecording(), False)),
        'loopMode': loop_mode,
        'metronome': bool(_safe(lambda: ui.isMetronomeEnabled(), False)),
        'songTime': str(_safe(lambda: transport.getSongPosString(), '') or ''),
    }


def _track_snapshot(idx):
    peak_l = round(float(_safe(lambda: mixer.getTrackPeaks(idx, 0), 0.0) or 0.0), 3)
    peak_r = round(float(_safe(lambda: mixer.getTrackPeaks(idx, 1), 0.0) or 0.0), 3)
    return {
        'index': idx,
        'name': str(_safe(lambda: mixer.getTrackName(idx), 'Insert %d' % idx) or ('Insert %d' % idx)),
        'volume': round(float(_safe(lambda: mixer.getTrackVolume(idx), 0.8) or 0.0), 4),
        'pan': round(float(_safe(lambda: mixer.getTrackPan(idx), 0.0) or 0.0), 4),
        'muted': bool(_safe(lambda: mixer.isTrackMuted(idx), False)),
        'solo': bool(_safe(lambda: mixer.isTrackSolo(idx), False)),
        'peakL': peak_l,
        'peakR': peak_r,
        'clipping': max(peak_l, peak_r) >= 0.99,
    }


def _handle_ping(_args):
    return {
        'pong': True,
        'flVersion': str(_safe(lambda: ui.getVersion(), '') or ''),
        'apiVersion': int(_safe(lambda: general.getVersion(), 0) or 0),
    }


def _handle_state(args):
    max_channels = max(1, min(int(args.get('maxChannels', 24)), 64))
    max_tracks = max(1, min(int(args.get('maxTracks', 16)), 64))
    only_active = bool(args.get('onlyActive', False))

    pat_idx = int(_safe(patterns.patternNumber, 1) or 1)
    pattern_info = {
        'index': pat_idx,
        'name': str(_safe(lambda: patterns.getPatternName(pat_idx), 'Pattern %d' % pat_idx) or ''),
        'length': int(_safe(lambda: patterns.getPatternLength(pat_idx), 16) or 16),
    }

    ch_total = int(_safe(channels.channelCount, 0) or 0)
    selected_ch = int(_safe(lambda: channels.selectedChannel(1), 0) or 0)
    ch_list = []
    for i in range(min(ch_total, max_channels)):
        ch_list.append({
            'index': i,
            'name': str(_safe(lambda i=i: channels.getChannelName(i), 'Channel %d' % i) or ''),
            'muted': bool(_safe(lambda i=i: channels.isChannelMuted(i), False)),
            'solo': bool(_safe(lambda i=i: channels.isChannelSolo(i), False)),
            'selected': i == selected_ch,
            'volume': round(float(_safe(lambda i=i: channels.getChannelVolume(i), 0.78) or 0.0), 4),
            'pan': round(float(_safe(lambda i=i: channels.getChannelPan(i), 0.0) or 0.0), 4),
            'mixerTrack': int(_safe(lambda i=i: channels.getTargetFxTrack(i), 0) or 0),
        })

    tr_total = int(_safe(mixer.trackCount, 127) or 127)
    tr_list = []
    for t in range(min(tr_total, max_tracks)):
        snap = _track_snapshot(t)
        if only_active and t != 0:
            default_name = 'Insert %d' % t
            has_signal = max(snap['peakL'], snap['peakR']) > 0.001
            if snap['name'] == default_name and not has_signal and not snap['muted'] and not snap['solo']:
                continue
        tr_list.append(snap)

    return {
        'transport': _transport_summary(),
        'pattern': pattern_info,
        'channelCount': ch_total,
        'channels': ch_list,
        'mixerTracks': tr_list,
    }


def _handle_transport(args):
    action = str(args.get('action') or '').strip().lower()
    if action == 'play':
        if not transport.isPlaying():
            transport.start()
    elif action == 'pause':
        if transport.isPlaying():
            transport.start()
    elif action == 'stop':
        transport.stop()
    elif action == 'record':
        transport.record()
    elif action == 'toggle_loop':
        transport.setLoopMode()
    elif action == 'pattern_mode':
        if transport.getLoopMode() != 0:
            transport.setLoopMode()
    elif action == 'song_mode':
        if transport.getLoopMode() != 1:
            transport.setLoopMode()
    elif action == 'metronome':
        transport.globalTransport(midi.FPT_Metronome, 1)
    elif action == 'set_bpm':
        raw_bpm = args.get('bpm')
        if raw_bpm is None:
            raise ValueError('bpm obrigatorio para action=set_bpm.')
        bpm = max(20.0, min(522.0, float(raw_bpm)))
        general.processRECEvent(
            midi.REC_Tempo,
            int(round(bpm * 1000)),
            midi.REC_UpdateValue | midi.REC_UpdateControl | midi.REC_ShowHint,
        )
    elif action == 'jump_marker':
        delta = int(args.get('delta', 1))
        select = bool(args.get('select', False))
        arrangement.jumpToMarker(delta, select)
    elif action == 'add_marker':
        marker_name = str(args.get('markerName') or 'Usami Marker').strip()[:48] or 'Usami Marker'
        cur_time = arrangement.currentTime(1)
        arrangement.addAutoTimeMarker(cur_time, marker_name)
    else:
        raise ValueError('Acao de transport invalida: %s' % action)

    out = _transport_summary()
    out['action'] = action
    return out


def _handle_mixer(args):
    idx = _resolve_track(args)

    if args.get('volume') is not None:
        vol = max(0.0, min(1.0, float(args['volume'])))
        mixer.setTrackVolume(idx, vol)

    if args.get('pan') is not None:
        pan = max(-1.0, min(1.0, float(args['pan'])))
        mixer.setTrackPan(idx, pan)

    if args.get('mute') is not None:
        desired_mute = bool(args['mute'])
        if bool(mixer.isTrackMuted(idx)) != desired_mute:
            mixer.muteTrack(idx)

    if args.get('solo') is not None:
        desired_solo = bool(args['solo'])
        if bool(mixer.isTrackSolo(idx)) != desired_solo:
            mixer.soloTrack(idx)

    if args.get('name') is not None:
        new_name = str(args['name']).strip()[:48]
        if new_name:
            mixer.setTrackName(idx, new_name)

    if args.get('select') is True:
        mixer.setTrackNumber(idx)

    return _track_snapshot(idx)


def _handle_steps(args):
    pat = args.get('pattern')
    if pat is not None:
        pat_idx = max(1, int(pat))
        patterns.jumpToPattern(pat_idx)

    ch = _resolve_channel(args)
    mode = str(args.get('mode') or 'replace').strip().lower()
    length = max(1, min(int(args.get('length', 16)), 64))
    raw_steps = args.get('steps') or []
    valid_steps = sorted(set(int(s) for s in raw_steps if 0 <= int(s) < length))

    if mode == 'replace':
        for s in range(length):
            channels.setGridBit(ch, s, 0)
        for s in valid_steps:
            channels.setGridBit(ch, s, 1)
    elif mode == 'add':
        for s in valid_steps:
            channels.setGridBit(ch, s, 1)
    elif mode == 'clear':
        if valid_steps:
            for s in valid_steps:
                channels.setGridBit(ch, s, 0)
        else:
            for s in range(length):
                channels.setGridBit(ch, s, 0)
    elif mode == 'read':
        pass
    else:
        raise ValueError('mode invalido em steps: %s' % mode)

    active_steps = [s for s in range(length) if channels.getGridBit(ch, s)]
    return {
        'channel': ch,
        'channelName': str(_safe(lambda: channels.getChannelName(ch), 'Channel %d' % ch) or ''),
        'pattern': int(_safe(patterns.patternNumber, 1) or 1),
        'mode': mode,
        'length': length,
        'activeSteps': active_steps,
    }


def _resolve_plugin_target(args):
    target = str(args.get('target') or 'channel').strip().lower()
    if target == 'mixer':
        index = _resolve_track(args)
        slot_index = max(0, min(int(args.get('slot', 0)), 9))
        target_label = 'mixer:%d:%d' % (index, slot_index)
    elif target == 'channel':
        index = _resolve_channel(args)
        slot_index = -1
        target_label = 'channel:%d' % index
    else:
        raise ValueError('target invalido em plugin: %s (use channel ou mixer).' % target)

    if not plugins.isValid(index, slot_index):
        raise ValueError('Nenhum plugin valido encontrado em %s.' % target_label)
    return target, index, slot_index


def _resolve_param_index(args, index, slot_index):
    total = int(plugins.getParamCount(index, slot_index) or 0)
    if args.get('paramIndex') is not None:
        p_idx = int(args['paramIndex'])
        if p_idx < 0 or p_idx >= total:
            raise ValueError('paramIndex %d fora do intervalo (0..%d).' % (p_idx, max(0, total - 1)))
        return p_idx
    p_name = str(args.get('paramName') or '').strip().lower()
    if not p_name:
        raise ValueError('Informe paramIndex ou paramName para ajustar parametro.')
    for i in range(total):
        name = (plugins.getParamName(i, index, slot_index) or '').strip().lower()
        if name == p_name:
            return i
    for i in range(total):
        name = (plugins.getParamName(i, index, slot_index) or '').strip().lower()
        if name and p_name in name:
            return i
    raise ValueError('Parametro "%s" nao encontrado no plugin.' % args.get('paramName'))


def _handle_plugin(args):
    target, index, slot_index = _resolve_plugin_target(args)
    plugin_name = str(_safe(lambda: plugins.getPluginName(index, slot_index, 0), 'Plugin') or 'Plugin')
    action = str(args.get('action') or 'list_params').strip().lower()

    if action == 'list_params':
        total = int(plugins.getParamCount(index, slot_index) or 0)
        flt = str(args.get('filter') or '').strip().lower()
        offset = max(0, int(args.get('offset', 0)))
        limit = max(1, min(int(args.get('limit', 30)), 40))

        matched = []
        for i in range(total):
            name = (plugins.getParamName(i, index, slot_index) or '').strip()
            if not name:
                continue
            if flt and flt not in name.lower():
                continue
            matched.append(i)

        selected = matched[offset:offset + limit]
        params = []
        for i in selected:
            val = round(float(_safe(lambda i=i: plugins.getParamValue(i, index, slot_index), 0.0) or 0.0), 4)
            val_str = str(_safe(lambda i=i: plugins.getParamValueString(i, index, slot_index), '') or '')
            params.append({
                'index': i,
                'name': (plugins.getParamName(i, index, slot_index) or '').strip(),
                'value': val,
                'display': val_str,
            })

        return {
            'target': target,
            'index': index,
            'slot': slot_index,
            'pluginName': plugin_name,
            'totalParams': total,
            'matchedCount': len(matched),
            'offset': offset,
            'params': params,
        }

    if action == 'set_param':
        raw_val = args.get('value')
        if raw_val is None:
            raise ValueError('value obrigatorio para action=set_param.')
        val = max(0.0, min(1.0, float(raw_val)))
        p_idx = _resolve_param_index(args, index, slot_index)
        plugins.setParamValue(val, p_idx, index, slot_index)
        return {
            'target': target,
            'index': index,
            'slot': slot_index,
            'pluginName': plugin_name,
            'action': 'set_param',
            'param': {
                'index': p_idx,
                'name': (plugins.getParamName(p_idx, index, slot_index) or '').strip(),
                'value': round(float(_safe(lambda: plugins.getParamValue(p_idx, index, slot_index), val) or val), 4),
                'display': str(_safe(lambda: plugins.getParamValueString(p_idx, index, slot_index), '') or ''),
            },
        }

    if action == 'next_preset':
        plugins.nextPreset(index, slot_index)
        return {
            'target': target,
            'index': index,
            'slot': slot_index,
            'pluginName': str(_safe(lambda: plugins.getPluginName(index, slot_index, 0), plugin_name) or plugin_name),
            'action': 'next_preset',
        }

    if action == 'prev_preset':
        plugins.prevPreset(index, slot_index)
        return {
            'target': target,
            'index': index,
            'slot': slot_index,
            'pluginName': str(_safe(lambda: plugins.getPluginName(index, slot_index, 0), plugin_name) or plugin_name),
            'action': 'prev_preset',
        }

    if action == 'focus':
        if target == 'channel':
            channels.showEditor(index, 1)
        else:
            mixer.focusEditor(index, slot_index)
        return {
            'target': target,
            'index': index,
            'slot': slot_index,
            'pluginName': plugin_name,
            'action': 'focus',
        }

    raise ValueError('Acao de plugin invalida: %s' % action)


def _handle_select_channel(args):
    ch = _resolve_channel(args)
    channels.selectOneChannel(ch)
    return {
        'channel': ch,
        'channelName': str(_safe(lambda: channels.getChannelName(ch), 'Channel %d' % ch) or ''),
    }


def _handle_undo(args):
    direction = str(args.get('direction') or 'undo').strip().lower()
    if direction == 'undo':
        general.undoUp()
    elif direction == 'redo':
        general.undoDown()
    else:
        raise ValueError('direction invalido em undo: %s (use undo ou redo).' % direction)
    return {
        'direction': direction,
        'historyLast': str(_safe(lambda: general.getUndoHistoryLast(), '') or ''),
        'historyCount': int(_safe(lambda: general.getUndoHistoryCount(), 0) or 0),
    }


def _handle_routing(args):
    mode = str(args.get('mode') or 'sidechain').strip().lower()
    src = _resolve_track({'track': args.get('sourceTrack'), 'trackName': args.get('sourceTrackName')})

    if mode == 'inspect':
        total = min(int(_safe(mixer.trackCount, 127) or 127), 64)
        routes = []
        for dst in range(total):
            if dst == src:
                continue
            active = bool(_safe(lambda dst=dst: mixer.getRouteSendActive(src, dst), False))
            if active:
                lvl = round(float(_safe(lambda dst=dst: mixer.getRouteToLevel(src, dst), 0.8) or 0.0), 4)
                routes.append({
                    'destTrack': dst,
                    'destName': str(_safe(lambda dst=dst: mixer.getTrackName(dst), 'Insert %d' % dst) or ''),
                    'level': lvl,
                    'isSidechainOnly': lvl <= 0.001,
                })
        return {
            'mode': 'inspect',
            'sourceTrack': src,
            'sourceName': str(_safe(lambda: mixer.getTrackName(src), 'Insert %d' % src) or ''),
            'routes': routes,
        }

    dest_list = []
    if isinstance(args.get('destTracks'), list) and args['destTracks']:
        for item in args['destTracks']:
            dest_list.append(_resolve_track({'track': item}))
    elif isinstance(args.get('destTrackNames'), list) and args['destTrackNames']:
        for name in args['destTrackNames']:
            dest_list.append(_resolve_track({'trackName': name}))
    else:
        dest_list.append(_resolve_track({'track': args.get('destTrack'), 'trackName': args.get('destTrackName')}))

    applied = []
    for dst in dest_list:
        if dst == src:
            raise ValueError('sourceTrack e destTrack nao podem ser a mesma track (%d).' % src)
        if mode == 'sidechain':
            mixer.setRouteTo(src, dst, True, True)
            if hasattr(mixer, 'setRouteToLevel'):
                mixer.setRouteToLevel(src, dst, 0.0)
            applied.append({'destTrack': dst, 'active': True, 'level': 0.0})
        elif mode == 'bus_only':
            lvl = max(0.0, min(1.0, float(args.get('level', 0.8))))
            mixer.setRouteTo(src, dst, True, True)
            if hasattr(mixer, 'setRouteToLevel'):
                mixer.setRouteToLevel(src, dst, lvl)
            if src != 0 and dst != 0:
                mixer.setRouteTo(src, 0, False, True)
            applied.append({'destTrack': dst, 'active': True, 'level': round(lvl, 4), 'unroutedMaster': True})
        elif mode == 'send':
            lvl = max(0.0, min(1.0, float(args.get('level', 0.8))))
            mixer.setRouteTo(src, dst, True, True)
            if hasattr(mixer, 'setRouteToLevel'):
                mixer.setRouteToLevel(src, dst, lvl)
            applied.append({'destTrack': dst, 'active': True, 'level': round(lvl, 4)})
        elif mode == 'disconnect':
            mixer.setRouteTo(src, dst, False, True)
            applied.append({'destTrack': dst, 'active': False})
        else:
            raise ValueError('mode invalido em routing: %s' % mode)

    if hasattr(mixer, 'afterRoutingChanged'):
        _safe(mixer.afterRoutingChanged)

    return {
        'mode': mode,
        'sourceTrack': src,
        'sourceName': str(_safe(lambda: mixer.getTrackName(src), 'Insert %d' % src) or ''),
        'applied': applied,
    }


def _set_eq_band_gain_db(track_idx, band, gain_db):
    clamped_db = max(-18.0, min(18.0, float(gain_db)))
    if hasattr(mixer, 'setEqGain'):
        # API nova normalizada (-1..1 ou dB conforme versao; REC event e universal em centesimos de dB)
        pass
    plug_id = int(mixer.getTrackPluginId(track_idx, 0))
    general.processRECEvent(
        midi.REC_Mixer_EQ_Gain + int(band) + plug_id,
        int(round(clamped_db * 100.0)),
        midi.REC_UpdateControl | midi.REC_UpdateValue | midi.REC_ShowHint,
    )
    return clamped_db


def _set_stereo_width_pct(track_idx, width_pct):
    # width_pct: -100 = 100% Mono (Merged), 0 = Original, +100 = 100% Wide (Separated)
    pct = max(-100.0, min(100.0, float(width_pct)))
    if hasattr(mixer, 'setTrackStereoSep'):
        # No FL Studio: -1.0 = 100% separated (wide), +1.0 = 100% merged (mono)
        mixer.setTrackStereoSep(track_idx, round(-pct / 100.0, 4))
    else:
        plug_id = int(mixer.getTrackPluginId(track_idx, 0))
        general.processRECEvent(
            midi.REC_Mixer_SS + plug_id,
            int(round((-pct / 100.0) * 64.0)),
            midi.REC_UpdateControl | midi.REC_UpdateValue | midi.REC_ShowHint,
        )
    return round(pct, 1)


def _handle_eq(args):
    idx = _resolve_track(args)
    preset = str(args.get('preset') or '').strip().lower()
    applied_bands = {}
    applied_width = None

    if preset == 'sub_mono_clean':
        applied_bands['lowGainDb'] = _set_eq_band_gain_db(idx, 0, 1.0)
        applied_bands['midGainDb'] = _set_eq_band_gain_db(idx, 1, -6.0)
        applied_bands['highGainDb'] = _set_eq_band_gain_db(idx, 2, -18.0)
        applied_width = _set_stereo_width_pct(idx, -100.0)
    elif preset == 'supersaw_air':
        applied_bands['lowGainDb'] = _set_eq_band_gain_db(idx, 0, -10.0)
        applied_bands['midGainDb'] = _set_eq_band_gain_db(idx, 1, -1.5)
        applied_bands['highGainDb'] = _set_eq_band_gain_db(idx, 2, 2.5)
        applied_width = _set_stereo_width_pct(idx, 35.0)
    elif preset == 'mud_cut':
        applied_bands['midGainDb'] = _set_eq_band_gain_db(idx, 1, -4.5)
    elif preset == 'flat':
        applied_bands['lowGainDb'] = _set_eq_band_gain_db(idx, 0, 0.0)
        applied_bands['midGainDb'] = _set_eq_band_gain_db(idx, 1, 0.0)
        applied_bands['highGainDb'] = _set_eq_band_gain_db(idx, 2, 0.0)
        applied_width = _set_stereo_width_pct(idx, 0.0)
    elif preset:
        raise ValueError('preset de EQ invalido: %s' % preset)

    if args.get('lowGainDb') is not None:
        applied_bands['lowGainDb'] = _set_eq_band_gain_db(idx, 0, args['lowGainDb'])
    if args.get('midGainDb') is not None:
        applied_bands['midGainDb'] = _set_eq_band_gain_db(idx, 1, args['midGainDb'])
    if args.get('highGainDb') is not None:
        applied_bands['highGainDb'] = _set_eq_band_gain_db(idx, 2, args['highGainDb'])

    if args.get('mono') is True:
        applied_width = _set_stereo_width_pct(idx, -100.0)
    elif args.get('stereoWidth') is not None:
        applied_width = _set_stereo_width_pct(idx, args['stereoWidth'])

    return {
        'track': idx,
        'trackName': str(_safe(lambda: mixer.getTrackName(idx), 'Insert %d' % idx) or ''),
        'preset': preset or None,
        'bands': applied_bands,
        'stereoWidth': applied_width,
    }


_HANDLERS = {
    'ping': _handle_ping,
    'state': _handle_state,
    'transport': _handle_transport,
    'mixer': _handle_mixer,
    'routing': _handle_routing,
    'eq': _handle_eq,
    'steps': _handle_steps,
    'plugin': _handle_plugin,
    'select_channel': _handle_select_channel,
    'undo': _handle_undo,
}


def OnInit():
    print('[Usami] FL Studio bridge initialized')


def OnSysEx(event):
    raw = bytes(getattr(event, 'sysex', b'') or b'')
    if len(raw) < len(SYSEX_HEADER) + 3:
        return
    if not raw.startswith(SYSEX_HEADER) or raw[-1] != SYSEX_END:
        return

    event.handled = True
    req_id = None
    try:
        body = raw[len(SYSEX_HEADER):-1].decode('ascii')
        msg = json.loads(body)
        if not isinstance(msg, dict):
            raise ValueError('Payload SysEx deve ser objeto JSON.')
        req_id = msg.get('id')
        cmd = str(msg.get('cmd') or '').strip().lower()
        args = msg.get('args') if isinstance(msg.get('args'), dict) else {}
        handler = _HANDLERS.get(cmd)
        if handler is None:
            raise ValueError('Comando desconhecido: %s' % cmd)
        result = handler(args)
        _send_response(req_id, True, data=result)
    except Exception as exc:
        _send_response(req_id, False, error=str(exc))


def OnMidiMsg(event):
    # Deixa Note On/Off e CCs livres para o FL Studio rotear ao canal ativo.
    event.handled = False
