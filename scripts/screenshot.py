"""Capture real Pocket PTY output with public-safe demo data.

Requires Python 3, Pillow and pyte. Run after cargo build:
  python3 scripts/screenshot.py target/debug/herdr-pocket
No real core, sessions, or network access are used by the fixture.
"""
import base64
import copy
import fcntl
import json
import os
from pathlib import Path
import select
import struct
import subprocess
import sys
import tempfile
import termios
import time


def core():
    names = ['Herdr Pocket', 'API service', 'Docs website', 'Release prep']
    tabs = ['Fix navigation', 'Review changes', 'Dev server', 'Shell']
    terminals = [dict(address=f't{i+1}', state='live', cwd='/projects/herdr-pocket',
                      title=name, status={'state': status}, turn=1)
                 for i, (name, status) in enumerate(zip(tabs, ['working', 'blocked', 'idle', 'idle']))]
    spaces = [dict(id=f's{i}', name=name, folder='/projects/' + ['herdr-pocket', 'api', 'docs', 'release'][i],
                   tabs=[dict(id=f'tab{j}', name=tab, root={'id': f'p{j}', 'type': 'block',
                         'content': {'terminal': f't{j+1}'}}) for j, tab in enumerate(tabs)] if i == 0 else [])
              for i, name in enumerate(names)]
    for line in sys.stdin:
        request = json.loads(line)
        method = request['method']
        result = {'hello': {}, 'terminal.list': {'terminals': terminals},
                  'machine.list': {'machines': []},
                  'doc.get': {'version': 1, 'value': {'spaces': spaces}}}.get(method, {})
        if method == 'machine.exec':
            argv = request['params']['argv']
            output = '/projects' if argv[0] == 'printenv' else ''
            result = {'code': 0, 'stdout': base64.b64encode(output.encode()).decode(), 'stderr': ''}
        print(json.dumps({'jsonrpc': '2.0', 'id': request['id'], 'result': result}), flush=True)


def capture(binary):
    import pyte
    with tempfile.TemporaryDirectory(prefix='pocket-screenshot-') as scratch:
        root = Path(scratch)
        hc = root / 'hc'
        hc.write_text('#!' + sys.executable + '\nimport runpy, sys\nsys.argv=["fixture", "connect"]\nrunpy.run_path(' + repr(str(Path(__file__).resolve())) + ', run_name="__main__")\n')
        hc.chmod(0o755)
        git = root / 'git'
        git.write_text('#!/bin/sh\nexit 1\n')
        git.chmod(0o755)
        env = {**os.environ, 'HOME': scratch, 'XDG_STATE_HOME': scratch,
               'HC_BIN': str(hc), 'PATH': scratch, 'TERM': 'xterm-256color'}
        master, slave = os.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 16, 44, 0, 0))
        process = subprocess.Popen([str(Path(binary).resolve())], env=env,
                                   stdin=slave, stdout=slave, stderr=slave)
        screen = pyte.Screen(44, 16)
        stream = pyte.ByteStream(screen)

        def wait_for(text):
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                if select.select([master], [], [], .1)[0]:
                    stream.feed(os.read(master, 65536))
                if text in '\n'.join(screen.display):
                    return
            raise RuntimeError('\n'.join(screen.display))

        try:
            wait_for('herdr pocket')
            os.write(master, b'\t')
            wait_for('Release prep')
            wait_for('1–9 open')
            first = copy.deepcopy(screen)
            os.write(master, b'\r')
            wait_for('Review changes')
            os.write(master, b'jj')
            # Wait for the selected session to be repainted before capturing.
            wait_for('› 3')
            second = copy.deepcopy(screen)
            os.write(master, b'q')
            process.wait(timeout=5)
            return first, second
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
            os.close(master)
            os.close(slave)


def render(screens):
    from PIL import Image, ImageDraw, ImageFont
    font_path = os.environ.get('SCREENSHOT_FONT', '/System/Library/Fonts/Menlo.ttc')
    font = ImageFont.truetype(font_path, 23)
    cell, line = round(font.getlength('M')), 35
    margin, top = 32, 78
    panel = cell * 44 + margin * 2
    image = Image.new('RGB', (panel * 2 + 24, top + line * 16 + 32), '#0b1018')
    draw = ImageDraw.Draw(image)
    colors = {'default': '#d8dee9', 'black': '#161b24', 'white': '#e5e9f0',
              'brightblack': '#778397', 'brown': '#ebcb8b', 'green': '#a3be8c',
              'cyan': '#88c0d0', 'blue': '#81a1c1', 'red': '#bf616a', 'magenta': '#b48ead'}
    for index, screen in enumerate(screens):
        origin = index * (panel + 24)
        draw.rounded_rectangle((origin + 8, 8, origin + panel - 8, image.height - 8), 18, fill='#151b25')
        draw.text((origin + margin, 26), ['Shared workspaces', 'Sessions & quick actions'][index], font=font, fill='#88c0d0')
        for y in range(screen.lines):
            for x in range(screen.columns):
                char = screen.buffer[y][x]
                px, py = origin + margin + x * cell, top + y * line
                fg = colors.get(char.fg, '#' + char.fg)
                bg = '#151b25' if char.bg == 'default' else colors.get(char.bg, '#' + char.bg)
                if char.reverse:
                    fg, bg = bg, fg
                draw.rectangle((px, py, px + cell, py + line), fill=bg)
                draw.text((px, py), char.data, font=font, fill=fg)
    destination = Path('docs/images/herdr-pocket.png')
    destination.parent.mkdir(parents=True, exist_ok=True)
    image.save(destination, optimize=True)
    print(destination)


if __name__ == '__main__':
    if sys.argv[1:] == ['connect']:
        core()
    else:
        render(capture(sys.argv[1]))
