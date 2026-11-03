"""Exercise update prompt, failed fetch, retry, replacement and restart in a real PTY."""
import json
import os
import pathlib
import shutil
import sys
import tempfile
from reconnect import Tty


def fake_tool(tool):
    root = pathlib.Path(os.environ['UPDATE_TEST_ROOT'])
    if tool == 'hc':
        for line in sys.stdin:
            request = json.loads(line)
            result = {
                'terminal.list': {'terminals': []},
                'machine.list': {'machines': []},
                'doc.get': {'version': 0, 'value': {'spaces': []}},
                'machine.exec': {'code': 0, 'stdout': '', 'stderr': ''},
            }.get(request['method'], {})
            print(json.dumps({'jsonrpc': '2.0', 'id': request['id'], 'result': result}), flush=True)
    elif tool == 'git':
        if 'ls-remote' in sys.argv:
            print('b' * 40 + '\trefs/heads/main')
        elif 'fetch' in sys.argv and not (root / 'failed').exists():
            (root / 'failed').touch()
            print('scripted fetch failure', file=sys.stderr)
            sys.exit(1)
    elif tool == 'cargo':
        assert os.environ['HERDR_POCKET_REVISION'] == 'b' * 40
        binary = pathlib.Path('target/release/herdr-pocket')
        binary.parent.mkdir(parents=True)
        binary.write_text('#!' + sys.executable + '\nimport pathlib, time\nprint("UPDATED-RESTART-OK", flush=True)\nwhile not pathlib.Path(' + repr(str(root / 'release')) + ').exists(): time.sleep(.01)\n')
        binary.chmod(0o755)


def main(binary):
    with tempfile.TemporaryDirectory(prefix='pocket-updater-') as scratch:
        root = pathlib.Path(scratch)
        installed = root / 'pocket'
        shutil.copy2(binary, installed)
        original = installed.read_bytes()
        tools = root / 'bin'
        tools.mkdir()
        for tool in ['git', 'cargo', 'hc']:
            script = tools / tool
            script.write_text('#!' + sys.executable + '\nimport runpy, sys\nsys.path.insert(0, ' + repr(str(pathlib.Path(__file__).resolve().parent)) + ')\nsys.argv.insert(1, ' + repr(tool) + ')\nrunpy.run_path(' + repr(str(pathlib.Path(__file__).resolve())) + ', run_name="__main__")\n')
            script.chmod(0o755)
        env = {**os.environ, 'HOME': scratch, 'XDG_STATE_HOME': str(root / 'state'),
               'HC_BIN': str(tools / 'hc'), 'UPDATE_TEST_ROOT': scratch,
               'PATH': str(tools) + os.pathsep + os.environ['PATH']}
        tty = Tty(str(installed), env)
        try:
            tty.until(b'[u Update]')
            tty.send(b'\x1b[<0;4;3M\x1b[<0;4;3m')
            tty.until(b'scripted fetch failure')
            assert installed.read_bytes() == original
            tty.send(b'u')
            tty.until(b'[u Restart]')
            assert installed.read_bytes() != original
            tty.send(b'\x1b[<0;4;3M\x1b[<0;4;3m')
            tty.until(b'UPDATED-RESTART-OK')
            (root / 'release').touch()
            tty.process.wait(timeout=5)
            assert tty.process.returncode == 0
        finally:
            tty.close()


if __name__ == '__main__':
    if sys.argv[1] in ['git', 'cargo', 'hc']:
        fake_tool(sys.argv[1])
    else:
        main(sys.argv[1])
