import { useCallback, useEffect, useState } from "react";
import {
  fetchProviderAuth,
  fetchProviders,
  fetchProvidersDetect,
  postProviderApiKey,
  postProviderLogout,
  type ProviderAuthStatus,
  type ProviderSummary,
  type ProvidersDetectResult,
} from "../api";
import { ProviderConnectRow } from "./ProviderConnectRow";
import { PROVIDERS_PI_COPY } from "../providers/helpers";

type StatusMap = Record<string, ProviderAuthStatus | undefined>;

export function SettingsProviders() {
  const [providers, setProviders] = useState<ProviderSummary[]>([]);
  const [statuses, setStatuses] = useState<StatusMap>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connectId, setConnectId] = useState<string | null>(null);
  const [oauthId, setOauthId] = useState<string | null>(null);
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [rowWarning, setRowWarning] = useState<string | null>(null);
  const [cursorDetect, setCursorDetect] = useState<
    Pick<
      ProvidersDetectResult,
      "cursorSdkReady" | "cursorApiKeyConfigured"
    > | null
  >(null);

  const refresh = useCallback(async () => {
    setError(null);
    const [listed, detect] = await Promise.all([
      fetchProviders(),
      fetchProvidersDetect(),
    ]);
    setCursorDetect({
      cursorSdkReady: detect.cursorSdkReady,
      cursorApiKeyConfigured: detect.cursorApiKeyConfigured,
    });
    setProviders(listed.providers);
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
      ) : (
        <>
          <div className="setting">
            <span>
              <strong>Cursor (SDK)</strong>
              <br />
              <span className="muted">
                For <code>cursor/…</code> models (not a Pi provider login).{" "}
                <code>pi-cursor-sdk</code> ships with the Stageflow npm package; set{" "}
                <code>CURSOR_API_KEY</code> on the Host process.
              </span>
            </span>
            <span className="muted">
              {cursorDetect?.cursorSdkReady &&
              cursorDetect?.cursorApiKeyConfigured
                ? "Connected"
                : cursorDetect?.cursorSdkReady
                  ? "API key missing on Host"
                  : cursorDetect?.cursorApiKeyConfigured
                    ? "SDK not found"
                    : "Not connected"}
            </span>
          </div>
          {providers.length === 0 ? (
            <p className="muted">No Pi providers reported.</p>
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
        </>
      )}
    </section>
  );
}
