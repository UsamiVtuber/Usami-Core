import argparse
import ctypes
from ctypes import wintypes
import glob
import json
import os
import struct
import sys
import time
import zlib

# Constantes Win32 SendInput / Teclado / Mouse
INPUT_MOUSE = 0
INPUT_KEYBOARD = 1

MOUSEEVENTF_MOVE = 0x0001
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004
MOUSEEVENTF_RIGHTDOWN = 0x0008
MOUSEEVENTF_RIGHTUP = 0x0010

KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_UNICODE = 0x0004

VK_RETURN = 0x0D
VK_ESCAPE = 0x1B
VK_SHIFT = 0x10
VK_CONTROL = 0x11
VK_MENU = 0x12  # Alt
VK_F5 = 0x74
VK_F6 = 0x75
VK_F7 = 0x76
VK_F8 = 0x77
VK_F9 = 0x78

SW_RESTORE = 9
PW_RENDERFULLCONTENT = 0x00000002
SRCCOPY = 0x00CC0020
BI_RGB = 0

KILLSWITCH_MOUSE_TOLERANCE_PX = 20

SHORTCUT_MAP = {
    'open_plugin_picker': ([], VK_F8),
    'toggle_playlist': ([], VK_F5),
    'toggle_channel_rack': ([], VK_F6),
    'toggle_piano_roll': ([], VK_F7),
    'toggle_mixer': ([], VK_F9),
    'assign_free_mixer_track': ([VK_CONTROL], ord('L')),
    'clone_channel': ([VK_MENU], ord('C')),
    'save_project': ([VK_CONTROL], ord('S')),
}


class POINT(ctypes.Structure):
    _fields_ = [('x', ctypes.c_long), ('y', ctypes.c_long)]


class RECT(ctypes.Structure):
    _fields_ = [
        ('left', ctypes.c_long),
        ('top', ctypes.c_long),
        ('right', ctypes.c_long),
        ('bottom', ctypes.c_long),
    ]


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [
        ('dx', ctypes.c_long),
        ('dy', ctypes.c_long),
        ('mouseData', ctypes.c_uint32),
        ('dwFlags', ctypes.c_uint32),
        ('time', ctypes.c_uint32),
        ('dwExtraInfo', ctypes.c_size_t),
    ]


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [
        ('wVk', ctypes.c_uint16),
        ('wScan', ctypes.c_uint16),
        ('dwFlags', ctypes.c_uint32),
        ('time', ctypes.c_uint32),
        ('dwExtraInfo', ctypes.c_size_t),
    ]


class _INPUTUNION(ctypes.Union):
    _fields_ = [('mi', MOUSEINPUT), ('ki', KEYBDINPUT)]


class INPUT(ctypes.Structure):
    _fields_ = [('type', ctypes.c_uint32), ('union', _INPUTUNION)]


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [
        ('biSize', ctypes.c_uint32),
        ('biWidth', ctypes.c_int32),
        ('biHeight', ctypes.c_int32),
        ('biPlanes', ctypes.c_uint16),
        ('biBitCount', ctypes.c_uint16),
        ('biCompression', ctypes.c_uint32),
        ('biSizeImage', ctypes.c_uint32),
        ('biXPelsPerMeter', ctypes.c_int32),
        ('biYPelsPerMeter', ctypes.c_int32),
        ('biClrUsed', ctypes.c_uint32),
        ('biClrImportant', ctypes.c_uint32),
    ]


class BITMAPINFO(ctypes.Structure):
    _fields_ = [('bmiHeader', BITMAPINFOHEADER), ('bmiColors', ctypes.c_uint32 * 3)]


class KillSwitchTriggered(RuntimeError):
    pass


def _enable_dpi_awareness():
    if sys.platform != 'win32':
        return
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except Exception:
        try:
            ctypes.windll.user32.SetProcessDPIAware()
        except Exception:
            pass


def _emit_json(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=True) + '\n')
    sys.stdout.flush()


def _get_cursor_pos(user32):
    pt = POINT()
    user32.GetCursorPos(ctypes.byref(pt))
    return int(pt.x), int(pt.y)


def _check_killswitch(user32, expected_pos=None):
    if user32.GetAsyncKeyState(VK_ESCAPE) & 0x8000:
        raise KillSwitchTriggered('Cancelado pelo kill-switch: tecla ESC pressionada pelo usuario.')
    if expected_pos is not None:
        cx, cy = _get_cursor_pos(user32)
        if abs(cx - expected_pos[0]) > KILLSWITCH_MOUSE_TOLERANCE_PX or abs(cy - expected_pos[1]) > KILLSWITCH_MOUSE_TOLERANCE_PX:
            raise KillSwitchTriggered('Cancelado pelo kill-switch: movimento manual do mouse detectado.')


