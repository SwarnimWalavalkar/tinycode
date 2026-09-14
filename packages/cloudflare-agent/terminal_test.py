"""Run with python3 -m unittest terminal_test inside the sandbox image."""
import asyncio
import importlib.util
import struct
import termios
import fcntl
import unittest

spec = importlib.util.spec_from_file_location('terminal', '/usr/local/lib/tinycode-terminal.py')
terminal = importlib.util.module_from_spec(spec)
spec.loader.exec_module(terminal)


class TerminalTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.shell = terminal.Shell()
        self.queue = asyncio.Queue(maxsize=256)
        self.shell.clients.add(self.queue)

    async def asyncTearDown(self):
        await self.shell.stop()

    async def until(self, marker):
        output = b''
        while marker not in output:
            item = await asyncio.wait_for(self.queue.get(), 5)
            if isinstance(item, bytes):
                output += item
        return output

    async def test_interrupt_foreground_job_and_preserve_shell(self):
        await self.until(b'# ')
        await self.shell.write(b'sleep 300\r')
        await asyncio.sleep(.15)
        await self.shell.write(b'\x03')
        await self.until(b'# ')
        await self.shell.write(b'printf "AFTER_%s\\n" INTERRUPT\r')
        await self.until(b'AFTER_INTERRUPT')
        self.assertIsNone(self.shell.code)

    async def test_resize_exit_and_replay(self):
        await self.until(b'# ')
        self.shell.resize(120, 40)
        self.assertEqual(struct.unpack('HHHH', fcntl.ioctl(self.shell.fd, termios.TIOCGWINSZ, b'\0' * 8))[:2], (40, 120))
        await self.shell.write(b'printf "FINAL_%s\\n" OUTPUT; exit 7\r')
        await self.until(b'FINAL_OUTPUT')
        while True:
            message = await asyncio.wait_for(self.queue.get(), 5)
            if isinstance(message, dict):
                self.assertEqual(message, {'type': 'exit', 'code': 7})
                break
        self.assertIn(b'FINAL_OUTPUT', self.shell.output)

    async def test_end_session_stops_foreground_job(self):
        await self.until(b'# ')
        await self.shell.write(b'sleep 300\r')
        await asyncio.sleep(.15)
        await asyncio.wait_for(self.shell.stop(), 5)
        self.assertIsNotNone(self.shell.code)


class TerminalWebSocketTest(unittest.IsolatedAsyncioTestCase):
    async def test_reconnect_interrupt_exit_and_restart(self):
        import sys
        from aiohttp import ClientSession, ClientError, WSMsgType
        process = await asyncio.create_subprocess_exec(sys.executable, '/usr/local/lib/tinycode-terminal.py')
        try:
            async with ClientSession() as client:
                for _ in range(100):
                    try:
                        async with client.get('http://127.0.0.1:3001/health') as response:
                            if response.status == 200:
                                break
                    except ClientError:
                        pass
                    await asyncio.sleep(.05)
                url = 'http://127.0.0.1:3001/terminal'

                async def until(ws, marker):
                    data = b''
                    while marker not in data:
                        msg = await asyncio.wait_for(ws.receive(), 5)
                        self.assertIn(msg.type, (WSMsgType.TEXT, WSMsgType.BINARY))
                        if msg.type == WSMsgType.BINARY:
                            data += msg.data
                    return data

                ws = await client.ws_connect(url)
                await until(ws, b'# ')
                await ws.send_bytes(b'export RECONNECT_TEST=kept; cd /tmp; printf "STATE_%s\\n" READY\r')
                await until(ws, b'STATE_READY')
                await ws.close()
                ws = await client.ws_connect(url)
                await until(ws, b'STATE_READY')
                await ws.send_bytes(b'printf "VALUE_%s\\n" "$RECONNECT_TEST"; pwd\r')
                await until(ws, b'VALUE_kept')
                await ws.send_bytes(b'sleep 300\r')
                await asyncio.sleep(.15)
                await ws.send_bytes(b'\x03')
                await ws.send_bytes(b'printf "INTERRUPT_%s\\n" OK\r')
                await until(ws, b'INTERRUPT_OK')
                await ws.send_bytes(b'exit 7\r')
                while True:
                    message = await asyncio.wait_for(ws.receive(), 5)
                    if message.type == WSMsgType.TEXT and message.json().get('type') == 'exit':
                        self.assertEqual(message.json()['code'], 7)
                        break
                await ws.close()
                ws = await client.ws_connect(url)
                await until(ws, b'# ')
                async with client.delete(url) as response:
                    self.assertEqual(response.status, 200)
                await ws.close()
        finally:
            process.terminate()
            await process.wait()
