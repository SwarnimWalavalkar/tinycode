# Tinycode

A small web workspace for Codex, Claude Code, and Pi. Tinycode wraps the harnesses you already use. It does not implement an agent loop, tools, or model routing.

**Early alpha · internal beta testing.** Expect rough edges and changing protocols. The same single-user server runs on your laptop or a remote development machine. Projects, credentials, harness processes, and shells live on that server. Each tester should run their own instance.

Start with a disposable project, or commit your work before trying agent-driven edits. Back up your Tinycode data and native harness sessions before updating. This repository shares the current implementation; there is no hosted service or stable release yet.

The interface uses [SF Pro](https://developer.apple.com/fonts/) through Apple's native system font on macOS/iOS, with locally installed SF Pro and system-font fallbacks elsewhere. Code, diffs, file contents, and terminals use bundled [JetBrains Mono](https://www.jetbrains.com/lp/mono/), including italics. Font files are served with the UI; no external font service is needed. JetBrains Mono's [SIL Open Font License](public/assets/fonts/jetbrains-mono-LICENSE.txt) is included in the build.

## Run

Requires Node 22.19+ (Node 24 recommended), Git, and at least one installed, authenticated harness. Use npm, pnpm 10.26+, or Bun as your package manager. macOS and Linux are the intended v0 platforms; native harness validation so far was performed on macOS. Windows is not yet supported.

Install a harness and sign in using its own CLI on the machine that will run the Tinycode server:

| Harness     | Setup                                                                                      | Command Tinycode looks for |
| ----------- | ------------------------------------------------------------------------------------------ | -------------------------- |
| Codex       | [Official CLI setup](https://developers.openai.com/codex/cli)                              | `codex`                    |
| Claude Code | [Official setup](https://code.claude.com/docs/en/overview)                                 | `claude`                   |
| Pi          | [Coding agent setup](https://github.com/earendil-works/pi/tree/main/packages/coding-agent) | `pi`                       |

Linux installs compile the terminal bindings from source, so Python 3, Make, and a C/C++ compiler are required. On Debian/Ubuntu, install them before installing dependencies:

```sh
sudo apt-get update
sudo apt-get install -y python3 build-essential
```

On macOS, install Xcode Command Line Tools if native bindings need to compile. Tinycode includes `node-gyp` as a build dependency; no global installation is needed. Do not skip dependency build scripts: the terminal and database require their native components.

From this checkout, choose your package manager:

| Package manager | Install | Development | Build and run |
| --- | --- | --- | --- |
| npm | `npm install` | `npm run dev` | `npm run build && npm run start` |
| pnpm | `pnpm install` | `pnpm run dev` | `pnpm run build && pnpm run start` |
| Bun | `bun install` | `bun run dev` | `bun run build && bun run start` |

Tinycode uses Node.js as its server runtime with all three package managers. Bun installs dependencies and runs the package scripts; Node.js must still be installed. The required dependency build scripts are already allowed for pnpm and Bun.

When switching package managers in an existing checkout, remove the old `node_modules` first, then install with your chosen manager. npm can otherwise crash with `Cannot read properties of null (reading 'matches')` while reading another manager's dependency layout ([npm issue](https://github.com/npm/cli/issues/9459)). For example, switching to npm:

```sh
rm -rf node_modules
npm install
```

Keep the repository's `pnpm-lock.yaml`; only the installed dependencies need replacing.

Examples below use npm; you can substitute `pnpm run` or `bun run` for `npm run`.

Open `http://127.0.0.1:4737` for development, or `http://127.0.0.1:4738` after building and starting the server. Choose a harness and model, and send a task. **New task** starts with **No project** selected. To work in an existing folder, use the **+** beside Projects to browse the connected server’s folders or enter a path, then select the project in the composer or sidebar. The model selector reads the installed harness's catalog and also accepts explicit model IDs. Both selections remain visible during work. You can change models between turns in the same native conversation.

The harness picker shows only installed harnesses with authentication configured. Tinycode asks Codex for its account state, Claude Code for its login status, and Pi for its credential-aware model catalog without sending a prompt. After signing in on the server, use **Refresh harnesses** in the picker. Checks do not verify remaining credits or guarantee a provider will accept a request.

Tinycode uses each harness's existing authentication and settings. Your provider's usage limits and charges apply, including the small-model requests used for task names. Stop the server with Ctrl+C when you are done; this interrupts active turns and closes its terminals.

If a native dependency fails to install, use your package manager's verbose output to see the underlying build error: `npm install --foreground-scripts`, `pnpm install --reporter=append-only`, or `bun install --verbose`.

Projectless tasks appear under **Scratchpad** in the sidebar. Each has its own persistent folder at `$TINYCODE_DATA_DIR/workspaces/<task-id>` (under `~/.tinycode` by default), with the same file editor, terminal, harness, and resume support. No Git repository is created automatically. Files remain after closing the task or restarting Tinycode.

The thinking picker beside the model shows the selected level. Available levels come from the installed harness for that model; **Default** inherits harness settings. Change it between turns. Changing models resets thinking to Default.

Task names are generated in the background from the first message, using a small model through the selected harness's credentials. Right-click a task and choose **Rename…** to edit its name or use a suggestion from the conversation. Suggestions never overwrite your input, and saved names survive refreshes. A temporary message-based label remains if naming is unavailable.

Paste images, drop them onto the composer, or use **+** to attach them. Previews sit on an animated shelf above the input, with upload status, removal, and retry. Images can be sent on their own or with text, including in queued or steered messages. Transcript thumbnails appear above your message and open the full image when clicked. PNG, JPEG, WebP, and GIF are supported: up to six images, 5 MB each, and 10 MB per message.

Uploads go to the Tinycode server, so attachments work with a remote server as well as a local one. Image files live in `$TINYCODE_DATA_DIR/images`; only small references travel with queue and transcript updates. Previews use the same authentication as the rest of the app. Unsent composer drafts are browser-local and clear when leaving the task; accepted queue messages and transcript images persist. Unattached uploads older than seven days are pruned at server startup.

For development:

```sh
npm run dev
```

Open `http://127.0.0.1:4737`. Vite proxies to the server on port 4738 by default.

Click the connection status at the bottom of the sidebar to change the **Server URL**, optionally name the connection, and enter its access token. The default is the origin serving the UI, so both the local development proxy and production app work without configuration. **Use default** restores that address. With no custom name, loopback addresses show **Local workspace** and other servers show their hostname. A green dot means the server answered a live heartbeat; Tinycode checks every 15 seconds, gives each check five seconds to respond, and automatically reconnects after failures.

The URL and name are saved in this browser. Tokens are scoped to the server and kept in this tab's session storage, surviving refresh but not closing the tab. Switching reloads the UI and clears unsent drafts; saved tasks and running work stay on their respective servers. Project and model preferences are also kept separately for each server.

### Explorer test page

Run `npm run dev:web` and open `http://127.0.0.1:4737/explorer.html` to try the shared file tree and code/diff viewer with sample data. No server, authenticated harness, or model calls are needed. The page includes modified, added, and deleted files, an editable preview, and a 2,500-file sample. Sample edits stay in memory until reset or reload.

This page is a development test surface. In a task, the conversation remains the main view: open the file panel beside it, select a file or change, drag the divider for more room, or expand the panel temporarily. Restoring the sidebar keeps the current preview. Closing the preview returns to compact file navigation. Both layouts use the same explorer components.

## Remote machine

The smallest setup keeps the server bound to loopback and forwards its port:

```sh
# On the development machine
npm run start

# On your laptop
ssh -L 4738:127.0.0.1:4738 your-server
```

Then open `http://127.0.0.1:4738` on your laptop. Install and authenticate the harnesses on the server, where execution happens.

For a direct listener, supply a long random access token and serve it behind HTTPS or on a trusted private network:

```sh
export TINYCODE_HOST=0.0.0.0
export TINYCODE_TOKEN="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
# If using a reverse proxy, set its browser-facing origin:
export TINYCODE_ORIGIN=https://tinycode.example.com
npm run start
```

Enter the token in the browser when prompted. Remote listeners refuse to start without a token of at least 24 characters. HTTP and WebSocket access require it. The token grants access to the server user's development environment; this is not a multi-user sandbox or a public hosting service. A reverse proxy must forward WebSocket upgrades and the `Sec-WebSocket-Protocol` request header.

### Development behind an authenticated proxy

For a development server behind a reverse proxy that already authenticates users, set the exact browser-facing origin:

```sh
TINYCODE_DEV_ORIGIN=https://dev.example.com npm run dev
```

This explicitly exposes Vite on `0.0.0.0:4737` and admits the configured hostname. Route that origin to port 4737, preserving the request Host and Origin headers and forwarding WebSocket upgrades. The UI, API, images, terminal, and hot reload share the same origin; the backend stays on `127.0.0.1:4738`. Custom public ports are supported. The development URL is printed at startup.

With no Tinycode token, this mode delegates access control to your proxy. It must authenticate every request, including WebSocket connections, and prevent direct access to the listener. Use HTTPS for public access. Tinycode does not detect or trust any hosting provider automatically. Without this setting, development stays on loopback; `npm run start` ignores it and retains the production access controls above.

### Local UI with a directly hosted remote server

Allow the local UI's exact origin on the remote server:

```sh
# On the remote machine, alongside the host/token/origin settings above:
export TINYCODE_ALLOWED_ORIGINS=http://127.0.0.1:4737
npm run start

# On your laptop, from the Tinycode checkout:
npm install
npm run dev:web
```

Open `http://127.0.0.1:4737`, click the sidebar's connection status, and enter `https://tinycode.example.com`, its token, and an optional name. The local UI can run without a local Tinycode backend. All API calls, live updates, terminals, and image uploads/previews use the selected remote server. Harnesses and credentials must be installed on that server.

`TINYCODE_ALLOWED_ORIGINS` accepts comma-separated origins; `http://localhost:4737` and `http://127.0.0.1:4737` are different origins. Paths and wildcards are not accepted, and enabling separate frontend origins requires a token of at least 24 characters, even on loopback. Cross-origin connections use bearer authentication and an authenticated WebSocket handshake rather than third-party cookies. An HTTPS UI requires an HTTPS remote endpoint.

Configuration is read from the server process environment. Tinycode does not automatically load `.env` files. Restart the server after changing these variables.

| Variable                      | Default                                                        |
| ----------------------------- | -------------------------------------------------------------- |
| `TINYCODE_HOST`               | `127.0.0.1`                                                    |
| `TINYCODE_PORT`               | `4738`                                                         |
| `TINYCODE_DATA_DIR`           | `~/.tinycode`                                                  |
| `TINYCODE_TOKEN`              | None for loopback; required for remote binding                 |
| `TINYCODE_ORIGIN`             | Request Host; set the public origin behind a proxy             |
| `TINYCODE_DEV_ORIGIN`         | None; explicit public dev origin behind an authenticated proxy |
| `TINYCODE_ALLOWED_ORIGINS`    | None; comma-separated additional frontend origins              |
| `TINYCODE_CODEX_BIN`          | `codex` on PATH                                                |
| `TINYCODE_CLAUDE_BIN`         | `claude` on PATH                                               |
| `TINYCODE_PI_BIN`             | `pi` on PATH                                                   |
| `TINYCODE_CODEX_TITLE_MODEL`  | Small model from the native catalog, preferring `gpt-5.4-mini` |
| `TINYCODE_CLAUDE_TITLE_MODEL` | `haiku`                                                        |
| `TINYCODE_PI_TITLE_MODEL`     | Small model from the task's provider; accepts `provider/model` |

## Included

- Real streaming conversations with all three harnesses, native session IDs, follow-up turns, and interruption.
- A persistent message queue above the composer. While a task runs, choose Queue for the next turn or Steer for native live input. Drag the left icon to change delivery order, use the pencil to edit text and images in the main composer, or remove a row with the trash button. Save keeps the message's queue position; save/cancel restores your previous composer draft. The focused drag handle also supports Alt + Up/Down. Stop, failure, and restart preserve unsent messages for explicit resumption.
- Searchable native model catalogs, remembered draft selections, and the model reported by each running harness. Logos are bundled from official sources; see [asset attribution](src/client/assets/harnesses/README.md).
- Model-specific thinking levels, remembered for new tasks and saved with existing tasks.
- Codex command/file approval prompts; Claude tool permission prompts; basic Pi extension prompts.
- A permissions picker in the composer, saved per task and editable between turns. Codex supports Ask for approval, Auto-accept edits, Approve for me (native auto review), and Full access. Claude exposes its native manual, edit, auto, plan, pre-approved-only, and bypass modes. Pi offers configured tools, a read/grep/find/ls allowlist, or no tools; these are tool settings, not an OS sandbox. Pi extensions still run. Native rules and managed policies remain authoritative; unavailable modes surface an error rather than silently substituting another mode. See [Claude permissions](https://code.claude.com/docs/en/agent-sdk/permissions) and [Pi's tool options](https://github.com/earendil-works/pi/tree/main/packages/coding-agent#cli-reference).
- New tasks start with workspace edits and explicit escalation for Codex, manual approval for Claude, and configured tools for Pi. Full access is never carried to a different harness or a new task. Tasks created before the picker keep their existing native settings until you select an explicit mode. Permissions control the harness on the connected server; your manual terminal and file-editor actions are separate.
- Provider-reported tool and subagent activity in collapsible rows.
- A quiet transcript with rounded user messages, plain assistant responses, grouped live activity, and a saved “Worked for…” summary for completed turns. Expand groups to inspect individual actions and their raw details.
- Multiple tasks, independently running on the server. Browser disconnects do not cancel work.
- Projectless tasks with separate persistent workspaces, alongside tasks in saved projects.
- Small-model task naming and a right-click rename dialog with conversation-based suggestions. Naming uses separate ephemeral sessions and bounded user/assistant context.
- One persistent shell per task, terminal resize, reconnect, and explicit process close. Hiding its panel leaves the shell alive.
- A lazy, virtualized file tree powered by [Trees](https://trees.software/), plus highlighted file previews and unified/split Git diffs powered by [Diffs](https://diffs.com/). Both load on demand; syntax highlighting runs in a small worker pool. Text files can still be edited and saved explicitly.
- A new Git worktree per task when requested, on a branch you name, based on the current `HEAD`.
- Search, keyboard shortcuts, light/dark themes, and a compact responsive layout.

`⌘/Ctrl K` searches tasks. `⌘/Ctrl J` toggles the terminal. Enter sends a prompt; Shift+Enter inserts a line break.

## Deliberate v0 limits

- Harness settings, authentication, tools, compaction, permissions, and agent execution stay native. Tinycode does not promise feature parity with every native interactive command. Unsupported Codex reverse requests are explicitly declined and surfaced.
- Subagents are a display integration. Tinycode does not create a separate agent orchestrator. Pi subagents depend on installed extensions and the events they expose.
- Non-image attachments, session import, checkpoints, custom plugins, and automated Git workflows are deferred.
- Model catalogs load on demand and are cached for one minute. Tinycode does not silently replace a chosen model when catalog loading fails. Tasks created before model tracking show "Choose model" until selected or reported by the harness on their next turn.
- Shells and active turns survive browser disconnects, **not server restarts**. Restarted work is marked interrupted; the next user message resumes its saved native conversation. There is no automatic retry of a potentially mutating turn.
- Worktrees are retained. There is no automatic branch deletion, dependency installation, `.env` copying, or cleanup. Use normal Git commands when you are finished with one.
- Files and Git status refresh on opening the panel or using Refresh. Text editing is deliberately basic. An optimistic content revision rejects a save when the file changed since opening; this is not an atomic cross-process editor lock.
- Transcript history is paged in windows of 120 rows. Earlier pages are explicit, with a return to the live tail. Terminal reconnect replays the last 128 KiB of bytes; this is not a full terminal-state snapshot and complex fullscreen applications may need redraw.

## Architecture and evidence

The [reference study](docs/references.md) records what we borrowed from bb, Paseo, and T3 Code, and what we deliberately left out.

```text
Browser: React shell + per-row transcript subscriptions + lazy xterm
       │ HTTP commands / WebSocket subscriptions
Node server: tasks + SQLite + native process ownership + filesystem/Git
       ├── Codex app-server (JSONL)
       ├── Claude Agent SDK → installed Claude Code
       └── Pi RPC (JSONL)
```

`src/shared/contracts.ts` is the small wire contract. `src/server/adapters` contains only native integrations. `runtime.ts` owns task execution and coalesces display updates; the harness still owns every agent decision. `src/client/state.ts` keeps token updates scoped to individual rows. Terminal output bypasses React entirely.

```sh
npm run check
npm run build
npm run test:smoke
```

See [validation](docs/validation.md) for the checks actually run and the remaining validation boundary.

## Beta feedback and contributions

Report reproducible bugs with the Tinycode commit, server OS, browser, and harness version. Screenshots help with UI issues; remove tokens, private code, and conversation content first. See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow and [SECURITY.md](SECURITY.md) for private security reports.

## License

[MIT](LICENSE). Fonts, harness logos, and dependencies retain their own terms; see [third-party notices](THIRD_PARTY_NOTICES.md).
