# Tinycode on Cloudflare

This package deploys the existing Tinycode UI and its durable-agent backend together. No Node server
is required for the Cloudflare mode.

```text
Browser -> Worker assets + authenticated API
              |
              +-- TaskDirectory DO: task index, attachment metadata, WebSocket fanout
              |
              +-- one DurablePiAgent DO per task
              |     +-- SQLite: transcript, Pi history, queue, receipts, replay events
              |     +-- alarms: dispatch accepted work, reconcile interrupted runs
              |     +-- Pi agent-core -> AI Gateway -> Workers AI / external model
              |     +-- VM tools -> same-ID Cloudflare Sandbox container
              |
              +-- R2: image attachments
```

The task DO is authoritative, including past conversations. This uses **DO SQLite**, not D1.
The directory is a retryable projection of task state, not another task executor. The browser holds
a disposable view; optionally, the local Node app can proxy the same cloud tasks alongside its local
Codex, Claude Code, and Pi tasks.

## Deploy

Install dependencies from the monorepo root with `pnpm install --frozen-lockfile`.
You need a Cloudflare account with Workers, Durable Objects, R2 and Containers enabled, Wrangler
authentication, and a working Docker engine to build the Sandbox image.

```sh
pnpm --dir packages/cloudflare-agent exec wrangler r2 bucket create tinycode-attachments
pnpm --dir packages/cloudflare-agent exec wrangler secret put TINYCODE_AGENT_TOKEN
pnpm --dir packages/cloudflare-agent exec wrangler secret put CLOUDFLARE_API_TOKEN
pnpm run deploy:cloudflare
```

Choose a random access token of at least 24 characters. If a bucket with this name already exists,
use that bucket or edit the binding in `wrangler.jsonc` before creating one. Edit `TINYCODE_MODELS`
and `TINYCODE_DEFAULT_MODEL` there if required. Set `CLOUDFLARE_ACCOUNT_ID` in its `vars` to your real
32-character Cloudflare account ID. `CLOUDFLARE_GATEWAY_ID` defaults to `default`; create that gateway
in your account or set the slug of an existing one. The deploy command builds the React assets, Worker,
and Sandbox image and applies the DO migrations. Open the printed HTTPS Worker URL and sign in
with the access token. Do not put the model API key into the browser.

This is a **single-user deployment**: its token grants access to every task and attachment. It does
not provide accounts, organizations, per-user authorization, or a public signup flow. Browser login
sets a Secure, HttpOnly, SameSite=Strict cookie derived from the token. Bearer authentication and
authenticated WebSocket subprotocols are also supported. Same-origin access is the default;
`TINYCODE_ALLOWED_ORIGINS` optionally allows additional comma-separated browser origins.

The inference token stays in the trusted Worker/DO environment and is never passed to the Sandbox.
The access token authorizes the Tinycode API; it is not a GitHub or inference credential.

## AI Gateway configuration

All inference, including title suggestions, uses Cloudflare's current account API at
`https://api.cloudflare.com/client/v4/accounts/<account-id>/ai/v1`. There is no direct-provider
fallback and `OPENAI_API_KEY` is no longer used. Set the Worker secret `CLOUDFLARE_API_TOKEN` to a
token scoped to your account with **Account > Workers AI > Read** permission. An AI Gateway-only
management token is not sufficient for this API. This inference secret is separate from both the
browser access token and the credentials Wrangler uses to deploy.

