# v0 validation

## Beta repository baseline · September 3, 2026

The initial Git snapshot contains source, tests, documentation, the lockfile, and attributed assets. Runtime state, databases, uploads, environment files, dependency caches, and build output are excluded. Reference links point to the studied upstream revisions rather than local clone directories.

A clean export of the staged files was installed with `pnpm install --frozen-lockfile --offline` on macOS arm64, Node 24.12.0, and pnpm 10.33.3. This reused the package cache but had no existing `node_modules`, native build output, Tinycode state, or TypeScript build cache. Native dependency installation and the PTY preparation step passed.

- `pnpm check`: 81 tests passed across 11 files, including 20 permission-mode tests.
- `pnpm build`: passed; initial JavaScript is 276.14 kB, or 88.30 kB gzip-equivalent. Initial CSS is 46.26 kB, or 13.88 kB gzip-equivalent. Terminal, Markdown, file-panel, and font assets remain separate.
- `pnpm test:smoke`: both disposable server checks passed, covering the built UI, authenticated HTTP/WebSocket access, task workspaces, a real PTY, files, Git/worktrees, and binary image upload/preview.
- `pnpm audit`: no known vulnerabilities reported in the locked dependency graph at the time of the check.
- Gitleaks 8.30.1: no secrets found in the source snapshot selected for publication.
- Actionlint 1.7.12: the CI workflow passed validation. It pins actions to commit SHAs, uses read-only permissions, and runs the checks above on Ubuntu with Node 22.19/24 and macOS with Node 24.

These checks send no model prompts. The HTTP smoke servers deliberately use nonexistent harness binary paths and temporary Git repositories, so the checks do not depend on personal harness installations, sessions, or projects. CI has not run on GitHub yet; Linux execution and a real remote HTTPS deployment remain unverified. The earlier native-provider results below are historical observations, not newly rerun beta checks.

The permissions picker persists explicit modes per task and resets to each harness's default for new tasks. Adapter tests cover fresh/resumed sessions, native mode rejection before prompt delivery, legacy inheritance, and changes between turns. Earlier browser checks covered selection, persistence, disabled controls during execution, and mobile layout. Native configuration-only probes confirmed Codex modes, Claude manual/edit/plan/pre-approved/bypass modes, and Pi tool allowlists. Claude auto mode is capability-gated and preflighted with the native harness; it can be unavailable for a model or account.

## Configurable server connection · September 3, 2026

The sidebar connection opens a small URL/name/token dialog. It validates the HTTP bootstrap and authenticated WebSocket heartbeat before saving a change. URL and name persist in local storage; credentials stay in tab session storage, keyed by server URL. Switching reloads the app, drops the previous server's task selection and unsent drafts, and scopes project/model preferences by server. The default remains the current UI origin, preserving the development proxy and single-server production setup.

The connection dot is green only after a matching server heartbeat. Checks run every 15 seconds with a five-second timeout, with another check when returning to the window. Failed/stalled sockets are closed and reconnect through HTTP bootstrap so authentication failures can be recovered. Remote origins must be explicitly allowed with `TINYCODE_ALLOWED_ORIGINS` and a server token. Cross-origin HTTP uses bearer auth; browser WebSockets authenticate through handshake headers without putting tokens in URLs. Image previews fetch authenticated blobs lazily and release them on unmount.

All 61 tests pass, including nine new cases for URL normalization, server-specific credentials/preferences, saved names, WebSocket authentication, origin restrictions, matching heartbeat replies, stale replies, timeouts and timer cleanup. The production build passes with approximately 86 KB gzip of initial JavaScript. Two isolated servers exercised actual cross-origin preflight/authentication, invalid-token rejection without switching, server selection, refresh persistence, remote transcript/queue/editor image previews, clipboard uploads delivered to a controlled adapter, file access, and a real PTY in the selected server's workspace. Suspending the remote process changed the indicator to Disconnected; resuming it automatically restored a green Connected state. No live model prompts were used in these checks.

## Queue editing and reordering · September 3, 2026

