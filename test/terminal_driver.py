import base64, fcntl, json, os, pty, select, signal, struct, subprocess, sys, termios, time

master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 44, 0, 0))
p = subprocess.Popen([sys.argv[1], '--import', 'tsx', sys.argv[2], sys.argv[3]], stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
buffer = b''
def until(text):
    global buffer
    deadline = time.monotonic() + 10
    while text not in buffer:
        remaining = deadline - time.monotonic()
        if remaining <= 0: raise AssertionError('Missing %r: %r' % (text, buffer[-4000:]))
        ready, _, _ = select.select([master], [], [], remaining)
        if ready: buffer += os.read(master, 65536)
    found = buffer
    buffer = b''
    return found
try:
    until(b'Picker')
    os.write(master, b'hello-from-phone\r')
    until(b'hello-from-phone')
    # Child clears the entire screen. Pocket must repaint its own controls below it.
    os.write(master, ('clear-screen-' + sys.argv[4] + '\r').encode())
    until(('APP-CLEARED-clear-screen-' + sys.argv[4]).encode())
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 2, 8, 0, 0))
    os.kill(p.pid, signal.SIGWINCH)
    until(b'Resize')
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 16, 32, 0, 0))
    os.kill(p.pid, signal.SIGWINCH)
    snapshot = until(b'Picker')
    if sys.argv[4] == 'mouse':
        for chunk in [b'\x1b[<', b'0;4;', b'16M', b'\x1b[<0;4;16m']:
            os.write(master, chunk)
    elif sys.argv[4] == 'hangup': os.kill(p.pid, signal.SIGHUP)
    else: os.write(master, b'\x1d')
    until(b'POCKET-DETACHED')
    deadline = time.monotonic() + 8
    while p.poll() is None:
        assert time.monotonic() < deadline, 'exit stalled'
        ready, _, _ = select.select([master], [], [], 0.1)
        if ready: os.read(master, 65536)
    assert p.returncode == 0
    assert termios.tcgetattr(slave)[3] & termios.ICANON
    print(json.dumps({'mode': sys.argv[4], 'tty_restored': True, 'snapshot': base64.b64encode(snapshot).decode()}))
finally:
    if p.poll() is None: os.killpg(p.pid, signal.SIGKILL); p.wait()
    os.close(master); os.close(slave)
