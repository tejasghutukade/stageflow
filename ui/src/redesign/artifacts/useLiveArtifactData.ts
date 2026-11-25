import { useEffect, useRef, useState } from "react";
import {
  ArtifactRequestError,
  fetchArtifactData,
  requestArtifactRefresh,
  type ArtifactDataResponse,
  type ArtifactRecord,
  type ArtifactSnapshot,
} from "../../api/artifacts";
import {
  createLiveRefreshController,
  type LiveRefreshClock,
  type LiveScheduleConfig,
  type LiveScheduleOutcome,
  type LiveScheduleRequest,
} from "./liveRefreshSchedule";

export type UseLiveArtifactDataOptions = {
  ownerKey: string;
  id: string;
  projectRoot?: string;
  version?: number;
  latestVersion?: number;
  hidden?: boolean;
};

export type LiveArtifactData = {
  snapshots: ArtifactSnapshot[];
  status: string | null;
  lastRefreshedAt: string | null;
  lastErrorCode: string | null;
  errors: Array<{ binding_id: string; code: string }>;
  refreshing: boolean;
  refresh: () => void;
  lastError: string | null;
  unavailable: boolean;
  unavailableMessage: string | null;
  settled: boolean;
};

export type LiveHttpBody = { status: number; body: unknown };

function emptyData(record: ArtifactRecord | null): Omit<LiveArtifactData, "refresh" | "settled"> {
  return {
    snapshots: [],
    status: record?.live?.status ?? null,
    lastRefreshedAt: record?.live?.last_refreshed_at ?? null,
    lastErrorCode: record?.live?.last_error_code ?? null,
    errors: [],
    refreshing: false,
    lastError: null,
    unavailable: false,
    unavailableMessage: null,
  };
}

export function viewedLiveVersion(record: ArtifactRecord | null, options: UseLiveArtifactDataOptions): number | undefined {
  if (options.version !== undefined) return options.version;
  return record?.version;
}

function isLiveFamily(kind: string | undefined): boolean {
  return kind === "live.declarative" || kind === "live.html";
}

export function liveVersionStance(
  record: ArtifactRecord | null,
  options: UseLiveArtifactDataOptions,
): "current" | "historical" | "pending" {
  if (!record || !isLiveFamily(record.kind)) return "current";
  if (options.latestVersion === undefined) return "pending";
  const viewed = viewedLiveVersion(record, options);
  if (viewed === undefined) return "pending";
  return viewed === options.latestVersion ? "current" : "historical";
}

