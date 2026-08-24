import { useCallback, useEffect, useState } from "react";
import {
  fetchProviderAuth,
  fetchProviders,
  fetchProvidersDetect,
  postCredentialSource,
  postProviderApiKey,
  postProviderLogout,
  type CredentialSource,
  type ProviderAuthStatus,
  type ProviderSummary,
} from "../api";
import { ProviderConnectRow } from "./ProviderConnectRow";
import { PROVIDERS_PI_COPY } from "../providers/helpers";

type StatusMap = Record<string, ProviderAuthStatus | undefined>;

export function SettingsProviders() {
  const [providers, setProviders] = useState<ProviderSummary[]>([]);
  const [statuses, setStatuses] = useState<StatusMap>({});
  const [credentialSource, setCredentialSource] = useState<
    CredentialSource | undefined
  >(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sourceSaving, setSourceSaving] = useState(false);
  const [connectId, setConnectId] = useState<string | null>(null);
  const [oauthId, setOauthId] = useState<string | null>(null);
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [rowWarning, setRowWarning] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    const [listed, detect] = await Promise.all([
      fetchProviders(),
      fetchProvidersDetect(),
    ]);
    setProviders(listed.providers);
    setCredentialSource(detect.credentialSource);
    const next: StatusMap = {};
    await Promise.all(
      listed.providers.map(async (provider) => {
        try {
          const { provider: status } = await fetchProviderAuth(provider.id);
          next[provider.id] = status;
        } catch {
          next[provider.id] = undefined;
        }
      }),
    );
    setStatuses(next);
  }, []);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      try {
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    })();
  }, [refresh]);

  async function onSourceChange(value: string) {
    if (value !== "pi_home" && value !== "sf_owned") return;
    setSourceSaving(true);
    setError(null);
    try {
      const result = await postCredentialSource(value);
      setCredentialSource(result.credentialSource);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSourceSaving(false);
    }
  }

  async function onConnectSubmit(providerId: string) {
    const key = apiKeyDraft.trim();
    if (!key) {
      setRowError("Paste an API key to connect.");
      return;
    }
    setRowBusy(providerId);
    setRowError(null);
    const result = await postProviderApiKey(providerId, key);
    setRowBusy(null);
    if (!result.ok) {
      setRowError(result.error);
      return;
    }
    setApiKeyDraft("");
    setConnectId(null);
    setStatuses((prev) => ({ ...prev, [providerId]: result.provider }));
  }

  async function onDisconnect(providerId: string) {
    setRowBusy(providerId);
    setRowError(null);
    const result = await postProviderLogout(providerId);
    setRowBusy(null);
    if (!result.ok) {
      setRowError(result.error);
      return;
    }
    setStatuses((prev) => ({ ...prev, [providerId]: result.provider }));
  }

  return (
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
        {PROVIDERS_PI_COPY}
      </p>

      <div className="setting">
        <span>
          <strong>Credential source</strong>
          <p>
            Use credentials already stored by Pi, or keep a Stageflow-owned
            store for keys you paste here.
          </p>
        </span>
        {loading ? (
          <span className="muted">—</span>
        ) : (
          <select
            className="select"
            value={credentialSource ?? ""}
            disabled={sourceSaving}
            onChange={(e) => void onSourceChange(e.target.value)}
          >
            <option value="" disabled>
              Not set
            </option>
            <option value="pi_home">Existing Pi login (~/.pi)</option>
            <option value="sf_owned">Stageflow-owned store</option>
          </select>
        )}
      </div>

      {error ? (
        <p
          style={{
            color: "var(--color-text-red)",
            fontSize: "var(--font-size-sm)",
            marginBottom: "var(--spacing-3)",
          }}
        >
          {error}
        </p>
      ) : null}
      {rowError ? (
        <p
          style={{
            color: "var(--color-text-red)",
            fontSize: "var(--font-size-sm)",
            marginBottom: "var(--spacing-3)",
          }}
        >
          {rowError}
        </p>
      ) : null}
      {rowWarning ? (
        <p
          style={{
            color: "var(--color-text-secondary)",
            fontSize: "var(--font-size-sm)",
            marginBottom: "var(--spacing-3)",
          }}
        >
          {rowWarning}
        </p>
      ) : null}

      {loading ? (
        <p className="muted">Loading providers…</p>
      ) : providers.length === 0 ? (
        <p className="muted">No providers reported by Pi.</p>
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
            showDisconnect={true}
            onSetConnecting={(id) => {
              setConnectId(id);
              setRowError(null);
            }}
            onSetOauthing={(id) => {
              setOauthId(id);
              setRowError(null);
              setRowWarning(null);
            }}
            onApiKeyChange={setApiKeyDraft}
            onConnectSubmit={(id) => void onConnectSubmit(id)}
            onDisconnect={(id) => void onDisconnect(id)}
            onOauthComplete={(next, warning) => {
              setOauthId(null);
              setRowWarning(warning ?? null);
              if (next) {
                setStatuses((prev) => ({ ...prev, [provider.id]: next }));
              } else {
                void refresh();
              }
            }}
            onOauthDismiss={() => {
              setOauthId(null);
              setRowError(null);
            }}
          />
        ))
      )}
    </section>
  );
}