def _guarded_sleep(user32, duration_sec, expected_pos=None):
    end = time.monotonic() + max(0.0, float(duration_sec))
    while time.monotonic() < end:
        _check_killswitch(user32, expected_pos)
        time.sleep(min(0.02, max(0.005, end - time.monotonic())))


def _get_process_image_name(pid):
    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    k32 = ctypes.windll.kernel32
    h_proc = k32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, int(pid))
    if not h_proc:
        return ''
    try:
        buf = ctypes.create_unicode_buffer(512)
        size = ctypes.c_uint32(512)
        if k32.QueryFullProcessImageNameW(h_proc, 0, buf, ctypes.byref(size)):
            return os.path.basename(buf.value)
        return ''
    finally:
        k32.CloseHandle(h_proc)


def enumerate_fl_windows():
    if sys.platform != 'win32':
        raise RuntimeError('Automacao UI do FL Studio disponivel apenas no Windows.')
    user32 = ctypes.windll.user32
    windows = []

    WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)

    def _cb(hwnd, _lparam):
        if not user32.IsWindowVisible(hwnd):
            return True
        pid = wintypes.DWORD(0)
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        proc_name = _get_process_image_name(pid.value).lower()
        cls_buf = ctypes.create_unicode_buffer(128)
        user32.GetClassNameW(hwnd, cls_buf, 128)
        cls_name = cls_buf.value

        is_fl = proc_name in ('fl64.exe', 'fl.exe') or cls_name == 'TFruityLoopsMainForm'
        if not is_fl:
            return True

        length = user32.GetWindowTextLengthW(hwnd)
        title_buf = ctypes.create_unicode_buffer(length + 2)
        user32.GetWindowTextW(hwnd, title_buf, length + 1)
        rc = RECT()
        user32.GetWindowRect(hwnd, ctypes.byref(rc))
        w = int(rc.right - rc.left)
        h = int(rc.bottom - rc.top)
        if w > 40 and h > 40:
            windows.append({
                'hwnd': int(hwnd),
                'pid': int(pid.value),
                'className': cls_name,
                'title': title_buf.value,
                'isMain': cls_name == 'TFruityLoopsMainForm',
                'rect': {'x': int(rc.left), 'y': int(rc.top), 'width': w, 'height': h},
            })
        return True

    cb_ref = WNDENUMPROC(_cb)
    user32.EnumWindows(cb_ref, 0)
    windows.sort(key=lambda item: (0 if item['isMain'] else 1, -item['rect']['width'] * item['rect']['height']))
    return windows


def list_installed_fst_plugins():
    candidates = [
        os.path.join(os.path.expanduser('~'), 'Documents', 'Image-Line', 'FL Studio', 'Presets', 'Plugin database'),
        os.path.join(os.path.expanduser('~'), 'OneDrive', 'Documentos', 'Image-Line', 'FL Studio', 'Presets', 'Plugin database'),
        os.path.join(os.path.expanduser('~'), 'OneDrive', 'Documents', 'Image-Line', 'FL Studio', 'Presets', 'Plugin database'),
    ]
    db_root = next((c for c in candidates if os.path.isdir(c)), None)
    if not db_root:
        return {'databaseDir': None, 'generators': [], 'effects': []}

    def _scan_sub(sub):
        folder = os.path.join(db_root, sub)
        if not os.path.isdir(folder):
            return []
        found = set()
        for path in glob.glob(os.path.join(folder, '**', '*.fst'), recursive=True):
            if os.sep + 'Installed' + os.sep in path:
                continue
            base = os.path.splitext(os.path.basename(path))[0].strip()
            if base:
                found.add(base)
        if not found:
            for path in glob.glob(os.path.join(folder, '**', '*.fst'), recursive=True):
                base = os.path.splitext(os.path.basename(path))[0].strip()
                if base:
                    found.add(base)
        return sorted(found)

    return {
        'databaseDir': db_root,
        'generators': _scan_sub('Generators'),
        'effects': _scan_sub('Effects'),
    }


