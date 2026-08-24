import type { CatalogSource, CatalogSnapshot } from "./source";

export type CatalogState = {
  snapshot: CatalogSnapshot;
  error: string | null;
  loading: boolean;
};

export type CatalogScheduler = {
  every(
    intervalMs: number,
    tick: () => void | Promise<void>,
  ): () => void;
};

export type RunCatalogOptions = {
  source: CatalogSource;
  intervalMs?: number;
  scheduler?: CatalogScheduler;
};

export type RunCatalog = {
  start(): Promise<void>;
  stop(): void;
  refresh(): Promise<void>;
  subscribe(listener: () => void): () => void;
  getState(): CatalogState;
};

const DEFAULT_INTERVAL_MS = 2000;

function defaultScheduler(): CatalogScheduler {
  return {
    every(intervalMs, tick) {
      const id = setInterval(() => {
        void tick();
      }, intervalMs);
      return () => clearInterval(id);
    },
  };
}

export function createRunCatalog(options: RunCatalogOptions): RunCatalog {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const scheduler = options.scheduler ?? defaultScheduler();
  const listeners = new Set<() => void>();
  let state: CatalogState = {
    snapshot: { runs: [], health: null },
    error: null,
    loading: true,
  };
  let running = false;
  let cancel: (() => void) | undefined;

  function getState(): CatalogState {
    return state;
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function notify(): void {
    for (const listener of listeners) listener();
  }

  async function poll(): Promise<void> {
    let runs = state.snapshot.runs;
    let health = state.snapshot.health;
    let error: string | null = null;

    const listingP = options.source.readListing();
    const capacityP = options.source.readCapacity();

    try {
      const listing = await listingP;
      runs = listing.runs;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    try {
      health = await capacityP;
    } catch {
      /* fail-open: keep last health */
    }

    state = {
      snapshot: { runs, health },
      error,
      loading: false,
    };
    notify();
  }

  async function start(): Promise<void> {
    if (running) return;
    running = true;
    await poll();
    cancel = scheduler.every(intervalMs, () => {
      if (!running) return;
      return poll();
    });
  }

  function stop(): void {
    running = false;
    cancel?.();
    cancel = undefined;
  }

  async function refresh(): Promise<void> {
    await poll();
  }

  return { start, stop, refresh, subscribe, getState };
}
