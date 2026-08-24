import { describe, expect, it } from "vitest";
import { mkdtemp, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRunStore } from "../src/runstore/createStore.js";
import { attemptAgentDir } from "../src/runstore/workspaceLayout.js";

describe("runstore layout", () => {
  it("creating a run yields workspace and persisted meta/task", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-run-"));
    const store = createRunStore({ rootDir: root });
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t1\ngoal: demo\n",
    });

    const meta = await store.readRunMeta(run.runId);
    expect(meta.pipeline_id).toBe("docs-only");
    expect(meta.checkout_root).toBeUndefined();
    expect(await store.readTaskYaml(run.runId)).toContain("goal: demo");
  });

  it("stamps checkout_root on meta when createRun receives checkoutRoot", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-run-"));
    const checkout = await mkdtemp(path.join(tmpdir(), "sf-checkout-"));
    const store = createRunStore({ rootDir: root });
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t1\ngoal: demo\n",
      checkoutRoot: checkout,
    });

    const meta = await store.readRunMeta(run.runId);
    expect(meta.checkout_root).toBe(checkout);
  });

  it("writeEnvelope and readEnvelope roundtrip", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-run-"));
    const store = createRunStore({ rootDir: root });
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t1\ngoal: demo\n",
    });

    const envelope = {
      status: "success" as const,
      summary: "done",
      artifacts: ["stages/clarify/attempts/1/artifacts/notes.md"],
    };
    await store.createStageExecution(run.runId, "clarify");
    await store.writeEnvelope(run.runId, "clarify", envelope);
    await expect(store.readEnvelope(run.runId, "clarify")).resolves.toEqual(envelope);
  });

  it("failed run still leaves attempt workspace intact", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-run-"));
    const store = createRunStore({ rootDir: root });
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t1\ngoal: demo\n",
    });

    await store.appendStageEvent(run.runId, "clarify", {
      event: "failed",
      reason: "missing emit",
    });
    const events = await store.listStageEvents(run.runId, "clarify");
    expect(events.some((e) => e.event === "failed")).toBe(true);
    await access(attemptAgentDir(run.workspaceDir, "clarify", 1));
  });
});