def _focus_fl_window(target_title=None):
    user32 = ctypes.windll.user32
    wins = enumerate_fl_windows()
    if not wins:
        raise RuntimeError('Janela do FL Studio (FL64.exe) nao encontrada aberta. Abra o FL Studio primeiro.')

    chosen = None
    if target_title:
        needle = target_title.strip().lower()
        chosen = next((w for w in wins if needle in w['title'].lower()), None)
    if chosen is None:
        chosen = next((w for w in wins if w['isMain']), wins[0])

    hwnd = chosen['hwnd']
    if user32.IsIconic(hwnd):
        user32.ShowWindow(hwnd, SW_RESTORE)
        time.sleep(0.15)

    user32.SetForegroundWindow(hwnd)
    time.sleep(0.12)

    fg = user32.GetForegroundWindow()
    fg_pid = wintypes.DWORD(0)
    user32.GetWindowThreadProcessId(fg, ctypes.byref(fg_pid))
    if int(fg_pid.value) != chosen['pid']:
        raise RuntimeError('Nao foi possivel colocar o FL Studio em primeiro plano com seguranca. Clique na janela do FL Studio e tente novamente.')

    # Atualiza rect pos-restore
    rc = RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(rc))
    chosen['rect'] = {
        'x': int(rc.left),
        'y': int(rc.top),
        'width': int(rc.right - rc.left),
        'height': int(rc.bottom - rc.top),
    }
    return chosen


def _send_inputs(inputs):
    arr = (INPUT * len(inputs))(*inputs)
    ctypes.windll.user32.SendInput(len(inputs), arr, ctypes.sizeof(INPUT))


def _key_input(vk=0, scan=0, flags=0):
    inp = INPUT()
    inp.type = INPUT_KEYBOARD
    inp.union.ki = KEYBDINPUT(wVk=vk, wScan=scan, dwFlags=flags, time=0, dwExtraInfo=0)
    return inp


def _mouse_flag_input(flags):
    inp = INPUT()
    inp.type = INPUT_MOUSE
    inp.union.mi = MOUSEINPUT(dx=0, dy=0, mouseData=0, dwFlags=flags, time=0, dwExtraInfo=0)
    return inp


def _press_vk_combo(user32, modifiers, vk):
    _check_killswitch(user32)
    downs = [_key_input(vk=m, flags=0) for m in modifiers] + [_key_input(vk=vk, flags=0)]
    ups = [_key_input(vk=vk, flags=KEYEVENTF_KEYUP)] + [_key_input(vk=m, flags=KEYEVENTF_KEYUP) for m in reversed(modifiers)]
    try:
        _send_inputs(downs)
        time.sleep(0.03)
    finally:
        _send_inputs(ups)


def _type_unicode_text(user32, text):
    for ch in str(text):
        _check_killswitch(user32)
        code = ord(ch)
        _send_inputs([
            _key_input(vk=0, scan=code, flags=KEYEVENTF_UNICODE),
            _key_input(vk=0, scan=code, flags=KEYEVENTF_UNICODE | KEYEVENTF_KEYUP),
        ])
        time.sleep(0.015)


def _encode_png_rgb(width, height, bgra_bytes):
    # Converte BGRA bottom-up ou top-down (usamos top-down: height negativo no BITMAPINFO) para RGB PNG puro
    stride_in = width * 4
    raw_rows = bytearray()
    for y in range(height):
        row_off = y * stride_in
        raw_rows.append(0)  # filtro PNG None
        for x in range(width):
            px = row_off + x * 4
            b = bgra_bytes[px]
            g = bgra_bytes[px + 1]
            r = bgra_bytes[px + 2]
            raw_rows.extend((r, g, b))

    def _chunk(tag, data):
        crc = zlib.crc32(tag + data) & 0xFFFFFFFF
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', crc)

    ihdr = struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)
    compressed = zlib.compress(bytes(raw_rows), level=6)
    return b'\x89PNG\r\n\x1a\n' + _chunk(b'IHDR', ihdr) + _chunk(b'IDAT', compressed) + _chunk(b'IEND', b'')


