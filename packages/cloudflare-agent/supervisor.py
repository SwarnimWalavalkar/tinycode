"""Bounded foreground commands. Cancellation never destroys the workspace.

The Sandbox SDK's process records retain unbounded logs and its kill API ignores
the signal argument. Use buffered exec only to transport this bounded result.
Control files contain no command/output and expire after the start deadline.
"""
import base64
import ctypes
import fcntl
import json
import os
from pathlib import Path
import re
import selectors
import signal
import subprocess
import sys
import time

ROOT = Path("/tmp/tinycode-commands")
LIMIT = 128 * 1024
ROOT.mkdir(mode=0o700, exist_ok=True)
action, ident, deadline = sys.argv[1:4]
assert re.fullmatch(r"[a-f0-9-]{36}", ident)
deadline = float(deadline)
path = ROOT / ident
# Only terminal, expired records are eligible; an in-flight stop may still need one.
for old in ROOT.iterdir():
    try:
        if old.stat().st_mtime < time.time() - 300:
            with old.open("r+") as handle:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                state = json.load(handle)
                if state.get("done") or not state.get("started"):
                    old.unlink(missing_ok=True)
    except (OSError, ValueError):
        pass


def control(update=None):
    with path.open("a+") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        handle.seek(0)
        state = json.loads(handle.read() or "{}")
        if update:
            state.update(update)
            handle.seek(0)
            handle.truncate()
            json.dump(state, handle)
            handle.flush()
        return state


if action == "stop":
    state = control({"cancelled": True})
    until = time.monotonic() + 4
    while state.get("started") and not state.get("done"):
        if time.monotonic() > until:
            raise RuntimeError("Command termination not confirmed")
        time.sleep(0.025)
        state = control()
    print("stopped")
    sys.exit(0)

assert action == "run"
command, cwd = json.loads(base64.b64decode(sys.argv[4]))
# Adopt orphaned grandchildren, allowing kill/reap of signal-resistant descendants.
ctypes.CDLL(None).prctl(36, 1, 0, 0, 0)  # PR_SET_CHILD_SUBREAPER
state = control({"started": True})
if state.get("cancelled") or time.time() * 1000 >= deadline:
    control({"done": True})
    raise RuntimeError("Command cancelled before startup")
process = None
output = {"stdout": bytearray(), "stderr": bytearray()}
truncated = set()
reason = None
def interrupted(_signal, _frame):
    raise RuntimeError("VM supervisor interrupted")

signal.signal(signal.SIGTERM, interrupted)
signal.signal(signal.SIGINT, interrupted)
try:
    process = subprocess.Popen(command, shell=True, cwd=cwd, start_new_session=True,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    selector = selectors.DefaultSelector()
    for name, stream in (("stdout", process.stdout), ("stderr", process.stderr)):
        os.set_blocking(stream.fileno(), False)
        selector.register(stream, selectors.EVENT_READ, name)
    # Do not reap the leader until the group is killed: its PID cannot be recycled.
    while True:
        if control().get("cancelled") or time.time() * 1000 >= deadline:
            reason = "VM command interrupted or timed out"
            break
        for key, _ in selector.select(0.025):
            chunk = os.read(key.fileobj.fileno(), 65536)
            if not chunk:
                selector.unregister(key.fileobj)
                continue
            buffer = output[key.data]
            room = LIMIT - len(buffer)
            buffer.extend(chunk[:room])
            if len(chunk) > room:
                truncated.add(key.data)
        if os.waitid(os.P_PID, process.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT):
            break
finally:
    if process:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait(timeout=3)
        # Reap the group before acknowledging cancellation.
        until = time.monotonic() + 3
        while True:
            try:
                pid, _ = os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                break
            if pid == 0:
                if time.monotonic() > until:
                    raise RuntimeError("Descendant termination not confirmed")
                time.sleep(0.01)
        for name, stream in (("stdout", process.stdout), ("stderr", process.stderr)):
            while chunk := stream.read(65536):
                room = LIMIT - len(output[name])
                output[name].extend(chunk[:room])
                if len(chunk) > room:
                    truncated.add(name)
            stream.close()
    control({"done": True})
if reason:
    raise RuntimeError(reason)
print(json.dumps({"success": process.returncode == 0, "exitCode": process.returncode,
                  **{key: value.decode("utf-8", errors="replace") +
                     ("\n…output truncated" if key in truncated else "")
                     for key, value in output.items()}}))
