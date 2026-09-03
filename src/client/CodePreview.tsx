import { useMemo } from "react";
import {
  parseDiffFromFile,
  parsePatchFiles,
  type CodeViewItem,
} from "@pierre/diffs";
import {
  CodeView,
  WorkerPoolContextProvider,
  type CodeViewReactOptions,
} from "@pierre/diffs/react";
import WorkerUrl from "@pierre/diffs/worker/worker.js?worker&url";
import type { PreviewDiff } from "./workspace-source";

const poolOptions = {
  workerFactory: () => new Worker(WorkerUrl, { type: "module" }),
  poolSize: 2,
};
const highlighterOptions = {
  theme: { dark: "pierre-dark", light: "pierre-light" },
} as const;

export interface PreviewSettings {
  wrap: boolean;
  numbers: boolean;
  backgrounds: boolean;
  indicators: "bars" | "classic" | "none";
  inline: "word-alt" | "char" | "none";
}

export default function CodePreview({
  file,
  patch,
  theme,
  split,
  settings,
}: {
  file?: { path: string; content: string; revision: string };
  patch?: PreviewDiff;
  theme: "light" | "dark";
  split: boolean;
  settings: PreviewSettings;
}) {
  const parsed = useMemo((): { items: CodeViewItem[]; note?: string } => {
    if (file)
      return {
        items: [
          {
            id: file.path,
            type: "file",
            file: {
              name: file.path,
              contents: file.content,
              cacheKey: file.revision,
            },
          },
        ],
      };
    if (!patch) return { items: [] };
    try {
      const files =
        patch.oldFile !== undefined || patch.newFile
          ? [parseDiffFromFile(patch.oldFile ?? null, patch.newFile ?? null)]
          : parsePatchFiles(patch.content).flatMap((entry) => entry.files);
      const items: CodeViewItem[] = files.map((fileDiff, i) => ({
        id: `${i}:${fileDiff.name}`,
        type: "diff",
        fileDiff,
      }));
      const note = !files.some((file) => file.hunks.length)
        ? /(?:Binary files|GIT binary patch)/.test(patch.content)
          ? "Binary file changed. No text preview available."
          : patch.content || patch.newFile
            ? "File metadata changed. No changed text lines."
            : "No changes compared with HEAD."
        : undefined;
      return { items, note };
    } catch {
      return {
        items: [],
        note: "This change could not be rendered as a text diff.",
      };
    }
  }, [file, patch]);
  const options = useMemo<CodeViewReactOptions>(
    () => ({
      themeType: theme,
      diffStyle: split ? "split" : "unified",
      diffIndicators: settings.indicators,
      lineDiffType: settings.inline,
      disableBackground: !settings.backgrounds,
      disableLineNumbers: !settings.numbers,
      hunkSeparators: "line-info",
      disableFileHeader: true,
      overflow: settings.wrap ? "wrap" : "scroll",
      layout: { paddingTop: 12, paddingBottom: 12, gap: 0 },
    }),
    [theme, split, settings],
  );
  return (
    <WorkerPoolContextProvider
      poolOptions={poolOptions}
      highlighterOptions={highlighterOptions}
    >
      {parsed.note && <div className="tree-note">{parsed.note}</div>}
      <CodeView
        className="code-preview"
        items={parsed.items}
        options={options}
      />
    </WorkerPoolContextProvider>
  );
}
