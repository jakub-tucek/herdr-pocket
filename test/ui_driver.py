import fcntl, json, os, pty, select, signal, struct, subprocess, sys, termios, time

master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 44, 0, 0))
p = subprocess.Popen([sys.argv[1], sys.argv[2]], stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
control = subprocess.Popen([os.environ['HC_BIN'], 'connect'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
buffer = b''
request_id = 0
def rpc(method, params):
    global request_id
    request_id += 1
    control.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': request_id, 'method': method, 'params': params}) + '\n')
    control.stdin.flush()
    while True:
        line = control.stdout.readline()
        assert line, 'core disconnected'
        result = json.loads(line)
        if result.get('id') != request_id: continue
        assert 'error' not in result, result
        return result['result']
def until(text):
    global buffer
    deadline = time.monotonic() + 15
    while text not in buffer:
        remaining = deadline - time.monotonic()
        if remaining <= 0: raise AssertionError('Missing %r: %r' % (text, buffer[-4000:]))
        ready, _, _ = select.select([master], [], [], remaining)
        if ready: buffer += os.read(master, 65536)
    buffer = b''
def click(x, y):
    os.write(master, ('\x1b[<0;%d;%dM\x1b[<0;%d;%dm' % (x, y, x, y)).encode())
try:
    rpc('hello', {'generation': 1})
    until(b'phone-repo')
    click(8, 4)  # repository
    until(b'+ Shell')
    click(8, 5)  # direct launch, no intermediate dialog
    until(b'Picker')
    os.write(master, b"printf 'TWO-CLICK-SHELL-OK\\n'\r")
    until(b'TWO-CLICK-SHELL-OK')
    click(4, 24)
    until(b'find')
    doc = rpc('doc.get', {'name': 'herdr-app'})
    assert len(doc['value']['spaces']) == 1, 'created duplicate workspace'
    assert len(doc['value']['spaces'][0]['tabs']) == 2, 'did not create exactly one session'
    doc['value']['spaces'][0]['name'] = 'Synced workspace'
    rpc('doc.set', {'name': 'herdr-app', 'version': doc['version'], 'value': doc['value']})
    until(b'Synced workspace')
    os.write(master, b'q')
    deadline = time.monotonic() + 8
    while p.poll() is None:
        assert time.monotonic() < deadline, 'exit stalled'
        ready, _, _ = select.select([master], [], [], 0.1)
        if ready: os.read(master, 65536)
    assert p.returncode == 0
    assert termios.tcgetattr(slave)[3] & termios.ICANON
    print(json.dumps({'two_click_shell': True, 'live_sync': True}))
finally:
    if p.poll() is None: os.killpg(p.pid, signal.SIGKILL); p.wait()
    control.terminate(); control.wait(timeout=5)
    os.close(master); os.close(slave)
