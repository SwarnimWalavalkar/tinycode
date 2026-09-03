import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Moon,
  Sun,
  RotateCcw,
  PanelRight,
  ArrowUpRight,
  GitBranch,
  Files as FilesIcon,
} from "lucide-react";
import "@fontsource-variable/jetbrains-mono/wght.css";
import "../style.css";
import Files from "../Files";
import { createSampleWorkspace } from "./fixture";
import "./style.css";

function ExplorerLab() {
  const [theme, setTheme] = useState<"light" | "dark">("dark");
  const [generation, setGeneration] = useState(0);
  const [large, setLarge] = useState(false);
  const [open, setOpen] = useState(true);
  const [start, setStart] = useState<"files" | "changes">("changes");
  const source = useMemo(
    () => createSampleWorkspace(large),
    [generation, large],
  );
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  function reset(tab = start) {
    setStart(tab);
    setOpen(true);
    setGeneration((n) => n + 1);
  }
  return (
    <div className="explorer-lab">
      <header className="lab-header">
        <a href="/" className="lab-brand">
          <img src="/assets/favicon.svg" alt="" />
          tinycode
        </a>
        <span className="lab-divider">/</span>
        <span>Explorer</span>
        <span className="lab-badge">Preview</span>
        <div className="lab-header-actions">
          <label className="lab-dataset">
            Workspace
            <select
              aria-label="Sample workspace"
              value={large ? "large" : "sample"}
              onChange={(e) => {
                setLarge(e.target.value === "large");
                setOpen(true);
              }}
            >
              <option value="sample">Components</option>
              <option value="large">2,500 files</option>
            </select>
          </label>
          <button
            onClick={() => reset()}
            title="Reset sample"
            aria-label="Reset sample"
          >
            <RotateCcw size={15} />
          </button>
          <button
            onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
            aria-label={
              theme === "dark" ? "Switch to light mode" : "Switch to dark mode"
            }
          >
            {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
          </button>
        </div>
      </header>
      <main className="lab-stage">
        <section className="lab-notes">
          <span className="lab-eyebrow">WORKSPACE EXPLORER</span>
          <h1>Room for the details.</h1>
          <p>
            A sample project to try the file tree, code preview, and change
            viewer.
          </p>
          <div className="lab-scenarios">
            <button onClick={() => reset("files")}>
              <FilesIcon size={16} />
              <span>
                Browse files<small>Folders, file icons, code</small>
              </span>
              <Chevron />
            </button>
            <button onClick={() => reset("changes")}>
              <GitBranch size={16} />
              <span>
                Review changes<small>Added, edited, and deleted</small>
              </span>
              <Chevron />
            </button>
          </div>
          <div className="lab-hints">
            <p>
              Open a file to expand the sidebar. Close the preview to make it
              compact again.
            </p>
            <p>
              Drag the divider to resize. Try split view, line wrapping, and
              display options.
            </p>
          </div>
          <span className="lab-local">
            <span />
            Sample data · edits stay on this page
          </span>
          <div className="lab-links">
            <a href="https://trees.software/" target="_blank" rel="noreferrer">
              Trees <ArrowUpRight size={12} />
            </a>
            <a href="https://diffs.com/" target="_blank" rel="noreferrer">
              Diffs <ArrowUpRight size={12} />
            </a>
          </div>
        </section>
        {open ? (
          <Files
            key={`${generation}-${large}`}
            source={source}
            workspaceName="tiny-components"
            theme={theme}
            initialTab={start}
            initialPath={
              start === "changes" ? "src/components/Button.tsx" : undefined
            }
            onClose={() => setOpen(false)}
          />
        ) : (
          <div className="lab-closed">
            <button onClick={() => setOpen(true)}>
              <PanelRight size={18} />
              Open explorer
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
function Chevron() {
  return <span className="lab-chevron">›</span>;
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ExplorerLab />
  </React.StrictMode>,
);