Queue rows have tighter spacing, subtle separators, 22 px image previews, pointer drag handles with insertion markers, keyboard reordering (Alt + Up/Down), and individual edit/remove actions. Editing loads text and images in the main composer. Saving updates the existing queue entry without changing its position; saving or cancelling restores the previous unsent composer draft. Attachments can be added or removed while editing.

SQLite persists queue positions and migrates older queues in their existing FIFO order. Runtime dispatch and pending native steering both read that order. Moves target a message ID and insertion anchor rather than replacing a client-side list, so concurrent appends are retained. Editing uses expected text and attachment IDs to reject stale changes, with attachment claims and edits in one transaction. Messages already in delivery cannot be changed; if delivery starts while the editor is open, the composer retains the draft and explains that it was not sent.

All 52 tests pass, including six added cases for actual reordered/edited dispatch, deletion, migration/restart persistence, stale and cross-task requests, native steering in flight, and attachment editing/rollback. Browser checks against an isolated server with controlled adapters covered dragging in both directions, keyboard reordering, main-composer editing, cancel/save draft restoration, pasting an image while editing, retained previews, deletion, refresh, actual next-message delivery, and a delivery/edit race. Light/dark layouts were inspected and browser error logs were empty. Production build passes; initial JavaScript is approximately 84 KB gzip.

## Image attachments · September 3, 2026

Clipboard paste, drag-and-drop, and the attachment button add images to an expanding shelf above the composer. The shelf has immediate local previews, upload state, remove/retry actions, and reduced-motion styling. User transcript thumbnails appear above the rounded message bubble; image-only messages omit the empty bubble. Queue rows retain small previews.

Binary image uploads use the authenticated HTTP connection and persist in the server data directory. Validated IDs and metadata are stored atomically with queue acceptance and copied into the transcript on delivery; base64 data never enters the UI event stream. Codex receives server-local `localImage` inputs, Claude receives base64 image blocks in its SDK stream, and Pi receives native `images` on prompt/steer calls ([Pi protocol](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md)). Each image is limited to 5 MB, messages to six images and 10 MB total. Claimed images survive stop/restart; unused drafts can be removed, and old unattached uploads are pruned on startup.

All 46 tests pass, including five new image cases covering persisted bytes, type/size/path validation, idempotent uploads, transactional claims, image-only sends, queue/steer propagation, restart recovery, and native input formats. `node scripts/image-http-smoke.mjs` passed authenticated upload/preview, cross-origin rejection, upload retry, exact server-side bytes, invalid image rejection, and draft removal. No provider calls are made by that HTTP test.

`node --import tsx scripts/image-smoke.mjs` passed real initial-image recognition and live image steering through Codex and Pi using GPT-5.6 Luna, and Claude using Haiku. All three identified blue/yellow in the first generated image and red/green in the steered image. Browser checks used controlled adapters through the production HTTP/WebSocket/runtime paths and covered real binary clipboard paste, drag-and-drop, file selection, removal, image-only queue/steer, refresh persistence, stop/resume, and light/dark shelf and transcript layouts. Production build passes; initial JavaScript is approximately 82 KB gzip.

## Task naming · September 3, 2026

The first accepted message starts a background naming request through the task's harness, in a separate ephemeral session and empty working directory. A message-based provisional label appears immediately. Small-model selection uses the native catalog (GPT-5.4 Mini preferred for Codex and available Pi providers; Haiku for Claude). Naming never delays the task or changes its native conversation. Pending naming survives restart; a saved manual name invalidates late generated results.

Right-clicking either a project task or a projectless task opens Rename. The compact dialog offers an editable name, a history-based suggestion beneath it, retry, Cancel, and Save. Suggestions use the first user message plus bounded recent user/assistant messages, excluding tool output and thinking. Saving updates labels over WebSocket without changing activity order or unread state.

