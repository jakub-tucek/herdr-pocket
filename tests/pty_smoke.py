"""Black-box Rust binary + real isolated hc + real PTY. No Node or user's core."""
import fcntl
import json
import os
import pathlib
import select
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time

binary = os.path.abspath(sys.argv[1])
hc = os.environ.get('HC_BIN', os.path.expanduser('~/.local/bin/hc'))

class Core:
    def __init__(self, env):
        self.p = subprocess.Popen([hc, 'connect'], env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        self.id = 0
        self.rpc('hello', {'generation': 1})
    def rpc(self, method, params):
        self.id += 1
        self.p.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': self.id, 'method': method, 'params': params}) + '\n')
        self.p.stdin.flush()
        while True:
            line = self.p.stdout.readline()
            assert line, 'core disconnected'
            reply = json.loads(line)
            if reply.get('id') != self.id: continue
            assert 'error' not in reply, reply
            return reply['result']
    def close(self):
        try: self.rpc('server.stop', {})
        except (AssertionError, BrokenPipeError): pass
        self.p.terminate()
        self.p.wait(timeout=5)

class Tty:
    def __init__(self, args, env):
        self.master, self.slave = os.openpty()
        self.size(44, 24)
        self.p = subprocess.Popen([binary, *args], env=env, stdin=self.slave, stdout=self.slave, stderr=self.slave, start_new_session=True)
        self.buffer = b''
    def size(self, cols, rows):
        fcntl.ioctl(self.slave, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
        if hasattr(self, 'p'): os.kill(self.p.pid, signal.SIGWINCH)
    def send(self, data): os.write(self.master, data)
    def click(self, x, y): self.send(('\x1b[<0;%d;%dM\x1b[<0;%d;%dm' % (x,y,x,y)).encode())
    def until(self, text, seconds=15):
        deadline = time.monotonic() + seconds
        while text not in self.buffer:
            left = deadline - time.monotonic()
            assert left > 0, 'Missing %r: %r' % (text, self.buffer[-3000:])
            if select.select([self.master], [], [], left)[0]:
                chunk = os.read(self.master, 65536)
                assert chunk, 'terminal exited: %r' % self.buffer[-3000:]
                self.buffer += chunk
        result = self.buffer
        self.buffer = b''
        return result
    def finish(self, code=0):
        deadline = time.monotonic() + 8
        while self.p.poll() is None:
            assert time.monotonic() < deadline, 'exit stalled: %r' % self.buffer[-3000:]
            if select.select([self.master], [], [], .1)[0]:
                try: self.buffer += os.read(self.master, 65536)
                except OSError: pass
        assert self.p.returncode == code, (self.p.returncode, self.buffer[-3000:])
        try: assert termios.tcgetattr(self.slave)[3] & termios.ICANON
        except termios.error as error:
            if error.args[0] != 25: raise  # macOS may revoke a controlling PTY after exit.
    def close(self):
        if self.p.poll() is None: os.killpg(self.p.pid, signal.SIGKILL); self.p.wait()
        os.close(self.master); os.close(self.slave)

cache = pathlib.Path.home() / '.cache'
cache.mkdir(exist_ok=True)
with tempfile.TemporaryDirectory(prefix='hp-rs-', dir=cache) as scratch:
    root = pathlib.Path(scratch)
    env = {**os.environ, 'HOME': str(root/'home'), 'HC_BIN': hc, 'HC_SESSION': 'r', 'XDG_STATE_HOME': str(root/'state'), 'XDG_CONFIG_HOME': str(root/'config'), 'XDG_RUNTIME_DIR': str(root/'run'), 'TERM': 'xterm-256color', 'SHELL': '/bin/sh'}
    (root/'home').mkdir(); (root/'run').mkdir(mode=0o700)
    repo = root/'home/Projects/phone-repo'
    repo.mkdir(parents=True)
    def git(*args): return subprocess.check_output(['git', *args], env=env, stderr=subprocess.DEVNULL, text=True)
    git('init', '-b', 'main', str(repo))
    git('-C', str(repo), '-c', 'user.name=Pocket', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'seed')
    core = Core(env)
    try:
        terminal = core.rpc('terminal.run', {'argv': ['/bin/sh', '-c', "printf 'APP-READY\\r\\n'; while IFS= read -r line; do case \"$line\" in clear-*) printf '\\033[2J\\033[HAPP-%s\\r\\n' \"$line\" ;; *) printf '%s\\r\\n' \"$line\" ;; esac; done"], 'cwd': str(repo), 'keep': True, 'no_parent': True, 'no_notify': True})
        address = terminal['address']
        original_pid = core.rpc('terminal.get', {'terminal': address})['pid']
        core.rpc('doc.set', {'name': 'herdr-app', 'version': 0, 'value': {'custom': 'preserve', 'spaces': [{'id': 'phone', 'name': 'Phone', 'folder': str(repo), 'tabs': [{'id': 'existing', 'name': 'Existing', 'root': {'id': 'root', 'type': 'row', 'children': [{'id': 'pane', 'type': 'block', 'content': {'terminal': address}}]}}]}]}})
        for mode in ['mouse', 'keyboard', 'hangup']:
            print('Testing ' + mode, flush=True)
            tty = Tty(['--attach', address], env)
            try:
                tty.until(b'Picker')
                tty.send(('hello-' + mode + '\r').encode()); tty.until(('hello-' + mode).encode())
                tty.send(('clear-' + mode + '\r').encode()); tty.until(('APP-clear-' + mode).encode())
                # A partial paste prefix must survive network jitter, including Ctrl+] inside paste.
                tty.send(b'\x1b[20'); time.sleep(.18)
                tty.send(b'0~paste-utf8-\xc4\x8d\x1d\x1b[20'); time.sleep(.18)
                tty.send(b'1~\r'); tty.until(b'paste-utf8-')
                tty.size(8, 2); tty.until(b'Resize')
                tty.size(32, 16); tty.until(b'Picker')
                if mode == 'mouse': tty.click(4, 16)
                elif mode == 'keyboard': tty.send(b'\x1d')
                else: os.kill(tty.p.pid, signal.SIGHUP)
                tty.finish()
                info = core.rpc('terminal.get', {'terminal': address})
                assert info['state'] == 'live', (mode, info)
                assert info['pid'] == original_pid, ('program restarted during detach', mode, info)
            finally: tty.close()
        print('PASS: terminal rendering, slow paste, input, resize, mouse/key/hangup detach, surviving session', flush=True)

        repositories = json.loads(subprocess.check_output([binary, '--repos', '--json'], env=env))
        assert len(repositories) == 1 and repositories[0]['name'] == 'phone-repo', repositories
        tty = Tty([], env)
        try:
            tty.until(b'phone-repo'); tty.click(8, 4)
            tty.until(b'+ Shell'); tty.click(8, 5)
            tty.until(b'Picker')
            tty.send(b"printf '%s%s\\n' 'RUST-' 'TWO-CLICK-OK'\r")
            tty.until(b'RUST-TWO-CLICK-OK')
            tty.click(4, 24); tty.until(b'find')
            doc = core.rpc('doc.get', {'name': 'herdr-app'})
            assert len(doc['value']['spaces']) == 1
            assert len(doc['value']['spaces'][0]['tabs']) == 2
            doc['value']['spaces'][0]['name'] = 'Synced workspace'
            core.rpc('doc.set', {'name': 'herdr-app', 'version': doc['version'], 'value': doc['value']})
            tty.until(b'Synced workspace')
            tty.send(b'q'); tty.finish()
        finally: tty.close()
        print('PASS: two-click shell creation and live layout sync from another client', flush=True)

        created = json.loads(subprocess.check_output([binary, 'tree', '--repo', str(repo), '--branch', 'phone/test', '--program', 'shell'], env=env))
        assert 'phone/test' in git('-C', str(repo), 'worktree', 'list', '--porcelain')
        doc = core.rpc('doc.get', {'name': 'herdr-app'})
        assert doc['value']['custom'] == 'preserve' and len(doc['value']['spaces']) == 2
        assert core.rpc('terminal.get', {'terminal': created['address']})['state'] == 'live'
        print('PASS: Git worktree and shared workspace creation', flush=True)

        wrapper = root/'failing-hc'
        wrapper.write_text('#!/bin/sh\nif [ "$1" = attach ]; then exit 7; fi\nexec "$REAL_HC" "$@"\n')
        wrapper.chmod(0o755)
        tty = Tty(['--attach', address], {**env, 'HC_BIN': str(wrapper), 'REAL_HC': hc})
        try:
            tty.until(b'Attach ended (exit 7)'); tty.finish(code=1)
        finally: tty.close()
        print('PASS: attachment failure is reported and TTY restored', flush=True)
    finally: core.close()
