import { useEffect, useState } from "react";
import {
  fetchProviderAuth,
  fetchProviders,
  fetchProvidersDetect,
  postCredentialSource,
  postProviderApiKey,
  type CredentialSource,
  type ProviderAuthStatus,
  type ProviderSummary,
} from "../api";
import { ProviderConnectRow } from "../components/ProviderConnectRow";
import {
  PROVIDERS_PI_COPY,
  defaultOfferChoice,
  providerAllowsApiKey,
} from "../providers/helpers";
import { providerSupportsOauthConnect } from "../providers/oauthSession";

export function ProviderConnectPage({
  onComplete,
}: {
  onComplete: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [piHomeUsable, setPiHomeUsable] = useState(false);
  const [choice, setChoice] = useState<CredentialSource>("sf_owned");
  const [phase, setPhase] = useState<"offer" | "keys">("offer");
  const [saving, setSaving] = useState(false);
  const [providers, setProviders] = useState<ProviderSummary[]>([]);
  const [statuses, setStatuses] = useState<
    Record<string, ProviderAuthStatus | undefined>
  >({});
  const [connectId, setConnectId] = useState<string | null>(null);
  const [oauthId, setOauthId] = useState<string | null>(null);
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [rowBusy, setRowBusy] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const detect = await fetchProvidersDetect();
        setPiHomeUsable(detect.piHomeUsable);
        const initial = defaultOfferChoice(detect.piHomeUsable);
        setChoice(initial);
        if (detect.piHomeUsable) {
          setPhase("offer");
        } else {
          setPhase("keys");
          await loadConnectProviders();
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function loadConnectProviders() {
    const listed = await fetchProviders();
    const connectable = listed.providers.filter(
      (p) => providerAllowsApiKey(p) || providerSupportsOauthConnect(p),
    );
    setProviders(connectable);
    const next: Record<string, ProviderAuthStatus | undefined> = {};
    await Promise.all(
      connectable.map(async (provider) => {
        try {
          const { provider: status } = await fetchProviderAuth(provider.id);
          next[provider.id] = status;
        } catch {
          next[provider.id] = undefined;
        }
      }),
    );
    setStatuses(next);
  }

  async function onConfirmOffer() {
    setSaving(true);
    setError(null);
    try {
      await postCredentialSource(choice);
      if (choice === "pi_home") {
        onComplete();
        return;
      }
      await loadConnectProviders();
      setPhase("keys");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function onConnectSubmit(providerId: string) {
    const key = apiKeyDraft.trim();
    if (!key) {
      setError("Paste an API key to connect.");
      return;
    }
    setRowBusy(providerId);
    setError(null);
    try {
      await postCredentialSource("sf_owned");
    } catch (err) {
      setRowBusy(null);
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    const result = await postProviderApiKey(providerId, key);
    setRowBusy(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setApiKeyDraft("");
    setConnectId(null);
    setStatuses((prev) => ({ ...prev, [providerId]: result.provider }));
  }

  const anyConfigured = Object.values(statuses).some((s) => s?.configured);

  return (
    <div className="main__inner">
      <div className="page-head">
        <div>
          <h1>Connect providers</h1>
          <p>{PROVIDERS_PI_COPY}</p>
        </div>
      </div>

      {loading ? (
        <p className="muted">Checking for an existing Pi login…</p>
      ) : null}
      {error ? (
        <p
          style={{
            color: "var(--color-text-red)",
            marginBottom: "var(--spacing-4)",
          }}
        >
          {error}
        </p>
      ) : null}
      {warning ? (
        <p
          style={{
            color: "var(--color-text-secondary)",
            marginBottom: "var(--spacing-4)",
          }}
        >
          {warning}
        </p>
      ) : null}

      {!loading && phase === "offer" ? (
        <section className="card">
          <div className="card__head">
            <h2>Credential source</h2>
          </div>
          <p
            style={{
              margin: 0,
              color: "var(--color-text-secondary)",
              fontSize: "var(--font-size-sm)",
            }}
          >
            {piHomeUsable
              ? "Usable Pi credentials were found on this machine. Reuse them, or set up keys inside Stageflow."
              : "No usable Pi login was detected. Set up credentials in Stageflow."}
          </p>
          <div
            className="theme-picks"
            role="radiogroup"
            aria-label="Credential source"
          >
            <button
              type="button"
              className="theme-pick"
              aria-pressed={choice === "pi_home" ? "true" : "false"}
              disabled={!piHomeUsable}
              onClick={() => setChoice("pi_home")}
            >
              <strong>Use existing Pi login</strong>
              <span>Reuse ~/.pi credentials without re-entering keys</span>
            </button>
            <button
              type="button"
              className="theme-pick"
              aria-pressed={choice === "sf_owned" ? "true" : "false"}
              onClick={() => setChoice("sf_owned")}
            >
              <strong>Set up in Stageflow</strong>
              <span>Paste API keys or complete Pi OAuth in an SF-owned store</span>
            </button>
          </div>
          <div className="form-actions" style={{ marginTop: "var(--spacing-4)" }}>
            <button
              type="button"
              className="btn btn--primary"
              disabled={saving || (!piHomeUsable && choice === "pi_home")}
              onClick={() => void onConfirmOffer()}
            >
              {saving ? "Saving…" : "Continue"}
            </button>
          </div>
        </section>
      ) : null}

      {!loading && phase === "keys" ? (
        <section className="card">
          <div className="card__head">
            <h2>Providers</h2>
          </div>
          <p
            style={{
              margin: 0,
              color: "var(--color-text-secondary)",
              fontSize: "var(--font-size-sm)",
            }}
          >
            Connect at least one provider with an API key or Pi OAuth /
            subscription login.
          </p>
          {providers.length === 0 ? (
            <p className="muted">
              No connectable providers are available from Pi right now.
            </p>
          ) : (
            providers.map((provider) => (
              <ProviderConnectRow
                key={provider.id}
                provider={provider}
                status={statuses[provider.id]}
                connecting={connectId === provider.id}
                oauthing={oauthId === provider.id}
                apiKeyDraft={apiKeyDraft}
                rowBusy={rowBusy === provider.id}
                showDisconnect={false}
                onSetConnecting={setConnectId}
                onSetOauthing={setOauthId}
                onApiKeyChange={setApiKeyDraft}
                onConnectSubmit={(id) => void onConnectSubmit(id)}
                onDisconnect={() => undefined}
                onOauthComplete={(next, warn) => {
                  setOauthId(null);
                  setWarning(warn ?? null);
                  if (next) {
                    setStatuses((prev) => ({ ...prev, [provider.id]: next }));
                  } else {
                    void loadConnectProviders();
                  }
                }}
                onOauthDismiss={() => setOauthId(null)}
              />
            ))
          )}
          <div className="form-actions" style={{ marginTop: "var(--spacing-4)" }}>
            <button
              type="button"
              className="btn btn--primary"
              disabled={!anyConfigured}
              onClick={onComplete}
            >
              Continue to console
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={onComplete}
            >
              Skip for now
            </button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
