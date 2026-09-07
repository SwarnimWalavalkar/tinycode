import type { Sandbox } from "@cloudflare/sandbox";

export interface Env {
  AGENTS: DurableObjectNamespace;
  SANDBOX: DurableObjectNamespace<Sandbox>;
  DIRECTORY: DurableObjectNamespace;
  ATTACHMENTS: R2Bucket;
  ASSETS: Fetcher;
  TINYCODE_ALLOWED_ORIGINS?: string;
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_GATEWAY_ID?: string;
  TINYCODE_AGENT_TOKEN?: string;
  TINYCODE_DEFAULT_MODEL?: string;
  TINYCODE_MODELS?: string;
}
