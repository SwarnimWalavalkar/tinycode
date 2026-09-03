# Contributing to Tinycode

Tinycode is in an early beta. Small bug reports and focused fixes are especially useful. Please discuss larger product or architecture changes before starting them.

## Development

Use Node 24 (see `.node-version`), pnpm 10.33.3 (pinned in `package.json`), and Git. macOS and Linux are the intended platforms. Install and authenticate a supported harness only when you want to run real agent tasks.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

The UI is at `http://127.0.0.1:4737`; the server is at `http://127.0.0.1:4738`. Use a separate `TINYCODE_DATA_DIR` if you want disposable development state. The default, `~/.tinycode`, contains real task history and workspaces.

## Validation

```sh
pnpm check
pnpm build
pnpm test:smoke
```

These checks use controlled adapters and disposable directories. They do not send model prompts or require harness credentials. The smoke checks briefly bind loopback ports 4739 and 4742 and exercise the built UI, authentication, WebSockets, a real PTY, files, Git/worktrees, and image uploads. They stop their servers and remove their fixtures when finished.

Other scripts in `scripts/` are opt-in harness checks. Some send paid model requests and create native sessions; consult [validation](docs/validation.md) before running them. They are not part of CI.

## Scope of a change

- Keep harness behavior in its adapter. The harness owns execution, authentication, tools, and permission decisions.
- Preserve persisted native session IDs, accepted queue messages, and attachment references across reconnects.
- Keep streaming updates scoped to the affected transcript rows. Load secondary surfaces only when needed.
- Add regression coverage for behavioral changes at the relevant boundary. Small visual adjustments usually need a browser check.
- Describe what changed, how to reproduce the original problem, and which checks you actually ran. Include a screenshot for visible changes, with private content removed.

Never commit `.env` files, tokens, runtime databases, native sessions, uploaded images, or personal project contents. Report security problems privately as described in [SECURITY.md](SECURITY.md).
