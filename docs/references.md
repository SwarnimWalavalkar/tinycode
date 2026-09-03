# What Tinycode takes from its references

Tinycode is a browser interface around existing coding harnesses. Its first proof is small: useful work through three harnesses, a browser that can disconnect without stopping work, and an interface that stays responsive during output. The server must be equally usable on a laptop or a remote development machine.

This study uses the local snapshots below. Claims describe those revisions, not an independently refreshed upstream release.

| Reference | Studied revision                           | Strongest contribution                                              |
| --------- | ------------------------------------------ | ------------------------------------------------------------------- |
| bb        | `cef44aeb13e2d4bc545e2de22d89eebf52d9efc8` | Provider boundaries and explicit compatibility contracts            |
| Paseo     | `fa1f01ebbcce84b3e8e27ef4f2b3473d5d7b5a33` | Client-independent execution and reconnect behavior                 |
| T3 Code   | `70cd258d8aac43ea57494527b00bf36de3efa6c0` | A conversation-centered workspace with review and terminal surfaces |

## bb: preserve the harness contract

BB's project picker offers "Don't work in a project". Internally it uses a hidden personal-project row and provisions a persistent `personal-workspaces/<environment-id>` folder on the selected host, without creating a worktree or running project setup scripts. Tinycode borrows the optional-project UX and per-task folder, using a nullable project reference because it has no separate environment registry. Projectless tasks live under **Scratchpad**, and each uses `workspaces/<task-id>` on the server. The global **New task** action starts without a project; project headings still start tasks in that project.

