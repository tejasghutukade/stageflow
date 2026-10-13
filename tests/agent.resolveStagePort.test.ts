import { describe, expect, it } from "vitest";
import {
  createPiStagePort,
  globalStageBackendFromManifest,
  resolveStageBackend,
  resolveStagePort,
} from "../src/agent/resolveStagePort.js";
import { STAGE_LEVEL_AGENT_OVERRIDE_ENABLED } from "../src/agent/agentBackend.js";
import { PiAgentAdapter } from "../src/agent/piAdapter.js";
import { ClaudeAgentAdapter } from "../src/agent/claudeAdapter.js";
import type { LoadedManifest } from "../src/types/stageflowManifest.js";

describe("resolveStageBackend — precedence", () => {
  it("defaults to pi when nothing is set", () => {
    expect(resolveStageBackend({})).toBe("pi");
    expect(resolveStageBackend()).toBe("pi");
  });

  it("global wins over the default", () => {
    expect(resolveStageBackend({ global: "claude" })).toBe("claude");
  });

  it("pipeline overrides global", () => {
    expect(resolveStageBackend({ global: "claude", pipeline: "pi" })).toBe("pi");
    expect(resolveStageBackend({ global: "pi", pipeline: "claude" })).toBe("claude");
  });

  it("pipeline wins even when only pipeline is set", () => {
    expect(resolveStageBackend({ pipeline: "claude" })).toBe("claude");
  });

  it("stage is gated off — pipeline/global win even when stage disagrees", () => {
    expect(STAGE_LEVEL_AGENT_OVERRIDE_ENABLED).toBe(false);
    expect(resolveStageBackend({ stage: "claude", pipeline: "pi" })).toBe("pi");
    expect(resolveStageBackend({ stage: "claude", global: "pi" })).toBe("pi");
    // stage alone still can't win while gated, even with nothing else set
    expect(resolveStageBackend({ stage: "claude" })).toBe("pi");
  });
});

describe("resolveStagePort — constructs the matching adapter", () => {
  it('"pi" (or unset) constructs a PiAgentAdapter', () => {
    expect(resolveStagePort()).toBeInstanceOf(PiAgentAdapter);
    expect(resolveStagePort({ global: "pi" })).toBeInstanceOf(PiAgentAdapter);
    expect(createPiStagePort()).toBeInstanceOf(PiAgentAdapter);
  });

  it('"claude" constructs a ClaudeAgentAdapter', () => {
    expect(resolveStagePort({ global: "claude" })).toBeInstanceOf(ClaudeAgentAdapter);
    expect(resolveStagePort({ pipeline: "claude" })).toBeInstanceOf(ClaudeAgentAdapter);
  });
});

function manifestWithAgent(agent: string | undefined): LoadedManifest {
  return {
    path: "/tmp/stageflow.yaml",
    projectRoot: "/tmp",
    manifest: {
      version: 1,
      catalog: { pipelines: [], tasks: [] },
      ...(agent !== undefined ? { agent } : {}),
    },
    patterns: { pipeline: "*.pipeline.yaml", task: "*.task.yaml" },
  };
}

describe("globalStageBackendFromManifest", () => {
  it("returns undefined for a null manifest (missing/invalid stageflow.yaml)", () => {
    expect(globalStageBackendFromManifest(null)).toBeUndefined();
  });

  it("returns undefined when the manifest has no agent field", () => {
    expect(globalStageBackendFromManifest(manifestWithAgent(undefined))).toBeUndefined();
  });

  it("returns the manifest's agent field when it's a known backend id", () => {
    expect(globalStageBackendFromManifest(manifestWithAgent("claude"))).toBe("claude");
    expect(globalStageBackendFromManifest(manifestWithAgent("pi"))).toBe("pi");
  });

  it("returns undefined for an unrecognized value rather than throwing", () => {
    expect(globalStageBackendFromManifest(manifestWithAgent("not-a-real-backend"))).toBeUndefined();
  });
});
