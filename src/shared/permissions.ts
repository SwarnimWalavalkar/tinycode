import type { ProviderId } from "./contracts.js";

export type PermissionMode =
  | "read-only"
  | "workspace-write"
  | "auto-review"
  | "full-access"
  | "default"
  | "acceptEdits"
  | "auto"
  | "plan"
  | "dontAsk"
  | "bypassPermissions"
  | "native"
  | "read-only-tools"
  | "no-tools";

export interface PermissionOption {
  id: PermissionMode;
  label: string;
  description: string;
  icon: "ask" | "edit" | "auto" | "read" | "deny" | "full";
}

export const permissionOptions: Record<ProviderId, readonly PermissionOption[]> = {
  codex: [
    {
      id: "read-only",
      label: "Ask for approval",
      description: "Read-only sandbox. Ask before edits and other actions that need more access.",
      icon: "ask",
    },
    {
      id: "workspace-write",
      label: "Auto-accept edits",
      description: "Allow workspace edits. Ask before going beyond the sandbox.",
      icon: "edit",
    },
    {
      id: "auto-review",
      label: "Approve for me",
      description: "Codex reviews requests to go beyond the workspace sandbox.",
      icon: "auto",
    },
    {
      id: "full-access",
      label: "Full access",
      description:
        "No Codex sandbox or approval prompts. Access files and the network on the server.",
      icon: "full",
    },
  ],
  claude: [
    {
      id: "default",
      label: "Ask for approval",
      description: "Ask when an action needs permission under your Claude rules.",
      icon: "ask",
    },
    {
      id: "acceptEdits",
      label: "Auto-accept edits",
      description: "Allow workspace edits and common filesystem commands. Ask for other actions.",
      icon: "edit",
    },
    {
      id: "auto",
      label: "Approve for me",
      description:
        "Claude reviews actions with its native classifier. Requires auto mode availability.",
      icon: "auto",
    },
    {
      id: "plan",
      label: "Plan",
      description: "Explore and plan before making changes. Claude's plan-mode rules apply.",
      icon: "read",
    },
    {
      id: "dontAsk",
      label: "Only pre-approved",
      description: "Deny actions that your Claude rules have not already allowed.",
      icon: "deny",
    },
    {
      id: "bypassPermissions",
      label: "Full access",
      description: "Skip ordinary approval prompts. Claude's enforced rules still apply.",
      icon: "full",
    },
  ],
  pi: [
    {
      id: "native",
      label: "All tools",
      description:
        "Use Pi's configured tools and extension prompts. Pi has no built-in approval gate.",
      icon: "full",
    },
    {
      id: "read-only-tools",
      label: "Read-only tools",
      description:
        "Enable read, grep, find, and ls only. A tool allowlist, not a filesystem sandbox.",
      icon: "read",
    },
    {
      id: "no-tools",
      label: "No tools",
      description: "Start Pi with tools disabled. Extensions still run on the server.",
      icon: "deny",
    },
  ],
  cloudflare: [
    {
      id: "native",
      label: "Managed VM tools",
      description:
        "Run the agent in its Durable Object. It may start and manage its isolated Linux VM on demand.",
      icon: "auto",
    },
  ],
};

export const defaultPermissionMode: Record<ProviderId, PermissionMode> = {
  codex: "workspace-write",
  claude: "default",
  pi: "native",
  cloudflare: "native",
};

export function parsePermissionMode(provider: ProviderId, value: unknown): PermissionMode {
  const option = permissionOptions[provider]?.find((option) => option.id === value);
  if (!option) throw new Error(`Unsupported permissions for ${provider}`);
  return option.id;
}
