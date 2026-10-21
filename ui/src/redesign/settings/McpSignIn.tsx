import { useEffect, useRef, useState } from "react";
import { projectMcpApi, type ProjectMcpApi } from "./mcpApi";
import { pollOAuthSignIn } from "./mcpSession";

const INPUT =
  "h-8 w-full rounded-lg border border-[#ffffff1a] bg-[var(--sf-raised)] px-2.5 font-['Geist_Mono',monospace] text-[13px] text-[var(--sf-text-1)] outline-none focus:border-[#ffffff40]";
const BTN =
  "flex h-8 items-center rounded-lg border border-[#ffffff1a] bg-[var(--sf-raised)] px-3 font-sans text-[13px] font-medium text-[var(--sf-text-1)] disabled:opacity-60";
const LABEL = "font-sans text-xs text-[var(--sf-text-3)]";

/**
 * Sign-in for a server that asks for OAuth. The Host starts the flow and returns a link; the user
 * approves in their own browser and, when that browser cannot reach the Host's callback (Docker,
 * a remote machine), pastes the address it ended on. On a local Host the callback completes the
 * flow by itself, so the dialog also polls (for up to five minutes, and only while it is mounted).
 */
export function McpSignIn({
  name,
  onDone,
  onCancel,
  api = projectMcpApi,
}: {
  name: string;
  onDone: () => void;
  onCancel: () => void;
  api?: Pick<ProjectMcpApi, "oauthStart" | "oauthComplete" | "oauthStatus">;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [pasted, setPasted] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const live = useRef(true);
  const finished = useRef(false);
  // The poll, the paste path and a re-render can all see "signed in"; only the first reports it.
  const done = () => {
    if (finished.current || !live.current) return;
    finished.current = true;
    onDoneRef.current();
  };

  useEffect(() => {
    live.current = true;
    finished.current = false;
    return () => {
      live.current = false;
    };
  }, [name]);

  useEffect(() => {
    let current = true;
    setUrl(null);
    setError(null);
    api.oauthStart(name).then(
      (res) => current && setUrl(res.authorizationUrl),
      (err) => current && setError(err instanceof Error ? err.message : String(err)),
    );
    return () => {
      current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);

  useEffect(() => {
    if (!url) return;
    return pollOAuthSignIn({
      api,
      name,
      onSignedIn: done,
      onTimeout: () => setError("Timed out waiting for sign-in. Finish it with the pasted address, or cancel and start again."),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, url]);

  const finish = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.oauthComplete(name, pasted.trim());
      if (res.status === "authenticated") done();
      else setError("Sign-in did not complete. Start again.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (live.current) setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2.5 border-t border-t-[#ffffff12] bg-[var(--sf-raised)] px-3.5 py-3">
      <span className="font-sans text-[13px] font-medium text-[var(--sf-text-1)]">Sign in to {name}</span>
      {!url && !error ? <span className={LABEL}>Starting sign-in…</span> : null}
      {url ? (
        <>
          <span className={LABEL}>1. Open the sign-in page and approve access.</span>
          <div className="flex gap-2">
            <button type="button" className={BTN} onClick={() => window.open(url, "_blank", "noopener")}>
              Open sign-in page
            </button>
            <button type="button" className={BTN} onClick={() => void navigator.clipboard?.writeText(url)}>
              Copy link
            </button>
          </div>
          <span className={LABEL}>
            2. Your browser may then show a page that cannot be reached (it points at localhost). That is expected: copy
            the full address from the address bar and paste it here.
          </span>
          <input
            className={INPUT}
            aria-label="Address your browser ended on"
            placeholder="http://localhost:…/callback?code=…&state=…"
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
          />
        </>
      ) : null}
      {error ? (
        <p className="font-sans text-[13px] text-[var(--sf-fail)]" role="alert">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <button type="button" className={BTN} disabled={!url || busy || !pasted.trim()} onClick={() => void finish()}>
          {busy ? "Finishing…" : "Finish sign-in"}
        </button>
        <button type="button" className={BTN} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