export function liveArtifactScheduleConfig(record: ArtifactRecord | null, options: UseLiveArtifactDataOptions): LiveScheduleConfig {
  const live = isLiveFamily(record?.kind) ? record?.live : undefined;
  const current = liveVersionStance(record, options) === "current";
  const enabled = Boolean(live) && record?.status !== "expired" && options.hidden !== true && current;
  const auto = live?.refresh?.auto_seconds;
  const parsed = live?.last_refreshed_at ? Date.parse(live.last_refreshed_at) : Number.NaN;
  return {
    enabled,
    onView: enabled && live?.refresh?.on_view !== false,
    autoSeconds: typeof auto === "number" && auto >= 30 ? auto : null,
    visible: typeof document === "undefined" ? true : document.visibilityState !== "hidden",
    lastRefreshedAt: Number.isFinite(parsed) ? parsed : null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isArtifactDataResponse(body: unknown): body is ArtifactDataResponse {
  return isRecord(body) && Array.isArray(body.snapshots) && Array.isArray(body.errors) && "status" in body;
}

function outcomeFrom(data: ArtifactDataResponse): LiveScheduleOutcome {
  const resourceLimit =
    data.errors.some((error) => error.code === "artifact.resource_limit") || data.last_error_code === "artifact.resource_limit";
  return {
    ok: true,
    resourceLimit,
    ...(data.retry_after_seconds !== undefined ? { retryAfterSeconds: data.retry_after_seconds } : {}),
    refreshedAt: data.last_refreshed_at ? Date.parse(data.last_refreshed_at) : null,
  };
}

export function interpretStoredSnapshots(status: number, body: unknown): Omit<LiveArtifactData, "refresh" | "refreshing" | "settled"> {
  if (status === 404 && isRecord(body) && body.code === "artifact.content_unavailable") {
    return {
      snapshots: [],
      status: null,
      lastRefreshedAt: null,
      lastErrorCode: null,
      errors: [],
      lastError: null,
      unavailable: true,
      unavailableMessage: typeof body.error === "string" && body.error.trim().length > 0 ? body.error : "This artifact has expired",
    };
  }
  if (status === 200 && isArtifactDataResponse(body)) {
    return {
      snapshots: body.snapshots,
      status: body.status,
      lastRefreshedAt: body.last_refreshed_at,
      lastErrorCode: body.last_error_code,
      errors: body.errors,
      lastError: null,
      unavailable: false,
      unavailableMessage: null,
    };
  }
  const message = isRecord(body) && typeof body.error === "string" ? body.error : "Could not load snapshots";
  return {
    snapshots: [],
    status: null,
    lastRefreshedAt: null,
    lastErrorCode: null,
    errors: [],
    lastError: message,
    unavailable: false,
    unavailableMessage: null,
  };
}

export function interpretRefreshResponse(
  status: number,
  body: unknown,
): { data: ArtifactDataResponse | null; outcome: LiveScheduleOutcome } {
  if ((status === 200 || status === 503) && isArtifactDataResponse(body)) {
    return { data: body, outcome: outcomeFrom(body) };
  }
  const code = isRecord(body) && typeof body.code === "string" ? body.code : undefined;
  const retry = isRecord(body) && typeof body.retry_after_seconds === "number" ? body.retry_after_seconds : undefined;
  const message =
    isRecord(body) && typeof body.error === "string" ? body.error : code ?? `Refresh failed (${status})`;
  const resourceLimit = status === 429 || status === 503 || code === "artifact.resource_limit";
  return {
    data: null,
    outcome: {
      ok: false,
      resourceLimit,
      refreshedAt: null,
      error: message,
      ...(retry !== undefined ? { retryAfterSeconds: retry } : {}),
    },
  };
}

export function createLiveArtifactDataModel(input: {
  record: ArtifactRecord | null;
  options: UseLiveArtifactDataOptions;
  clock: LiveRefreshClock;
  loadStored: () => Promise<LiveHttpBody>;
  refresh: (request: LiveScheduleRequest) => Promise<LiveHttpBody>;
  onChange: (state: Omit<LiveArtifactData, "refresh" | "settled">) => void;
}): {
  start: () => Promise<void>;
  manual: () => void;
  setVisible: (visible: boolean) => void;
  unmount: () => void;
} {
  let state = emptyData(input.record);
  let stopped = false;

  function emit(patch: Partial<Omit<LiveArtifactData, "refresh" | "settled">>): void {
    state = { ...state, ...patch };
    if (!stopped) input.onChange(state);
  }

  const scheduler = createLiveRefreshController({
    clock: input.clock,
    onChange: (view) => emit({ refreshing: view.refreshing, lastError: view.lastError }),
    refresh: async (request) => {
      const response = await input.refresh(request);
      if (request.signal.aborted || stopped) {
        return { ok: false, resourceLimit: false, refreshedAt: null };
      }
      const interpreted = interpretRefreshResponse(response.status, response.body);
      if (interpreted.data) {
        emit({
          snapshots: interpreted.data.snapshots,
          status: interpreted.data.status,
          lastRefreshedAt: interpreted.data.last_refreshed_at,
          lastErrorCode: interpreted.data.last_error_code,
          errors: interpreted.data.errors,
          lastError: null,
          unavailable: false,
          unavailableMessage: null,
        });
      }
      return interpreted.outcome;
    },
  });
  return {
    async start() {
      const record = input.record;
      const stance = liveVersionStance(record, input.options);
      const live = isLiveFamily(record?.kind);
      if (!record || !live || stance !== "current") {
        emit(emptyData(record));
        return;
      }
      const loaded = await input.loadStored();
      if (stopped) return;
      const stored = interpretStoredSnapshots(loaded.status, loaded.body);
      emit({ ...stored, refreshing: false });
      if (stored.unavailable) return;
      const config = liveArtifactScheduleConfig(record, input.options);
      if (!config.enabled || stopped) return;
      scheduler.mount(config);
    },
    manual() {
      scheduler.manual();
    },
    setVisible(visible: boolean) {
      scheduler.setVisible(visible);
    },
    unmount() {
      stopped = true;
      scheduler.unmount();
    },
  };
}

export function useLiveArtifactData(record: ArtifactRecord | null, options: UseLiveArtifactDataOptions): LiveArtifactData {
  const [data, setData] = useState<Omit<LiveArtifactData, "refresh" | "settled">>(() => emptyData(record));
  const [settled, setSettled] = useState(false);
  const refreshRef = useRef<() => void>(() => undefined);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const recordRef = useRef(record);
  recordRef.current = record;
  const identity = [
    record?.key ?? "",
    record?.version ?? "",
    record?.status ?? "",
    record?.kind ?? "",
    record?.live?.refresh?.on_view === false ? "off" : "on",
    record?.live?.refresh?.auto_seconds ?? "",
    record?.live?.last_refreshed_at ?? "",
    options.ownerKey,
    options.id,
    options.projectRoot ?? "",
    options.version ?? "",
    options.latestVersion ?? "",
    options.hidden === true ? "hidden" : "shown",
  ].join("\0");

  useEffect(() => {
    const current = optionsRef.current;
    setSettled(false);
    setData(emptyData(recordRef.current));
    const model = createLiveArtifactDataModel({
      record: recordRef.current,
      options: current,
      clock: {
        now: () => Date.now(),
        setTimer: (fn, delayMs) => setTimeout(fn, delayMs),
        clearTimer: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
      },
      loadStored: async () => {
        try {
          const body = await fetchArtifactData(current.ownerKey, current.id, current.projectRoot);
          return { status: 200, body };
        } catch (error) {
          if (error instanceof ArtifactRequestError) {
            return {
              status: error.status,
              body: { error: error.message, code: error.code, retry_after_seconds: error.retryAfterSeconds },
            };
          }
          return { status: 0, body: { error: error instanceof Error ? error.message : String(error) } };
        }
      },
      refresh: (request) =>
        requestArtifactRefresh(current.ownerKey, current.id, current.projectRoot, {
          ifStale: request.ifStale,
          signal: request.signal,
        }),
      onChange: (state) => {
        setData(state);
        setSettled(true);
      },
    });
    refreshRef.current = () => model.manual();
    const onVisibility = () => model.setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", onVisibility);
    void model.start();
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      model.unmount();
      refreshRef.current = () => undefined;
    };
  }, [identity]);

  return { ...data, settled, refresh: () => refreshRef.current() };
}
