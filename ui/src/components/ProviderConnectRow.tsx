import type { ProviderAuthStatus, ProviderSummary } from "../api";
import { ProviderOAuthSession } from "./ProviderOAuthSession";
import { providerAllowsApiKey, providerOauthOnly, statusLabel } from "../providers/helpers";
import { providerSupportsOauthConnect } from "../providers/oauthSession";

export type ProviderConnectRowProps = {
  provider: ProviderSummary;
  status: ProviderAuthStatus | undefined;
  connecting: boolean;
  oauthing: boolean;
  apiKeyDraft: string;
  rowBusy: boolean;
  showDisconnect: boolean;
  onSetConnecting: (id: string | null) => void;
  onSetOauthing: (id: string | null) => void;
  onApiKeyChange: (value: string) => void;
  onConnectSubmit: (providerId: string) => void;
  onDisconnect: (providerId: string) => void;
  onOauthComplete: (
    status: ProviderAuthStatus | undefined,
    warning?: string,
  ) => void;
  onOauthDismiss: () => void;
};

export function ProviderConnectRow({
  provider,
  status,
  connecting,
  oauthing,
  apiKeyDraft,
  rowBusy,
  showDisconnect,
  onSetConnecting,
  onSetOauthing,
  onApiKeyChange,
  onConnectSubmit,
  onDisconnect,
  onOauthComplete,
  onOauthDismiss,
}: ProviderConnectRowProps) {
  const configured = status?.configured === true;
  const canKey = providerAllowsApiKey(provider);
  const canOauth = providerSupportsOauthConnect(provider);
  const oauthOnly = providerOauthOnly(provider);

  return (
    <div className="setting" key={provider.id}>
      <span>
        <strong>{provider.name}</strong>
        <p>{statusLabel(status)}</p>
        {connecting ? (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "var(--spacing-2)",
              marginTop: "var(--spacing-2)",
            }}
          >
            <input
              className="input"
              type="password"
              autoComplete="off"
              placeholder="API key"
              value={apiKeyDraft}
              onChange={(e) => onApiKeyChange(e.target.value)}
            />
            <div style={{ display: "flex", gap: "var(--spacing-2)" }}>
              <button
                type="button"
                className="btn btn--primary"
                disabled={rowBusy}
                onClick={() => onConnectSubmit(provider.id)}
              >
                {rowBusy ? "Saving…" : "Save key"}
              </button>
              <button
                type="button"
                className="btn btn--ghost"
                disabled={rowBusy}
                onClick={() => {
                  onSetConnecting(null);
                  onApiKeyChange("");
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : null}
        {oauthing ? (
          <ProviderOAuthSession
            providerId={provider.id}
            providerName={provider.name}
            onComplete={onOauthComplete}
            onDismiss={onOauthDismiss}
          />
        ) : null}
      </span>
      <span style={{ display: "flex", gap: "var(--spacing-2)" }}>
        {configured && showDisconnect ? (
          <button
            type="button"
            className="btn btn--ghost"
            disabled={rowBusy || oauthing}
            onClick={() => onDisconnect(provider.id)}
          >
            Disconnect
          </button>
        ) : null}
        {configured && !showDisconnect ? (
          <span className="muted">Connected</span>
        ) : null}
        {canKey && !configured && !oauthing ? (
          <button
            type="button"
            className="btn btn--primary"
            disabled={rowBusy}
            onClick={() => {
              onSetConnecting(provider.id);
              onSetOauthing(null);
              onApiKeyChange("");
            }}
          >
            Connect
          </button>
        ) : null}
        {canOauth && !configured && !connecting && !oauthing ? (
          <button
            type="button"
            className={oauthOnly ? "btn btn--primary" : "btn btn--ghost"}
            disabled={rowBusy}
            onClick={() => {
              onSetOauthing(provider.id);
              onSetConnecting(null);
              onApiKeyChange("");
            }}
          >
            Connect with OAuth
          </button>
        ) : null}
      </span>
    </div>
  );
}
