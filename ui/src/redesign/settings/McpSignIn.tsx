import { useEffect, useRef, useState } from "react";
import {
  completeMcpOAuthSignIn,
  fetchMcpOAuthStatus,
  startMcpOAuthSignIn,
} from "../../api";

const INPUT =
  "h-8 w-full rounded-lg border border-[#ffffff1a] bg-[var(--sf-raised)] px-2.5 font-['Geist_Mono',monospace] text-[13px] text-[var(--sf-text-1)] outline-none focus:border-[#ffffff40]";
const BTN =
  "flex h-8 items-center rounded-lg border border-[#ffffff1a] bg-[var(--sf-raised)] px-3 font-sans text-[13px] font-medium text-[var(--sf-text-1)] disabled:opacity-60";
const LABEL = "font-sans text-xs text-[var(--sf-text-3)]";

/**
 * Sign-in for a server that asks for OAuth. The Host starts the flow and returns a link; the user
 * approves in their own browser and, when that browser cannot reach the Host's callback (Docker,
 * a remote machine), pastes the address it ended on. On a local Host the callback completes the
 * flow by itself, so the dialog also polls.
 */
export function McpSignIn({
  name,
  onDone,
  onCancel,
}: {
  name: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [pasted, setPasted] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => {
    let live = true;
    startMcpOAuthSignIn(name).then(
      (res) => live && setUrl(res.authorizationUrl),
      (err) => live && setError(err instanceof Error ? err.message : String(err)),
    );
    return () => {
      live = false;
    };
  }, [name]);

  useEffect(() => {
    if (!url) return;
    const timer = setInterval(() => {
      fetchMcpOAuthStatus(name).then(
        (res) => {
          if (res.status === "authenticated") done.current();
        },
        () => {},
      );
    }, 2000);
    return () => clearInterval(timer);
  }, [name, url]);

  const finish = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await completeMcpOAuthSignIn(name, pasted.trim());
      if (res.status === "authenticated") done.current();
      else setError("Sign-in did not complete. Start again.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
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
