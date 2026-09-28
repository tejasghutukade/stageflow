import { describe, expect, it } from "vitest";
import { coerceTriggerFile, parseTriggerFile } from "../src/config/loadTrigger.js";
import { findingsForTriggerRefs } from "../src/config/validateCatalog.js";

describe("coerceTriggerFile", () => {
  it("parses a minimal manual trigger", () => {
    const trigger = coerceTriggerFile({
      id: "manual-hello-world",
      pipeline: "hello-world",
      task: "hello-world",
      kind: "manual",
      enabled: true,
    });
    expect(trigger).toEqual({
      id: "manual-hello-world",
      pipeline: "hello-world",
      task: "hello-world",
      kind: "manual",
      enabled: true,
    });
  });

  it("parses schedule and event details", () => {
    const trigger = coerceTriggerFile({
      id: "nightly",
      pipeline: "hello-world",
      task: "hello-world",
      kind: "schedule",
      schedule: { cron: "0 2 * * *", timezone: "UTC" },
      enabled: false,
    });
    expect(trigger?.schedule).toEqual({ cron: "0 2 * * *", timezone: "UTC" });

    const eventTrigger = coerceTriggerFile({
      id: "on-issue",
      pipeline: "hello-world",
      task: "hello-world",
      kind: "event",
      event: { source: "github", match: { type: "issue" } },
      enabled: true,
    });
    expect(eventTrigger?.event).toEqual({ source: "github", match: { type: "issue" } });
  });

  it("parses a trigger with task omitted (dynamic mode)", () => {
    const trigger = coerceTriggerFile({
      id: "dynamic-hello",
      pipeline: "hello",
      kind: "manual",
      enabled: true,
    });
    expect(trigger).toEqual({
      id: "dynamic-hello",
      pipeline: "hello",
      kind: "manual",
      enabled: true,
    });
  });

  it("rejects an invalid kind", () => {
    const trigger = coerceTriggerFile({
      id: "bad",
      pipeline: "hello-world",
      task: "hello-world",
      kind: "cron",
      enabled: true,
    });
    expect(trigger).toBeUndefined();
  });

  it("returns a load failure for missing fields", () => {
    const outcome = parseTriggerFile({ id: "bad" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.issues[0].code).toBe("trigger.invalid_shape");
    }
  });
});

describe("findingsForTriggerRefs", () => {
  const trigger = {
    id: "manual-hello-world",
    pipeline: "hello-world",
    task: "hello-world",
    kind: "manual" as const,
    enabled: true,
  };

  it("reports no findings when refs resolve", () => {
    const findings = findingsForTriggerRefs("/repo", "/repo/manual.trigger.yaml", trigger, {
      pipelineIds: new Set(["hello-world"]),
      taskIds: new Set(["hello-world"]),
    });
    expect(findings).toEqual([]);
  });

  it("reports dangling pipeline and task refs", () => {
    const findings = findingsForTriggerRefs("/repo", "/repo/manual.trigger.yaml", trigger, {
      pipelineIds: new Set(),
      taskIds: new Set(),
    });
    expect(findings.map((f) => f.code)).toEqual([
      "trigger.unknown_pipeline",
      "trigger.unknown_task",
    ]);
    expect(findings.every((f) => f.category === "trigger")).toBe(true);
  });

  it("produces no task-related findings when task is absent (dynamic mode)", () => {
    const dynamicTrigger = {
      id: "dynamic-hello",
      pipeline: "hello-world",
      kind: "manual" as const,
      enabled: true,
    };
    const findings = findingsForTriggerRefs("/repo", "/repo/dynamic.trigger.yaml", dynamicTrigger, {
      pipelineIds: new Set(["hello-world"]),
      taskIds: new Set(),
    });
    expect(findings).toEqual([]);
  });
});
