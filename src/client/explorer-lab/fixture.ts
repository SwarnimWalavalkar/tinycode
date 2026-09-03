import type { WorkspaceEntry } from "../../shared/contracts";
import type { WorkspaceSource } from "../workspace-source";

const button = `import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Spinner } from "./Spinner";
import "../../styles/components.css";

type ButtonVariant = "primary" | "secondary" | "quiet";
type ButtonSize = "small" | "medium";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  leadingIcon?: ReactNode;
  children: ReactNode;
}

const variantClasses: Record<ButtonVariant, string> = {
  primary: "button-primary",
  secondary: "button-secondary",
  quiet: "button-quiet",
};

const sizeClasses: Record<ButtonSize, string> = {
  small: "button-sm",
  medium: "button-md",
};

/** A small, accessible action for the workspace. */
export function Button({
  variant = "primary",
  size = "medium",
  loading = false,
  leadingIcon,
  children,
  className = "",
  disabled,
  ...props
}: ButtonProps) {
  const classes = [
    "button",
    variantClasses[variant],
    sizeClasses[size],
    className,
  ].filter(Boolean).join(" ");

  return (
    <button
      {...props}
      className={classes}
      disabled={disabled}
      aria-busy={loading}
    >
      {leadingIcon}
      <span className="button-label">{children}</span>
    </button>
  );
}
`;
const updatedButton = button
  .replace('"small" | "medium"', '"small" | "medium" | "large"')
  .replace(
    '  medium: "button-md",',
    '  medium: "button-md",\n  large: "button-lg",',
  )
  .replace("disabled={disabled}", "disabled={disabled || loading}")
  .replace("aria-busy={loading}", "aria-busy={loading || undefined}")
  .replace("{leadingIcon}", "{loading ? <Spinner size={16} /> : leadingIcon}");

const base: Record<string, string> = {
  ".github/workflows/check.yml":
    "name: Check\non: [push, pull_request]\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: npm install\n      - run: npm test\n",
  ".gitignore": "node_modules/\ndist/\n.env.local\n",
  "package.json":
    '{\n  "name": "tiny-components",\n  "version": "0.1.0",\n  "private": true,\n  "scripts": { "dev": "vite", "build": "vite build" }\n}\n',
  "README.md":
    "# Tiny components\n\nSmall building blocks for a calmer workspace.\n\n## Development\n\nInstall dependencies and run the development server.\n\n## Components\n\n- Button\n- Card\n- Spinner\n",
  "src/components/Button.tsx": button,
  "src/components/Card.tsx":
    'import type { ReactNode } from "react";\n\nexport function Card({ children }: { children: ReactNode }) {\n  return <section className="card">{children}</section>;\n}\n',
  "src/components/Spinner.tsx":
    'export function Spinner({ size = 16 }: { size?: number }) {\n  return <span role="status" aria-label="Loading" style={{ width: size, height: size }} className="spinner" />;\n}\n',
  "src/components/LegacyButton.tsx":
    'export const LegacyButton = () => <button className="old-button">Continue</button>;\n',
  "src/hooks/useDebounce.ts":
    'import { useEffect, useState } from "react";\n\nexport function useDebounce<T>(value: T, delay = 250) {\n  const [settled, setSettled] = useState(value);\n  useEffect(() => {\n    const timer = setTimeout(() => setSettled(value), delay);\n    return () => clearTimeout(timer);\n  }, [value, delay]);\n  return settled;\n}\n',
  "src/lib/utils/classes.ts":
    'export const classes = (...values: (string | false | undefined)[]) =>\n  values.filter(Boolean).join(" ");\n',
  "styles/components.css":
    ".button {\n  display: inline-flex;\n  align-items: center;\n  gap: 8px;\n  border-radius: 6px;\n  transition: background 150ms ease;\n}\n\n.button-primary {\n  background: #fafafa;\n  color: #171717;\n}\n\n.button:disabled {\n  opacity: 0.5;\n}\n",
  "docs/getting-started.md":
    "# Getting started\n\nKeep the interface small. Give the work room to breathe.\n",
  "public/mark.svg":
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">\n  <rect x="4" y="4" width="10" height="10" rx="2" fill="#da987a"/>\n  <rect x="16" y="16" width="12" height="12" rx="2" fill="#da987a"/>\n</svg>\n',
  "empty.txt": "",
};

export function createSampleWorkspace(large = false): WorkspaceSource {
  const files = {
    ...base,
    "src/components/Button.tsx": updatedButton,
    "styles/components.css": base["styles/components.css"]
      .replace("6px", "8px")
      .replace("0.5", "0.45"),
    "src/components/Badge.tsx":
      'import type { ReactNode } from "react";\n\nexport function Badge({ children }: { children: ReactNode }) {\n  return <span className="badge">{children}</span>;\n}\n',
    "styles/tokens.css":
      ":root {\n  --space-1: 4px;\n  --space-2: 8px;\n  --space-3: 12px;\n  --radius: 8px;\n}\n",
  } as Record<string, string>;
  delete files["src/components/LegacyButton.tsx"];
  if (large)
    for (let n = 0; n < 2500; n++)
      files[`src/generated/Module${String(n).padStart(4, "0")}.ts`] =
        `export const moduleId = ${n};\n`;
  const read = (path: string) => {
    if (!(path in files)) throw new Error("File not found");
    return { path, content: files[path], revision: files[path] };
  };
  return {
    async tree(path) {
      const prefix = path ? path.replace(/\/$/, "") + "/" : "";
      const entries = new Map<string, WorkspaceEntry>();
      for (const file of Object.keys(files)) {
        if (!file.startsWith(prefix)) continue;
        const rest = file.slice(prefix.length);
        const name = rest.split("/")[0];
        entries.set(name, {
          name,
          path: prefix + name,
          type: rest.includes("/") ? "directory" : "file",
        });
      }
      return [...entries.values()].sort(
        (a, b) =>
          Number(b.type === "directory") - Number(a.type === "directory") ||
          a.name.localeCompare(b.name),
      );
    },
    async file(path) {
      return read(path);
    },
    async git() {
      return {
        isGit: true,
        branch: "ui/refinements",
        files: [...new Set([...Object.keys(base), ...Object.keys(files)])]
          .filter(
            (path) =>
              base[path] !== files[path] && !path.startsWith("src/generated/"),
          )
          .map((path) => ({
            path,
            status: !(path in files) ? " D" : !(path in base) ? "??" : " M",
          })),
      };
    },
    async diff(path) {
      const { parseDiffFromFile } = await import("@pierre/diffs");
      const oldFile =
        path in base ? { name: path, contents: base[path] } : null;
      const newFile =
        path in files ? { name: path, contents: files[path] } : undefined;
      const parsed = parseDiffFromFile(oldFile, newFile ?? null);
      const stats = { added: 0, removed: 0 };
      for (const hunk of parsed.hunks)
        for (const part of hunk.hunkContent) {
          if (part.type === "change") {
            stats.added += part.additions;
            stats.removed += part.deletions;
          }
        }
      return { content: "", oldFile, newFile, stats };
    },
    async save(file, content) {
      if (files[file.path] !== file.revision)
        throw new Error("This file has changed. Reopen it before saving.");
      files[file.path] = content;
      return read(file.path);
    },
  };
}
