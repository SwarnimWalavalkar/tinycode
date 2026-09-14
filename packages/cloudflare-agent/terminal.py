"""One reconnectable Linux PTY per sandbox; only reachable through the Worker."""
import asyncio
import errno
import fcntl
import json
import os
import pty
import signal
import struct
import subprocess
import sys
import termios
import time
import urllib.request
from aiohttp import web, WSMsgType

PORT = 3001
BUFFER = 256 * 1024


class Shell:
    def __init__(self):
        self.output = bytearray()
        self.clients = set()
        self.code = None
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.environ['TERM'] = 'xterm-256color'
            os.environ['SHELL'] = '/usr/bin/zsh'
            os.execv('/usr/bin/zsh', ['zsh', '-i'])
        os.set_blocking(self.fd, False)
        self.loop = asyncio.get_running_loop()
        self.loop.add_reader(self.fd, self.read)
        self.waiter = asyncio.create_task(self.wait())

    def broadcast(self, message):
        for queue in tuple(self.clients):
            if queue.full():
                self.clients.remove(queue)
                while not queue.empty():
                    queue.get_nowait()
                queue.put_nowait({'type': 'error', 'message': 'Terminal output overflow; reconnect'})
                queue.put_nowait(None)
            else:
                queue.put_nowait(message)

    def read(self):
        try:
            data = os.read(self.fd, 16384)
        except BlockingIOError:
            return
        except OSError as error:
            if error.errno != errno.EIO:
                raise
            data = b''
        if data:
            self.output.extend(data)
            del self.output[:-BUFFER]
            self.broadcast(data)
        else:
            self.loop.remove_reader(self.fd)

    async def wait(self):
        while True:
            pid, status = os.waitpid(self.pid, os.WNOHANG)
            if pid:
                # Drain final output before publishing exit.
                while True:
                    try:
                        data = os.read(self.fd, 16384)
                    except (BlockingIOError, OSError):
                        break
                    if not data:
                        break
                    self.output.extend(data)
                    del self.output[:-BUFFER]
                    self.broadcast(data)
                self.code = os.waitstatus_to_exitcode(status)
                if self.code < 0:
                    self.code = 128 - self.code
                self.loop.remove_reader(self.fd)
                os.close(self.fd)
                self.broadcast({'type': 'exit', 'code': self.code})
                return
            await asyncio.sleep(0.05)

    async def write(self, data):
        # Nonblocking writes with bounded websocket input, including large pastes.
        view = memoryview(data)
        while view and self.code is None:
            try:
                view = view[os.write(self.fd, view):]
            except BlockingIOError:
                await asyncio.sleep(0.01)
            except OSError:
                return

    def resize(self, cols, rows):
        if type(cols) is not int or type(rows) is not int or not (1 <= cols <= 1000 and 1 <= rows <= 1000):
            raise ValueError('Invalid terminal dimensions')
        if self.code is None:
            fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))

    async def stop(self):
        if self.code is None:
            # The foreground job may have a different process group than bash.
            try:
                os.killpg(os.tcgetpgrp(self.fd), signal.SIGKILL)
            except (OSError, ProcessLookupError):
                pass
            try:
                os.killpg(self.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            await self.waiter


async def serve():
    shell = None
    lock = asyncio.Lock()

    async def health(request):
        return web.Response(text='tinycode-terminal')

    async def terminal(request):
        nonlocal shell
        async with lock:
            if request.method == 'DELETE':
                if shell:
                    await shell.stop()
                    shell = None
                return web.json_response({'ok': True})
            ws = web.WebSocketResponse(max_msg_size=1024 * 1024)
            if not ws.can_prepare(request).ok:
                return web.Response(status=426)
            if shell is None or shell.code is not None:
                shell = Shell()
            current = shell
            queue = asyncio.Queue(maxsize=256)
            current.clients.add(queue)
            replay = bytes(current.output)
        try:
            await ws.prepare(request)
        except BaseException:
            current.clients.discard(queue)
            raise

        async def send():
            if replay:
                await ws.send_bytes(replay)
            await ws.send_json({'type': 'ready'})
            while True:
                message = await queue.get()
                if message is None:
                    await ws.close(code=1013)
                    return
                if isinstance(message, bytes):
                    await ws.send_bytes(message)
                else:
                    await ws.send_json(message)
                    if message['type'] == 'exit':
                        await ws.close()
                        return

        sender = asyncio.create_task(send())
        try:
            async for message in ws:
                if message.type == WSMsgType.BINARY:
                    await current.write(message.data)
                elif message.type == WSMsgType.TEXT:
                    try:
                        control = json.loads(message.data)
                        if control.get('type') != 'resize':
                            raise ValueError('Unknown terminal control')
                        current.resize(control.get('cols'), control.get('rows'))
                    except (ValueError, AttributeError, OSError):
                        await ws.send_json({'type': 'error', 'message': 'Invalid terminal control'})
        finally:
            current.clients.discard(queue)
            sender.cancel()
            await asyncio.gather(sender, return_exceptions=True)
        return ws

    app = web.Application()
    app.router.add_get('/health', health)
    app.router.add_route('*', '/terminal', terminal)
    runner = web.AppRunner(app)
    await runner.setup()
    await web.TCPSite(runner, '0.0.0.0', PORT).start()
    await asyncio.Event().wait()


def ensure():
    # Serialize concurrent launches without retaining an SDK command connection.
    with open('/tmp/tinycode-terminal.lock', 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        for attempt in range(100):
            try:
                with urllib.request.urlopen(f'http://127.0.0.1:{PORT}/health', timeout=0.2) as response:
                    if response.read() == b'tinycode-terminal':
                        return
            except OSError:
                pass
            if attempt == 0:
                subprocess.Popen([sys.executable, __file__], stdin=subprocess.DEVNULL,
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                 start_new_session=True, close_fds=True)
            time.sleep(0.05)
        raise RuntimeError('Terminal service did not start')


if __name__ == '__main__':
    if sys.argv[1:] == ['ensure']:
        ensure()
    else:
        asyncio.run(serve())
