import type {
  LiveViewRelay,
  LiveViewSession,
  LiveViewSessionRequest,
} from "./liveViewRelay.js";

export const LIVE_VIEW_SESSION_GRACE_MS = 5_000;

export type LiveViewLease = {
  session: LiveViewSession;
  release(): void;
};

export interface LiveViewSessionManager {
  /** Opens the one relay session of (run, stage) on first use; undefined when the stage has no browser to show. */
  acquire(runId: string, stageId: string): Promise<LiveViewLease | undefined>;
  /** The open session, if any; never opens one. */
  peek(runId: string, stageId: string): LiveViewSession | undefined;
  closeStage(runId: string, stageId: string): Promise<void>;
  closeRun(runId: string): Promise<void>;
  /** Closes every session and cancels every grace timer. */
  dispose(): Promise<void>;
}

export type LiveViewSessionManagerOptions = {
  relay: LiveViewRelay;
  /** Rebuilds the relay request from persisted state; undefined when the stage has no browser. */
  request: (runId: string, stageId: string) => Promise<LiveViewSessionRequest | undefined>;
  graceMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

type Entry = {
  runId: string;
  stageId: string;
  opening: Promise<LiveViewSession | undefined>;
  session?: LiveViewSession;
  refs: number;
  timer?: unknown;
};

function keyOf(runId: string, stageId: string): string {
  return `${runId}\0${stageId}`;
}

export function createLiveViewSessionManager(
  options: LiveViewSessionManagerOptions,
): LiveViewSessionManager {
  const graceMs = options.graceMs ?? LIVE_VIEW_SESSION_GRACE_MS;
  const setTimer =
    options.setTimer ??
    ((fn: () => void, ms: number) => {
      const handle = setTimeout(fn, ms);
      handle.unref();
      return handle;
    });
  const clearTimer =
    options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as NodeJS.Timeout));
  const entries = new Map<string, Entry>();
  const closing = new Map<string, Set<Promise<void>>>();

  function track(entry: Entry, closer: Promise<void>): Promise<void> {
    const key = keyOf(entry.runId, entry.stageId);
    const set = closing.get(key) ?? new Set<Promise<void>>();
    closing.set(key, set);
    const tracked: Promise<void> = closer.finally(() => {
      set.delete(tracked);
      if (set.size === 0 && closing.get(key) === set) closing.delete(key);
    });
    set.add(tracked);
    return tracked;
  }

  async function settled(match: (key: string) => boolean): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const [key, set] of closing) if (match(key)) pending.push(...set);
    await Promise.all(pending);
  }

  function stopTimer(entry: Entry): void {
    if (entry.timer === undefined) return;
    clearTimer(entry.timer);
    entry.timer = undefined;
  }

  function closeEntry(entry: Entry): Promise<void> {
    stopTimer(entry);
    return track(
      entry,
      (async () => {
        const session = await entry.opening.catch(() => undefined);
        await session?.close().catch(() => undefined);
      })(),
    );
  }

  function open(runId: string, stageId: string): Entry {
    const key = keyOf(runId, stageId);
    const entry = { runId, stageId, refs: 0 } as Entry;
    entry.opening = (async () => {
      const request = await options.request(runId, stageId);
      if (request === undefined) return undefined;
      const session = await options.relay.open(request);
      entry.session = session;
      session.subscribe((message) => {
        if (message.type === "closed" && entries.get(key) === entry) entries.delete(key);
      });
      return session;
    })();
    entries.set(key, entry);
    entry.opening.then(
      (session) => {
        if (session === undefined && entries.get(key) === entry) entries.delete(key);
      },
      () => {
        if (entries.get(key) === entry) entries.delete(key);
      },
    );
    return entry;
  }

  return {
    async acquire(runId, stageId) {
      const entry = entries.get(keyOf(runId, stageId)) ?? open(runId, stageId);
      stopTimer(entry);
      entry.refs += 1;
      let session: LiveViewSession | undefined;
      try {
        session = await entry.opening;
      } catch (err) {
        entry.refs -= 1;
        throw err;
      }
      if (session === undefined) {
        entry.refs -= 1;
        return undefined;
      }
      let released = false;
      return {
        session,
        release() {
          if (released) return;
          released = true;
          entry.refs -= 1;
          if (entry.refs > 0 || entries.get(keyOf(runId, stageId)) !== entry) return;
          stopTimer(entry);
          entry.timer = setTimer(() => {
            entry.timer = undefined;
            if (entry.refs > 0 || entries.get(keyOf(runId, stageId)) !== entry) return;
            entries.delete(keyOf(runId, stageId));
            void track(entry, session.close().catch(() => undefined));
          }, graceMs);
        },
      };
    },
    peek(runId, stageId) {
      return entries.get(keyOf(runId, stageId))?.session;
    },
    async closeStage(runId, stageId) {
      const key = keyOf(runId, stageId);
      const entry = entries.get(key);
      if (entry !== undefined) {
        entries.delete(key);
        void closeEntry(entry);
      }
      await settled((k) => k === key);
    },
    async closeRun(runId) {
      const doomed = [...entries.values()].filter((entry) => entry.runId === runId);
      for (const entry of doomed) {
        entries.delete(keyOf(entry.runId, entry.stageId));
        void closeEntry(entry);
      }
      await settled((k) => k.startsWith(`${runId}\0`));
    },
    async dispose() {
      const doomed = [...entries.values()];
      entries.clear();
      for (const entry of doomed) void closeEntry(entry);
      await settled(() => true);
    },
  };
}
