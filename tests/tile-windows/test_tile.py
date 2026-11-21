#!/usr/bin/env python3
"""In-container assertions for tile-bridge-windows (stdlib only)."""
import math, os, re, subprocess, sys, time

os.environ['DISPLAY'] = ':99'
W, H = os.environ.get('DISPLAY_WIDTH', '1440'), os.environ.get('DISPLAY_HEIGHT', '900')
SCRIPT = '/usr/local/bin/tile-bridge-windows'
results = []


def sh(*a, check=True):
    p = subprocess.run(a, text=True, capture_output=True)
    if check and p.returncode:
        raise RuntimeError(f'{a} failed: {p.stderr}')
    return p.stdout


def check(name, ok, detail=''):
    results.append((name, ok))
    print(f"{'PASS' if ok else 'FAIL'}: {name}" + (f'  [{detail}]' if detail and not ok else ''))


def wait(cond, what, timeout=15):
    end = time.time() + timeout
    while time.time() < end:
        v = cond()
        if v:
            return v
        time.sleep(0.2)
    raise RuntimeError('timeout waiting for ' + what)


def ids():
    return {l.split()[0] for l in sh('wmctrl', '-l').splitlines()}


def workarea():
    d = next(l for l in sh('wmctrl', '-d').splitlines() if l.split()[1] == '*')
    m = re.search(r'WA:\s*(-?\d+),(-?\d+)\s+(\d+)x(\d+)', d)
    return tuple(map(int, m.groups())) if m else None


def extents(w):
    m = re.search(r'= (\d+), (\d+), (\d+), (\d+)', sh('xprop', '-id', w, '_NET_FRAME_EXTENTS', check=False))
    return tuple(map(int, m.groups())) if m else (0, 0, 0, 0)


def frame(w):
    """Outer frame (x, y, w, h) = client geometry plus _NET_FRAME_EXTENTS."""
    i = sh('xwininfo', '-id', w)
    g = lambda k: int(re.search(rf'{k}:\s+(-?\d+)', i).group(1))
    l, r, t, b = extents(w)
    return (g('Absolute upper-left X') - l, g('Absolute upper-left Y') - t,
            g('Width') + l + r, g('Height') + t + b)


def state(w):
    return sh('xprop', '-id', w, '_NET_WM_STATE', check=False)


def active():
    m = re.search(r'window id # (0x[0-9a-f]+)', sh('xprop', '-root', '_NET_ACTIVE_WINDOW'))
    return int(m.group(1), 16) if m else None


