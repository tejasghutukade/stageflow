import type { StageActivityEvent } from "./activity.js";

export type StageActivityObserver = {
  onAssistantTextDelta(delta: string): void;
  onStreamBoundary(): void;
  onActivity(activity: StageActivityEvent): void;
  dispose(): void;
};

export type CreateStageActivityObserverOptions = {
  onActivity?: (event: StageActivityEvent) => void;
  writeStderr?: boolean;
};

function writeActivityStderr(activity: StageActivityEvent): void {
  switch (activity.event) {
    case "agent_start":
      process.stderr.write("  … agent started\n");
      return;
    case "agent_end":
      process.stderr.write("  … agent settled\n");
      return;
    case "turn_start":
      process.stderr.write("  … turn\n");
      return;
    case "tool_start":
      process.stderr.write(`  → ${activity.toolName}\n`);
      return;
    case "tool_end":
      if (activity.isError) {
        process.stderr.write(`  ✕ ${activity.toolName}\n`);
      }
      return;
    case "message":
      return;
  }
}

/**
 * Observe StageActivityEvent milestones and optional assistant text deltas.
 * Pi (or any adapter) maps provider events to StageActivityEvent before calling
 * onActivity — Record-shaped SDK events never enter this module.
 */
export function createStageActivityObserver(
  options: CreateStageActivityObserverOptions = {},
): StageActivityObserver {
  const writeStderr = options.writeStderr !== false;
  let inAssistantText = false;

  const endTextLine = () => {
    if (!inAssistantText) {
      return;
    }
    if (writeStderr) {
      process.stderr.write("\n");
    }
    inAssistantText = false;
  };

  return {
    onAssistantTextDelta(delta: string) {
      if (!writeStderr || !delta) {
        return;
      }
      if (!inAssistantText) {
        process.stderr.write("  ");
        inAssistantText = true;
      }
      process.stderr.write(delta);
    },
    onStreamBoundary() {
      endTextLine();
    },
    onActivity(activity: StageActivityEvent) {
      endTextLine();
      options.onActivity?.(activity);
      if (writeStderr) {
        writeActivityStderr(activity);
      }
    },
    dispose() {
      endTextLine();
    },
  };
}
