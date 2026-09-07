import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  claudeSessionMarkerPath,
  clearClaudeSessionMarker,
  readClaudeSessionMarker,
  writeClaudeSessionMarker,
} from "../src/agent/claudeSession.js";
import { buildStageRoots } from "../src/runtime/stageRoots.js";
import type { StageRunInput } from "../src/agent/port.js";

function baseInput(overrides: Partial<StageRunInput> = {}): StageRunInput {
  return {
    roots: buildStageRoots("/tmp/claude-session-test-ws", "review"),
    stage: { id: "review", system_prompt: "review", model: "anthropic/claude-sonnet-4-5" },
    task: { id: "t1", goal: "review" },
    priorEnvelope: null,
    ...overrides,
  };
}

describe("claudeSessionMarkerPath — resumeToken-derived branch", () => {
  // The production shape: the runtime always supplies a resumeToken (Pi's
  // own session-path convention, see openStageAttempt). This is the branch
  // that was previously exercised only implicitly, through the fallback.
  it("derives a sibling of resumeToken's directory, never resumeToken itself", () => {
    const resumeToken = "/runs/r1/stages/review/attempts/1/pi-session.jsonl";
    const input = baseInput({ resumeToken });
    const markerPath = claudeSessionMarkerPath(input);

    expect(markerPath).not.toBe(resumeToken);
    expect(path.dirname(markerPath)).toBe(path.dirname(resumeToken));
    expect(path.basename(markerPath)).toBe("claude-session.json");
  });

  it("two different attempts (different resumeToken dirs) never collide", () => {
    const attempt1 = claudeSessionMarkerPath(
      baseInput({ resumeToken: "/runs/r1/stages/review/attempts/1/pi-session.jsonl" }),
    );
    const attempt2 = claudeSessionMarkerPath(
      baseInput({ resumeToken: "/runs/r1/stages/review/attempts/2/pi-session.jsonl" }),
    );
    expect(attempt1).not.toBe(attempt2);
  });
});

describe("claudeSessionMarkerPath — fallback branch (no resumeToken)", () => {
  it("falls back to a path under roots.runWorkspaceDir keyed by stage id", () => {
    const input = baseInput({ resumeToken: undefined });
    const markerPath = claudeSessionMarkerPath(input);
    expect(markerPath).toBe(
      path.join("/tmp/claude-session-test-ws", "stages", "review", "claude-session.json"),
    );
  });

  it("an empty-string resumeToken is treated as absent", () => {
    const input = baseInput({ resumeToken: "" });
    const markerPath = claudeSessionMarkerPath(input);
    expect(markerPath).toBe(
      path.join("/tmp/claude-session-test-ws", "stages", "review", "claude-session.json"),
    );
  });
});

describe("marker read/write/clear round-trip", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "sf-claude-session-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("readClaudeSessionMarker returns undefined when nothing has been written", async () => {
    const markerPath = path.join(dir, "claude-session.json");
    await expect(readClaudeSessionMarker(markerPath)).resolves.toBeUndefined();
  });

  it("writes, reads back, and clears a marker", async () => {
    const markerPath = path.join(dir, "nested", "claude-session.json");
    await writeClaudeSessionMarker(markerPath, {
      sessionId: "s1",
      prompt: { kind: "confirm", message: "Proceed?", id: "q1" },
    });

    const read = await readClaudeSessionMarker(markerPath);
    expect(read).toEqual({
      sessionId: "s1",
      prompt: { kind: "confirm", message: "Proceed?", id: "q1" },
    });

    await clearClaudeSessionMarker(markerPath);
    expect(existsSync(markerPath)).toBe(false);
    await expect(readClaudeSessionMarker(markerPath)).resolves.toBeUndefined();
  });

  it("clearClaudeSessionMarker on a path that never existed does not throw", async () => {
    const markerPath = path.join(dir, "never-written.json");
    await expect(clearClaudeSessionMarker(markerPath)).resolves.toBeUndefined();
  });
});
