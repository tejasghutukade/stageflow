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

export function wrapRunStoreWithChangeBus(
  store: RunStore,
  bus: RunChangeBus,
): RunStore {
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

  return new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === "createRun") return createRun;
      if (prop === "updateRunStatus") return updateRunStatus;
      if (prop === "appendStageEvent") return appendStageEvent;
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === "function") {
        return value.bind(target);
      }
      return value;
    },
  });
}