def capture_window_png(hwnd, out_path):
    user32 = ctypes.windll.user32
    gdi32 = ctypes.windll.gdi32

    rc = RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(rc))
    width = max(1, int(rc.right - rc.left))
    height = max(1, int(rc.bottom - rc.top))

    hwnd_dc = user32.GetWindowDC(hwnd)
    mem_dc = gdi32.CreateCompatibleDC(hwnd_dc)
    bmp = gdi32.CreateCompatibleBitmap(hwnd_dc, width, height)
    old_obj = gdi32.SelectObject(mem_dc, bmp)

    try:
        rendered = user32.PrintWindow(hwnd, mem_dc, PW_RENDERFULLCONTENT)
        if not rendered:
            screen_dc = user32.GetDC(0)
            try:
                gdi32.BitBlt(mem_dc, 0, 0, width, height, screen_dc, rc.left, rc.top, SRCCOPY)
            finally:
                user32.ReleaseDC(0, screen_dc)

        bmi = BITMAPINFO()
        bmi.bmiHeader.biSize = ctypes.sizeof(BITMAPINFOHEADER)
        bmi.bmiHeader.biWidth = width
        bmi.bmiHeader.biHeight = -height  # top-down
        bmi.bmiHeader.biPlanes = 1
        bmi.bmiHeader.biBitCount = 32
        bmi.bmiHeader.biCompression = BI_RGB

        buf_len = width * height * 4
        buf = ctypes.create_string_buffer(buf_len)
        gdi32.GetDIBits(mem_dc, bmp, 0, height, buf, ctypes.byref(bmi), 0)

        png_bytes = _encode_png_rgb(width, height, buf.raw)
        os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
        with open(out_path, 'wb') as fh:
            fh.write(png_bytes)
        return {'width': width, 'height': height, 'bytesWritten': len(png_bytes), 'filePath': out_path}
    finally:
        gdi32.SelectObject(mem_dc, old_obj)
        gdi32.DeleteObject(bmp)
        gdi32.DeleteDC(mem_dc)
        user32.ReleaseDC(hwnd, hwnd_dc)


def _resolve_Bounded_coords(win_rect, rel_x, rel_y):
    rx = int(rel_x)
    ry = int(rel_y)
    if rx < 0 or ry < 0 or rx >= win_rect['width'] or ry >= win_rect['height']:
        raise ValueError(
            'Coordenada relativa (%d, %d) fora dos limites da janela (%d x %d).'
            % (rx, ry, win_rect['width'], win_rect['height'])
        )
    return win_rect['x'] + rx, win_rect['y'] + ry


