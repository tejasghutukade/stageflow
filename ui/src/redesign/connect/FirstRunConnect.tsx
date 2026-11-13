import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  fetchProviderAuth,
  fetchProviders,
  fetchProvidersDetect,
  postCredentialSource,
  postProviderApiKey,
  type ProviderAuthStatus,
  type ProviderSummary,
} from "../../api";
import { ProviderOAuthSession } from "../../components/ProviderOAuthSession";
import { providerAllowsApiKey, statusLabel } from "../../providers/helpers";
import { providerSupportsOauthConnect } from "../../providers/oauthSession";
import {
  browserSignInLabel,
  connectStart,
} from "../settings/providerActionsModel";
import { notifyProvidersChanged } from "../shell/useProviderSummary";
import { firstRunBlurb, partitionFirstRunProviders } from "./firstRunProviders";
import {
  LuCheck,
  LuChevronDown,
  LuChevronRight,
  LuKey,
  LuSearch,
} from "react-icons/lu";

type StatusMap = Record<string, ProviderAuthStatus | undefined>;

export function FirstRunConnect({
  onComplete,
  preview = false,
}: {
  onComplete: () => void;
  /** Show the unconnected first-run screen without reading or writing saved keys. */
  preview?: boolean;
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [providers, setProviders] = useState<ProviderSummary[]>([]);
  const [statuses, setStatuses] = useState<StatusMap>({});
  const [connectId, setConnectId] = useState<string | null>(null);
  const [oauthId, setOauthId] = useState<string | null>(null);
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [othersOpen, setOthersOpen] = useState(false);
  const [otherSearch, setOtherSearch] = useState("");
  const otherSearchRef = useRef<HTMLInputElement>(null);

  async function loadConnectProviders() {
    const listed = await fetchProviders();
    const connectable = listed.providers.filter(
      (provider) =>
        providerAllowsApiKey(provider) || providerSupportsOauthConnect(provider),
    );
    setProviders(connectable);
    const next: StatusMap = {};
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
    return next;
  }

  useEffect(() => {
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        if (!preview) {
          const detect = await fetchProvidersDetect();
          if (detect.credentialSource === undefined) {
            await postCredentialSource("sf_owned");
          }
        }
        const next = await loadConnectProviders();
        if (preview) {
          const cleared: StatusMap = {};
          for (const id of Object.keys(next)) cleared[id] = undefined;
          setStatuses(cleared);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    })();
  }, [preview]);

  useEffect(() => {
    if (othersOpen) otherSearchRef.current?.focus();
  }, [othersOpen]);

  const { featured, other } = useMemo(
    () => partitionFirstRunProviders(providers),
    [providers],
  );
  const othersVisible = featured.length === 0 || othersOpen;
  const filteredOther = useMemo(() => {
    const query = otherSearch.trim().toLowerCase();
    if (!query) return other;
    return other.filter(
      (provider) =>
        provider.id.toLowerCase().includes(query) ||
        provider.name.toLowerCase().includes(query),
    );
  }, [other, otherSearch]);

  const connected = providers.filter(
    (provider) => statuses[provider.id]?.configured === true,
  );
  const anyConfigured = connected.length > 0;

  function remember(providerId: string, status: ProviderAuthStatus | undefined) {
    setStatuses((prev) => ({ ...prev, [providerId]: status }));
    if (status?.configured && !preview) notifyProvidersChanged();
  }

  async function onConnectSubmit(providerId: string) {
    const key = apiKeyDraft.trim();
    if (!key) {
      setError("Paste an API key to connect.");
      return;
    }
    if (preview) {
      setError(null);
      setApiKeyDraft("");
      setConnectId(null);
      remember(providerId, {
        providerId,
        configured: true,
        authKind: "api_key",
      });
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
    remember(providerId, result.provider);
  }

  function openConnect(provider: ProviderSummary) {
    setError(null);
    setWarning(null);
    const start = connectStart({
      canKey: providerAllowsApiKey(provider),
      canOauth: providerSupportsOauthConnect(provider),
    });
    if (start === "key") {
      setConnectId(provider.id);
      setOauthId(null);
      setApiKeyDraft("");
    } else     if (start === "oauth") {
      if (preview) {
        setWarning("Browser sign-in is off in this preview.");
        return;
      }
      setOauthId(provider.id);
      setConnectId(null);
      setApiKeyDraft("");
    }
  }

  return (
    <div className="absolute inset-0 flex min-h-0 flex-col overflow-hidden bg-[var(--sf-ground)]">
      <header className="flex h-14 shrink-0 items-center border-b border-b-[#ffffff12] px-8">
        <span className="font-sans text-[11px] font-medium uppercase tracking-[0.88px] text-[var(--sf-text-3)]">
          First run
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-8 pb-8 pt-8">
        <div className="mx-auto flex w-full max-w-[720px] flex-col gap-8">
          <div className="flex flex-col gap-2">
            {preview ? (
              <p className="font-sans text-[13px] text-[var(--sf-needs)]">
                Preview. Saved providers on this machine are left as they are,
                and a key typed here is not stored.
              </p>
            ) : null}
            <h1 className="font-sans text-[28px] font-semibold tracking-[-0.6px] text-[var(--sf-text-1)]">
              Connect a provider
            </h1>
            <p className="max-w-[560px] font-sans text-[14px] leading-6 text-[var(--sf-text-2)]">
              Stages, agents, and evals call a model. Until a provider is
              connected, a run has nothing to call. The key stays on this
              machine.
            </p>
          </div>

          {error ? (
            <p className="font-sans text-[13px] text-[var(--sf-fail)]">{error}</p>
          ) : null}
          {warning ? (
            <p className="font-sans text-[13px] text-[var(--sf-text-2)]">{warning}</p>
          ) : null}

          <section className="flex flex-col gap-2.5">
            <span className="text-[11px] font-medium uppercase tracking-[0.88px] text-[var(--sf-text-3)]">
              {featured.length > 0 ? "Start with one" : "Providers"}
            </span>
            <div className="flex flex-col overflow-clip rounded-xl border border-[#ffffff12] bg-[var(--sf-panel)]">
              {loading ? (
                <>
                  <SkeletonRow />
                  <SkeletonRow />
                  <SkeletonRow />
                </>
              ) : providers.length === 0 ? (
                <p className="px-4 py-6 font-sans text-[13px] text-[var(--sf-text-3)]">
                  No connectable providers are available from Pi right now.
                </p>
              ) : (
                <>
                  {(featured.length > 0 ? featured : filteredOther).map(
                    (provider, index, list) => (
                      <ProviderLine
                        key={provider.id}
                        provider={provider}
                        status={statuses[provider.id]}
                        suggested={provider.id === "openrouter" && featured.length > 0}
                        isLast={index === list.length - 1}
                        connecting={connectId === provider.id}
                        oauthing={oauthId === provider.id}
                        apiKeyDraft={apiKeyDraft}
                        rowBusy={rowBusy === provider.id}
                        onOpen={() => openConnect(provider)}
                        onApiKeyChange={setApiKeyDraft}
                        onConnectSubmit={() => void onConnectSubmit(provider.id)}
                        onCancelKey={() => {
                          setConnectId(null);
                          setApiKeyDraft("");
                        }}
                        onStartOauth={() => {
                          if (preview) {
                            setWarning("Browser sign-in is off in this preview.");
                            return;
                          }
                          setConnectId(null);
                          setOauthId(provider.id);
                        }}
                        onOauthComplete={(next, warn) => {
                          setOauthId(null);
                          setWarning(warn ?? null);
                          if (next) remember(provider.id, next);
                          else void loadConnectProviders();
                        }}
                        onOauthDismiss={() => setOauthId(null)}
                      />
                    ),
                  )}
                  {featured.length > 0 && other.length > 0 ? (
                    <OtherProviders
                      open={othersVisible}
                      count={other.length}
                      search={otherSearch}
                      searchRef={otherSearchRef}
                      providers={filteredOther}
                      statuses={statuses}
                      connectId={connectId}
                      oauthId={oauthId}
                      apiKeyDraft={apiKeyDraft}
                      rowBusy={rowBusy}
                      onToggle={() => {
                        setOthersOpen((open) => !open);
                        if (othersOpen) setOtherSearch("");
                      }}
                      onSearch={setOtherSearch}
                      onOpen={openConnect}
                      onApiKeyChange={setApiKeyDraft}
                      onConnectSubmit={(id) => void onConnectSubmit(id)}
                      onCancelKey={() => {
                        setConnectId(null);
                        setApiKeyDraft("");
                      }}
                      onStartOauth={(id) => {
                        if (preview) {
                          setWarning("Browser sign-in is off in this preview.");
                          return;
                        }
                        setConnectId(null);
                        setOauthId(id);
                      }}
                      onOauthComplete={(id, next, warn) => {
                        setOauthId(null);
                        setWarning(warn ?? null);
                        if (next) remember(id, next);
                        else void loadConnectProviders();
                      }}
                      onOauthDismiss={() => setOauthId(null)}
                    />
                  ) : null}
                </>
              )}
            </div>
          </section>
        </div>
      </div>

      <footer className="flex shrink-0 items-center justify-between gap-6 border-t border-t-[#ffffff12] bg-[var(--sf-ground)] px-8 py-4">
        <div className="flex min-w-0 items-center gap-2.5">
          {anyConfigured ? (
            <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-[var(--sf-ok-bg)]">
              <LuCheck className="size-3 text-[var(--sf-ok)]" aria-hidden="true" />
            </span>
          ) : null}
          <p className="truncate font-sans text-[13px] text-[var(--sf-text-2)]">
            {anyConfigured
              ? `${connected.map((provider) => provider.name).join(", ")} connected. The console is ready.`
              : "Connect one provider to run stages, agents, and evals."}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-4">
          <button
            type="button"
            className="font-sans text-[13px] text-[var(--sf-text-2)] hover:text-[var(--sf-text-1)]"
            onClick={onComplete}
          >
            Skip for now
          </button>
          <button
            type="button"
            className="flex h-9 items-center rounded-lg bg-[var(--sf-text-1)] px-3.5 font-sans text-[13px] font-medium text-[var(--sf-ground)] disabled:opacity-40"
            disabled={!anyConfigured}
            onClick={onComplete}
          >
            Go to console
          </button>
        </div>
      </footer>
    </div>
  );
}

function SkeletonRow() {
  return (
    <div className="flex h-[68px] items-center gap-3 border-b border-b-[#ffffff12] px-4">
      <div className="size-8 shrink-0 animate-pulse rounded-lg bg-[var(--sf-raised)]" />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="h-3 w-32 animate-pulse rounded bg-[var(--sf-raised)]" />
        <div className="h-2.5 w-64 max-w-full animate-pulse rounded bg-[var(--sf-raised)]" />
      </div>
      <div className="h-8 w-[88px] shrink-0 animate-pulse rounded-lg bg-[var(--sf-raised)]" />
    </div>
  );
}

function ProviderLine({
  provider,
  status,
  suggested,
  isLast,
  connecting,
  oauthing,
  apiKeyDraft,
  rowBusy,
  onOpen,
  onApiKeyChange,
  onConnectSubmit,
  onCancelKey,
  onStartOauth,
  onOauthComplete,
  onOauthDismiss,
}: {
  provider: ProviderSummary;
  status: ProviderAuthStatus | undefined;
  suggested: boolean;
  isLast: boolean;
  connecting: boolean;
  oauthing: boolean;
  apiKeyDraft: string;
  rowBusy: boolean;
  onOpen: () => void;
  onApiKeyChange: (value: string) => void;
  onConnectSubmit: () => void;
  onCancelKey: () => void;
  onStartOauth: () => void;
  onOauthComplete: (status: ProviderAuthStatus | undefined, warning?: string) => void;
  onOauthDismiss: () => void;
}) {
  const configured = status?.configured === true;
  const canKey = providerAllowsApiKey(provider);
  const canOauth = providerSupportsOauthConnect(provider);
  const letter = provider.name.slice(0, 1).toUpperCase();
  const expanded = connecting || oauthing;

  return (
    <div
      className={`flex flex-col px-4 ${expanded ? "gap-3 py-3.5" : "h-[68px] justify-center"}${
        isLast ? "" : " border-b border-b-[#ffffff12]"
      }${oauthing ? " bg-[#6ca6ff0a]" : ""}`}
    >
      <div className="flex items-center gap-3">
        <span
          className={`flex size-8 shrink-0 items-center justify-center rounded-lg border bg-[var(--sf-raised)] ${
            configured ? "border-[#4cc38a55]" : "border-[#ffffff1a]"
          }`}
        >
          {configured ? (
            <LuCheck className="size-3.5 text-[var(--sf-ok)]" aria-hidden="true" />
          ) : (
            <span className="font-['Geist_Mono',monospace] text-xs font-semibold text-[var(--sf-text-1)]">
              {letter}
            </span>
          )}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-center gap-2">
            <span className="truncate font-sans text-[13px] font-medium text-[var(--sf-text-1)]">
              {provider.name}
            </span>
            {suggested && !configured ? (
              <span className="shrink-0 rounded-full bg-[var(--sf-running-bg)] px-2 py-0.5 font-sans text-[11px] font-medium text-[var(--sf-running)]">
                Suggested
              </span>
            ) : null}
          </span>
          <span className="truncate font-sans text-xs text-[var(--sf-text-3)]">
            {configured ? statusLabel(status) : firstRunBlurb(provider.id)}
          </span>
        </span>
        {configured ? (
          <span className="flex h-6 shrink-0 items-center gap-[5px] rounded-full bg-[#4cc38a1a] px-2">
            <LuCheck className="size-3 text-[var(--sf-ok)]" aria-hidden="true" />
            <span className="font-sans text-xs font-medium text-[var(--sf-ok)]">
              Connected
            </span>
          </span>
        ) : (
          <button
            type="button"
            className="flex h-8 shrink-0 items-center rounded-lg border border-[#ffffff1a] bg-[var(--sf-raised)] px-3 disabled:opacity-50"
            disabled={rowBusy || expanded}
            onClick={onOpen}
          >
            <span className="font-sans text-[13px] font-medium text-[var(--sf-text-1)]">
              Connect
            </span>
          </button>
        )}
      </div>
      {connecting && canKey ? (
        <form
          className="flex flex-wrap items-center gap-2 pl-11"
          onSubmit={(event) => {
            event.preventDefault();
            onConnectSubmit();
          }}
        >
          <LuKey className="size-3.5 text-[var(--sf-text-3)]" aria-hidden="true" />
          <input
            type="password"
            autoFocus
            autoComplete="off"
            className="min-w-[220px] flex-1 rounded-lg border border-[#ffffff1a] bg-[var(--sf-raised)] px-2.5 py-1.5 font-sans text-[13px] text-[var(--sf-text-1)] outline-none placeholder:text-[var(--sf-text-3)]"
            placeholder={`Paste ${provider.name} API key`}
            aria-label={`${provider.name} API key`}
            value={apiKeyDraft}
            onChange={(event) => onApiKeyChange(event.target.value)}
          />
          <button
            type="submit"
            className="rounded-lg bg-[var(--sf-text-1)] px-3 py-1.5 font-sans text-[13px] font-medium text-[var(--sf-ground)] disabled:opacity-50"
            disabled={rowBusy}
          >
            {rowBusy ? "Saving…" : "Save key"}
          </button>
          {canOauth ? (
            <button
              type="button"
              className="font-sans text-[13px] text-[var(--sf-text-2)] underline-offset-2 hover:underline"
              disabled={rowBusy}
              onClick={onStartOauth}
            >
              {browserSignInLabel(provider.name)}
            </button>
          ) : null}
          <button
            type="button"
            className="font-sans text-[13px] text-[var(--sf-text-2)]"
            disabled={rowBusy}
            onClick={onCancelKey}
          >
            Cancel
          </button>
        </form>
      ) : null}
      {oauthing && canOauth ? (
        <div className="pl-11">
          <ProviderOAuthSession
            providerId={provider.id}
            providerName={provider.name}
            supportsApiKey={provider.supportsApiKey}
            onComplete={onOauthComplete}
            onDismiss={onOauthDismiss}
          />
        </div>
      ) : null}
    </div>
  );
}

function OtherProviders({
  open,
  count,
  search,
  searchRef,
  providers,
  statuses,
  connectId,
  oauthId,
  apiKeyDraft,
  rowBusy,
  onToggle,
  onSearch,
  onOpen,
  onApiKeyChange,
  onConnectSubmit,
  onCancelKey,
  onStartOauth,
  onOauthComplete,
  onOauthDismiss,
}: {
  open: boolean;
  count: number;
  search: string;
  searchRef: RefObject<HTMLInputElement | null>;
  providers: ProviderSummary[];
  statuses: StatusMap;
  connectId: string | null;
  oauthId: string | null;
  apiKeyDraft: string;
  rowBusy: string | null;
  onToggle: () => void;
  onSearch: (value: string) => void;
  onOpen: (provider: ProviderSummary) => void;
  onApiKeyChange: (value: string) => void;
  onConnectSubmit: (providerId: string) => void;
  onCancelKey: () => void;
  onStartOauth: (providerId: string) => void;
  onOauthComplete: (
    providerId: string,
    status: ProviderAuthStatus | undefined,
    warning?: string,
  ) => void;
  onOauthDismiss: () => void;
}) {
  if (!open) {
    return (
      <button
        type="button"
        className="flex h-11 w-full items-center gap-2 border-t border-t-[#ffffff12] px-4 text-left"
        onClick={onToggle}
      >
        <LuChevronRight className="size-3.5 text-[var(--sf-text-3)]" aria-hidden="true" />
        <span className="font-sans text-[13px] font-medium text-[var(--sf-text-2)]">
          More providers ({count})
        </span>
      </button>
    );
  }
  return (
    <>
      <div className="flex h-[38px] items-center gap-2 border-y border-[#ffffff12] px-4">
        <button type="button" className="flex shrink-0 items-center gap-1.5" onClick={onToggle}>
          <LuChevronDown className="size-3.5 text-[var(--sf-text-3)]" aria-hidden="true" />
          <span className="font-sans text-[13px] font-medium text-[var(--sf-text-2)]">
            More providers ({count})
          </span>
        </button>
        <LuSearch className="size-3.5 shrink-0 text-[var(--sf-text-3)]" aria-hidden="true" />
        <input
          ref={searchRef}
          value={search}
          onChange={(event) => onSearch(event.target.value)}
          placeholder="Search providers…"
          aria-label="Search providers"
          className="min-w-0 flex-1 border-none bg-transparent font-sans text-[13px] text-[var(--sf-text-1)] outline-none placeholder:text-[var(--sf-text-3)]"
        />
      </div>
      {providers.length === 0 ? (
        <p className="border-t border-t-[#ffffff12] px-4 py-4 font-sans text-[13px] text-[var(--sf-text-3)]">
          No provider matches that search.
        </p>
      ) : (
        providers.map((provider, index) => (
          <ProviderLine
            key={provider.id}
            provider={provider}
            status={statuses[provider.id]}
            suggested={false}
            isLast={index === providers.length - 1}
            connecting={connectId === provider.id}
            oauthing={oauthId === provider.id}
            apiKeyDraft={apiKeyDraft}
            rowBusy={rowBusy === provider.id}
            onOpen={() => onOpen(provider)}
            onApiKeyChange={onApiKeyChange}
            onConnectSubmit={() => onConnectSubmit(provider.id)}
            onCancelKey={onCancelKey}
            onStartOauth={() => onStartOauth(provider.id)}
            onOauthComplete={(next, warn) => onOauthComplete(provider.id, next, warn)}
            onOauthDismiss={onOauthDismiss}
          />
        ))
      )}
    </>
  );
}
