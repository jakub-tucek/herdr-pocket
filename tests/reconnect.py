"""Black-box picker reconnect regression. Never starts or contacts a user's core."""
import base64
import fcntl
import json
import os
import pathlib
import re
import select
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time


def fake_hc():
    root = pathlib.Path(os.environ['RECONNECT_ROOT'])
    repo = root / 'home/Projects/reconnect-repo'
    # Persist across hc children, including an unexpected client reconnect.
    state_path = root / 'world-count'
    for line in sys.stdin:
        request = json.loads(line)
        method = request['method']
        params = request.get('params', {})
        with (root / 'calls.jsonl').open('a') as log:
            log.write(json.dumps(request) + '\n')
        result, error = {}, None
        if method == 'terminal.list':
            count = int(state_path.read_text()) + 1 if state_path.exists() else 1
            state_path.write_text(str(count))
            if count == 2:
                error = {'code': -32000, 'message': 'scripted world outage'}
            else:
                if count >= 3:
                    deadline = time.monotonic() + 10
                    while not (root / 'recover').exists():
                        if time.monotonic() >= deadline:
                            raise AssertionError('test never released recovery')
                        time.sleep(.01)
                result = {'terminals': []}
        elif method == 'machine.list':
            result = {'machines': []}
        elif method == 'doc.get':
            result = {'version': 1, 'value': {'spaces': [
                {'id': 'test-space', 'name': 'Reconnect', 'folder': str(repo), 'tabs': []}
            ]}}
        elif method == 'machine.exec':
            argv = params['argv']
            assert argv[0] in ('printenv', 'find', 'git'), argv
            process = subprocess.run(argv, capture_output=True, timeout=5)
            result = {
                'code': process.returncode,
                'stdout': base64.b64encode(process.stdout).decode(),
                'stderr': base64.b64encode(process.stderr).decode(),
                'timed_out': False, 'truncated': False,
            }
        elif method == 'terminal.run':
            # Observing the RPC proves the UI enabled launch. Avoid attaching.
            error = {'code': -32000, 'message': 'recovered shell launch observed'}
        elif method != 'hello':
            error = {'code': -32601, 'message': 'unexpected method: ' + method}
        response = {'jsonrpc': '2.0', 'id': request['id']}
        response['error' if error else 'result'] = error if error else result
        print(json.dumps(response), flush=True)


class Tty:
    def __init__(self, binary, env):
        self.master, self.slave = os.openpty()
        fcntl.ioctl(self.slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
        self.process = subprocess.Popen(
            [binary], env=env, stdin=self.slave, stdout=self.slave,
            stderr=self.slave, start_new_session=True,
        )
        self.buffer = b''

    def send(self, value):
        os.write(self.master, value)

    def drain(self, seconds):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if select.select([self.master], [], [], max(0, deadline - time.monotonic()))[0]:
                try:
                    chunk = os.read(self.master, 65536)
                except OSError as error:
                    raise AssertionError('PTY closed: %r' % self.buffer[-4000:]) from error
                assert chunk, 'PTY exited: %r' % self.buffer[-4000:]
                self.buffer += chunk

    def until(self, text, seconds=10):
        deadline = time.monotonic() + seconds
        while text not in self.buffer:
            assert time.monotonic() < deadline, 'Missing %r: %r' % (text, self.buffer[-4000:])
            self.drain(.05)
        result, self.buffer = self.buffer, b''
        return result

    def close(self):
        if self.process.poll() is None:
            os.killpg(self.process.pid, signal.SIGKILL)
        self.process.wait(timeout=5)
        os.close(self.master)
        os.close(self.slave)


def main(binary):
    with tempfile.TemporaryDirectory(prefix='pocket-reconnect-') as scratch:
        root = pathlib.Path(scratch)
        home = root / 'home'
        repo = home / 'Projects/reconnect-repo'
        repo.mkdir(parents=True)
        for folder in ('state', 'config', 'run'):
            (root / folder).mkdir(mode=0o700)
        wrapper = root / 'hc'
        wrapper.write_text('#!' + sys.executable + '\n'
                           'import runpy\n'
                           'runpy.run_path(' + repr(str(pathlib.Path(__file__).resolve()))
                           + ', run_name="__main__")\n')
        wrapper.chmod(0o755)
        env = {**os.environ, 'HOME': str(home), 'HC_BIN': str(wrapper),
               'HC_SESSION': 'reconnect-test', 'RECONNECT_ROOT': str(root),
               'XDG_STATE_HOME': str(root / 'state'),
               'XDG_CONFIG_HOME': str(root / 'config'),
               'XDG_RUNTIME_DIR': str(root / 'run'),
               'TERM': 'xterm-256color', 'SHELL': '/bin/sh',
               'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': os.devnull}
        subprocess.run(['git', 'init', '-b', 'main', str(repo)], env=env,
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(['git', '-C', str(repo), '-c', 'user.name=Pocket',
                        '-c', 'user.email=test@example.invalid', 'commit',
                        '--allow-empty', '-m', 'seed'], env=env, check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

        def calls():
            log = root / 'calls.jsonl'
            return [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []

        def launches():
            return [call for call in calls() if call['method'] == 'terminal.run']

        tty = Tty(os.path.abspath(binary), env)
        try:
            tty.until(b'reconnect-repo')
            tty.send(b'\r')
            tty.until(b'+ Shell')
            offline = tty.until(b'offline')
            assert b'+ Shell' in offline, offline
            failed_at = time.monotonic()
            tty.send(b's')
            tty.drain(.4)
            assert not launches(), 'offline shortcut launched a terminal'
            tty.buffer = b''
            (root / 'recover').touch()

            # Do not press r: automatic reconnect must invalidate the 60s scan cache.
            deadline = time.monotonic() + 10
            while True:
                scans = [call for call in calls() if call['method'] == 'machine.exec'
                         and call['params']['argv'][0] == 'find']
                if len(scans) >= 2:
                    break
                assert time.monotonic() < deadline, 'reconnect did not rediscover repositories'
                tty.drain(.05)
            # Observe the rendered action, not just completion of a backend RPC.
            while True:
                lines = re.split(rb'\x1b\[\d+;1H', tty.buffer)
                shells = [line for line in lines if b'+ Shell' in line and b'\x1b[K' in line]
                if shells and b'offline' not in shells[-1]:
                    break
                assert time.monotonic() < deadline, 'shell action stayed visibly offline'
                tty.drain(.05)
            tty.send(b's')
            tty.until(b'recovered shell launch observed')
            assert time.monotonic() - failed_at < 15, 'recovery waited for discovery TTL'
            assert len(launches()) == 1, launches()
            assert pathlib.Path(launches()[0]['params']['cwd']).resolve() == repo.resolve()
            tty.send(b'q')
            tty.process.wait(timeout=5)
            assert tty.process.returncode == 0
        finally:
            tty.close()
        print('PASS: world error disables shell; automatic reconnect rediscovers and enables launch')


if __name__ == '__main__':
    if sys.argv[1:] == ['connect']:
        fake_hc()
    else:
        main(sys.argv[1])
