import sys
sys.path.insert(0, '/usr/local/lib')
import hashlib
from pathlib import Path
import os
import tempfile
import unittest
from aiohttp.test_utils import TestClient, TestServer
from workspace_server import application


class WorkspaceTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.client = TestClient(TestServer(application(self.root)))
        await self.client.start_server()

    async def asyncTearDown(self):
        await self.client.close()
        self.temp.cleanup()

    async def test_tree_file_and_revision(self):
        (self.root / 'folder').mkdir()
        (self.root / '.git').mkdir()
        name = "a'$(echo nope).py"
        (self.root / name).write_text('print(42)\n')
        response = await self.client.get('/tree')
        entries = await response.json()
        self.assertEqual([e['name'] for e in entries], ['folder', name])
        response = await self.client.get('/file', params={'path': name})
        self.assertEqual(await response.json(), {'path': name, 'content': 'print(42)\n', 'revision': hashlib.sha256(b'print(42)\n').hexdigest()})
        (self.root / name).write_text('changed')
        response = await self.client.get('/file', params={'path': name})
        self.assertEqual((await response.json())['content'], 'changed')

    async def test_rejects_escaping_and_non_text_files(self):
        (self.root / 'escape').symlink_to('/etc')
        (self.root / 'binary').write_bytes(b'\0')
        (self.root / 'large').write_bytes(b'x' * 1000001)
        os.mkfifo(self.root / 'pipe')
        for path in ('../outside', '/etc/passwd', 'escape/passwd', 'binary', 'large', 'pipe', ''):
            response = await self.client.get('/file', params={'path': path})
            self.assertEqual(response.status, 400, path)
        response = await self.client.put('/file', json={'path': 'new', 'content': 'no'})
        self.assertEqual(response.status, 405)
        self.assertFalse((self.root / 'new').exists())
