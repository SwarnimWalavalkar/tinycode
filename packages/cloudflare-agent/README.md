# Tinycode Cloudflare agent

This workspace package is the Cloudflare-hosted execution option shown in Tinycode's harness picker.
It is deliberately split into two durable owners:

```text
Tinycode UI -> Tinycode Node adapter -> Worker -> one DurablePiAgent DO per task
                                                   |
                                                   +-- Pi SDK agent loop + SQLite history
                                                   |
                                                   +-- VM tools -> same-ID Cloudflare Sandbox
```

The Durable Object owns the Pi agent, serialized turns, chunked SQLite conversation state, and the decision to use
the VM. The Sandbox is a separate Cloudflare Container that starts lazily on `vm_start` or `vm_exec`,
sleeps after ten idle minutes, and can be permanently removed with `vm_destroy`. Its filesystem is
ephemeral across that idle sleep; the DO's SQLite conversation history is durable. The model credential
stays in the Worker and is never copied into the Sandbox.

Tinycode accepts only an HTTPS Worker endpoint before attaching the transport token. Canceling or
interrupting a local turn aborts the Pi run, sends `SIGKILL` to the active Sandbox process group, and
waits for process exit and the Durable Object to settle before Tinycode releases the local run. Command
timeouts use the same managed-process path, so they do not leave a buffered `exec()` process running.

## Configure

Install the monorepo from its root, then create Worker secrets:

```sh
pnpm --dir packages/cloudflare-agent exec wrangler secret put TINYCODE_AGENT_TOKEN
pnpm --dir packages/cloudflare-agent exec wrangler secret put OPENAI_API_KEY
```

Edit `TINYCODE_MODELS` and `TINYCODE_DEFAULT_MODEL` in `wrangler.jsonc` if required, then deploy:

```sh
pnpm run deploy:cloudflare
```

Configure the Tinycode Node server with the URL printed by Wrangler and the same transport token:

```sh
export TINYCODE_CLOUDFLARE_AGENT_URL=https://tinycode-cloudflare-agent.example.workers.dev
export TINYCODE_CLOUDFLARE_AGENT_TOKEN=replace-with-the-transport-token
pnpm run dev
```

Refresh harnesses in Tinycode. **Cloudflare** then appears beside Codex, Claude Code, and local Pi.

## Current boundary

Cloudflare tasks are projectless. Their VM filesystem is remote and intentionally is not presented as
the local Tinycode server's project, terminal, or file explorer. The transcript displays every VM tool
call and its result. A future workspace transport can mount the remote Sandbox into those existing UI
surfaces without changing the agent or VM tool interface.

The Sandbox receives no GitHub, package-registry, cloud, or other third-party credentials. Public
network access can clone a public repository; a private clone is unavailable by default. Add a scoped
credential broker or repository provisioning path before enabling that workflow instead of copying the
Worker's model key or long-lived user credentials into the VM.

The initial provider is OpenAI through Pi's provider-neutral agent core. Adding providers belongs in
`models.ts`; adding another VM backend belongs behind the small `VmRuntime` interface in `vm-tools.ts`.
The interface is covered with an in-memory test double as well as the Cloudflare Sandbox adapter, so a
second backend does not need to change the tools or Durable Object.
