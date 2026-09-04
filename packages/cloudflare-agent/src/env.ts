import type { Sandbox } from "@cloudflare/sandbox";

export interface Env {
  AGENTS: DurableObjectNamespace;
  SANDBOX: DurableObjectNamespace<Sandbox>;
  OPENAI_API_KEY?: string;
  TINYCODE_AGENT_TOKEN?: string;
  TINYCODE_DEFAULT_MODEL?: string;
  TINYCODE_MODELS?: string;
}
