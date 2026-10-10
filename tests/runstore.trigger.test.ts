import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRunStore } from "../src/runstore/createStore.js";

describe("triggers registry", () => {
  it("upsertTrigger creates a trigger and getTrigger round-trips it", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "sf-trigger-reg-"));
    const store = createRunStore({ rootDir: home });

    const created = await store.upsertTrigger({
      id: "manual-hello-world",
      definitionRef: "triggers/manual-hello-world.trigger.yaml",
      enabled: true,
    });
    expect(created).toMatchObject({
      id: "manual-hello-world",
      definition_ref: "triggers/manual-hello-world.trigger.yaml",
      enabled: true,
    });
    expect(created.last_fired_at).toBeUndefined();
    expect(created.last_run_id).toBeUndefined();

    const fetched = await store.getTrigger("manual-hello-world");
    expect(fetched).toEqual(created);
  });

  it("getTrigger returns null for an unknown id", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "sf-trigger-miss-"));
    const store = createRunStore({ rootDir: home });
    expect(await store.getTrigger("no-such-trigger")).toBeNull();
  });

  it("upsertTrigger is idempotent and updates definition_ref/enabled in place", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "sf-trigger-upsert-"));
    const store = createRunStore({ rootDir: home });

    const first = await store.upsertTrigger({
      id: "t1",
      definitionRef: "triggers/t1.trigger.yaml",
      enabled: true,
    });
    const second = await store.upsertTrigger({
      id: "t1",
      definitionRef: "triggers/t1-renamed.trigger.yaml",
      enabled: false,
    });

    expect(second.id).toBe(first.id);
    expect(second.created_at).toBe(first.created_at);
    expect(second.definition_ref).toBe("triggers/t1-renamed.trigger.yaml");
    expect(second.enabled).toBe(false);

    const all = await store.listTriggers();
    expect(all).toHaveLength(1);
    expect(all[0]).toEqual(second);
  });

  it("listTriggers returns all registered triggers ordered by id", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "sf-trigger-list-"));
    const store = createRunStore({ rootDir: home });
    await store.upsertTrigger({
      id: "b-trigger",
      definitionRef: "triggers/b.trigger.yaml",
      enabled: true,
    });
    await store.upsertTrigger({
      id: "a-trigger",
      definitionRef: "triggers/a.trigger.yaml",
      enabled: false,
    });

    const all = await store.listTriggers();
    expect(all.map((t) => t.id)).toEqual(["a-trigger", "b-trigger"]);
  });

  it("recordTriggerFired stamps last_fired_at and last_run_id", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "sf-trigger-fire-"));
    const store = createRunStore({ rootDir: home });
    await store.upsertTrigger({
      id: "manual-hello-world",
      definitionRef: "triggers/manual-hello-world.trigger.yaml",
      enabled: true,
    });
    const { runId } = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
    });

    await store.recordTriggerFired("manual-hello-world", runId);

    const fired = await store.getTrigger("manual-hello-world");
    expect(fired?.last_run_id).toBe(runId);
    expect(fired?.last_fired_at).toEqual(expect.any(String));
    expect(await store.listTriggerFires("manual-hello-world", 20)).toEqual([
      { fired_at: fired?.last_fired_at, run_id: runId },
    ]);
  });

  it("listTriggerFires returns newest fires first and honors limit", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "sf-trigger-fires-"));
    const store = createRunStore({ rootDir: home });
    await store.upsertTrigger({
      id: "manual-hello-world",
      definitionRef: "triggers/manual-hello-world.trigger.yaml",
      enabled: true,
    });
    const { runId: older } = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
    });
    await store.recordTriggerFired("manual-hello-world", older);
    const { runId: newer } = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t2\ngoal: g\n",
    });
    await store.recordTriggerFired("manual-hello-world", newer);

    const fires = await store.listTriggerFires("manual-hello-world", 20);
    expect(fires.map((row) => row.run_id)).toEqual([newer, older]);
    expect(await store.listTriggerFires("manual-hello-world", 1)).toEqual([fires[0]]);
    expect(await store.listTriggerFires("other-trigger", 20)).toEqual([]);
  });

  it("recordTriggerFired throws for an unknown trigger id", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "sf-trigger-fire-miss-"));
    const store = createRunStore({ rootDir: home });
    await expect(
      store.recordTriggerFired("no-such-trigger", "some-run"),
    ).rejects.toThrow(/Trigger not found/);
  });

  it("setTriggerNextRun stamps next_run_at and round-trips it", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "sf-trigger-next-run-"));
    const store = createRunStore({ rootDir: home });
    const created = await store.upsertTrigger({
      id: "manual-hello-world",
      definitionRef: "triggers/manual-hello-world.trigger.yaml",
      enabled: true,
    });
    expect(created.next_run_at).toBeUndefined();

    await store.setTriggerNextRun("manual-hello-world", "2026-01-01T00:02:00.000Z");

    const fetched = await store.getTrigger("manual-hello-world");
    expect(fetched?.next_run_at).toBe("2026-01-01T00:02:00.000Z");
  });

  it("setTriggerNextRun throws for an unknown trigger id", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "sf-trigger-next-run-miss-"));
    const store = createRunStore({ rootDir: home });
    await expect(
      store.setTriggerNextRun("no-such-trigger", "2026-01-01T00:02:00.000Z"),
    ).rejects.toThrow(/Trigger not found/);
  });

  it("getTriggerAdapterState returns null for an unset key", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "sf-trigger-adapter-miss-"));
    const store = createRunStore({ rootDir: home });
    expect(await store.getTriggerAdapterState("t1", "cursor")).toBeNull();
  });

  it("setTriggerAdapterState/getTriggerAdapterState round-trips a value", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "sf-trigger-adapter-roundtrip-"));
    const store = createRunStore({ rootDir: home });
    await store.setTriggerAdapterState("t1", "cursor", "etag-abc");
    expect(await store.getTriggerAdapterState("t1", "cursor")).toBe("etag-abc");
  });

  it("setTriggerAdapterState overwrites an existing key (upsert)", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "sf-trigger-adapter-upsert-"));
    const store = createRunStore({ rootDir: home });
    await store.setTriggerAdapterState("t1", "cursor", "etag-abc");
    await store.setTriggerAdapterState("t1", "cursor", "etag-xyz");
    expect(await store.getTriggerAdapterState("t1", "cursor")).toBe("etag-xyz");
  });

  it("setTriggerAdapterState keeps state for different trigger_ids with the same key separate", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "sf-trigger-adapter-collide-"));
    const store = createRunStore({ rootDir: home });
    await store.setTriggerAdapterState("t1", "cursor", "etag-t1");
    await store.setTriggerAdapterState("t2", "cursor", "etag-t2");
    expect(await store.getTriggerAdapterState("t1", "cursor")).toBe("etag-t1");
    expect(await store.getTriggerAdapterState("t2", "cursor")).toBe("etag-t2");
  });
});