All 41 tests pass. Seven naming tests cover nonblocking first-message generation, retry deduplication, follow-ups, late-result/manual-name races, bounded history, failures, restart persistence, and small-model selection. The opt-in `node --import tsx scripts/title-smoke.mjs` passed real naming requests with Codex (GPT-5.4 Mini, 4.0s), Claude (Haiku, 2.6s), and Pi (OpenAI Codex GPT-5.4 Mini, 2.7s), each returning a short relevant title.

An isolated browser preview exercised the production HTTP/WebSocket/runtime paths with controlled naming responses: right-click and keyboard entry, typing while a suggestion loads, suggestion failure/retry, applying a suggestion, saving custom names, first-message automatic naming, refresh persistence, and retained unread dots. Light and dark dialogs were visually checked. Production build passes; initial JavaScript is approximately 80 KB gzip.

## Message queue and steering · September 3, 2026

The composer stays usable during a run. Queue/Steer is remembered in the browser; pending messages sit above the input, with individual Steer and Remove actions. SQLite stores the queue in delivery order and request IDs deduplicate retries. Successful turns drain it one message at a time; stopping, failure, or server restart leaves unsent messages for explicit resumption. Unacknowledged steering stays visible with its error and is never silently converted into a new turn.

Codex uses `turn/steer` with the expected native turn ID. Claude uses its open SDK input stream with native delivery behavior and follows queued native continuations before completing. Pi uses its native `steer` RPC and waits for the matching user-message event, including expanded prompt templates; a queue acknowledgement alone does not mean the input was consumed.

All 34 tests pass, covering FIFO delivery, removal, duplicate requests, steering acceptance/completion races, a delayed stop acknowledgement racing a new send, stop/failure/restart preservation, and each adapter's protocol. Short real turns passed steering checks with Codex 0.147.0, Claude Code 2.1.251, and Pi 0.84.4; each returned the revised response. The opt-in check is `node --import tsx scripts/steering-smoke.mjs`.

An isolated browser preview using the production HTTP/WebSocket paths verified queuing with Enter and the send button, per-message steering/removal, the remembered delivery choice, refresh persistence, automatic next-turn delivery, and explicit resumption after Stop. No browser errors were reported. Production build passed; the initial JavaScript bundle is approximately 79 KB gzip.

## Transcript update · September 3, 2026

The transcript groups adjacent tools, reasoning, and subagent events while work runs. A small live timer sits above the turn. Completion collapses intermediate commentary and activity behind a “Worked for…” disclosure, keeping the final response outside. Expanding activity shows individual file reads, searches, edits, and commands; their raw details load only when expanded. User messages are rounded and right-aligned; assistant messages have no bubble, name, or harness icon.

Turn IDs and start/finish times are stored in SQLite and included with transcript pages. The saved duration survives reconnects and follow-up turns, including reused native sessions. Older history without timing shows “Worked”; an unclean restart does not fabricate an end time. Text deltas still notify individual rows, and the live clock rerenders only its own label. Pi now projects its native thinking and text blocks in their original order.

`pnpm check` passes all 23 tests. New coverage includes grouping, preserving final answers and errors, native action labels, partial pages, legacy transcripts, two turns through one native session, final delta flushing, duplicate requests, failed starts, restart timing, and Pi thinking/text projection. An isolated browser run exercised live groups, nested raw output, automatic collapse at completion, keyboard expansion, and reopening the completed work. It used controlled adapter events through the real HTTP/WebSocket/runtime path; no model prompts were sent to providers. The production build passed with about 78 kB gzip-equivalent initial JavaScript.

## Projectless tasks update · September 3, 2026

Tasks can be created with an omitted or null `projectId`, before any project is added. Each receives a persistent `workspaces/<task-id>` folder in the server data directory. Harness adapters and terminals use the saved task directory. Unknown project IDs and projectless worktree requests are rejected.

`pnpm check` passes all 17 tests. The migration check preserves existing transcripts, request receipts, native session identity, selected/reported models, thinking level, and unread state while making the project reference nullable. It also verifies workspace persistence across reopening SQLite, excludes an enclosing Git repository, and recognizes Git initialized inside the task directory.