def execute_action(payload):
    _enable_dpi_awareness()
    action = str(payload.get('action') or 'inspect_windows').strip().lower()
    user32 = ctypes.windll.user32 if sys.platform == 'win32' else None

    if action == 'inspect_windows':
        wins = enumerate_fl_windows()
        db = list_installed_fst_plugins()
        return {
            'ok': True,
            'action': 'inspect_windows',
            'flOpen': len(wins) > 0,
            'windows': wins,
            'installedGenerators': db['generators'],
            'installedEffects': db['effects'],
        }

    if action == 'capture_window':
        out_path = str(payload.get('outPath') or '').strip()
        if not out_path:
            raise ValueError('outPath obrigatorio para capture_window.')
        win = _focus_fl_window(payload.get('windowTitle'))
        shot = capture_window_png(win['hwnd'], out_path)
        return {'ok': True, 'action': 'capture_window', 'window': win['title'], **shot}

    if action == 'add_plugin':
        plugin_name = str(payload.get('pluginName') or '').strip()
        if not plugin_name:
            raise ValueError('pluginName obrigatorio para add_plugin.')
        db = list_installed_fst_plugins()
        # Resolve case-insensitive para nome exato do .fst se disponivel
        exact = next((g for g in db['generators'] if g.lower() == plugin_name.lower()), None)
        if not exact:
            exact = next((g for g in db['generators'] if plugin_name.lower() in g.lower()), plugin_name)

        win = _focus_fl_window()
        _check_killswitch(user32)
        # Abre Channel Rack (F6) -> Plugin Picker (F8) -> digita nome -> Enter
        _press_vk_combo(user32, [], VK_F8)
        _guarded_sleep(user32, 0.28)
        _type_unicode_text(user32, exact)
        _guarded_sleep(user32, 0.20)
        _press_vk_combo(user32, [], VK_RETURN)
        return {
            'ok': True,
            'action': 'add_plugin',
            'pluginName': exact,
            'window': win['title'],
        }

    if action == 'shortcut':
        shortcut_id = str(payload.get('shortcut') or '').strip().lower()
        if shortcut_id not in SHORTCUT_MAP:
            raise ValueError('Atalho nao permitido: %s' % shortcut_id)
        win = _focus_fl_window(payload.get('windowTitle'))
        mods, vk = SHORTCUT_MAP[shortcut_id]
        _press_vk_combo(user32, mods, vk)
        return {'ok': True, 'action': 'shortcut', 'shortcut': shortcut_id, 'window': win['title']}

    if action == 'mouse_click':
        win = _focus_fl_window(payload.get('windowTitle'))
        abs_x, abs_y = _resolve_Bounded_coords(win['rect'], payload['relX'], payload['relY'])
        button = str(payload.get('button') or 'left').strip().lower()
        double = bool(payload.get('double', False))

        _check_killswitch(user32)
        user32.SetCursorPos(abs_x, abs_y)
        expected = (abs_x, abs_y)
        _guarded_sleep(user32, 0.04, expected)

        down_flag = MOUSEEVENTF_RIGHTDOWN if button == 'right' else MOUSEEVENTF_LEFTDOWN
        up_flag = MOUSEEVENTF_RIGHTUP if button == 'right' else MOUSEEVENTF_LEFTUP
        clicks = 2 if double else 1
        for _ in range(clicks):
            _check_killswitch(user32, expected)
            try:
                _send_inputs([_mouse_flag_input(down_flag)])
                time.sleep(0.025)
            finally:
                _send_inputs([_mouse_flag_input(up_flag)])
            time.sleep(0.04)

        return {'ok': True, 'action': 'mouse_click', 'x': abs_x, 'y': abs_y, 'button': button, 'double': double}

    if action == 'knob_drag':
        # Arrasto vertical fino e guardado para knobs de VSTs (deltaPx negativo = sobe valor; positivo = desce)
        win = _focus_fl_window(payload.get('windowTitle'))
        abs_x, abs_y = _resolve_Bounded_coords(win['rect'], payload['relX'], payload['relY'])
        delta_px = max(-250, min(250, int(payload.get('deltaPx', -60))))
        steps = max(4, min(25, abs(delta_px) // 4 + 1))

        _check_killswitch(user32)
        user32.SetCursorPos(abs_x, abs_y)
        cur_pos = (abs_x, abs_y)
        _guarded_sleep(user32, 0.04, cur_pos)

        button_down = False
        try:
            _send_inputs([_mouse_flag_input(MOUSEEVENTF_LEFTDOWN)])
            button_down = True
            for i in range(1, steps + 1):
                _check_killswitch(user32, cur_pos)
                ny = abs_y + int(round(delta_px * (i / float(steps))))
                user32.SetCursorPos(abs_x, ny)
                cur_pos = (abs_x, ny)
                time.sleep(0.018)
        finally:
            if button_down:
                _send_inputs([_mouse_flag_input(MOUSEEVENTF_LEFTUP)])

        return {'ok': True, 'action': 'knob_drag', 'startX': abs_x, 'startY': abs_y, 'deltaPx': delta_px}

    if action == 'mouse_drag':
        win = _focus_fl_window(payload.get('windowTitle'))
        x0, y0 = _resolve_Bounded_coords(win['rect'], payload['fromRelX'], payload['fromRelY'])
        x1, y1 = _resolve_Bounded_coords(win['rect'], payload['toRelX'], payload['toRelY'])
        steps = 15

        _check_killswitch(user32)
        user32.SetCursorPos(x0, y0)
        cur_pos = (x0, y0)
        _guarded_sleep(user32, 0.04, cur_pos)

        button_down = False
        try:
            _send_inputs([_mouse_flag_input(MOUSEEVENTF_LEFTDOWN)])
            button_down = True
            for i in range(1, steps + 1):
                _check_killswitch(user32, cur_pos)
                nx = x0 + int(round((x1 - x0) * (i / float(steps))))
                ny = y0 + int(round((y1 - y0) * (i / float(steps))))
                user32.SetCursorPos(nx, ny)
                cur_pos = (nx, ny)
                time.sleep(0.02)
        finally:
            if button_down:
                _send_inputs([_mouse_flag_input(MOUSEEVENTF_LEFTUP)])

        return {'ok': True, 'action': 'mouse_drag', 'from': [x0, y0], 'to': [x1, y1]}

    raise ValueError('Acao de UI desconhecida: %s' % action)


def main():
    parser = argparse.ArgumentParser(description='Guarded Win32 UI Bridge for FL Studio 2026.')
    parser.add_argument('--payload', required=True)
    args = parser.parse_args()

    try:
        payload = json.loads(args.payload)
        res = execute_action(payload)
        _emit_json(res)
    except KillSwitchTriggered as ks:
        _emit_json({'ok': False, 'code': 'killswitch', 'error': str(ks)})
    except Exception as exc:
        _emit_json({'ok': False, 'code': 'ui_error', 'error': str(exc)})


if __name__ == '__main__':
    main()
