import { effectiveLiveTtlSeconds } from "../../api/artifacts";

export const LIVE_REFRESH_BACKOFF_SECONDS = 30;

export type LiveScheduleConfig = {
  enabled: boolean;
  onView: boolean;
  autoSeconds: number | null;
  visible: boolean;
  lastRefreshedAt: number | null;
};

export type LiveScheduleRequest = {
  ifStale: boolean;
  signal: AbortSignal;
};

export type LiveScheduleOutcome = {
  ok: boolean;
  resourceLimit: boolean;
  retryAfterSeconds?: number;
  refreshedAt: number | null;
  error?: string;
};

export type LiveScheduleView = {
  refreshing: boolean;
  lastError: string | null;
};

export type LiveRefreshClock = {
  now: () => number;
  setTimer: (fn: () => void, delayMs: number) => unknown;
  clearTimer: (id: unknown) => void;
};

export function formatUpdatedAgo(iso: string | null | undefined, nowMs: number): string | null {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return null;
  const seconds = Math.max(0, Math.floor((nowMs - parsed) / 1000));
  return `Updated ${seconds}s ago`;
}

export function autoRefreshNote(
  autoSeconds: number | null | undefined,
  ttlSeconds?: number | null,
): string | null {
  if (autoSeconds === null || autoSeconds === undefined || autoSeconds < 30) return null;
  const ttl = effectiveLiveTtlSeconds(typeof ttlSeconds === "number" ? ttlSeconds : undefined);
  return `Checking every ${autoSeconds}s · data refreshed at most every ${ttl}s`;
}

export function createLiveRefreshController(options: {
  clock: LiveRefreshClock;
  refresh: (request: LiveScheduleRequest) => Promise<LiveScheduleOutcome>;
  onChange: (view: LiveScheduleView) => void;
}): {
  mount: (config: LiveScheduleConfig) => void;
  setVisible: (visible: boolean) => void;
  manual: () => void;
  unmount: () => void;
} {
  let config: LiveScheduleConfig = {
    enabled: false,
    onView: false,
    autoSeconds: null,
    visible: true,
    lastRefreshedAt: null,
  };
  let refreshing = false;
  let lastError: string | null = null;
  let stopped = false;
  let epoch = 0;
  let timer: unknown = null;
  let currentAbort: AbortController | null = null;
  let mounted = false;
  let backoffUntil = 0;

  function emit(): void {
    options.onChange({ refreshing, lastError });
  }

  function clearTimer(): void {
    if (timer === null) return;
    options.clock.clearTimer(timer);
    timer = null;
  }

  function arm(delayMs: number): void {
    clearTimer();
    if (stopped || !config.enabled || !config.visible || config.autoSeconds === null) return;
    timer = options.clock.setTimer(() => {
      timer = null;
      onTick();
    }, Math.max(0, delayMs));
  }

  function blockedByBackoff(ifStale: boolean): boolean {
    if (!ifStale) return false;
    return options.clock.now() < backoffUntil;
  }

  function begin(ifStale: boolean, ignoreVisibility: boolean): void {
    if (stopped || !config.enabled || refreshing) return;
    if (!ignoreVisibility && !config.visible) return;
    if (blockedByBackoff(ifStale)) {
      arm(backoffUntil - options.clock.now());
      return;
    }
    refreshing = true;
    const generation = epoch;
    const abort = new AbortController();
    currentAbort = abort;
    emit();
    void options
      .refresh({ ifStale, signal: abort.signal })
      .then((outcome) => finish(generation, outcome))
      .catch((error: unknown) =>
        finish(generation, {
          ok: false,
          resourceLimit: false,
          refreshedAt: null,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
  }

  function finish(generation: number, outcome: LiveScheduleOutcome): void {
    if (generation !== epoch) return;
    refreshing = false;
    currentAbort = null;
    if (outcome.resourceLimit) {
      backoffUntil = options.clock.now() + (outcome.retryAfterSeconds ?? LIVE_REFRESH_BACKOFF_SECONDS) * 1000;
      lastError = outcome.ok ? null : (outcome.error ?? null);
    } else if (outcome.ok) {
      backoffUntil = 0;
      lastError = null;
    } else {
      lastError = outcome.error ?? "Refresh failed";
    }
    if (outcome.ok && outcome.refreshedAt !== null) config = { ...config, lastRefreshedAt: outcome.refreshedAt };
    emit();
    if (!config.enabled || !config.visible || config.autoSeconds === null || stopped) return;
    const delay = outcome.resourceLimit ? backoffUntil - options.clock.now() : config.autoSeconds * 1000;
    arm(delay);
  }

  function onTick(): void {
    if (stopped || !config.enabled || !config.visible) return;
    if (refreshing || blockedByBackoff(true)) {
      if (blockedByBackoff(true)) arm(backoffUntil - options.clock.now());
      return;
    }
    begin(true, false);
  }

  function catchUp(): void {
    if (stopped || !config.enabled || !config.visible || refreshing || config.autoSeconds === null) return;
    if (blockedByBackoff(true)) {
      arm(backoffUntil - options.clock.now());
      return;
    }
    const now = options.clock.now();
    const age = config.lastRefreshedAt === null ? Number.POSITIVE_INFINITY : now - config.lastRefreshedAt;
    if (age >= config.autoSeconds * 1000) begin(true, false);
    else arm(config.autoSeconds * 1000 - age);
  }

  return {
    mount(next) {
      mounted = true;
      stopped = false;
      epoch += 1;
      config = next;
      lastError = null;
      backoffUntil = 0;
      if (!config.enabled) {
        emit();
        return;
      }
      if (config.onView) begin(true, true);
      if (config.visible && config.autoSeconds !== null) arm(config.autoSeconds * 1000);
    },
    setVisible(visible) {
      if (!mounted || stopped || config.visible === visible) return;
      config = { ...config, visible };
      if (!visible) {
        clearTimer();
        return;
      }
      catchUp();
    },
    manual() {
      if (!mounted || stopped || !config.enabled) return;
      begin(false, true);
    },
    unmount() {
      stopped = true;
      mounted = false;
      epoch += 1;
      clearTimer();
      currentAbort?.abort();
      currentAbort = null;
      refreshing = false;
    },
  };
}
