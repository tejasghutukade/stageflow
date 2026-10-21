import { describe, expect, it } from "vitest";
import type { ToolCallView } from "./runDetailTranscriptModel";
import {
  formatToolCallDuration,
  toolCallArgSummary,
  toolCallDurationMs,
} from "./runDetailTranscriptFormat";

describe("toolCallArgSummary", () => {
  it("extracts bash command from JSON args", () => {
    const call: ToolCallView = {
      name: "bash",
      status: "complete",
      args: '{"command":"npm test"}',
    };
    expect(toolCallArgSummary(call)).toBe("npm test");
  });

  it("shows basename for read file_path", () => {
    const call: ToolCallView = {
      name: "read",
      status: "complete",
      args: '{"file_path":"/repo/src/foo.ts"}',
    };
    expect(toolCallArgSummary(call)).toBe("foo.ts");
  });
});

describe("toolCallDurationMs", () => {
  it("computes elapsed time for completed tools", () => {
    const call: ToolCallView = {
      name: "bash",
      status: "complete",
      startedAt: "2020-01-01T00:00:00.000Z",
      at: "2020-01-01T00:00:05.000Z",
    };
    expect(toolCallDurationMs(call, Date.now())).toBe(5000);
    expect(formatToolCallDuration(call, Date.now())).toBe("5s");
  });
});
