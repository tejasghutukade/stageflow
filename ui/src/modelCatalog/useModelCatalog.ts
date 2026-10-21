import { useCallback, useEffect, useState } from "react";
import { fetchModels, refreshModels, type ModelsResponse } from "../api";

export type ModelCatalogState = {
  status: "loading" | "ready" | "error";
  catalog: ModelsResponse | null;
  error: string | null;
  refreshing: boolean;
};

const INITIAL: ModelCatalogState = { status: "loading", catalog: null, error: null, refreshing: false };

let state: ModelCatalogState = INITIAL;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function publish(next: ModelCatalogState): void {
  state = next;
  for (const listener of listeners) listener();
}

function load(force: boolean): Promise<void> {
  if (inflight) return inflight;
  if (!force && state.status === "ready") return Promise.resolve();
  if (force) publish({ ...state, refreshing: true });
  inflight = (force ? refreshModels() : fetchModels())
    .then((catalog) => publish({ status: "ready", catalog, error: null, refreshing: false }))
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      // A failed refresh keeps the list already on screen.
      publish(state.catalog ? { ...state, refreshing: false, error: message } : { status: "error", catalog: null, error: message, refreshing: false });
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Test seam: put the shared list in a ready state without a fetch. */
export function seedModelCatalogForTests(catalog: ModelsResponse): void {
  state = { status: "ready", catalog, error: null, refreshing: false };
}

/** Test seam: forget the shared list so the next hook fetches again. */
export function resetModelCatalogForTests(): void {
  state = INITIAL;
  inflight = null;
  listeners.clear();
}

/**
 * The one client-side source of model lists. Every picker reads this, so a screen never keeps its
 * own list; the list is fetched once and shared, and `refresh` asks the providers again.
 */
export function useModelCatalog(): ModelCatalogState & { refresh: () => Promise<void> } {
  const [snapshot, setSnapshot] = useState(state);
  useEffect(() => {
    const listener = () => setSnapshot(state);
    listeners.add(listener);
    listener();
    void load(false);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  const refresh = useCallback(() => load(true), []);
  return { ...snapshot, refresh };
}
