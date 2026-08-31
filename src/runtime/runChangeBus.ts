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
  return {
    createRun: async (input: CreateRunInput): Promise<CreatedRun> => {
      const created = await store.createRun(input);
      bus.emit({ runId: created.runId, kind: "created" });
      return created;
    },
    updateRunStatus: async (runId: string, status: RunStatus): Promise<void> => {
      await store.updateRunStatus(runId, status);
      bus.emit({ runId, kind: "status" });
    },
    appendStageEvent: async (
      runId: string,
      stageId: string,
      event: StageLogLine,
      options?: { attempt?: number },
    ): Promise<void> => {
      await store.appendStageEvent(runId, stageId, event, options);
      if (event.event === "waiting_for_input" || event.event === "resumed") {
        bus.emit({ runId, kind: "waiting" });
      }
    },
    readRunMeta: (runId) => store.readRunMeta(runId),
    readTaskYaml: (runId) => store.readTaskYaml(runId),
    getWorkspaceDir: (runId) => store.getWorkspaceDir(runId),
    ensureStageWorkspace: (runId, stageId) =>
      store.ensureStageWorkspace(runId, stageId),
    ensureAttemptWorkspace: (runId, stageId, attempt) =>
      store.ensureAttemptWorkspace(runId, stageId, attempt),
    createStageExecution: (runId, stageId) =>
      store.createStageExecution(runId, stageId),
    listStageExecutions: (runId, stageId) =>
      store.listStageExecutions(runId, stageId),
    getLatestStageExecution: (runId, stageId) =>
      store.getLatestStageExecution(runId, stageId),
    countStageAttempts: (runId, stageId) =>
      store.countStageAttempts(runId, stageId),
    getStageExecution: (runId, stageId, attempt) =>
      store.getStageExecution(runId, stageId, attempt),
    updateStageExecution: (runId, stageId, attempt, patch) =>
      store.updateStageExecution(runId, stageId, attempt, patch),
    writeEnvelope: (runId, stageId, envelope, options) =>
      store.writeEnvelope(runId, stageId, envelope, options),
    readEnvelope: (runId, stageId) => store.readEnvelope(runId, stageId),
    listStageEvents: (runId, stageId, attempt) =>
      store.listStageEvents(runId, stageId, attempt),
    listRuns: (filter) => store.listRuns(filter),
    readRun: (runId) => store.readRun(runId),
    updatePipelineDag: (runId, dag) => store.updatePipelineDag(runId, dag),
  };
}
