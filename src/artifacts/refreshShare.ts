import type { ArtifactRefreshResult } from "./refresh.js";
import { refreshLeaderEntered, tryBeginRefreshLeader } from "./refresh.js";

export type RefreshShareOptions = {
  bindingIds?: readonly string[];
  bindingIdsIssuePath?: string;
  ifStale?: boolean;
  skipBindingIds?: readonly string[];
  signal?: AbortSignal;
};

type Flight = {
  bindingIds: readonly string[] | undefined;
  excludes: readonly string[];
  ifStale: boolean;
  joiners: number;
  promise: Promise<ArtifactRefreshResult>;
};

/** Joiners only wait on a shared promise. Past this, a joiner is refused for memory safety. */
export const REFRESH_JOINERS_PER_FLIGHT = 1000;

const flights = new Map<string, Flight[]>();

export function refreshInFlightCount(): number {
  let count = 0;
  for (const list of flights.values()) count += list.length;
  return count;
}

export function refreshJoinerCount(key: string): number {
  let count = 0;
  for (const flight of flights.get(key) ?? []) count += flight.joiners;
  return count;
}

export function abortRefreshError(): Error {
  const error = new Error("The refresh request was aborted");
  error.name = "AbortError";
  return error;
}

export function waitForSharedRefresh<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortRefreshError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(abortRefreshError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) reject(abortRefreshError());
        else resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function flightCoversId(flight: Flight, id: string): boolean {
  if (flight.excludes.includes(id)) return false;
  if (flight.bindingIds === undefined) return true;
  return flight.bindingIds.includes(id);
}

function sharesExecution(flight: Flight, options: RefreshShareOptions): boolean {
  if (options.ifStale !== true && flight.ifStale) return false;
  return true;
}

function covers(flight: Flight, options: RefreshShareOptions): boolean {
  if (!sharesExecution(flight, options)) return false;
  if (options.bindingIds === undefined) {
    return flight.bindingIds === undefined && flight.excludes.length === 0;
  }
  return options.bindingIds.every((id) => flightCoversId(flight, id));
}

function overlaps(flight: Flight, options: RefreshShareOptions): boolean {
  if (flight.bindingIds === undefined && flight.excludes.length === 0) return true;
  if (options.bindingIds === undefined && (options.skipBindingIds?.length ?? 0) === 0 && flight.bindingIds === undefined) {
    return true;
  }
  if (options.bindingIds) return options.bindingIds.some((id) => flightCoversId(flight, id) || (flight.bindingIds?.includes(id) ?? false));
  if (flight.bindingIds) return flight.bindingIds.some((id) => !(options.skipBindingIds ?? []).includes(id));
  return flight.excludes.length > 0 || (options.skipBindingIds?.length ?? 0) > 0;
}

function listFlights(key: string): Flight[] {
  return flights.get(key) ?? [];
}

function addFlight(key: string, flight: Flight): void {
  const list = flights.get(key);
  if (list) list.push(flight);
  else flights.set(key, [flight]);
}

function removeFlight(key: string, flight: Flight): void {
  const list = flights.get(key);
  if (!list) return;
  const next = list.filter((entry) => entry !== flight);
  if (next.length === 0) flights.delete(key);
  else flights.set(key, next);
}

const JOIN_CAPACITY = Symbol("join-capacity");

async function joinFlight(
  flight: Flight,
  signal: AbortSignal | undefined,
): Promise<ArtifactRefreshResult | typeof JOIN_CAPACITY> {
  if (signal?.aborted) throw abortRefreshError();
  if (flight.joiners >= REFRESH_JOINERS_PER_FLIGHT) return JOIN_CAPACITY;
  flight.joiners += 1;
  try {
    return await waitForSharedRefresh(flight.promise, signal);
  } finally {
    flight.joiners -= 1;
  }
}

function stillNeeded(
  options: RefreshShareOptions,
  waited: readonly Flight[],
): { done: true } | { done: false; bindingIds?: string[]; skipBindingIds?: string[] } {
  const sharing = waited.filter((flight) => sharesExecution(flight, options));
  if (options.bindingIds) {
    const missing = options.bindingIds.filter((id) => !sharing.some((flight) => flightCoversId(flight, id)));
    if (missing.length === 0) return { done: true };
    return { done: false, bindingIds: missing };
  }
  if (sharing.some((flight) => flight.bindingIds === undefined && flight.excludes.length === 0)) return { done: true };
  const skip = new Set<string>();
  for (const flight of sharing) {
    if (flight.bindingIds) for (const id of flight.bindingIds) skip.add(id);
  }
  if (skip.size === 0) return { done: false, ...(options.skipBindingIds ? { skipBindingIds: [...options.skipBindingIds] } : {}) };
  return { done: false, skipBindingIds: [...skip] };
}

export async function coordinateRefresh(
  key: string,
  options: RefreshShareOptions,
  start: () => Promise<ArtifactRefreshResult>,
  again: (options: RefreshShareOptions) => Promise<ArtifactRefreshResult>,
  hooks: {
    onCapacity: () => ArtifactRefreshResult;
    freshCache?: () => ArtifactRefreshResult | undefined;
  },
): Promise<ArtifactRefreshResult> {
  const joinable = options.ifStale === true;
  if (joinable) {
    const active = listFlights(key);
    const covering = active.find((flight) => covers(flight, options));
    if (covering) {
      const joined = await joinFlight(covering, options.signal);
      if (joined === JOIN_CAPACITY) return hooks.onCapacity();
      return joined;
    }
    const overlapping = active.filter((flight) => overlaps(flight, options));
    if (overlapping.length > 0) {
      if (options.signal?.aborted) throw abortRefreshError();
      let last: ArtifactRefreshResult | undefined;
      for (const flight of overlapping) {
        const joined = await joinFlight(flight, options.signal);
        if (joined === JOIN_CAPACITY) return hooks.onCapacity();
        last = joined;
      }
      if (options.signal?.aborted) throw abortRefreshError();
      const needed = stillNeeded(options, overlapping);
      if (needed.done) {
        if (!last) throw abortRefreshError();
        return last;
      }
      const next: RefreshShareOptions = {
        ...(options.bindingIdsIssuePath ? { bindingIdsIssuePath: options.bindingIdsIssuePath } : {}),
        ...(options.ifStale === true ? { ifStale: true } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      };
      if (needed.bindingIds) next.bindingIds = needed.bindingIds;
      if (needed.skipBindingIds) next.skipBindingIds = needed.skipBindingIds;
      return again(next);
    }
    const cached = hooks.freshCache?.();
    if (cached) return cached;
  }

  if (!tryBeginRefreshLeader(key)) return hooks.onCapacity();
  let resolveRun!: (result: ArtifactRefreshResult) => void;
  let rejectRun!: (error: unknown) => void;
  const run = new Promise<ArtifactRefreshResult>((resolve, reject) => {
    resolveRun = resolve;
    rejectRun = reject;
  });
  const flight: Flight = {
    bindingIds: options.bindingIds ? [...options.bindingIds] : undefined,
    excludes: options.skipBindingIds ? [...options.skipBindingIds] : [],
    ifStale: options.ifStale === true,
    joiners: 0,
    promise: run,
  };
  addFlight(key, flight);
  void (async () => {
    let entered = false;
    try {
      refreshLeaderEntered(key);
      entered = true;
      resolveRun(await start());
    } catch (error) {
      rejectRun(error);
    } finally {
      if (!entered) refreshLeaderEntered(key);
      removeFlight(key, flight);
    }
  })();
  return waitForSharedRefresh(run, options.signal);
}
