import type { TimelineItem, Turn } from "./contracts.js";

export const isActivity = (item: TimelineItem) =>
  item.kind === "tool" || item.kind === "thought" || item.kind === "subagent";

export function transcriptTurns(items: TimelineItem[], turns: Turn[]) {
  const metadata = new Map(turns.map((turn) => [turn.id, turn]));
  const groups: { id: string; turn?: Turn; items: TimelineItem[] }[] = [];
  for (const item of items) {
    const previous = groups.at(-1);
    const id = item.turnId ?? (item.kind === "user" ? item.id : (previous?.id ?? item.id));
    let group = previous;
    if (!group || group.id !== id) {
      group = { id, turn: metadata.get(id), items: [] };
      groups.push(group);
    }
    if (item.kind !== "assistant" || item.text.trim()) group.items.push(item);
  }
  return groups;
}

export function activityGroups(items: TimelineItem[]) {
  const groups: { id: string; activity: boolean; items: TimelineItem[] }[] = [];
  for (const item of items) {
    const previous = groups.at(-1);
    if (isActivity(item) && previous?.activity) previous.items.push(item);
    else groups.push({ id: item.id, activity: isActivity(item), items: [item] });
  }
  return groups;
}

export function completedTurn(items: TimelineItem[]) {
  const lastActivity = items.reduce((last, item, index) => (isActivity(item) ? index : last), -1);
  const work: TimelineItem[] = [];
  const visible: TimelineItem[] = [];
  for (const [index, item] of items.entries()) {
    if (index <= lastActivity && (isActivity(item) || item.kind === "assistant")) work.push(item);
    else visible.push(item);
  }
  return { work, visible };
}

export function workLabel(turn?: Turn) {
  if (!turn?.finishedAt) return turn?.status === "interrupted" ? "Work interrupted" : "Worked";
  const duration = elapsedTime(turn.startedAt, Date.parse(turn.finishedAt));
  return duration ? `Worked for ${duration}` : "Worked";
}

export function elapsedTime(startedAt: string, now: number) {
  const elapsed = now - Date.parse(startedAt);
  if (!Number.isFinite(elapsed) || elapsed < 0) return null;
  const seconds = Math.floor(elapsed / 1000);
  return `${seconds >= 60 ? `${Math.floor(seconds / 60)}m ` : ""}${seconds % 60}s`;
}

export function activityType(item: TimelineItem) {
  if (item.kind === "thought") return "thought";
  if (item.kind === "subagent") return "agent";
  const title = (item.title ?? "").toLowerCase();
  if (/^(read|read_file|readfile)\b|(?:^|[\s'"])(cat|sed|head|tail)\s/.test(title)) return "read";
  if (/^(grep|glob|search|websearch|web_search)\b|(?:^|[\s'"])rg\s/.test(title)) return "search";
  if (/^(ls|list|list_files|listfiles)\b/.test(title)) return "list";
  if (/^(edit|write|multiedit|apply_patch|filechange|write_file)\b/.test(title)) return "edit";
  if (/browser|webfetch|web_fetch/.test(title)) return "browser";
  if (/^(bash|shell|exec_command|commandexecution)\b|^\//.test(title)) return "command";
  return "tool";
}

const labels = {
  read: ["Read files", "Reading files"],
  search: ["Searched", "Searching"],
  list: ["Listed files", "Listing files"],
  edit: ["Edited files", "Editing files"],
  browser: ["Used the browser", "Using the browser"],
  command: ["Ran commands", "Running commands"],
  agent: ["Used subagents", "Running subagents"],
  thought: ["Thought", "Thinking"],
  tool: ["Used tools", "Using tools"],
} as const;

export function activityLabel(items: TimelineItem[], active: boolean) {
  const types = new Map<keyof typeof labels, boolean>();
  for (const item of items) {
    for (const action of activityActions(item))
      types.set(
        action.type,
        Boolean(types.get(action.type) || (active && item.status === "running")),
      );
  }
  return [...types]
    .map(([type, running], index) => {
      const label = labels[type][running ? 1 : 0];
      return index === 0 ? label : label.toLowerCase();
    })
    .join(", ");
}

export interface ActivityAction {
  type: keyof typeof labels;
  label: string;
  target?: string;
  path?: string;
}
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;
const filename = (path: string) => path.split(/[\\/]/).at(-1) || path;

export function activityActions(item: TimelineItem): ActivityAction[] {
  let detail: Record<string, unknown> = {};
  try {
    detail = record(JSON.parse(item.detail ?? "{}"));
  } catch {}
  if (Array.isArray(detail.commandActions) && detail.commandActions.length) {
    return detail.commandActions.map((value) => {
      const action = record(value);
      const path = text(action.path);
      switch (action.type) {
        case "read":
          return {
            type: "read",
            label: "Read",
            target: text(action.name) ?? (path && filename(path)),
            path,
          };
        case "listFiles":
          return { type: "list", label: "Listed files in", target: path ?? ".", path };
        case "search":
          return {
            type: "search",
            label: `Searched${text(action.query) ? ` for ${text(action.query)}` : ""}${path ? " in" : ""}`,
            target: path,
            path,
          };
        default:
          return {
            type: "command",
            label: "Ran",
            target: text(action.command) ?? text(detail.command) ?? item.title,
          };
      }
    });
  }
  if (detail.type === "fileChange" && Array.isArray(detail.changes) && detail.changes.length) {
    return detail.changes.map((value) => {
      const path = text(record(value).path);
      return { type: "edit", label: "Changed", target: path && filename(path), path };
    });
  }
  const type = activityType(item);
  const input = record(detail.input ?? detail.args ?? detail);
  const path = text(input.file_path) ?? text(input.path);
  const query = text(input.pattern) ?? text(input.query);
  const command = text(input.command) ?? text(input.cmd);
  switch (type) {
    case "read":
      return [{ type, label: path ? "Read" : "Read files", target: path && filename(path), path }];
    case "edit":
      return [
        { type, label: path ? "Edited" : "Edited files", target: path && filename(path), path },
      ];
    case "search":
      return [
        {
          type,
          label: `Searched${query ? ` for ${query}` : ""}${path ? " in" : ""}`,
          target: path,
          path,
        },
      ];
    case "list":
      return [{ type, label: "Listed files in", target: path ?? ".", path }];
    case "command":
      return [{ type, label: "Ran", target: command ?? item.title }];
    case "thought":
      return [{ type, label: "Thinking" }];
    case "agent":
      return [{ type, label: item.title ?? "Subagent activity" }];
    default:
      return [{ type, label: item.title ?? "Tool activity" }];
  }
}
