import type { StageActivityEvent } from "./activity.js";

export type StageActivityObserver = {
  onAssistantTextDelta(delta: string): void;
  onThinkingDelta(delta: string): void;
  onToolPartialResult(accumulatedText: string): void;
  onStreamBoundary(): void;
  onActivity(activity: StageActivityEvent): void;
  dispose(): void;
};

export type CreateStageActivityObserverOptions = {
  onActivity?: (event: StageActivityEvent) => void;
  writeStderr?: boolean;
};

type OpenStream = "none" | "assistant" | "thinking" | "tool";

function writeIndentedPreview(preview: string): void {
  for (const line of preview.split("\n")) {
    process.stderr.write(`    ${line}\n`);
  }
}

function writeActivityStderr(
  activity: StageActivityEvent,
  skipAssistantMessage: boolean,
): void {
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
      if (activity.argsPreview) {
        writeIndentedPreview(activity.argsPreview);
      }
      return;
    case "tool_end":
      if (activity.isError) {
        process.stderr.write(`  ✕ ${activity.toolName}\n`);
      } else if (activity.resultPreview) {
        process.stderr.write(`  ← ${activity.toolName}\n`);
      }
      if (activity.resultPreview) {
        writeIndentedPreview(activity.resultPreview);
      }
      return;
    case "message":
      if (activity.role === "assistant" && skipAssistantMessage) {
        return;
      }
      if (activity.text) {
        writeIndentedPreview(activity.text);
      }
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
  let openStream: OpenStream = "none";
  let assistantStreamedForMessage = false;
  let lastToolPartial = "";

  const endOpenStream = () => {
    if (openStream === "none") {
      return;
    }
    if (writeStderr) {
      process.stderr.write("\n");
    }
    openStream = "none";
  };

  return {
    onAssistantTextDelta(delta: string) {
      if (!writeStderr || !delta) {
        return;
      }
      assistantStreamedForMessage = true;
      if (openStream !== "assistant") {
        endOpenStream();
        process.stderr.write("  ");
        openStream = "assistant";
      }
      process.stderr.write(delta);
    },
    onThinkingDelta(delta: string) {
      if (!writeStderr || !delta) {
        return;
      }
      if (openStream !== "thinking") {
        endOpenStream();
        process.stderr.write("  ∴ ");
        openStream = "thinking";
      }
      process.stderr.write(delta);
    },
    onToolPartialResult(accumulatedText: string) {
      if (!writeStderr || !accumulatedText) {
        return;
      }
      const delta = accumulatedText.startsWith(lastToolPartial)
        ? accumulatedText.slice(lastToolPartial.length)
        : accumulatedText;
      lastToolPartial = accumulatedText;
      if (!delta) {
        return;
      }
      if (openStream !== "tool") {
        endOpenStream();
        process.stderr.write("  │ ");
        openStream = "tool";
      }
      process.stderr.write(delta);
    },
    onStreamBoundary() {
      endOpenStream();
      lastToolPartial = "";
    },
    onActivity(activity: StageActivityEvent) {
      endOpenStream();
      lastToolPartial = "";
      if (activity.event === "turn_start") {
        assistantStreamedForMessage = false;
      }
      const skipAssistantMessage =
        activity.event === "message" &&
        activity.role === "assistant" &&
        assistantStreamedForMessage;
      if (
        activity.event === "message" &&
        activity.role === "assistant"
      ) {
        assistantStreamedForMessage = false;
      }
      options.onActivity?.(activity);
      if (writeStderr) {
        writeActivityStderr(activity, skipAssistantMessage);
      }
    },
    dispose() {
      endOpenStream();
    },
  };
}