Sources: [`NewThreadComposer.tsx`](https://github.com/get-bb/bb/blob/cef44aeb13e2d4bc545e2de22d89eebf52d9efc8/apps/app/src/components/promptbox/NewThreadComposer.tsx), [`thread-default-policy.ts`](https://github.com/get-bb/bb/blob/cef44aeb13e2d4bc545e2de22d89eebf52d9efc8/apps/server/src/services/threads/thread-default-policy.ts), [`worktree-paths.ts`](https://github.com/get-bb/bb/blob/cef44aeb13e2d4bc545e2de22d89eebf52d9efc8/apps/server/src/services/threads/worktree-paths.ts), and [`provision.ts`](https://github.com/get-bb/bb/blob/cef44aeb13e2d4bc545e2de22d89eebf52d9efc8/packages/host-workspace/src/provision.ts).

The interesting part of bb is the separation between a provider bridge and the process runtime. Callers ask to start a thread, run a turn, and receive events. A bridge owns the native wire format. Application and provider thread identifiers remain distinct. Start/resume must return a native identity; an asynchronous identity notification cannot substitute for a successful construction result. Startup and process failures reject the relevant operation rather than leaving a fictional live session behind.

Its native integrations deliberately use different mechanisms: Codex app-server, Claude's SDK, and Pi RPC. A plugin-delivered declaration carries capabilities; runtime code does not infer them from a provider name. The parity corpus includes resume, interruptions, permission requests, subagents, and crash cases. This is more valuable than pretending there is one universal agent API.

The interface groups tool activity and separates a thread's conversation from secondary surfaces. Its streaming Markdown implementation separates settled text from the unfinished tail, including fence/list boundaries. That illustrates how apparently small rendering decisions can dominate streaming responsiveness.

For transcript activity, the supplied Codex App screenshots set the visual target: plain assistant text, rounded user messages, a quiet elapsed-time divider, and flat action lists inside expandable groups. BB's `packages/thread-view/src/timeline-row-title.ts` also distinguishes captured durations from untimed historical work. Its generated Codex `CommandAction` contract exposes structured reads, file listings, searches, and other commands; Tinycode uses those native actions for readable rows instead of trying to parse every shell command.

Managed worktrees have explicit provisioning and lifecycle contracts: tracked checkout first, optional local file copying, setup completion before dispatch, teardown during destruction. Copying respects tracked files and symlinks. Cleanup, however, is deliberately powerful: bb can force-remove a worktree and stop processes inside it. Tinycode v0 does not adopt automatic cleanup.

**Take:** native identities, small adapters, honest capability differences, explicit process ownership, collapsed tool details, contract tests, checkout/worktree separation.

**Defer:** provider plugins, a marketplace, API parity across several clients, host-daemon splitting, setup/teardown machinery, force cleanup, and a generalized provider grammar. They are mature-product investments, not prerequisites for this proof.

Source trail:

- [`packages/agent-runtime/README.md`](https://github.com/get-bb/bb/blob/cef44aeb13e2d4bc545e2de22d89eebf52d9efc8/packages/agent-runtime/README.md)
- [`docs/provider-bridge-protocol.md`](https://github.com/get-bb/bb/blob/cef44aeb13e2d4bc545e2de22d89eebf52d9efc8/docs/provider-bridge-protocol.md)
- [`plugins/provider-codex/src/bridge/app-server-connection.ts`](https://github.com/get-bb/bb/blob/cef44aeb13e2d4bc545e2de22d89eebf52d9efc8/plugins/provider-codex/src/bridge/app-server-connection.ts)
- [`plugins/provider-claude-code/src/bridge/session-options.ts`](https://github.com/get-bb/bb/blob/cef44aeb13e2d4bc545e2de22d89eebf52d9efc8/plugins/provider-claude-code/src/bridge/session-options.ts)
- [`plugins/provider-pi/src/bridge/rpc-child.ts`](https://github.com/get-bb/bb/blob/cef44aeb13e2d4bc545e2de22d89eebf52d9efc8/plugins/provider-pi/src/bridge/rpc-child.ts)
- [`streaming-markdown-split.ts`](https://github.com/get-bb/bb/blob/cef44aeb13e2d4bc545e2de22d89eebf52d9efc8/apps/app/src/components/thread/timeline/streaming-markdown-split.ts)
- [`docs/worktrees.md`](https://github.com/get-bb/bb/blob/cef44aeb13e2d4bc545e2de22d89eebf52d9efc8/docs/worktrees.md)
- Visual: `assets/app-screenshot.png`.

## Paseo: the browser is an attachment

Paseo's execution model is the most useful starting point for portability. A daemon manages agents in the machine's real development environment. Web, desktop, phone, and CLI clients attach to that owner. The native harness supplies tools, settings, skills, and credentials; the interface doesn't become a replacement agent.

The agent manager distinguishes subscribers from sessions and persistence handles. Resume reconstructs the native session, with timeline hydration treated separately. Its Pi runtime shares a bounded JSONL process transport and exposes Pi's actual prompt, abort, model, and extension-UI commands. The distinction between accepting a prompt and completing a turn is explicit.

Terminal lifecycle is equally deliberate: a stream controller subscribes/unsubscribes independently from the terminal process, handles snapshot/output/restore separately, and discards stale attachment results. Leaving a screen is not a command to kill its shell. The rendering code also treats scroll anchoring as a contract: history insertion must not cause a user reading old output to jump to the live tail.

Paseo's web timeline has a hybrid history window: a mounted recent tail and virtualized older rows. Its tests cover terminal retention, reconnect, alternate screens, keystroke stress, and provider subagents. These are useful examples of testing the consumer path instead of merely mocking a successful provider call.

Its composer keeps the provider/model selector in a quiet toolbar trigger: a glyph, the selected name, and a caret, with a transparent resting background. Tinycode uses one combined control with named harness tabs and searchable native model lists. The selected harness and model remain visible. The supplied Codex App reference informs the empty state: a small centered question and a composer at the bottom, without a marketing hero or suggestion cards.

**Take:** server-owned execution, attach/detach semantics, native persistence handles, independent terminal byte handling, bounded history, and testing disconnects with real processes.

**Defer:** mobile applications, voice, pairing, encrypted relays, multi-host aggregation, native terminal renderers, and a public SDK. Tinycode selects its remote host through the sidebar connection settings or by opening the server's URL.

Source trail:

- [`README.md`](https://github.com/getpaseo/paseo/blob/fa1f01ebbcce84b3e8e27ef4f2b3473d5d7b5a33/README.md)
- [`agent-manager.ts`](https://github.com/getpaseo/paseo/blob/fa1f01ebbcce84b3e8e27ef4f2b3473d5d7b5a33/packages/server/src/server/agent/agent-manager.ts)
- [`providers/pi/cli-runtime.ts`](https://github.com/getpaseo/paseo/blob/fa1f01ebbcce84b3e8e27ef4f2b3473d5d7b5a33/packages/server/src/server/agent/providers/pi/cli-runtime.ts)
- [`providers/pi/runtime.ts`](https://github.com/getpaseo/paseo/blob/fa1f01ebbcce84b3e8e27ef4f2b3473d5d7b5a33/packages/server/src/server/agent/providers/pi/runtime.ts)
- [`providers/claude/query.ts`](https://github.com/getpaseo/paseo/blob/fa1f01ebbcce84b3e8e27ef4f2b3473d5d7b5a33/packages/server/src/server/agent/providers/claude/query.ts)
- [`terminal-stream-controller.ts`](https://github.com/getpaseo/paseo/blob/fa1f01ebbcce84b3e8e27ef4f2b3473d5d7b5a33/packages/app/src/terminal/runtime/terminal-stream-controller.ts)
- [`web-virtualization.ts`](https://github.com/getpaseo/paseo/blob/fa1f01ebbcce84b3e8e27ef4f2b3473d5d7b5a33/packages/app/src/agent-stream/web-virtualization.ts)
- [`combined-model-selector.tsx`](https://github.com/getpaseo/paseo/blob/fa1f01ebbcce84b3e8e27ef4f2b3473d5d7b5a33/packages/app/src/components/combined-model-selector.tsx)
- Visual: `packages/website/public/hero-mockup.png`.

## T3 Code: make the work easy to inspect

T3's product structure is useful: a project/task sidebar, a central conversation, visible task status, reviewable changes, and optional terminal surfaces. The screenshot gives output and changed files room without turning the application into an editor with a chat sidebar. Tinycode borrows this hierarchy while using a quieter palette and fewer persistent controls.

The server is the execution boundary. Its authenticated RPC subscriptions serve shell metadata separately from a selected thread. Driver instances and adapters separate native provider behavior from application operations. Capability declarations explicitly describe unsupported operations instead of faking them.

Its event-sourced orchestration is careful: command receipts, serialized dispatch, and event/projection writes in one transaction, with notification after commit. That complexity buys durable retries and recoverable workflows across a much larger product. Tinycode needs the lesson—persist accepted work and keep UI projections honest—without adopting reactors and a command bus in v0.

Terminal rendering is particularly relevant. T3's server owns PTYs and sends raw bytes. The web terminal's Ghostty/WASM canvas operates outside React's frame loop. The specific renderer is less important to Tinycode than keeping its byte stream and rendering out of React state. Tinycode uses the established xterm renderer and defers custom WASM.

**Take:** conversation-centered layout, visible status, adjacent diffs, lazy secondary panes, native adapter boundaries, scoped subscriptions, and terminal rendering outside React.

**Defer:** Effect RPC and a shared multi-client runtime, event-sourced orchestration, checkpoint refs/revert orchestration, custom Ghostty builds, provider catalog refresh infrastructure, and multi-environment authorization scopes.

Source trail:

- [`docs/internals/overview.md`](https://github.com/pingdotgg/t3code/blob/70cd258d8aac43ea57494527b00bf36de3efa6c0/docs/internals/overview.md)
- [`docs/internals/providers.md`](https://github.com/pingdotgg/t3code/blob/70cd258d8aac43ea57494527b00bf36de3efa6c0/docs/internals/providers.md)
- [`ProviderAdapter.ts`](https://github.com/pingdotgg/t3code/blob/70cd258d8aac43ea57494527b00bf36de3efa6c0/apps/server/src/provider/Services/ProviderAdapter.ts)
- [`docs/architecture/terminal-renderers.md`](https://github.com/pingdotgg/t3code/blob/70cd258d8aac43ea57494527b00bf36de3efa6c0/docs/architecture/terminal-renderers.md)
- [`apps/web/package.json`](https://github.com/pingdotgg/t3code/blob/70cd258d8aac43ea57494527b00bf36de3efa6c0/apps/web/package.json)
- Visual: `apps/marketing/public/updated-screenshot.webp`.

## The resulting cut

The sidebar borrows the references' separation of unread activity from execution status: Paseo's `agent-manager.ts` creates attention on completion/error transitions; T3's `Sidebar.logic.ts` distinguishes unread completion from the ready state; bb's `plugin-sidebar-threads.ts` separates pending interactions from unread results. Tinycode uses a small trailing spinner while running and a blue dot for unread results or pending requests. Viewing clears unread events; pending-request indicators remain until answered. Completed tasks have no persistent checkmark.

One TypeScript project. One Node server. One React/Vite client. SQLite stores tasks and their display transcripts; harnesses keep their native sessions. JSON HTTP commands and a small WebSocket stream are enough. There is no LLM SDK for reasoning, tool registry, injected agent prompt, subagent scheduler, or model router.

Three native adapters are worth their small maintenance cost because converting everything into an artificial common protocol would either hide native behavior or recreate part of a harness. Claude uses the [official Agent SDK](https://code.claude.com/docs/en/agent-sdk/typescript) as a control interface to Claude Code. Codex and Pi speak their own documented native protocols. The adapter's job ends at translation and lifecycle.

Performance choices are concrete: initial JavaScript stays below 100 KB gzip, terminal and Markdown code are lazy, transcript pages contain at most 120 items, token updates coalesce every 40 ms and notify only the affected row, and terminal bytes never enter React state. These are v0 boundaries, not claims that responsiveness at every workload has already been proven.

The next decision should follow hands-on use: does this surface feel better than switching between three CLIs? Do people need richer native controls first, or better review/file interactions? A plugin system is not the next validation step.
