import { describe, expect, it } from "vitest";
import {
  globalAgentBackendFromManifest,
  resolveAgentBackend,
  resolveAgentPort,
} from "../src/agent/resolveAgentPort.js";
import { STAGE_LEVEL_AGENT_OVERRIDE_ENABLED } from "../src/agent/agentBackend.js";
import { PiAgentAdapter } from "../src/agent/piAdapter.js";
import { ClaudeAgentAdapter } from "../src/agent/claudeAdapter.js";
import type { LoadedManifest } from "../src/types/stageflowManifest.js";

describe("resolveAgentBackend — precedence", () => {
  it("defaults to pi when nothing is set", () => {
    expect(resolveAgentBackend({})).toBe("pi");
    expect(resolveAgentBackend()).toBe("pi");
  });

  it("global wins over the default", () => {
    expect(resolveAgentBackend({ global: "claude" })).toBe("claude");
  });

  it("pipeline overrides global", () => {
    expect(resolveAgentBackend({ global: "claude", pipeline: "pi" })).toBe("pi");
    expect(resolveAgentBackend({ global: "pi", pipeline: "claude" })).toBe("claude");
  });

  it("pipeline wins even when only pipeline is set", () => {
    expect(resolveAgentBackend({ pipeline: "claude" })).toBe("claude");
  });

  it("stage is gated off — pipeline/global win even when stage disagrees", () => {
    expect(STAGE_LEVEL_AGENT_OVERRIDE_ENABLED).toBe(false);
    expect(resolveAgentBackend({ stage: "claude", pipeline: "pi" })).toBe("pi");
    expect(resolveAgentBackend({ stage: "claude", global: "pi" })).toBe("pi");
    // stage alone still can't win while gated, even with nothing else set
    expect(resolveAgentBackend({ stage: "claude" })).toBe("pi");
  });
});

describe("resolveAgentPort — constructs the matching adapter", () => {
  it('"pi" (or unset) constructs a PiAgentAdapter', () => {
    expect(resolveAgentPort()).toBeInstanceOf(PiAgentAdapter);
    expect(resolveAgentPort({ global: "pi" })).toBeInstanceOf(PiAgentAdapter);
  });

  it('"claude" constructs a ClaudeAgentAdapter', () => {
    expect(resolveAgentPort({ global: "claude" })).toBeInstanceOf(ClaudeAgentAdapter);
    expect(resolveAgentPort({ pipeline: "claude" })).toBeInstanceOf(ClaudeAgentAdapter);
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

describe("globalAgentBackendFromManifest", () => {
  it("returns undefined for a null manifest (missing/invalid stageflow.yaml)", () => {
    expect(globalAgentBackendFromManifest(null)).toBeUndefined();
  });

  it("returns undefined when the manifest has no agent field", () => {
    expect(globalAgentBackendFromManifest(manifestWithAgent(undefined))).toBeUndefined();
  });

  it("returns the manifest's agent field when it's a known backend id", () => {
    expect(globalAgentBackendFromManifest(manifestWithAgent("claude"))).toBe("claude");
    expect(globalAgentBackendFromManifest(manifestWithAgent("pi"))).toBe("pi");
  });

  it("returns undefined for an unrecognized value rather than throwing", () => {
    expect(globalAgentBackendFromManifest(manifestWithAgent("not-a-real-backend"))).toBeUndefined();
  });
});
