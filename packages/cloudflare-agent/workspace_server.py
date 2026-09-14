"""Read-only explorer service. The authenticated Worker is the only ingress."""
import asyncio
import fcntl
import hashlib
import os
from pathlib import Path
import stat
import subprocess
import sys
import time
import urllib.request
from aiohttp import web

PORT = 3002
ROOT = Path('/workspace')


def read_workspace(action, path, root=ROOT):
    root = root.resolve()
    if action not in ('tree', 'file'):
        raise ValueError('Invalid workspace action')
    if len(path) > 4096 or '\0' in path or os.path.isabs(path):
        raise ValueError('Use a workspace-relative path')
    target = (root / path).resolve()
    if not target.is_relative_to(root):
        raise ValueError('Path is outside workspace')
    if action == 'tree':
        entries = []
        # scandir reuses directory-entry metadata rather than stat-ing every child.
        with os.scandir(target) as children:
            for child in children:
                if child.name == '.git':
                    continue
                if len(entries) >= 5000:
                    raise ValueError('Directory contains too many entries')
                kind = 'symlink' if child.is_symlink() else 'directory' if child.is_dir() else 'file'
                entries.append({'name': child.name, 'path': str((target / child.name).relative_to(root)), 'type': kind})
        return sorted(entries, key=lambda e: (e['type'] != 'directory', e['name']))
    # Nonblocking open avoids hanging the service on FIFOs/devices.
    fd = os.open(target, os.O_RDONLY | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode):
            raise ValueError('Choose a regular file')
        if info.st_size > 1000000:
            raise ValueError('File too large to preview')
        data = source.read(1000001)
    if len(data) > 1000000:
        raise ValueError('File too large to preview')
    if b'\0' in data:
        raise ValueError('Binary file cannot be previewed')
    return {'path': path, 'content': data.decode('utf-8'), 'revision': hashlib.sha256(data).hexdigest()}


def application(root=ROOT):
    async def read(request):
        try:
            result = await asyncio.to_thread(read_workspace, request.match_info['action'], request.query.get('path', ''), root)
            return web.json_response(result)
        except (ValueError, OSError) as error:
            return web.json_response({'error': str(error)}, status=400)

    async def health(request):
        return web.Response(text='tinycode-workspace')

    app = web.Application()
    app.router.add_get('/health', health)
    app.router.add_get('/{action:tree|file}', read)
    return app


def ensure():
    with open('/tmp/tinycode-workspace.lock', 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        for attempt in range(100):
            try:
                with urllib.request.urlopen(f'http://127.0.0.1:{PORT}/health', timeout=0.2) as response:
                    if response.read() == b'tinycode-workspace':
                        return
            except OSError:
                pass
            if attempt == 0:
                subprocess.Popen([sys.executable, __file__], stdin=subprocess.DEVNULL,
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                 start_new_session=True, close_fds=True)
            time.sleep(0.05)
        raise RuntimeError('Workspace service did not start')


if __name__ == '__main__':
    if sys.argv[1:] == ['ensure']:
        ensure()
    else:
        web.run_app(application(), host='0.0.0.0', port=PORT, print=None)
