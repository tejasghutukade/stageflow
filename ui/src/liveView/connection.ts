import { applyDialogClosed, parseDialogOpened, type ViewerDialog } from "./dialogState";
import type { LiveViewMode } from "./types";

export type LiveViewPhase = "waiting" | "live" | "reconnecting" | "closed";

export type LiveViewState = {
  phase: LiveViewPhase;
  hasFrame: boolean;
  url: string;
  notice: string | null;
  dialog: ViewerDialog | null;
  closedReason: string | null;
};

export type FramePayload = { data: string; metadata?: unknown };

export type TicketResult = { ticket: string } | { status: number };

export type EventSourceLike = {
  onopen: ((ev: any) => void) | null;
  onerror: ((ev: any) => void) | null;
  addEventListener(type: string, listener: (ev: any) => void): void;
  close(): void;
};

export type ConnectionDeps = {
  mode: LiveViewMode;
  baseUrl: string;
  requestTicket(mode: LiveViewMode): Promise<TicketResult>;
  openEventSource(url: string): EventSourceLike;
  setTimer(fn: () => void, ms: number): () => void;
  onState(state: LiveViewState): void;
  onFrame(frame: FramePayload): void;
  maxFailures?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  noticeMs?: number;
};

export type LiveViewConnection = {
  start(): void;
  refresh(): Promise<boolean>;
  dispose(): void;
};

export const RETARGET_NOTICE = "Switched to a new window";

export const initialLiveViewState: LiveViewState = {
  phase: "waiting",
  hasFrame: false,
  url: "",
  notice: null,
  dialog: null,
  closedReason: null,
};

function parse(raw: string | undefined): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export function createLiveViewConnection(deps: ConnectionDeps): LiveViewConnection {
  const maxFailures = deps.maxFailures ?? 8;
  const baseDelay = deps.baseDelayMs ?? 1000;
  const maxDelay = deps.maxDelayMs ?? 10_000;
  const noticeMs = deps.noticeMs ?? 5000;
  let state = initialLiveViewState;
  let source: EventSourceLike | undefined;
  let generation = 0;
  let failures = 0;
  let disposed = false;
  let cancelRetry: (() => void) | undefined;
  let cancelNotice: (() => void) | undefined;
  let cancelLinger: (() => void) | undefined;

  function update(patch: Partial<LiveViewState>): void {
    state = { ...state, ...patch };
    deps.onState(state);
  }

  function closeSource(): void {
    const current = source;
    source = undefined;
    if (current !== undefined) {
      current.onopen = null;
      current.onerror = null;
      current.close();
    }
  }

  function finish(reason: string): void {
    generation += 1;
    cancelRetry?.();
    cancelRetry = undefined;
    closeSource();
    cancelLinger?.();
    cancelLinger = undefined;
    update({ phase: "closed", closedReason: reason, dialog: null });
  }

  function dropped(gen: number): void {
    if (disposed || gen !== generation || state.phase === "closed") return;
    closeSource();
    failures += 1;
    if (failures > maxFailures) {
      finish("connection_lost");
      return;
    }
    cancelLinger?.();
    cancelLinger = undefined;
    update({ phase: "reconnecting", dialog: null });
    const delay = Math.min(baseDelay * 2 ** (failures - 1), maxDelay);
    cancelRetry?.();
    cancelRetry = deps.setTimer(() => {
      cancelRetry = undefined;
      void attempt();
    }, delay);
  }

  function showNotice(text: string): void {
    cancelNotice?.();
    update({ notice: text });
    cancelNotice = deps.setTimer(() => {
      cancelNotice = undefined;
      update({ notice: null });
    }, noticeMs);
  }

  async function attempt(): Promise<boolean> {
    if (disposed || state.phase === "closed") return false;
    generation += 1;
    const gen = generation;
    closeSource();
    let result: TicketResult;
    try {
      result = await deps.requestTicket(deps.mode);
    } catch {
      dropped(gen);
      return false;
    }
    if (disposed || gen !== generation) return false;
    if ("status" in result) {
      if (result.status === 404 || result.status === 409) finish("unavailable");
      else dropped(gen);
      return false;
    }
    return new Promise<boolean>((resolve) => {
      const es = deps.openEventSource(
        `${deps.baseUrl}/events?ticket=${encodeURIComponent(result.ticket)}`,
      );
      source = es;
      let settled = false;
      const settle = (ok: boolean) => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };
      const alive = () => !disposed && gen === generation;
      const seen = () => {
        failures = 0;
      };
      es.onopen = () => {
        if (!alive()) return;
        if (state.phase !== "closed") update({ phase: state.hasFrame ? "live" : "waiting" });
        settle(true);
      };
      es.onerror = () => {
        settle(false);
        dropped(gen);
      };
      es.addEventListener("frame", (ev) => {
        if (!alive()) return;
        seen();
        const payload = parse(ev.data);
        if (payload === undefined || typeof payload.data !== "string") return;
        deps.onFrame({ data: payload.data, metadata: payload.metadata });
        if (!state.hasFrame || state.phase !== "live") update({ hasFrame: true, phase: "live" });
      });
      es.addEventListener("url", (ev) => {
        if (!alive()) return;
        seen();
        const payload = parse(ev.data);
        if (typeof payload?.url === "string") update({ url: payload.url });
      });
      es.addEventListener("retarget", (ev) => {
        if (!alive()) return;
        seen();
        const payload = parse(ev.data);
        if (typeof payload?.url === "string") update({ url: payload.url });
        showNotice(RETARGET_NOTICE);
      });
      es.addEventListener("dialog", (ev) => {
        if (!alive()) return;
        seen();
        const dialog = parseDialogOpened(parse(ev.data));
        if (dialog === undefined) return;
        cancelLinger?.();
        cancelLinger = undefined;
        update({ dialog });
      });
      es.addEventListener("dialog_closed", (ev) => {
        if (!alive()) return;
        seen();
        const effect = applyDialogClosed(state.dialog, parse(ev.data));
        if (effect.dialog === state.dialog) return;
        cancelLinger?.();
        cancelLinger = undefined;
        update({ dialog: effect.dialog });
        if (effect.notice !== null) showNotice(effect.notice);
        if (effect.linger) {
          const lingering = effect.dialog;
          cancelLinger = deps.setTimer(() => {
            cancelLinger = undefined;
            if (state.dialog === lingering) update({ dialog: null });
          }, noticeMs);
        }
      });
      for (const name of ["status", "tabs"]) {
        es.addEventListener(name, () => {
          if (alive()) seen();
        });
      }
      es.addEventListener("closed", (ev) => {
        if (!alive()) return;
        const payload = parse(ev.data);
        settle(false);
        finish(typeof payload?.reason === "string" ? payload.reason : "closed");
      });
    });
  }

  return {
    start() {
      void attempt();
    },
    refresh() {
      cancelRetry?.();
      cancelRetry = undefined;
      return attempt();
    },
    dispose() {
      disposed = true;
      generation += 1;
      cancelRetry?.();
      cancelNotice?.();
      cancelLinger?.();
      closeSource();
    },
  };
}
