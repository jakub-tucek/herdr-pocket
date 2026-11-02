import fcntl, json, os, pty, select, signal, struct, subprocess, sys, termios, time

master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 44, 0, 0))
use_tmux = len(sys.argv) > 3
command = [sys.argv[1], sys.argv[2]]
if use_tmux:
    command = [sys.argv[3], '-S', sys.argv[4], '-f', sys.argv[5], 'new-session', '-s', 'phone', *command]
p = subprocess.Popen(command, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
buffer = b''
def until(text):
    global buffer
    deadline = time.monotonic() + 8
    while text not in buffer:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise AssertionError('Missing %r, output %r' % (text, buffer[-3000:]))
        ready, _, _ = select.select([master], [], [], remaining)
        if ready:
            part = os.read(master, 65536)
            if not part: raise AssertionError('TUI exited early')
            buffer += part
    buffer = b''
try:
    until(b'Phone')
    os.write(master, b'\r')
    until(b'TUI-ATTACH-OK')
    os.write(master, b'typed-from-termius\r')
    until(b'typed-from-termius')
    if use_tmux:
        # Real SGR mouse press/release on the tmux status bar, not a key shortcut.
        os.write(master, b'\x1b[<0;4;24M\x1b[<0;4;24m')
    else:
        os.write(master, b'\x1c')
    until(b'find')
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 16, 32, 0, 0))
    os.kill(p.pid, signal.SIGWINCH)
    until(b'Phone')
    os.write(master, b'\x1bq')
    # Keep consuming output: macOS tcsetattr drains the PTY during restoration.
    deadline = time.monotonic() + 8
    while p.poll() is None:
        if time.monotonic() >= deadline:
            raise AssertionError('Exit stalled: %r' % buffer[-3000:])
        ready, _, _ = select.select([master], [], [], 0.1)
        if ready: buffer += os.read(master, 65536)
    assert p.returncode == 0
    assert termios.tcgetattr(slave)[3] & termios.ICANON
    print(json.dumps({'attach': True, 'input': True, 'detach': True, 'resize': True, 'tty_restored': True, 'picker_button': use_tmux}))
finally:
    if p.poll() is None: os.killpg(p.pid, signal.SIGKILL); p.wait()
    os.close(master); os.close(slave)
