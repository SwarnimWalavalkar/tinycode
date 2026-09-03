# Security

Tinycode is an early, single-user development tool. Each beta tester should run a separate instance under their own OS account. A server access token gives control of that account's Tinycode tasks, file editor, and terminal. It is not a multi-user authorization boundary.

## Running a server

- The default listener is loopback-only. SSH port forwarding is the simplest remote setup; see the [README](README.md#remote-machine).
- Direct remote access requires a long random `TINYCODE_TOKEN`. Use HTTPS or a trusted private network. Keep the listener off the public internet unless the host and transport are secured.
- Set `TINYCODE_ORIGIN` to the browser-facing origin behind a reverse proxy. Allow separate frontend origins explicitly; do not use broad origin rules.
- Harness permission settings apply to harness actions. They do not restrict actions you take through the manual terminal or file editor. Pi tool allowlists are not an OS sandbox, and native extensions still run.
- Tinycode stores task text, tool output, attachments, and scratchpad files in `TINYCODE_DATA_DIR` (`~/.tinycode` by default). Protect that directory and its backups. Native harness credentials and session files remain in their native locations.
- Browser authentication uses cookies or request/handshake headers rather than URL tokens. A token can still be accessed by someone with control of your browser tab or server account. Restart the server with a new token to rotate access.

## Reporting a vulnerability

Please do not put credentials, private code, transcripts, or exploit details in a public issue. During the internal beta, contact the maintainer privately through the channel where you received your invitation. If this repository offers **Security → Report a vulnerability**, you can use that private report instead.

Include the affected commit, operating system, Node and harness versions, and a minimal reproduction with synthetic data. Only test instances and data you own or have permission to inspect.

The current development branch receives fixes. There are no long-term support releases or response-time guarantees during the beta.
