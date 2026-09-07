import type { AdapterContext, AdapterSession } from "./types.js";

/** Cloud tasks must be routed through CloudAuthority, never the local Runtime. */
export async function createCloudflare(_context: AdapterContext): Promise<AdapterSession> {
  throw new Error("Cloudflare tasks are cloud-owned. Refresh Tinycode to import legacy history and use the cloud API.");
}
