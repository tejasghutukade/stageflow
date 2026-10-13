import {
  createCompletedOnlyStageHandle,
  type StagePort,
  type StageRunInput,
} from "../../src/agent/port.js";
import { okEnvelope } from "./envelopes.js";

type WithRunId = StageRunInput & { runId: string };

function runIdOf(input: StageRunInput): string {
  return (input as WithRunId).runId;
}

export function gatedAgent(gate: Promise<void>): StagePort {
  return {
    openStage(input: StageRunInput) {
      return createCompletedOnlyStageHandle({
        stageId: input.stage.id,
        run: async () => {
          await gate;
          return { ok: true as const, envelope: okEnvelope("ok") };
        },
      });
    },
    async runStage() {
      await gate;
      return { ok: true as const, envelope: okEnvelope("ok") };
    },
  };
}

export function recordingAgent(starts: string[]): StagePort {
  return {
    openStage(input: StageRunInput) {
      starts.push(runIdOf(input));
      return createCompletedOnlyStageHandle({
        stageId: input.stage.id,
        run: async () => ({ ok: true as const, envelope: okEnvelope("ok") }),
      });
    },
    async runStage(input) {
      starts.push(runIdOf(input));
      return { ok: true as const, envelope: okEnvelope("ok") };
    },
  };
}
