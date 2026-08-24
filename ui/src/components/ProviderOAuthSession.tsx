import { useEffect, useRef, useState } from "react";
import {
  fetchProviderLoginSession,
  postProviderLoginAnswer,
  postProviderLoginCancel,
  postProviderOauthLogin,
  type LoginSessionProjection,
  type ProviderAuthStatus,
} from "../api";
import {
  OAUTH_LOOPBACK_CAVEAT,
  OAUTH_PASTE_HINT,
  isTerminalSession,
  latestAuthUrl,
  latestDeviceCode,
  latestInfoLinks,
  latestStatusMessage,
  promptInputKind,
} from "../providers/oauthSession";

const POLL_MS = 500;

export function ProviderOAuthSession({
  providerId,
  providerName,
  onComplete,
  onDismiss,
}: {
  providerId: string;
  providerName: string;
  onComplete: (status: ProviderAuthStatus | undefined, warning?: string) => void;
  onDismiss: () => void;
}) {
  const [session, setSession] = useState<LoginSessionProjection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const startedRef = useRef(false);
  const finishedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void (async () => {
      setBusy(true);
      const result = await postProviderOauthLogin(providerId);
      setBusy(false);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSession(result.session);
    })();
  }, [providerId]);

  useEffect(() => {
    if (!session || isTerminalSession(session)) return;
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const { session: next } = await fetchProviderLoginSession(
            providerId,
            session.id,
          );
          setSession(next);
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        }
      })();
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [providerId, session?.id, session?.status]);

  useEffect(() => {
    if (!session || !isTerminalSession(session) || finishedRef.current) return;
    finishedRef.current = true;
    if (session.status === "completed") {
      onComplete(session.provider, session.warning?.message);
      return;
    }
    if (session.status === "failed") {
      setError(session.error?.message ?? "OAuth login failed");
      return;
    }
    onDismiss();
  }, [session, onComplete, onDismiss]);

  const pending = session?.pendingPrompt;

  useEffect(() => {
    if (!pending) {
      setDraft("");
      setError((prev) =>
        prev === "Enter a value to continue." ? null : prev,
      );
    }
  }, [pending]);

  async function copyText(label: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
      window.setTimeout(() => setCopied(null), 1500);
    } catch {
      setError("Could not copy to clipboard");
    }
  }

  async function onSubmitAnswer() {
    if (!session) return;
    const value = draft.trim();
    if (!value) {
      setError("Enter a value to continue.");
      return;
    }
    setBusy(true);
    setError(null);
    const result = await postProviderLoginAnswer(
      providerId,
      session.id,
      value,
    );
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setDraft("");
    setSession(result.session);
  }

  async function onSelectOption(optionId: string) {
    if (!session) return;
    setBusy(true);
    setError(null);
    const result = await postProviderLoginAnswer(
      providerId,
      session.id,
      optionId,
    );
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setSession(result.session);
  }

  async function onCancel() {
    if (!session) {
      onDismiss();
      return;
    }
    setBusy(true);
    await postProviderLoginCancel(providerId, session.id);
    setBusy(false);
    finishedRef.current = true;
    onDismiss();
  }

  const authUrl = session ? latestAuthUrl(session.events) : undefined;
  const device = session ? latestDeviceCode(session.events) : undefined;
  const statusLine = session ? latestStatusMessage(session.events) : undefined;
  const infoLinks = session ? latestInfoLinks(session.events) : undefined;
  const inputKind = pending ? promptInputKind(pending) : null;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--spacing-2)",
        marginTop: "var(--spacing-2)",
      }}
    >
      <p
        style={{
          margin: 0,
          color: "var(--color-text-secondary)",
          fontSize: "var(--font-size-sm)",
        }}
      >
        Connecting {providerName} with Pi OAuth / subscription login.
      </p>
      {statusLine ? (
        <p className="muted" style={{ margin: 0 }}>
          {statusLine}
        </p>
      ) : null}
      {infoLinks && infoLinks.length > 0 ? (
        <div style={{ display: "flex", gap: "var(--spacing-2)", flexWrap: "wrap" }}>
          {infoLinks.map((link) => (
            <a
              key={link.url}
              className="btn btn--ghost"
              href={link.url}
              target="_blank"
              rel="noreferrer"
            >
              {link.label ?? "Open link"}
            </a>
          ))}
        </div>
      ) : null}
      {authUrl ? (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "var(--spacing-2)",
          }}
        >
          {authUrl.instructions ? (
            <p style={{ margin: 0, fontSize: "var(--font-size-sm)" }}>
              {authUrl.instructions}
            </p>
          ) : null}
          <div style={{ display: "flex", gap: "var(--spacing-2)", flexWrap: "wrap" }}>
            <a
              className="btn btn--primary"
              href={authUrl.url}
              target="_blank"
              rel="noreferrer"
            >
              Open browser
            </a>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => void copyText("url", authUrl.url)}
            >
              {copied === "url" ? "Copied" : "Copy link"}
            </button>
          </div>
          <p
            style={{
              margin: 0,
              color: "var(--color-text-secondary)",
              fontSize: "var(--font-size-sm)",
            }}
          >
            {OAUTH_LOOPBACK_CAVEAT} {OAUTH_PASTE_HINT}
          </p>
        </div>
      ) : null}
      {device ? (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "var(--spacing-2)",
          }}
        >
          <p style={{ margin: 0 }}>
            Device code: <strong>{device.userCode}</strong>
          </p>
          {typeof device.expiresInSeconds === "number" ? (
            <p
              className="muted"
              style={{ margin: 0, fontSize: "var(--font-size-sm)" }}
            >
              Code expires in about {device.expiresInSeconds}s.
            </p>
          ) : null}
          <div style={{ display: "flex", gap: "var(--spacing-2)", flexWrap: "wrap" }}>
            <a
              className="btn btn--primary"
              href={device.verificationUri}
              target="_blank"
              rel="noreferrer"
            >
              Open verification page
            </a>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => void copyText("code", device.userCode)}
            >
              {copied === "code" ? "Copied" : "Copy code"}
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => void copyText("uri", device.verificationUri)}
            >
              {copied === "uri" ? "Copied" : "Copy URI"}
            </button>
          </div>
        </div>
      ) : null}
      {pending && inputKind === "select" ? (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "var(--spacing-2)",
          }}
        >
          <p style={{ margin: 0 }}>{pending.message}</p>
          {(pending.options ?? []).map((option) => (
            <button
              key={option.id}
              type="button"
              className="btn btn--ghost"
              disabled={busy}
              onClick={() => void onSelectOption(option.id)}
            >
              {option.label}
              {option.description ? ` — ${option.description}` : ""}
            </button>
          ))}
        </div>
      ) : null}
      {pending && inputKind !== "select" ? (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "var(--spacing-2)",
          }}
        >
          <p style={{ margin: 0 }}>{pending.message}</p>
          {pending.type === "manual_code" ? (
            <p
              style={{
                margin: 0,
                color: "var(--color-text-secondary)",
                fontSize: "var(--font-size-sm)",
              }}
            >
              {OAUTH_PASTE_HINT}
            </p>
          ) : null}
          <input
            className="input"
            type={inputKind === "password" ? "password" : "text"}
            autoComplete="off"
            placeholder={pending.placeholder ?? ""}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy}
            onClick={() => void onSubmitAnswer()}
          >
            {busy ? "Sending…" : "Continue"}
          </button>
        </div>
      ) : null}
      {error ? (
        <p
          style={{
            margin: 0,
            color: "var(--color-text-red)",
            fontSize: "var(--font-size-sm)",
          }}
        >
          {error}
        </p>
      ) : null}
      <div style={{ display: "flex", gap: "var(--spacing-2)" }}>
        <button
          type="button"
          className="btn btn--ghost"
          disabled={busy}
          onClick={() => void onCancel()}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
