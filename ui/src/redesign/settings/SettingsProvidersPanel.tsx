import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
} from "../../api";
import { ProviderOAuthSession } from "../../components/ProviderOAuthSession";
import {
  providerAllowsApiKey,
  statusLabel,
} from "../../providers/helpers";
import { providerSupportsOauthConnect } from "../../providers/oauthSession";
import { Keycap } from "../Keycap";
import {
  LuCheck,
  LuChevronDown,
  LuChevronRight,
  LuEllipsisVertical,
  LuHouse,
  LuKey,
  LuRefreshCw,
  LuSearch,
} from "react-icons/lu";

type StatusMap = Record<string, ProviderAuthStatus | undefined>;

type ProvidersCache = {
  providers: ProviderSummary[];
  statuses: StatusMap;
  credentialSource?: CredentialSource;
};

let settingsProvidersCache: ProvidersCache | null = null;

function ProviderSkeletonRow() {
  return (
    <div className="flex h-14 items-center gap-3 border-b border-b-[#ffffff12] px-3.5 py-0">
      <div className="size-7 shrink-0 animate-pulse rounded-[7px] bg-[var(--sf-raised)]" />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="h-3 w-28 animate-pulse rounded bg-[var(--sf-raised)]" />
        <div className="h-2.5 w-56 max-w-full animate-pulse rounded bg-[var(--sf-raised)]" />
      </div>
      <div className="h-6 w-[88px] shrink-0 animate-pulse rounded-full bg-[var(--sf-raised)]" />
    </div>
  );
}

export type SettingsProvidersPanelProps = {
  onProvidersSummary?: (connected: number, total: number) => void;
};

function isPrimaryAccount(
  providerId: string,
  status: ProviderAuthStatus | undefined,
  oauthId: string | null,
  connectId: string | null,
): boolean {
  if (status?.configured === true) return true;
  if (oauthId === providerId) return true;
  if (connectId === providerId) return true;
  return false;
}

