import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { RunCatalogContext } from "../../../catalog/useRunCatalog";
import type { CatalogState } from "../../../catalog/runCatalog";
import { chooseSandboxOrigin } from "../../../hostInfo";

export type SandboxOriginState = {
  origin: string | null;
  ready: boolean;
};

/** The one sandbox origin for HTML cards and live HTML artifacts. Without a provider, the console's Host health decides. */
const SandboxOriginContext = createContext<SandboxOriginState | null>(null);

const EMPTY_CATALOG: CatalogState = {
  snapshot: { runs: [], health: null },
  error: null,
  loading: true,
};

type Override = { origin: string | null } | null;

let override: Override = null;
const overrideListeners = new Set<() => void>();

function subscribeOverride(listener: () => void): () => void {
  overrideListeners.add(listener);
  return () => {
    overrideListeners.delete(listener);
  };
}

function getOverride(): Override {
  return override;
}

export function setSandboxOriginForTests(origin: string | null | "unset"): void {
  override = origin === "unset" ? null : { origin };
  for (const listener of overrideListeners) listener();
}

function subscribeNoop(listener: () => void): () => void {
  void listener;
  return () => undefined;
}

function getEmptyCatalog(): CatalogState {
  return EMPTY_CATALOG;
}

function pageHostname(fallback: string): string {
  return typeof location === "undefined" ? fallback : location.hostname;
}

/** The console's origin, from the Host health the run catalog polls. */
function useConsoleSandboxOrigin(): SandboxOriginState {
  const catalog = useContext(RunCatalogContext);
  const state = useSyncExternalStore(
    catalog ? catalog.subscribe.bind(catalog) : subscribeNoop,
    catalog ? catalog.getState.bind(catalog) : getEmptyCatalog,
    catalog ? catalog.getState.bind(catalog) : getEmptyCatalog,
  );
  if (!catalog) return { origin: null, ready: false };
  const health = state.snapshot.health;
  if (state.loading && health == null) return { origin: null, ready: false };
  return {
    origin: chooseSandboxOrigin(health?.sandbox_origin, health?.sandbox_origins, pageHostname("")),
    ready: true,
  };
}

export function useSandboxOrigin(): SandboxOriginState {
  const forced = useSyncExternalStore(subscribeOverride, getOverride, getOverride);
  const provided = useContext(SandboxOriginContext);
  const consoleOrigin = useConsoleSandboxOrigin();
  if (forced) return { origin: forced.origin, ready: true };
  return provided ?? consoleOrigin;
}

/** The public chat page: origins come from its own API, not from the console's Host health. */
export function ChatSandboxProvider({ origins, children }: { origins: readonly string[]; children: ReactNode }) {
  const joined = origins.join("\n");
  const value = useMemo<SandboxOriginState>(
    () => ({ origin: chooseSandboxOrigin(null, joined ? joined.split("\n") : [], pageHostname("localhost")), ready: true }),
    [joined],
  );
  return <SandboxOriginContext.Provider value={value}>{children}</SandboxOriginContext.Provider>;
}

/** Console pages with chat cards (agent sessions, the Guide): the console's own origin. */
export function ConsoleSandboxProvider({ children }: { children: ReactNode }) {
  const { origin, ready } = useConsoleSandboxOrigin();
  const memo = useMemo<SandboxOriginState>(() => ({ origin, ready }), [origin, ready]);
  return <SandboxOriginContext.Provider value={memo}>{children}</SandboxOriginContext.Provider>;
}
