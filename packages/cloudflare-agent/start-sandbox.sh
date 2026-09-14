#!/bin/sh
# Start read-only browsing alongside the SDK, before the first explorer request.
python3 /usr/local/lib/workspace_server.py &
exec /container-server/sandbox "$@"