`node scripts/http-smoke.mjs` passed with temporary server state: projectless task creation for Codex, Claude Code, and Pi, empty-project bootstrap, separate file trees, file editing, invalid project/worktree rejection, and a real PTY starting in the task directory. Existing authenticated HTTP/WebSocket, worktree, and Git checks still pass. No new model turns were submitted; native adapter conversation checks remain the earlier baseline.

Browser checks covered the No project choice, switching away from a worktree selection, sending availability without a project, the Tasks sidebar section, clearing an unread completion on opening it, and the projectless file tree and empty Git panel. The production build passed; initial JavaScript remains about 76 kB gzip-equivalent.

## Thinking picker update · September 3, 2026

The composer has a compact thinking-level picker for new and existing tasks. Options are discovered per model. Codex uses `supportedReasoningEfforts` and passes `effort` on native turns; Claude uses `supportedEffortLevels` and the SDK's `effort` option; Pi queries `get_available_thinking_levels` in an ephemeral process and passes `--thinking` when starting/resuming the task. See the [Codex app-server reference](https://developers.openai.com/codex/app-server), [Claude SDK reference](https://code.claude.com/docs/en/agent-sdk/typescript), and [Pi RPC reference](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md).

All 16 tests pass, including adapter request wiring, native identity retention, task-setting persistence, rejection during active turns, and resetting thinking on model changes. Live metadata queries succeeded for all three installed harnesses. Browser checks covered selecting a level, draft preference persistence after refresh, per-harness options, and a 360 px layout with no horizontal overflow. No new model turns were submitted for these checks. Initial JavaScript remains about 76 kB gzip-equivalent.

## Task attention update · September 3, 2026

Task rows now use a trailing blue dot for unread completions, errors, interrupted work, or pending approval/input. Viewing the latest conversation in a focused, visible browser clears unread activity; pending requests remain until answered. Read acknowledgements persist on the server without changing task order. Existing completed history stays quiet after migration.

`pnpm check` passes all 12 tests. The six new cases cover acknowledgement persistence, repeated status events, metadata changes, stale acknowledgements, pending requests, and migration/restart behavior. An isolated browser instance verified dots on unread tasks, no indicators on running/read tasks, clearing on opening completion/error, persistence after refresh, and a pending-request dot remaining after opening. No model calls were needed for this update. The production build remains about 75 kB gzip-equivalent for initial JavaScript.

## Model selector update · September 3, 2026

The native catalogs were queried successfully for all three installed harnesses without submitting prompts. An opt-in `node scripts/model-smoke.mjs` run then verified explicit model choices through real, short, no-tools turns:

- Codex: selected and reported `gpt-5.6-luna`, then changed to `gpt-5.6-terra`. The native thread ID stayed the same and the second model recalled the first turn's context.
- Claude Code: selected `haiku`; the harness reported `claude-haiku-4-5-20251001`.
- Pi: selected and reported `openai-codex/gpt-5.6-luna`.
- Model changes during active turns were rejected for each harness. Requested and reported models are stored separately; changing the selection clears the previous reported model.

Browser checks covered search and arrow-key/Enter selection, Claude and Pi selection without losing the draft, selection persistence after refresh, model display in an existing conversation, official logo rendering in both themes, and the empty state at 360 px width. The production build and all six automated tests passed after the update. Initial JavaScript including the model picker and bundled logos is about 75 kB gzip-equivalent; CSS is about 6.5 kB.

The script uses the same disposable fixture described below and makes real model calls. The earlier v0 checks below remain the baseline; native session continuation across a model change is now additionally covered for Codex.

## Initial v0 checks

Verified on macOS with Node 24.12.0 and pnpm 10.33.3 on September 2, 2026. These are checks of the current implementation, not a claim of complete native-harness parity.

## Checks run