export function SettingsProvidersPanel({
  onProvidersSummary,
}: SettingsProvidersPanelProps) {
  const summaryRef = useRef(onProvidersSummary);
  summaryRef.current = onProvidersSummary;
  const otherSearchRef = useRef<HTMLInputElement>(null);

  const [providers, setProviders] = useState<ProviderSummary[]>(
    () => settingsProvidersCache?.providers ?? [],
  );
  const [statuses, setStatuses] = useState<StatusMap>(
    () => settingsProvidersCache?.statuses ?? {},
  );
  const [credentialSource, setCredentialSource] = useState<
    CredentialSource | undefined
  >(() => settingsProvidersCache?.credentialSource);
  const [loading, setLoading] = useState(() => settingsProvidersCache == null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sourceSaving, setSourceSaving] = useState(false);
  const [connectId, setConnectId] = useState<string | null>(null);
  const [oauthId, setOauthId] = useState<string | null>(null);
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [rowWarning, setRowWarning] = useState<string | null>(null);
  const [otherExpanded, setOtherExpanded] = useState(false);
  const [otherSearch, setOtherSearch] = useState("");

  const { primaryProviders, otherProviders } = useMemo(() => {
    const primary: ProviderSummary[] = [];
    const other: ProviderSummary[] = [];
    for (const provider of providers) {
      if (
        isPrimaryAccount(
          provider.id,
          statuses[provider.id],
          oauthId,
          connectId,
        )
      ) {
        primary.push(provider);
      } else {
        other.push(provider);
      }
    }
    const byId = (a: ProviderSummary, b: ProviderSummary) =>
      a.id.localeCompare(b.id);
    primary.sort(byId);
    other.sort(byId);
    return { primaryProviders: primary, otherProviders: other };
  }, [providers, statuses, oauthId, connectId]);

  const filteredOtherProviders = useMemo(() => {
    const q = otherSearch.trim().toLowerCase();
    if (!q) return otherProviders;
    return otherProviders.filter(
      (p) =>
        p.id.toLowerCase().includes(q) ||
        p.name.toLowerCase().includes(q),
    );
  }, [otherProviders, otherSearch]);

  const refresh = useCallback(async (mode: "initial" | "background" = "background") => {
    setError(null);
    const showSkeleton = mode === "initial" && settingsProvidersCache == null;
    if (mode === "background" && !showSkeleton) {
      setRefreshing(true);
    }
    try {
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
      settingsProvidersCache = {
        providers: listed.providers,
        statuses: next,
        credentialSource: detect.credentialSource,
      };
      const connected = listed.providers.filter(
        (p) => next[p.id]?.configured === true,
      ).length;
      summaryRef.current?.(connected, listed.providers.length);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        await refresh(settingsProvidersCache == null ? "initial" : "background");
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    })();
  }, [refresh]);

  useEffect(() => {
    if (otherExpanded) {
      otherSearchRef.current?.focus();
    }
  }, [otherExpanded]);

  async function onSourceChange(value: CredentialSource) {
    setSourceSaving(true);
    setError(null);
    try {
      const result = await postCredentialSource(value);
      setCredentialSource(result.credentialSource);
      await refresh("background");
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
    void refresh("background");
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
    void refresh("background");
  }

  const showSkeleton = loading && providers.length === 0;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex w-full items-end justify-between gap-6">
        <div className="flex flex-col gap-1.5">
          <h1 className="font-sans text-[22px] font-semibold tracking-[-0.44px] text-[var(--sf-text-1)]">
            Providers
          </h1>
          <p className="max-w-xl font-sans text-[13px] text-[var(--sf-text-2)]">
            Model accounts your stages call. Keys stay on this machine and are
            never sent to MCP clients.
          </p>
        </div>
        <button
          type="button"
          className="flex h-8 shrink-0 items-center gap-2 rounded-lg border border-[#ffffff1a] bg-[var(--sf-raised)] px-3 py-0 disabled:opacity-60"
          disabled={showSkeleton}
          onClick={() => void refresh("background")}
        >
          <LuRefreshCw
            className={`size-3.5 text-[var(--sf-text-2)]${refreshing ? " animate-spin" : ""}`}
            aria-hidden="true"
          />
          <span className="font-sans text-[13px] font-medium text-[var(--sf-text-1)]">
            Test connections
          </span>
          <Keycap className="text-[var(--sf-text-3)]">T</Keycap>
        </button>
      </header>

      <section className="flex w-full flex-col gap-2.5">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-medium uppercase tracking-[0.88px] text-[var(--sf-text-3)]">
            Credential source
          </span>
          <span className="font-['Geist_Mono',monospace] text-xs text-[var(--sf-text-3)]">
            providers.credential_source
          </span>
        </div>
        <div className="grid grid-cols-[minmax(0px,_1fr)_minmax(0px,_1fr)] gap-3">
          <CredentialCard
            selected={credentialSource === "pi_home"}
            disabled={showSkeleton || sourceSaving}
            tag="pi_home"
            icon={LuHouse}
            title="Use Pi home credentials"
            description="Share the logins you already made with the Pi CLI."
            path="~/.pi/agent/auth.json"
            onSelect={() => void onSourceChange("pi_home")}
          />
          <CredentialCard
            selected={credentialSource === "sf_owned"}
            disabled={showSkeleton || sourceSaving}
            tag="sf_owned"
            icon={LuKey}
            title="Stageflow-owned credentials"
            description="Separate logins only Stageflow uses, kept in the OS keychain."
            path="~/.stageflow/credentials"
            onSelect={() => void onSourceChange("sf_owned")}
          />
        </div>
      </section>

      {error ? (
        <p className="font-sans text-[13px] text-[var(--sf-fail)]">{error}</p>
      ) : null}
      {rowError ? (
        <p className="font-sans text-[13px] text-[var(--sf-fail)]">{rowError}</p>
      ) : null}
      {rowWarning ? (
        <p className="font-sans text-[13px] text-[var(--sf-text-2)]">{rowWarning}</p>
      ) : null}

      <section className="flex w-full flex-col gap-2.5">
        <span className="text-[11px] font-medium uppercase tracking-[0.88px] text-[var(--sf-text-3)]">
          Accounts
        </span>
        <div className="flex flex-col overflow-clip rounded-xl border border-[#ffffff12] bg-[var(--sf-panel)]">
          {showSkeleton ? (
            <>
              <ProviderSkeletonRow />
              <ProviderSkeletonRow />
              <ProviderSkeletonRow />
            </>
          ) : providers.length === 0 ? (
            <p className="px-3.5 py-6 font-sans text-[13px] text-[var(--sf-text-3)]">
              No providers reported by Pi.
            </p>
          ) : (
            <>
              {primaryProviders.map((provider, index) => (
                <ProviderRow
                  key={provider.id}
                  provider={provider}
                  status={statuses[provider.id]}
                  isLast={
                    index === primaryProviders.length - 1 &&
                    otherProviders.length === 0 &&
                    !otherExpanded
                  }
                  connecting={connectId === provider.id}
                  oauthing={oauthId === provider.id}
                  apiKeyDraft={apiKeyDraft}
                  rowBusy={rowBusy === provider.id}
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
                      void refresh("background");
                    }
                  }}
                  onOauthDismiss={() => {
                    setOauthId(null);
                    setRowError(null);
                  }}
                />
              ))}
              {otherProviders.length > 0 ? (
                <>
                  {!otherExpanded ? (
                    <button
                      type="button"
                      className="flex h-11 w-full items-center gap-2 border-t border-t-[#ffffff12] px-3.5 py-0 text-left"
                      onClick={() => setOtherExpanded(true)}
                    >
                      <LuChevronRight className="size-3.5 text-[var(--sf-text-3)]" aria-hidden="true" />
                      <span className="font-sans text-[13px] font-medium text-[var(--sf-text-2)]">
                        Other providers ({otherProviders.length})
                      </span>
                    </button>
                  ) : (
                    <>
                      <div className="flex h-[38px] items-center gap-2 border-t border-t-[#ffffff12] px-3.5 py-0">
                        <button
                          type="button"
                          className="flex shrink-0 items-center gap-1.5"
                          onClick={() => {
                            setOtherExpanded(false);
                            setOtherSearch("");
                          }}
                        >
                          <LuChevronDown className="size-3.5 text-[var(--sf-text-3)]" aria-hidden="true" />
                          <span className="font-sans text-[13px] font-medium text-[var(--sf-text-2)]">
                            Other providers ({otherProviders.length})
                          </span>
                        </button>
                        <LuSearch className="size-3.5 shrink-0 text-[var(--sf-text-3)]" aria-hidden="true" />
                        <input
                          ref={otherSearchRef}
                          value={otherSearch}
                          onChange={(e) => setOtherSearch(e.target.value)}
                          placeholder="Search providers…"
                          className="min-w-0 flex-1 border-none bg-transparent font-sans text-[13px] text-[var(--sf-text-1)] outline-none placeholder:text-[var(--sf-text-3)]"
                        />
                      </div>
                      {filteredOtherProviders.map((provider, index) => (
                        <ProviderRow
                          key={provider.id}
                          provider={provider}
                          status={statuses[provider.id]}
                          isLast={index === filteredOtherProviders.length - 1}
                          connecting={connectId === provider.id}
                          oauthing={oauthId === provider.id}
                          apiKeyDraft={apiKeyDraft}
                          rowBusy={rowBusy === provider.id}
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
                              setStatuses((prev) => ({
                                ...prev,
                                [provider.id]: next,
                              }));
                            } else {
                              void refresh("background");
                            }
                          }}
                          onOauthDismiss={() => {
                            setOauthId(null);
                            setRowError(null);
                          }}
                        />
                      ))}
                    </>
                  )}
                </>
              ) : null}
            </>
          )}
        </div>
      </section>
    </div>
  );
}

