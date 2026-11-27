import { useEffect, useState } from "react";
import {
  acknowledgeControlToken,
  setControlToken,
  subscribeControlTokenRequired,
  verifyControlToken,
  wasControlTokenRequired,
} from "../api/controlToken";

export type AuthHint = { tokenFile: string | null; source?: "env" };

const FALLBACK =
  "The token is in the `control-token` file in the Host's data directory (`~/.stageflow` by default, `/data` in Docker). In Docker, run `docker exec <container> cat /data/control-token`.";

export function ControlTokenInstructions({ hint }: { hint: AuthHint | null }) {
  if (hint?.source === "env") {
    return (
      <p className="font-sans text-xs text-[var(--sf-text-3)]">
        This Host rejected the request. Its token was set by the operator in STAGEFLOW_CONTROL_TOKEN. It stays in this
        browser.
      </p>
    );
  }
  if (hint?.tokenFile) {
    return (
      <>
        <p className="font-sans text-xs text-[var(--sf-text-3)]">
          This Host rejected the request. The token is in this file. It stays in this browser.
        </p>
        <p className="font-['Geist_Mono',monospace] text-[12px] text-[var(--sf-text-2)]">
          cat {hint.tokenFile}
        </p>
      </>
    );
  }
  return (
    <p className="font-sans text-xs text-[var(--sf-text-3)]">{FALLBACK}</p>
  );
}

export function ControlTokenGate() {
  const [open, setOpen] = useState(wasControlTokenRequired);
  const [token, setToken] = useState("");
  const [hint, setHint] = useState<AuthHint | null>(null);
  const [storedRejected, setStoredRejected] = useState(false);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const openGate = (hadStoredToken: boolean) => {
    setToken("");
    setError("");
    setStoredRejected(hadStoredToken);
    setOpen(true);
  };

  useEffect(() => {
    if (wasControlTokenRequired()) openGate(false);
    return subscribeControlTokenRequired(openGate);
  }, []);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void fetch("/api/auth-hint")
      .then((res) => (res.ok ? res.json() : null))
      .then((body: unknown) => {
        if (cancelled) return;
        const tokenFile =
          body !== null &&
          typeof body === "object" &&
          "tokenFile" in body &&
          typeof (body as { tokenFile?: unknown }).tokenFile === "string"
            ? (body as { tokenFile: string }).tokenFile
            : null;
        const source =
          body !== null && typeof body === "object" && (body as { source?: unknown }).source === "env"
            ? ("env" as const)
            : undefined;
        setHint(source ? { tokenFile, source } : { tokenFile });
      })
      .catch(() => {
        if (!cancelled) setHint(null);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-[#0c0d0fcc] p-6">
      <form
        className="flex w-full max-w-md flex-col gap-3 rounded-xl border border-[#ffffff12] bg-[var(--sf-panel)] p-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (submitting) return;
          const trimmed = token.trim();
          if (trimmed.length === 0) {
            setError("Paste the Host's control token.");
            return;
          }
          setError("");
          setSubmitting(true);
          void verifyControlToken(trimmed).then((result) => {
            if (result === "rejected") {
              setError("That token was rejected by the Host.");
              setSubmitting(false);
              return;
            }
            if (result === "unreachable") {
              setError("Could not reach the Host. Check that sf ui is running.");
              setSubmitting(false);
              return;
            }
            setControlToken(trimmed);
            acknowledgeControlToken();
            window.location.reload();
          });
        }}
      >
        <h2 className="font-sans text-[15px] font-semibold text-[var(--sf-text-1)]">
          Control token
        </h2>
        <ControlTokenInstructions hint={hint} />
        {storedRejected ? (
          <p className="font-sans text-xs text-[var(--sf-warn,#e8a838)]">
            The token saved in this browser was rejected. Paste the current token from the Host.
          </p>
        ) : null}
        {error ? (
          <p className="font-sans text-xs text-[var(--sf-danger,#f87171)]" role="alert">
            {error}
          </p>
        ) : null}
        <input
          type="password"
          autoComplete="off"
          autoFocus
          value={token}
          onChange={(event) => {
            setToken(event.target.value);
            if (error) setError("");
          }}
          placeholder="STAGEFLOW_CONTROL_TOKEN"
          className="h-8 rounded-lg border border-[#ffffff1a] bg-[var(--sf-raised)] px-2.5 font-['Geist_Mono',monospace] text-[13px] text-[var(--sf-text-1)] outline-none"
        />
        <button
          type="submit"
          disabled={submitting}
          className="h-8 self-start rounded-lg bg-[#ecedee] px-3 font-sans text-[13px] font-medium text-[#0c0d0f] disabled:opacity-60"
        >
          {submitting ? "Checking…" : "Save and reload"}
        </button>
      </form>
    </div>
  );
}
