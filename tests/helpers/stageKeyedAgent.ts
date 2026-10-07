import {
  scriptedFakeAgent,
  type FakeAgentBehavior,
} from "../../src/agent/fakeAgent.js";
import type { AgentPort, StageRunInput } from "../../src/agent/port.js";

export type StageKeyedAgent = AgentPort & {
  openCounts: Map<string, number>;
  sessionModes: Map<string, Array<string | undefined>>;
  feedbackContexts: Map<string, number>;
};

export type StageKeyedAgentOptions = {
  fallback?: FakeAgentBehavior;
  stageKey?: (input: StageRunInput) => string;
};

export function stageKeyedAgent(
  behaviorsByStage: Record<string, FakeAgentBehavior[]>,
  options: StageKeyedAgentOptions = {},
): StageKeyedAgent {
  const fallback = options.fallback ?? { type: "never_emit" as const };
  const keyOf = options.stageKey ?? ((input) => input.stage.id);
  const openCounts = new Map<string, number>();
  const stageIndex = new Map<string, number>();
  const sessionModes = new Map<string, Array<string | undefined>>();
  const feedbackContexts = new Map<string, number>();
  return {
    openCounts,
    sessionModes,
    feedbackContexts,
    openStage(input: StageRunInput) {
      const stageId = keyOf(input);
      openCounts.set(stageId, (openCounts.get(stageId) ?? 0) + 1);
      const modes = sessionModes.get(stageId) ?? [];
      modes.push(input.sessionMode);
      sessionModes.set(stageId, modes);
      if (input.feedbackLoopContext !== undefined) {
        feedbackContexts.set(
          stageId,
          (feedbackContexts.get(stageId) ?? 0) + 1,
        );
      }
      const index = stageIndex.get(stageId) ?? 0;
      stageIndex.set(stageId, index + 1);
      const behavior = behaviorsByStage[stageId]?.[index] ?? fallback;
      return scriptedFakeAgent([behavior]).openStage(input);
    },
    async runStage(input) {
      const handle = this.openStage(input);
      const event = await handle.next();
      await handle.close();
      if (event.status === "waiting_for_input") {
        return { ok: false, reason: "unexpected wait" };
      }
      return event.result;
    },
  };
}
