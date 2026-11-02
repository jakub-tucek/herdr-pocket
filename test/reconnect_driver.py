import fcntl, json, os, pty, re, select, signal, struct, subprocess, sys, termios, time

master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
p = subprocess.Popen([sys.argv[1], '--import', 'tsx', sys.argv[2]], stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
pending = b''
transcript = b''
ansi = re.compile(r'\x1b\[[0-?]*[ -/]*[@-~]')

def read(timeout):
    global pending, transcript
    ready, _, _ = select.select([master], [], [], timeout)
    if ready:
        chunk = os.read(master, 65536)
        assert chunk, 'PTY closed: %r' % transcript[-4000:]
        pending += chunk
        transcript += chunk

def until(predicate, label, timeout=8):
    global pending
    deadline = time.monotonic() + timeout
    while True:
        while b'\x1b[J' in pending:
            frame, pending = pending.split(b'\x1b[J', 1)
            frame = ansi.sub('', frame.decode('utf-8', errors='replace')).replace('\r', '')
            if predicate(frame):
                return frame
        remaining = deadline - time.monotonic()
        assert remaining > 0, 'Missing %s: %r' % (label, transcript[-6000:])
        read(remaining)

def send(keys):
    os.write(master, keys)

def disabled_shell(frame):
    return any('+ Shell' in line and 'offline' in line and not re.search(r'\b\d +\+ Shell', line) for line in frame.splitlines())

try:
    until(lambda f: 'Original repo' in f, 'initial discovery')
    send(b'\r')
    until(lambda f: bool(re.search(r'\b2 +\+ Shell', f)), 'initial shell action')
    until(lambda f: 'Controlled refresh failure' in f and disabled_shell(f), 'failed refresh disables repository actions')
    send(b's')
    until(lambda f: 'Machine offline' in f and disabled_shell(f), 'offline repository launch blocked')

    send(b'\t')
    until(lambda f: 'Test space' in f and 'offline' in f, 'cached space marked offline')
    send(b'\r')
    until(disabled_shell, 'offline space actions disabled')
    send(b's')
    until(lambda f: 'Machine offline' in f and disabled_shell(f), 'offline space launch blocked')

    send(b'\t')
    until(lambda f: 'Original repo' in f and 'offline' in f, 'cached repository marked offline')
    send(b'\r')
    until(disabled_shell, 'offline repository reopened')
    # No r key: the next periodic world refresh must trigger discovery itself.
    until(lambda f: 'Recovered repo' in f and bool(re.search(r'\b2 +\+ Shell', f)) and not disabled_shell(f), 'automatic reconnect discovery restores actions')
    send(b's')
    until(lambda f: 'Controlled shell launch accepted' in f, 'recovered shell dispatch')
    send(b'q')
    deadline = time.monotonic() + 5
    while p.poll() is None:
        assert time.monotonic() < deadline, 'exit stalled'
        read(0.1)
    # The parent retains the slave, so draining after child exit cannot hit EIO.
    while select.select([master], [], [], 0)[0]:
        read(0)
    assert p.returncode == 0, transcript[-6000:]
    assert termios.tcgetattr(slave)[3] & termios.ICANON, 'TTY not restored'
    match = re.search(rb'RECONNECT-COUNTERS (\{[^\r\n]+\})', transcript)
    assert match, 'Missing backend counters: %r' % transcript[-4000:]
    print(json.dumps(json.loads(match.group(1))))
finally:
    if p.poll() is None:
        os.killpg(p.pid, signal.SIGKILL)
        p.wait()
    os.close(master)
    os.close(slave)