def term(title, geom):
    before = ids()
    subprocess.Popen(['xterm', '-T', title, '-geometry', geom, '-e', 'sleep', '3600'],
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    new = wait(lambda: ids() - before, f'window {title}')
    w = new.pop()
    time.sleep(0.4)
    return w


def expected_cells(wa, n):
    x, y, w, h = wa
    cols = math.ceil(math.sqrt(n)); rows = math.ceil(n / cols)
    cells = []
    for i in range(n):
        c, r = i % cols, i // cols
        cells.append((x + c * w // cols, y + r * h // rows,
                      (c + 1) * w // cols - c * w // cols, (r + 1) * h // rows - r * h // rows))
    return cells


def overlap(a, b):
    return a[0] < b[0] + b[2] and b[0] < a[0] + a[2] and a[1] < b[1] + b[3] and b[1] < a[1] + a[3]


def main():
    subprocess.Popen(['Xvfb', ':99', '-screen', '0', f'{W}x{H}x24', '-nolisten', 'tcp', '-ac', '+extension', 'RANDR'],
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    wait(lambda: subprocess.run(['xdpyinfo'], capture_output=True).returncode == 0, 'Xvfb')
    # openbox ignores wmctrl sticky/-t -1 requests, so a rule pins the t-sticky xterm to all desktops (-1).
    rc = open('/etc/xdg/openbox/rc.xml').read().replace(
        '<applications>', '<applications><application title="t-sticky"><desktop>all</desktop></application>', 1)
    open('/tmp/rc.xml', 'w').write(rc)
    subprocess.Popen(['openbox', '--config-file', '/tmp/rc.xml'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    wait(lambda: subprocess.run(['wmctrl', '-d'], capture_output=True).returncode == 0, 'openbox')
    subprocess.Popen(['tint2', '-c', '/etc/bridge/tint2rc'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    wait(lambda: (workarea() or (0, 0, 0, int(H)))[3] < int(H), 'workarea shrink for panel')
    wa = workarea()
    print(f'workarea={wa}')
    panel = next(l.split()[0] for l in sh('wmctrl', '-l').splitlines() if 'tint2' in l.lower()) \
        if 'tint2' in sh('wmctrl', '-l').lower() else None
    if panel is None:  # panel is a dock window, not listed by wmctrl -l; find via xwininfo tree
        tree = sh('xwininfo', '-root', '-tree')
        m = re.search(r'(0x[0-9a-f]+) "tint2"', tree)
        panel = m.group(1) if m else None
    panel_before = frame(panel) if panel else None

    # Scenario windows
    tiles = []
    a = term('t-a', '40x8+50+50'); tiles.append(a)
    b = term('t-b', '40x8+100+100'); tiles.append(b)
    c = term('t-max', '40x8+150+150'); tiles.append(c)
    d = term('t-icon', '40x8+200+200'); tiles.append(d)
    s = term('t-sticky', '40x8+250+250'); tiles.append(s)
    dlg = term('t-dialog', '30x6+300+300')
    sh('wmctrl', '-ir', c, '-b', 'add,maximized_vert,maximized_horz')
    sh('wmctrl', '-ir', d, '-b', 'add,hidden')
    sh('wmctrl', '-ir', s, '-b', 'add,sticky')  # no-op under openbox; the rc.xml rule does the work
    sh('xprop', '-id', dlg, '-f', '_NET_WM_WINDOW_TYPE', '32a', '-set', '_NET_WM_WINDOW_TYPE',
       '_NET_WM_WINDOW_TYPE_DIALOG,_NET_WM_WINDOW_TYPE_NORMAL')
    sh('wmctrl', '-ia', b)  # a specific non-last normal window
    time.sleep(0.8)
    check('setup: sticky window reports desktop -1',
          '4294967295' in sh('xprop', '-id', s, '_NET_WM_DESKTOP'),
          sh('xprop', '-id', s, '_NET_WM_DESKTOP').strip())
    print('setup: maximized=%s hidden=%s sticky_desktop=%s' % (
        'maximized_vert' in state(c).lower(), 'hidden' in state(d).lower(),
        [l.split()[1] for l in sh('wmctrl', '-l').splitlines() if l.startswith(s[2:]) or l.split()[0] == s]))
    dlg_before = frame(dlg)
    active_before = active()
    check('setup: window b is active before tiling', active_before == int(b, 16), f'{active_before:#x} vs {b}')

    p = subprocess.run([SCRIPT], text=True, capture_output=True, timeout=60)
    check('tile script exits 0 in normal case', p.returncode == 0, f'rc={p.returncode} {p.stderr.strip()[-300:]}')
    time.sleep(1.0)

    # a: grid placement
    n = len(tiles)
    cells = expected_cells(wa, n)
    frames = {w: frame(w) for w in tiles}
    print(f'tiled windows={n} expected cells={cells}')
    for w in tiles:
        print(f'  {w} frame={frames[w]}')
    check(f'a: every cell ({n}) is occupied by exactly one window frame, exactly matching the cell',
          sorted(frames.values()) == sorted(cells), f'{sorted(frames.values())}')
    for w in tiles:
        name = {a: 'a', b: 'b', c: 'maximized', d: 'iconified', s: 'sticky'}[w]
        check(f'a: window {name} is exactly inside one cell', frames[w] in cells, str(frames[w]))
    fl = list(frames.values())
    check('a: no overlap between tiled windows',
          not any(overlap(fl[i], fl[j]) for i in range(n) for j in range(i + 1, n)))
    check('a: no spill outside workarea',
          all(f[0] >= wa[0] and f[1] >= wa[1] and f[0] + f[2] <= wa[0] + wa[2] and f[1] + f[3] <= wa[1] + wa[3] for f in fl))
    check('a: iconified window no longer hidden', 'hidden' not in state(d).lower(), state(d).strip())
    check('a: maximized state cleared', 'maximized' not in state(c).lower(), state(c).strip())

    # b: dialog
    check('b: dialog (DIALOG,NORMAL types) not moved', frame(dlg) == dlg_before, f'{dlg_before} -> {frame(dlg)}')

    # c: sticky
    check('c: sticky window included in grid', frames[s] in cells, str(frames[s]))
    check('c: grid has 5 tiled windows (3x2)', len(set(frames.values())) == 5 and len({f[0] for f in fl}) == 3
          and len({f[1] for f in fl}) == 2, str(sorted(set(frames.values()))))

    # d: focus
    check('d: previously active window still active after tiling', active() == int(b, 16),
          f'{(active() or 0):#x} vs {b}')

    # e: panel
    if panel:
        check('e: tint2 panel not moved', frame(panel) == panel_before, f'{panel_before} -> {frame(panel)}')
    else:
        check('e: tint2 panel not moved', False, 'panel window not found')

    # f: error path
    subprocess.run(['pkill', '-x', 'openbox']); subprocess.run(['pkill', '-x', 'tint2'])
    time.sleep(1.0)
    # A killed WM leaves stale root properties behind; clear them so no WM/workarea is reported.
    for prop in ('_NET_SUPPORTING_WM_CHECK', '_NET_WORKAREA', '_NET_CURRENT_DESKTOP', '_NET_NUMBER_OF_DESKTOPS',
                 '_NET_DESKTOP_GEOMETRY', '_NET_DESKTOP_VIEWPORT', '_NET_DESKTOP_NAMES', '_NET_ACTIVE_WINDOW',
                 '_NET_CLIENT_LIST', '_NET_CLIENT_LIST_STACKING', '_NET_SUPPORTED'):
        subprocess.run(['xprop', '-root', '-remove', prop], capture_output=True)
    subprocess.run(['pkill', '-x', 'xmessage'])
    proc = subprocess.Popen([SCRIPT], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    seen = False
    end = time.time() + 15
    while time.time() < end:
        if subprocess.run(['pgrep', '-x', 'xmessage'], capture_output=True).returncode == 0 or \
                'xmessage' in sh('xwininfo', '-root', '-tree', check=False).lower():
            seen = True
            break
        if proc.poll() is not None:
            break
        time.sleep(0.2)
    seen = seen or subprocess.run(['pgrep', '-x', 'xmessage'], capture_output=True).returncode == 0
    try:
        rc = proc.wait(timeout=3)
    except subprocess.TimeoutExpired:
        subprocess.run(['pkill', '-x', 'xmessage'])
        try:
            rc = proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill(); rc = None
    check('f: script exits non-zero without a window manager', rc not in (0, None), f'rc={rc}')
    check('f: xmessage error dialog appeared', seen)
    subprocess.run(['pkill', '-x', 'xmessage'])

    failed = [n for n, ok in results if not ok]
    print(f'\nSUMMARY: {len(results) - len(failed)} passed, {len(failed)} failed')
    for n in failed:
        print('  FAILED:', n)
    return 1 if failed else 0


if __name__ == '__main__':
    try:
        rc = main()
    except Exception as e:
        print(f'HARNESS ERROR: {e}')
        rc = 2
    sys.exit(rc)
