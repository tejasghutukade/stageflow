import type { StageLogLine } from "../agent/activity.js";
import type {
  CreateRunInput,
  CreatedRun,
  RunStatus,
  RunStore,
} from "../runstore/port.js";

export type RunChangeKind = "created" | "status" | "waiting";

export type RunChangeEvent = {
  runId: string;
  kind: RunChangeKind;
};

type RunChangeListener = (event: RunChangeEvent) => void;

export class RunChangeBus {
  private readonly listeners = new Set<RunChangeListener>();

  on(listener: RunChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  off(listener: RunChangeListener): void {
    this.listeners.delete(listener);
  }

  emit(event: RunChangeEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // Listener isolation: one throw must not block others.
      }
    }
  }
}

export function createRunChangeBus(): RunChangeBus {
  return new RunChangeBus();
}

const WRAPPED_MARKER = Symbol.for("stageflow.wrapRunStoreWithChangeBus");
const BUS_MARKER = Symbol.for("stageflow.runChangeBus");

export function isRunStoreWrapped(store: RunStore): boolean {
  return (store as object as Record<PropertyKey, unknown>)[WRAPPED_MARKER] === true;
}

export function getRunChangeBusFromWrappedStore(
  store: RunStore,
): RunChangeBus | undefined {
  const bus = (store as object as Record<PropertyKey, unknown>)[BUS_MARKER];
  return bus instanceof RunChangeBus ? bus : undefined;
}

export function wrapRunStoreWithChangeBus(
  store: RunStore,
  bus: RunChangeBus,
): RunStore {
  if (isRunStoreWrapped(store)) {
    const bound = getRunChangeBusFromWrappedStore(store);
    if (bound !== bus) {
      throw new Error(
        "runChangeBus does not match the bus already bound to the provided store",
      );
    }
    return store;
  }

  const createRun = async (input: CreateRunInput): Promise<CreatedRun> => {
    const created = await store.createRun(input);
    bus.emit({ runId: created.runId, kind: "created" });
    return created;
  };

  const updateRunStatus = async (
    runId: string,
    status: RunStatus,
  ): Promise<void> => {
    await store.updateRunStatus(runId, status);
    bus.emit({ runId, kind: "status" });
  };

  const appendStageEvent = async (
    runId: string,
    stageId: string,
    event: StageLogLine,
    options?: { attempt?: number },
  ): Promise<void> => {
    await store.appendStageEvent(runId, stageId, event, options);
    if (event.event === "waiting_for_input" || event.event === "resumed") {
      bus.emit({ runId, kind: "waiting" });
    }
  };

  const boundCache = new Map<PropertyKey, unknown>();
  return new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === WRAPPED_MARKER) return true;
      if (prop === BUS_MARKER) return bus;
      if (prop === "createRun") return createRun;
      if (prop === "updateRunStatus") return updateRunStatus;
      if (prop === "appendStageEvent") return appendStageEvent;
      const cached = boundCache.get(prop);
      if (cached !== undefined) return cached;
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === "function") {
        const bound = value.bind(target);
        boundCache.set(prop, bound);
        return bound;
      }
      return value;
    },
  });
}
