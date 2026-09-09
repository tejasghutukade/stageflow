import { describe, expect, it } from "vitest";
import {
  globalModelFromManifest,
  resolveModelOutcome,
} from "../src/config/resolveModel.js";
import { parseModelField } from "../src/config/modelField.js";
import type { LoadedManifest } from "../src/types/stageflowManifest.js";

describe("resolveModelOutcome — precedence", () => {
  const ctx = { stageId: "plan", pipelineId: "hello" };

  it("fails when nothing is set", () => {
    const outcome = resolveModelOutcome({}, ctx);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.code).toBe("stage.missing_model");
    expect(outcome.issues[0]?.message).toMatch(/plan/);
    expect(outcome.issues[0]?.message).toMatch(/hello/);
  });

  it("global alone succeeds", () => {
    const outcome = resolveModelOutcome({ global: "anthropic/claude-sonnet-4-5" }, ctx);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value).toBe("anthropic/claude-sonnet-4-5");
  });

  it("pipeline overrides global", () => {
    const outcome = resolveModelOutcome(
      {
        global: "anthropic/claude-sonnet-4-5",
        pipeline: "openai/gpt-4o",
      },
      ctx,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value).toBe("openai/gpt-4o");
  });

  it("stage overrides pipeline and global", () => {
    const outcome = resolveModelOutcome(
      {
        global: "anthropic/claude-sonnet-4-5",
        pipeline: "openai/gpt-4o",
        stage: "google/gemini-2.5-pro",
      },
      ctx,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value).toBe("google/gemini-2.5-pro");
  });

  it("stage alone succeeds", () => {
    const outcome = resolveModelOutcome({ stage: "anthropic/claude-opus-4" }, ctx);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value).toBe("anthropic/claude-opus-4");
  });
});

describe("parseModelField", () => {
  it("accepts absent", () => {
    expect(parseModelField(undefined)).toEqual({ ok: true, value: undefined });
  });

  it("rejects empty and whitespace-only strings", () => {
    expect(parseModelField("").ok).toBe(false);
    expect(parseModelField("   ").ok).toBe(false);
    expect(parseModelField(null).ok).toBe(false);
    expect(parseModelField(1).ok).toBe(false);
  });

  it("trims a valid string", () => {
    expect(parseModelField("  anthropic/claude-sonnet-4-5  ")).toEqual({
      ok: true,
      value: "anthropic/claude-sonnet-4-5",
    });
  });
});

function manifestWithModel(model: string | undefined): LoadedManifest {
  return {
    path: "/tmp/stageflow.yaml",
    projectRoot: "/tmp",
    manifest: {
      version: 1,
      catalog: { pipelines: [], tasks: [] },
      ...(model !== undefined ? { model } : {}),
    },
    patterns: { pipeline: "*.pipeline.yaml", task: "*.task.yaml" },
  };
}

describe("globalModelFromManifest", () => {
  it("returns undefined for a null manifest", () => {
    expect(globalModelFromManifest(null)).toBeUndefined();
  });

  it("returns undefined when the manifest has no model field", () => {
    expect(globalModelFromManifest(manifestWithModel(undefined))).toBeUndefined();
  });

  it("returns the manifest model when set", () => {
    expect(globalModelFromManifest(manifestWithModel("openai/gpt-4o"))).toBe(
      "openai/gpt-4o",
    );
  });
});
