import type { Sandbox } from "./sandbox.js";
import type { Accounts } from "./accounts.js";

export interface Env {
  AGENTS: DurableObjectNamespace;
  SANDBOX: DurableObjectNamespace<Sandbox>;
  DIRECTORY: DurableObjectNamespace;
  ACCOUNTS: DurableObjectNamespace<Accounts>;
  ATTACHMENTS: R2Bucket;
  ASSETS: Fetcher;
  TINYCODE_ALLOWED_ORIGINS?: string;
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_GATEWAY_ID?: string;
  TINYCODE_AGENT_TOKEN?: string;
  GITHUB_OAUTH_CLIENT_ID?: string;
  GITHUB_OAUTH_CLIENT_SECRET?: string;
  TINYCODE_AUTH_SECRET?: string;
  TINYCODE_DEFAULT_MODEL?: string;
  TINYCODE_MODELS?: string;
}