| Check                     | Result                                                                                                                                                                        |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm check`              | TypeScript checks and all six integration/unit tests passed.                                                                                                                  |
| `pnpm build`              | Production assets built successfully.                                                                                                                                         |
| Real Codex 0.147.0        | Two completed turns through app-server; remembered context and retained its native thread ID.                                                                                 |
| Real Claude Code 2.1.251  | Two completed turns through Agent SDK 0.3.258; remembered context using native session resume.                                                                                |
| Real Pi 0.84.4            | Two completed turns through RPC; remembered context and retained its native session file.                                                                                     |
| Real PTY                  | Shell input/output and resize worked. Reconnecting returned the same PTY and preserved an exported shell variable; explicit close ended it.                                   |
| Production HTTP/WebSocket | Built UI served by Node; unauthorized access rejected; cookie login succeeded; cross-origin requests rejected.                                                                |
| Git/worktree/files        | Created a named branch and isolated worktree, read/edited a file there, and retrieved status/diff. The original checkout stayed unchanged.                                    |
| Browser                   | Opened a project, a real conversation, a live shell, and a text file preview. Switched the compact composer picker among Codex, Claude Code, and Pi without losing the draft. |

The six tests cover path traversal, external symlinks and Git internals, rejecting stale file saves, literal Git filenames, SQLite/native-identity recovery and transcript paging, exact-token authentication, and origin validation. They use temporary directories and real Git/SQLite operations.

The native smoke prompts asked each harness to remember a word, then recall it on a second turn. They explicitly requested no tools. Those checks prove the conversation path and native continuity; they do not exercise file mutations, permission prompts, subagent events, or cancellation in the models.

## Performance boundary

The initial v0 production build's JavaScript was 224.68 kB, or 71.11 kB gzip-equivalent. Initial CSS was 25.79 kB, or 6.29 kB gzip-equivalent. See the update above for current sizes. The Latin font is a separate 36.93 kB asset. These are Vite's bundle measurements, not measured network transfers; the Node server does not add compression.

xterm (73.25 kB gzip-equivalent), Markdown (47.73 kB), and the file panel (1.98 kB) load separately when needed. The display window is bounded to 120 transcript rows; token updates coalesce every 40 ms and notify individual rows; terminal bytes go directly to xterm.

No repeatable latency/CPU benchmark, large-session stress test, Linux execution test, or real remote-network/TLS deployment was run. Those remain the next evidence needed before stronger portability or performance claims.

## Reproduce the checks without model calls

```sh
pnpm check
pnpm build
pnpm test:smoke
```

`test:smoke` starts its own servers on loopback ports 4739 and 4742, creates disposable fixtures, and removes them on completion. No setup project, running Tinycode instance, or authenticated harness is required.

## Reproduce the opt-in native harness checks

`scripts/smoke.mjs` uses authenticated, installed harnesses and makes real model calls. It leaves native sessions and UI tasks for inspection. `terminal-smoke.mjs` then checks shell reconnection against a task created by that fixture without making additional model calls. These scripts are not part of CI.

Prepare an otherwise empty disposable fixture once:

```sh
mkdir -p .tinycode/smoke-project
git -C .tinycode/smoke-project init
printf 'export const hello = "world";\n' > .tinycode/smoke-project/hello.ts
git -C .tinycode/smoke-project add hello.ts
git -C .tinycode/smoke-project -c user.name=Test -c user.email=test@localhost commit -m fixture
pnpm build
TINYCODE_DATA_DIR="$PWD/.tinycode" pnpm dev
```

In another terminal:

```sh
node scripts/smoke.mjs
node scripts/terminal-smoke.mjs
```

The additional `model-smoke.mjs`, `steering-smoke.mjs`, `title-smoke.mjs`, and `image-smoke.mjs` scripts also make real model calls. The sections above describe their scope and invocation. Use disposable data and your own authenticated harness accounts.

Server restart recovery is covered at the SQLite level; resuming all three native harnesses after a server restart has not been separately exercised. Approval UI, harness interruption, and subagent projection need broader real-provider coverage. Terminal replay retains recent bytes rather than a full alternate-screen snapshot. The README records the product limits that follow from this deliberately small implementation.
