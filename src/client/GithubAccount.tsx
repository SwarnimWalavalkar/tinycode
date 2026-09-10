import { useEffect, useState } from "react";
import { Github } from "lucide-react";
import Dialog from "./Dialog";
import { connection, serverFetch, serverUrl } from "./connection";

interface AuthInfo {
  mode: "github" | "token";
  user: { id: string; login: string; name: string; connected: boolean } | null;
}
export function useGithubAuth() {
  const [error, setError] = useState("");
  const [auth, setAuth] = useState<AuthInfo | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let identity: string | null | undefined;
    async function load() {
      try {
        const response = await serverFetch("/api/auth", {
          signal: controller.signal,
          cache: "no-store",
        });
        if (!response.ok) {
          const failure = await response.json().catch(() => null);
          throw new Error(typeof failure?.error === "string" ? failure.error : "Could not load sign-in settings. Check the server configuration and try again.");
        }
        const data = await response.json();
        if (data?.mode !== "github" && data?.mode !== "token") throw new Error("Invalid sign-in settings response.");
        if (!controller.signal.aborted) {
          setError("");
          const nextIdentity = data?.user?.id ?? null;
          if (identity !== undefined && identity !== nextIdentity) {
            location.assign(connection.url);
            return;
          }
          identity = nextIdentity;
          setAuth(
            data?.mode === "github" ? data : { mode: "token", user: null },
          );
        }
      } catch (error) {
        if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "Could not load sign-in settings.");
      }
    }
    void load();
    window.addEventListener("focus", load);
    return () => {
      controller.abort();
      window.removeEventListener("focus", load);
    };
  }, []);
  return { auth, setAuth, error };
}

export function GithubSignIn({ reconnect = false }: { reconnect?: boolean }) {
  return (
    <a className="button github-sign-in" href={serverUrl("/api/auth/github")}>
      <Github size={18} aria-hidden="true" />{" "}
      <span>{reconnect ? "Reconnect GitHub" : "Sign in with GitHub"}</span>
    </a>
  );
}

export default function GithubAccount() {
  const { auth, setAuth } = useGithubAuth();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (auth?.mode !== "github" || !auth.user) return null;
  async function action(path: string, method: string) {
    setBusy(true);
    setError("");
    try {
      const response = await serverFetch(path, { method });
      if (!response.ok)
        throw new Error("Could not update your account. Please try again.");
      if (path === "/api/logout") {
        // Reload clears task data, sockets, and provider state from this account.
        location.assign(connection.url);
      } else setAuth({ ...auth!, user: { ...auth!.user!, connected: false } });
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button
        className="button"
        onClick={() => setOpen(true)}
        aria-label="GitHub account"
      >
        <Github size={15} /> @{auth.user.login}
        {!auth.user.connected && " · Reconnect"}
      </button>
      {open && (
        <Dialog title="GitHub account" onClose={() => setOpen(false)}>
          <p>
            Signed in as <strong>@{auth.user.login}</strong>.
          </p>
          <p>
            {auth.user.connected
              ? "GitHub is connected. Git and the GitHub CLI are ready in all your sandboxes."
              : "Reconnect GitHub to clone private repositories, push commits, and open pull requests."}
          </p>
          <div className="dialog-actions">
            {auth.user.connected ? (
              <button
                className="button"
                disabled={busy}
                onClick={() => void action("/api/auth/github", "DELETE")}
              >
                Disconnect GitHub
              </button>
            ) : (
              <GithubSignIn reconnect />
            )}
            <button
              className="button"
              disabled={busy}
              onClick={() => void action("/api/logout", "POST")}
            >
              Sign out
            </button>
          </div>
          {error && <p className="form-error">{error}</p>}
        </Dialog>
      )}
    </>
  );
}