Enable Unified Billing and fund your Cloudflare account for supported external models. Selecting an
external model still sends inference to that provider; selecting a Workers AI model keeps inference
on Cloudflare. See the [AI Gateway REST API](https://developers.cloudflare.com/ai-gateway/usage/rest-api/).

The shipped picker includes `openai/gpt-5.4`, `openai/gpt-5.4-mini`, and
`@cf/openai/gpt-oss-120b`. Existing OpenAI task IDs are preserved but routed through the gateway.
To use only Cloudflare-hosted inference (including naming), set both `TINYCODE_DEFAULT_MODEL` and
`TINYCODE_MODELS` to `@cf/openai/gpt-oss-120b`.

`TINYCODE_MODELS` is the comma-separated allowlist. `TINYCODE_GATEWAY_MODELS` is a JSON string of
explicit capability definitions for models outside Pi's built-in OpenAI catalog, or overrides of
that metadata. Each entry has `id`, `name`, `api` (`openai-responses` or `openai-completions`),
`input` (`["text"]` or `["text","image"]`), `contextWindow`, `maxTokens`, and `thinkingLevels`.
Use canonical `author/model` IDs for external models and `@cf/author/model` IDs for Workers AI.
Only allow models with function/tool calling support. Verify their gateway API and capabilities
before enabling them; not every gateway model is an agent-compatible language model.

The included [GPT OSS preset](https://developers.cloudflare.com/workers-ai/models/gpt-oss-120b/)
uses Chat Completions, text inputs, a 128,000-token context and a conservative 4,096-token output budget.
The Gateway Responses route currently rewrites its tool schema incorrectly. This preset uses
Chat Completions instead and normalizes null assistant tool-call content to an empty string,
which the Gateway requires when replaying tool results. Other Responses models are unchanged.
If you override `TINYCODE_GATEWAY_MODELS` in `.dev.vars`, update this preset's `api` there too.
Its empty `thinkingLevels` leaves model reasoning at its default without advertising unverified
reasoning controls. Other presets can explicitly allow `off`, `minimal`, `low`, `medium`, `high`,
or `xhigh` where supported. Unsupported images are rejected rather than silently dropped.

Response caching is disabled for agent calls using `cf-aig-skip-cache`; review your gateway's logging
and retention settings for sensitive conversations. Pi's local cost estimates are zero placeholders,
not a claim of free inference: Cloudflare's billing/analytics are authoritative for costs.

Upgrade existing deployments by setting the account ID and inference secret before publishing the
new Worker. An old OpenAI key alone will not make the harness ready. No model discovery network call
is made by the health check: readiness means valid configuration, not verified credits or model access.

## Durable execution contract

- Creating a task and submitting a message take client-generated request IDs. A send returns only
  after recording acceptance and arming a persisted alarm. Retries do not execute the same ID twice;
  changed content under the same ID is rejected.
- The DO owns the pending queue, turns, transcript, model history and run state. Closing a tab,
  losing a WebSocket, or shutting down the optional Node proxy does **not** cancel the run.
- Pi's awaited message events persist model history between steps. UI events and materialized rows
  are committed together. Directory publication retries from a persisted outbox.
- Reconnecting subscribes to a consistent snapshot plus subsequent cursor-ordered events. The
  latest 2,000 events support replay; older cursors fall back to a paginated transcript snapshot.
  Large transcript fields and total queued text are bounded to respect SQLite payload limits.
- Accepted, unstarted messages survive reconstruction. A runtime restart **during execution**
  stops any retained command and marks that turn interrupted, preserving saved history and pausing
  queued work. This is not transparent continuation or exactly-once external effects: a command
  may have succeeded before its result was saved. Inspect effects before retrying.
- Explicit Stop aborts Pi and kills the managed Sandbox process group. Undelivered steering remains
  queued. Resume restarts pending delivery; it does not replay the interrupted turn automatically.

Cloud tasks initially receive a message-based name. Rename and model-generated title suggestions
are available through the task menu. No automatic context compaction or cross-task memory is added.

## Optional local UI bridge and legacy migration

To show cloud tasks alongside local harnesses:

```sh
export TINYCODE_CLOUDFLARE_AGENT_URL=https://tinycode-cloudflare-agent.example.workers.dev
export TINYCODE_CLOUDFLARE_AGENT_TOKEN=replace-with-the-same-access-token
pnpm run dev
```

The bridge requires HTTPS. New cloud tasks never enter the local execution queue or transcript
database. Stop old Cloudflare runs before upgrading. On bootstrap, the bridge imports legacy local
cloud transcripts, attachments, submission receipts, and queued messages into their same-ID DOs.
Existing Pi model history is preserved. Imports are retryable; queued work is imported **paused**.
Local originals remain intact as a backup and are no longer used for execution after import.
If import fails, legacy cloud tasks cannot execute until it succeeds. Keep the Worker name and
AGENTS binding when upgrading so existing DO identities remain addressable.

The v1 request-bound run/title endpoints return 410. Upgrade the local app and Worker together.

## VM and product boundaries

The tools are `vm_start`, `vm_exec`, `vm_status`, and `vm_destroy`. A Sandbox starts lazily,
sleeps after ten idle minutes, and can be removed explicitly. Its filesystem is **ephemeral**
across sleep/replacement/destruction; durable conversation storage does not make workspace files
durable. Cloud tasks are projectless, with VM tool calls and results in the transcript. Remote
terminal, file explorer, diff inspection, workspace snapshots and private-repository provisioning
are not implemented.

The Sandbox receives no GitHub, registry or other integration credentials. Public clones work
with public network access; private clones need a separately implemented scoped credential broker
or provisioning mechanism. Pi uses Responses or Chat Completions through AI Gateway for enabled models.
Additional VM implementations belong behind `VmRuntime`; only Cloudflare Sandbox is implemented.

The fully Cloudflare-hosted deployment runs this durable Pi harness. Local Codex/Claude/Pi CLI
execution remains available through the optional Node server, not through Workers.

## Local development and end-to-end testing

`pnpm run dev` still starts the Node-based app. Use `pnpm run dev:cloudflare` for
the standalone Cloudflare UI and durable runtime. It builds the UI once and starts
Wrangler explicitly in local mode, bound to loopback on port 8794. Worker source
changes reload automatically; restart the command after UI changes to rebuild assets.
DO SQLite and R2 data persist under `packages/cloudflare-agent/.wrangler/state` (gitignored).
Containers run on your local Docker engine. No deployment or remote storage is required;
real model calls still go to AI Gateway and consume inference allowance/credits.

### 1. Start without inference credentials

Start Docker Desktop or OrbStack, and use Node >=22.19 with pnpm. From the repo root:

```sh
pnpm install --frozen-lockfile
cp -n packages/cloudflare-agent/dev.vars.example packages/cloudflare-agent/.dev.vars
pnpm run check
pnpm run dev:cloudflare
```

The copy preserves an existing `.dev.vars`; inspect your existing configuration if present.
The template contains only dummy values and is safe to commit. `.dev.vars` is gitignored
and is loaded by Wrangler from the package directory, not the repository root.
See [Cloudflare local variables](https://developers.cloudflare.com/workers/local-development/environment-variables/).

Open **http://localhost:8794** in Chrome and sign in with the template's
`TINYCODE_AGENT_TOKEN` value. Use `localhost` consistently for the browser session.
No real model will run yet. In a second terminal, run `pnpm run test:cloudflare:http`.
This smoke test requires the template's login token and an empty inference token; it
deliberately refuses a model-ready server. It creates test tasks in your local state.

### 2. Enable live inference

In your Cloudflare account, use the `default` AI Gateway (or create a gateway and use
its slug). For the Workers AI free allocation, leave its Workers AI billing on
**Standard**, not prepaid Unified billing. Create an account-scoped API token with
**Account > Workers AI > Read** permission. See the [AI Gateway REST API](https://developers.cloudflare.com/ai-gateway/usage/rest-api/).

Edit `packages/cloudflare-agent/.dev.vars`: replace the dummy account ID with your real
32-character ID and fill `CLOUDFLARE_API_TOKEN`. Keep both model settings restricted to
GPT OSS 120B. Restart `pnpm run dev:cloudflare`. Do not paste the inference token into
the UI, chat, or sandbox. Do not run the credential-free HTTP smoke with this configuration.

### 3. Exercise the real agent path

Create a new Cloudflare task with GPT OSS 120B, then work through this checklist:

1. **Inference:** send `Reply with LOCAL_AGENT_OK without using any tools.` Expect streamed
   text and a completed turn. This proves actual gateway access, unlike the readiness check.
2. **Sandbox:** send `Use vm_start, then vm_exec to run python3 -c 'import platform; print(platform.system()); print(6*7)'. Report the actual output.`
   Expect visible tool calls, Linux, and 42. First startup can take longer while Docker builds/starts.
3. **Filesystem within a running sandbox:** ask it to create `/tmp/tinycode-e2e.txt` with
   `SANDBOX_OK`, then read it in a separate tool call. Expect the same content; this does
   not establish persistence across sandbox destruction or sleep.
4. **Browser disconnect:** ask it to run `sleep 20; echo DETACHED_OK` through `vm_exec`.
   Once execution starts, close the browser tab, leaving Wrangler and Docker running.
   Reopen the same URL after completion. Expect the tool result and completed transcript.
5. **History across runtime restarts:** after the turn finishes, stop Wrangler with Ctrl-C,
   restart the same command, and reopen the task. Expect the saved conversation. Ask a
   follow-up about the earlier result to check restored model context too.
6. **Stop:** request `sleep 60; echo SHOULD_NOT_FINISH` through `vm_exec`, then press Stop
   while it runs. Expect an interrupted/stopped turn, not a successful completion output.
7. **Cleanup:** ask the agent to call `vm_destroy`. Conversation history should remain;
   sandbox files are not guaranteed to remain. Stop Wrangler when done.

Optional crash recovery check: stop Wrangler during a running command and restart it.
The expected contract is an **interrupted** turn and paused pending queue, not automatic
replay of potentially side-effecting work. Local testing does not establish production
eviction timing, placement, remote container cold-start behavior, or operation with your
laptop off. Those require a deployed canary.

GPT OSS 120B is text-only in our preset: skip image-understanding tests. The credential-free
HTTP smoke covers attachment storage separately. Private repository credentials, durable
workspace files, and remote file/diff/terminal UI are not implemented.

If inference fails, inspect the visible error and Gateway dashboard: check account/token
scope for 401/403, model support/configuration for 400, and quota/credits for 429 or billing
errors. Readiness only validates configuration. If sandbox startup fails, check that Docker
is running and inspect the Wrangler terminal. Never include tokens when sharing logs.

## Validate without deploying or calling a model

```sh
pnpm run check
pnpm run build:cloudflare
```

The build is a Wrangler dry-run, including the real Docker image build; it does not deploy.
For the actual local Worker/DO/R2/WebSocket smoke test, leave `CLOUDFLARE_API_TOKEN` unset and use no
real secrets in `.dev.vars`. In one terminal, after building:

```sh
pnpm --dir packages/cloudflare-agent exec wrangler dev --local --port 8794 --inspector-port 9294 --var TINYCODE_AGENT_TOKEN:tinycode-local-smoke-token-not-a-secret --var CLOUDFLARE_ACCOUNT_ID:00000000000000000000000000000000 --persist-to /tmp/tinycode-gateway-smoke
```

In another terminal:

```sh
pnpm run test:cloudflare:http
```

Restart Wrangler with the same persistence directory and run the smoke again. It asserts persisted
history and duplicate receipts, detached alarm dispatch (using a deliberate missing-key failure),
authentication, R2 ownership and socket reconnect. The test only accepts a localhost URL and refuses
to send a prompt if the Worker reports model credentials. A successful real model/tool run in a
deployed Cloudflare environment remains a separate, opt-in end-to-end check.
