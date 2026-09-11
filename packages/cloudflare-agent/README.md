# Tinycode on Cloudflare

## OpenCode Go

In the durable agent's model picker, choose **Connect OpenCode Go**, paste an API
key from the [OpenCode console](https://opencode.ai/auth), and save. New tasks select
GLM 5.3 Flash; GLM 5.3 and DeepSeek V4 Flash are also available. Existing tasks keep
their model until you change it in the picker. **Manage OpenCode Go** lets you replace
or disconnect the key. Saving stores the key; the first inference request verifies
that OpenCode accepts it and that subscription usage is available.

This uses the existing GitHub account and `TINYCODE_AUTH_SECRET` configuration below.
Keys are AES-GCM encrypted with account-and-provider binding in the Accounts DO.
Only connection status reaches the browser; keys never enter task history or sandbox
environment variables. Each model call loads the owner's current key, so replacing
or disconnecting it applies to subsequent calls, including resumed tasks. Requests
already sent can finish. Title generation uses the task's Go model and account too.

Calls go directly to `https://opencode.ai/zen/go/v1/chat/completions` with Tinycode's
own user-agent and a stable task session header. There is no automatic switch to
Cloudflare or another paid provider when Go rejects a request. OpenCode's own
**Use balance** setting can charge the user's Zen balance after subscription limits;
users manage that in their OpenCode console. See the [Go documentation](https://opencode.ai/docs/go/).

## GitHub sign-in and repository access

Configure one **GitHub OAuth App** for this deployment (not a GitHub App installation):

1. Register the OAuth App in GitHub developer settings. Set its homepage to your
   Tinycode origin and its authorization callback to
   `https://YOUR-TINYCODE-HOST/api/auth/github/callback`.
2. Configure these Worker secrets from the monorepo root:

   ```sh
   pnpm --dir packages/cloudflare-agent exec wrangler secret put GITHUB_OAUTH_CLIENT_ID
   pnpm --dir packages/cloudflare-agent exec wrangler secret put GITHUB_OAUTH_CLIENT_SECRET
   pnpm --dir packages/cloudflare-agent exec wrangler secret put TINYCODE_AUTH_SECRET
   ```

   Use a randomly generated value of at least 32 characters for `TINYCODE_AUTH_SECRET`
   (for example, generate one with `openssl rand -hex 32`). It encrypts the retained
   GitHub credentials. Keep it stable; changing it without migrating stored credentials
   requires users to reconnect. Never put credentials in chat, the browser bundle, or Git.
3. Deploy the Worker and sandbox image using the normal deployment command below.
   The `v3` migration creates the `Accounts` SQLite Durable Object.
4. Open the hosted Tinycode website and choose **Sign in with GitHub**. GitHub asks
   for `repo` and `workflow` permissions. The flow also requests `offline_access`;
   expiring grants refresh automatically, while non-expiring grants are supported.

Sign-in creates a Tinycode account keyed by the stable GitHub user ID and routes it
to a personal workspace (`personal-github-ID`). The workspace owns the task directory,
attachments, and WebSocket subscriptions. Conversations use server-generated stable
IDs, with Agent DO names `task:ID`; client creation IDs are workspace-local retry keys.
Each agent retains `{ workspaceId, createdBy, githubAccountId }`. Its GitHub identity
is fixed to the creator's connected account at creation, independent of later messages.
All subsequent sandboxes inherit that connection automatically. There is no identity
picker, membership system, or sharing UI in this iteration.

These workspace namespaces replace the unshipped user-scoped OAuth task namespaces;
pre-change local OAuth test conversations are not migrated. Legacy token-mode task
addresses remain unchanged. Users can run:

```sh
git clone https://github.com/OWNER/PRIVATE-REPO.git
cd PRIVATE-REPO
git switch -c feat/my-change
# edit files and run tests
git add .
git commit -m "feat: implement change"
git push -u origin HEAD
gh pr create --title "Implement change" --body "Description and validation"
```

`git` and `gh` authenticate as the user. Commit author and committer defaults use
that user's name and GitHub noreply email. Common GitHub SSH remote forms are
rewritten to HTTPS automatically. Branch protections and organization OAuth/SSO
policies still apply. Basic clone/fetch/push and GitHub repository/PR APIs are the
supported paths; private archive downloads, release-asset uploads, Git LFS downloads, and GitHub Enterprise hosts are not
implemented in this iteration.

The sandbox receives only a placeholder `GH_TOKEN`, never the real token. Trusted
Cloudflare outbound handlers identify the sandbox owner and inject credentials into
GitHub Git transport and supported API requests. The private account DO stores
AES-GCM-encrypted credentials, coalesces refreshes, and clears revoked connections.
It does not automatically retry writes. After an interrupted push or PR creation,
inspect GitHub before retrying: durable transcripts do not make external effects
exactly once.

The sidebar's GitHub account button provides disconnect/reconnect and sign-out.
Disconnect removes Tinycode's stored grant; the user can also revoke the OAuth App
in GitHub settings. Sign-out revokes the current browser session and closes that
user's live sockets; it does not stop background tasks or disconnect GitHub. Browser
sessions last 30 days. Account mode uses the hosted site's same-origin cookies and
is not supported through the legacy deployment-token Node bridge.

When any GitHub auth setting is present, all three settings are required and the
shared deployment token is **not** accepted. With all three absent, the original
single-user token mode remains available for local development and existing installs.
Existing token-mode tasks remain in the legacy namespace; they are not assigned to
an arbitrary GitHub user. This iteration does not migrate those tasks.

Workspace files remain ephemeral. This feature adds durable accounts, ownership,
and credentials, **not workspace persistence**.

For local OAuth testing, register a separate OAuth App with callback
`http://localhost:8794/api/auth/github/callback`, set these three values in `.dev.vars`,
and use the local server directly. Keep them absent when running the token-mode
HTTP smoke test. With dummy GitHub settings, `TINYCODE_SMOKE_URL=http://localhost:8794
node scripts/cloudflare-auth-smoke.mjs` checks the local OAuth redirect and auth gate
without contacting GitHub. Unit tests mock GitHub; they do not prove live provider behavior.
A deployment canary should sign in with two accounts, verify task/image/socket
isolation, and exercise private clone, commit, push, PR creation, another new
sandbox, disconnect, and reconnect. Test token renewal with an expiring grant.

## Automatic deployment

`.github/workflows/deploy-cloudflare.yml` deploys production on pushes to `main`
that change `packages/cloudflare-agent/**` or the deployment workflow. It can also
be run manually from GitHub Actions on `main`. UI-only or shared-code-only changes
outside this package do not trigger it; use the manual run when needed.

Add the repository Actions secret `CLOUDFLARE_DEPLOY_API_TOKEN` using a dedicated,
account-scoped Cloudflare token authorized to deploy Workers and Containers,
including uploading images to the container registry. An inference-only token
is not sufficient. The workflow reads the account ID from `wrangler.jsonc`.
Do not copy the local Wrangler OAuth token into GitHub.

Each run installs locked dependencies, runs the application and agent checks,
then builds and deploys the hosted UI, Worker, and sandbox image. Production
deployments are serialized and are not canceled mid-rollout. Existing Worker
secrets are retained; the application access token and inference credential are
not uploaded or changed by this workflow. The final check verifies public UI
routing and the API authentication gate, not an inference or VM task.

This package deploys the existing Tinycode UI and its durable-agent backend together. No Node server
is required for the Cloudflare mode.

```text
Browser -> Worker assets + GitHub session (or legacy deployment-token API)
              |
              +-- Accounts DO: users, encrypted GitHub grants, sessions, OAuth state
              +-- TaskDirectory DO per workspace: task index, attachment metadata, WebSocket fanout
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

Use a strong random access token. The cloud runtime requires a non-empty token but does not enforce a minimum length. Short or guessable tokens expose all sessions and billable agent tools to anyone who guesses them. If a bucket with this name already exists,
use that bucket or edit the binding in `wrangler.jsonc` before creating one. Edit `TINYCODE_MODELS`
and `TINYCODE_DEFAULT_MODEL` there if required. Set `CLOUDFLARE_ACCOUNT_ID` in its `vars` to your real
32-character Cloudflare account ID. `CLOUDFLARE_GATEWAY_ID` defaults to `default`; create that gateway
in your account or set the slug of an existing one. The deploy command builds the React assets, Worker,
and Sandbox image and applies the DO migrations. Open the printed HTTPS Worker URL and sign in
with the access token. Do not put the model API key into the browser.

Without GitHub OAuth configured, this is a **single-user deployment**: its token grants access to every task and attachment. Token mode does
not provide accounts or per-user authorization. Use GitHub sign-in above for user accounts. Browser login
sets a Secure, HttpOnly, SameSite=Strict cookie derived from the token, with a signed seven-day
expiry checked by the server. Upgrading from the pre-release cookie format requires signing in again. Bearer authentication and
authenticated WebSocket subprotocols are also supported. Same-origin access is the default;
`TINYCODE_ALLOWED_ORIGINS` optionally allows additional comma-separated browser origins.

AI Gateway payload logging is disabled by request header; metadata logging may remain enabled.

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

The shipped picker includes GPT OSS 20B (the budget default) and GPT OSS 120B,
all hosted on Workers AI. Existing OpenAI task IDs are preserved but routed through the gateway when explicitly enabled.
To use only Cloudflare-hosted inference (including naming), set both `TINYCODE_DEFAULT_MODEL` and
`TINYCODE_MODELS` to `@cf/openai/gpt-oss-120b`.

Model capabilities are a typed catalog in `src/gateway.ts`; native OpenAI metadata comes
from the pinned Pi SDK. `TINYCODE_MODELS` selects the allowed IDs and
`TINYCODE_DEFAULT_MODEL` selects the default. To add another model, add its verified
tool-calling protocol, input types, limits and thinking levels to the catalog.

The included [GPT OSS preset](https://developers.cloudflare.com/workers-ai/models/gpt-oss-120b/)
uses Chat Completions, text inputs, a 128,000-token context and a conservative 4,096-token output budget.
Workers AI streaming can lose tool-call boundaries or terminate without a final answer.
The GPT OSS transport requests complete Chat Completions and adapts their typed results to Pi's
existing parser. Results arrive per model step, not token by token. Tool execution and the
agent loop remain in Pi; no tool calls are inferred from thought text. Other models are unchanged.
`TINYCODE_GATEWAY_MODELS` is no longer read. Remove old overrides from `.dev.vars`,
`wrangler.jsonc`, or production environments; GPT OSS always uses the checked-in Completions preset.
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

## Optional local UI bridge

To show cloud tasks alongside local harnesses:

```sh
export TINYCODE_CLOUDFLARE_AGENT_URL=https://tiny-durable-agent.example.workers.dev
export TINYCODE_CLOUDFLARE_AGENT_TOKEN=replace-with-the-same-access-token
pnpm run dev
```

The bridge requires HTTPS. New cloud tasks never enter the local execution queue or transcript
database. The pre-release local-cloud importer has been removed; old local records remain
read-only in their original database. Existing cloud-authoritative DO conversations are unchanged.
Keep the Worker name and AGENTS binding when upgrading so DO identities remain addressable.
Upgrade the local app and Worker together: health and model discovery now use `/api/health`
and `/api/models`.

## VM and product boundaries

The tools are `vm_start`, `vm_exec`, `vm_status`, and `vm_destroy`. A Sandbox starts lazily,
with Node, Git, Python 3, pip, and venv available in the image. Its stable sandbox name encodes
the full Durable Object identity in base36 to fit the Sandbox SDK's 63-character limit.
It sleeps after ten idle minutes, and can be removed explicitly. Its filesystem is **ephemeral**
across sleep/replacement/destruction; durable conversation storage does not make workspace files
durable. Cloud tasks are projectless, with VM tool calls and results in the transcript. Remote
terminal, file explorer, diff inspection, and workspace snapshots are not implemented. GitHub-connected users can clone private repositories directly.

The Sandbox receives no real GitHub credentials. GitHub account mode injects them outside the
VM through outbound handlers; token mode supports public clones only. Registry and other integration
credentials are not provisioned. Pi uses Responses or Chat Completions through AI Gateway for enabled models.
Additional VM implementations belong behind `VmRuntime`; only Cloudflare Sandbox is implemented.

Foreground commands use the image's Python supervisor, not SDK process records. It caps each
output stream at 128 KiB, checks an absolute deadline, and kills/reaps the process group before
acknowledging cancellation. Commands cannot leave ordinary background children running. A
delayed startup sees the cancellation marker and cannot execute cancelled work. Control RPCs
have a six-second deadline; a failed acknowledgement leaves recovery pending, not a false success.
Small control records expire after five minutes; command output is never written to them.
This is process lifecycle management, not a security boundary against commands that deliberately
escape their process group or tamper with the supervisor. Old in-flight SDK commands without a
supervisor ID fail closed on upgrade; stop old runs before upgrading.

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
HTTP smoke covers attachment storage separately. Live private-repository access needs a configured GitHub OAuth connection. Durable
workspace files and remote file/diff/terminal UI are not implemented.

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
