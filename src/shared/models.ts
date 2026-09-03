/** Compact labels for native IDs when a harness does not supply a display name. */
export function modelLabel(id: string): string {
  return id
    .split("/")
    .at(-1)!
    .replace(/^claude-/, "")
    .replace(/^gpt-/, "GPT ")
    .replace(/-\d{8}$/, "")
    .replace(/(\d)-(\d)(?=\[|$)/, "$1.$2")
    .replace(/\[1m\]/, " (1M)")
    .replace(/-/g, " ")
    .replace(
      /\b(opus|sonnet|haiku|fable|sol|terra|luna|codex|spark)\b/gi,
      (word) => word[0].toUpperCase() + word.slice(1),
    );
}