function CredentialCard({
  selected,
  disabled,
  tag,
  icon: Icon,
  title,
  description,
  path,
  onSelect,
}: {
  selected: boolean;
  disabled?: boolean;
  tag: string;
  icon: typeof LuHouse;
  title: string;
  description: string;
  path: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onSelect}
      className={`flex gap-3 rounded-[10px] border p-3.5 text-left disabled:opacity-60${
        selected
          ? " border-[#ffffff47] bg-[var(--sf-active)] shadow-[0px_0px_0px_3px_rgba(255,255,255,0.04)]"
          : " border-[#ffffff12] bg-[var(--sf-panel)]"
      }`}
    >
      <span
        className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border${
          selected ? " border-[var(--sf-text-1)]" : " border-[#ffffff33]"
        }`}
      >
        {selected ? <span className="size-2 rounded-full bg-[var(--sf-text-1)]" /> : null}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span className="flex flex-wrap items-center gap-2">
          <Icon className="size-3.5 text-[var(--sf-text-3)]" aria-hidden="true" />
          <span
            className={`font-sans text-sm font-medium${selected ? " text-[var(--sf-text-1)]" : " text-[var(--sf-text-2)]"}`}
          >
            {title}
          </span>
          <Keycap className="text-[var(--sf-text-3)]">{tag}</Keycap>
        </span>
        <span className="font-sans text-xs leading-[1.45] text-[var(--sf-text-3)]">
          {description}
        </span>
        <span className="font-['Geist_Mono',monospace] text-xs text-[var(--sf-text-3)]">
          {path}
        </span>
      </span>
    </button>
  );
}

function ProviderRow({
  provider,
  status,
  isLast,
  connecting,
  oauthing,
  apiKeyDraft,
  rowBusy,
  onSetConnecting,
  onSetOauthing,
  onApiKeyChange,
  onConnectSubmit,
  onDisconnect,
  onOauthComplete,
  onOauthDismiss,
}: {
  provider: ProviderSummary;
  status: ProviderAuthStatus | undefined;
  isLast: boolean;
  connecting: boolean;
  oauthing: boolean;
  apiKeyDraft: string;
  rowBusy: boolean;
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
}) {
  const configured = status?.configured === true;
  const canKey = providerAllowsApiKey(provider);
  const canOauth = providerSupportsOauthConnect(provider);
  const letter = provider.name.slice(0, 1).toUpperCase();

  const expanded = connecting || oauthing;
  return (
    <div
      className={`flex flex-col px-3.5${
        expanded ? " gap-2 py-3" : " h-14 justify-center py-0"
      }${isLast ? "" : " border-b border-b-[#ffffff12]"}${
        oauthing ? " bg-[#6ca6ff0a]" : ""
      }`}
    >
      <div className="flex items-center gap-3">
        <span
          className={`flex size-7 shrink-0 items-center justify-center rounded-[7px] border border-[#ffffff1a] bg-[var(--sf-raised)]${
            !configured && !connecting ? " border-dashed border-[#ffffff26]" : ""
          }`}
        >
          <span className="font-['Geist_Mono',monospace] text-xs font-semibold text-[var(--sf-text-1)]">
            {letter}
          </span>
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="font-['Geist_Mono',monospace] text-[13px] font-medium text-[var(--sf-text-1)]">
            {provider.id}
          </span>
          <span className="truncate font-sans text-xs text-[var(--sf-text-3)]">
            {statusLabel(status)}
          </span>
        </span>
        {configured ? (
          <>
            <span className="flex h-6 shrink-0 items-center gap-[5px] rounded-full bg-[#4cc38a1a] px-2 py-0">
              <LuCheck className="size-3 text-[var(--sf-ok)]" aria-hidden="true" />
              <span className="font-sans text-xs font-medium text-[var(--sf-ok)]">
                Connected
              </span>
            </span>
            <button
              type="button"
              className="flex size-8 shrink-0 items-center justify-center rounded-lg text-[var(--sf-text-2)] hover:bg-[var(--sf-raised)] disabled:opacity-50"
              disabled={rowBusy}
              aria-label="Disconnect"
              onClick={() => onDisconnect(provider.id)}
            >
              <LuEllipsisVertical className="size-4" aria-hidden="true" />
            </button>
          </>
        ) : (
          <button
            type="button"
            className="flex h-8 shrink-0 items-center rounded-lg border border-[#ffffff1a] bg-[var(--sf-raised)] px-3 py-0"
            disabled={rowBusy}
            onClick={() => {
              if (canOauth) onSetOauthing(provider.id);
              else if (canKey) onSetConnecting(provider.id);
            }}
          >
            <span className="font-sans text-[13px] font-medium text-[var(--sf-text-1)]">
              Connect
            </span>
          </button>
        )}
      </div>
      {connecting && canKey ? (
        <div className="flex flex-wrap items-center gap-2 pl-10">
          <LuKey className="size-3.5 text-[var(--sf-text-3)]" aria-hidden="true" />
          <input
            type="password"
            className="min-w-[200px] flex-1 rounded-lg border border-[#ffffff1a] bg-[var(--sf-raised)] px-2.5 py-1.5 font-sans text-[13px] text-[var(--sf-text-1)] outline-none"
            placeholder="Paste API key"
            value={apiKeyDraft}
            onChange={(e) => onApiKeyChange(e.target.value)}
          />
          <button
            type="button"
            className="rounded-lg bg-[var(--sf-text-1)] px-3 py-1.5 font-sans text-[13px] font-medium text-[var(--sf-ground)]"
            disabled={rowBusy}
            onClick={() => onConnectSubmit(provider.id)}
          >
            Save key
          </button>
          <button
            type="button"
            className="font-sans text-[13px] text-[var(--sf-text-2)]"
            onClick={() => onSetConnecting(null)}
          >
            Cancel
          </button>
        </div>
      ) : null}
      {oauthing && canOauth ? (
        <div className="pl-10">
          <ProviderOAuthSession
            providerId={provider.id}
            providerName={provider.name}
            onComplete={onOauthComplete}
            onDismiss={onOauthDismiss}
          />
        </div>
      ) : null}
    </div>
  );
}
