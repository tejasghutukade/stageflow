import { useContext, useSyncExternalStore } from "react";
import { RunCatalogContext } from "../../catalog/useRunCatalog";
import { chooseSandboxOrigin } from "../../hostInfo";
import type { CatalogState } from "../../catalog/runCatalog";

export type SandboxOriginState = {
  origin: string | null;
  ready: boolean;
};

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

export function useSandboxOrigin(): SandboxOriginState {
  const forced = useSyncExternalStore(subscribeOverride, getOverride, getOverride);
  const catalog = useContext(RunCatalogContext);
  const state = useSyncExternalStore(
    catalog ? catalog.subscribe.bind(catalog) : subscribeNoop,
    catalog ? catalog.getState.bind(catalog) : getEmptyCatalog,
    catalog ? catalog.getState.bind(catalog) : getEmptyCatalog,
  );
  if (forced) return { origin: forced.origin, ready: true };
  if (!catalog) return { origin: null, ready: false };
  const health = state.snapshot.health;
  if (state.loading && health == null) return { origin: null, ready: false };
  const hostname = typeof location === "undefined" ? "" : location.hostname;
  return {
    origin: chooseSandboxOrigin(health?.sandbox_origin, health?.sandbox_origins, hostname),
    ready: true,
  };
}
