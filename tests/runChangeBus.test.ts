import { describe, expect, it } from "vitest";
import {
  createRunChangeBus,
  wrapRunStoreWithChangeBus,
} from "../src/runtime/runChangeBus.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

describe("RunChangeBus", () => {
  it("emits status after updateRunStatus", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-bus-"));
    const bus = createRunChangeBus();
    const events: Array<{ runId: string; kind: string }> = [];
    bus.on((e) => events.push({ ...e }));
    const store = wrapRunStoreWithChangeBus(
      createRunStore({ rootDir: root }),
      bus,
    );
    const { runId } = await store.createRun({
      pipelineId: "p",
      taskYaml: "id: t\ngoal: g\n",
    });
    await store.updateRunStatus(runId, "succeeded");
    expect(events).toEqual([
      { runId, kind: "created" },
      { runId, kind: "status" },
    ]);
  });

  it("emits waiting on waiting_for_input and resumed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-bus-wait-"));
    const bus = createRunChangeBus();
    const kinds: string[] = [];
    bus.on((e) => kinds.push(e.kind));
    const store = wrapRunStoreWithChangeBus(
      createRunStore({ rootDir: root }),
      bus,
    );
    const { runId } = await store.createRun({
      pipelineId: "p",
      taskYaml: "id: t\ngoal: g\n",
    });
    await store.appendStageEvent(runId, "clarify", {
      event: "waiting_for_input",
    });
    await store.appendStageEvent(runId, "clarify", { event: "resumed" });
    await store.appendStageEvent(runId, "clarify", {
      event: "started",
    });
    expect(kinds.filter((k) => k === "waiting")).toEqual(["waiting", "waiting"]);
    expect(kinds.includes("created")).toBe(true);
  });

  it("isolates throwing listeners", () => {
    const bus = createRunChangeBus();
    const seen: string[] = [];
    bus.on(() => {
      throw new Error("boom");
    });
    bus.on((e) => seen.push(e.runId));
    bus.emit({ runId: "r1", kind: "status" });
    expect(seen).toEqual(["r1"]);
  });
});
