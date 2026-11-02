import fcntl, json, os, pty, select, signal, struct, subprocess, sys, termios, time

master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 44, 0, 0))
p = subprocess.Popen([sys.argv[1], '--import', 'tsx', sys.argv[2], 'missing'], stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
buffer = b''
try:
    deadline = time.monotonic() + 10
    while p.poll() is None:
        assert time.monotonic() < deadline, 'exit stalled'
        ready, _, _ = select.select([master], [], [], 0.1)
        if ready: buffer += os.read(master, 65536)
    while select.select([master], [], [], 0)[0]: buffer += os.read(master, 65536)
    assert p.returncode == 1, (p.returncode, buffer)
    assert b'Attach ended (exit 7)' in buffer, buffer
    assert termios.tcgetattr(slave)[3] & termios.ICANON
    print(json.dumps({'exit_code': p.returncode}))
finally:
    if p.poll() is None: os.killpg(p.pid, signal.SIGKILL); p.wait()
    os.close(master); os.close(slave)
