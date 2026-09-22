import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRunStore } from "../src/runstore/createStore.js";
import { storeRootFor } from "../src/runstore/paths.js";

describe("run retention fixtures (U1 columns)", () => {
  it("exposes finished_at and slimmed_at for later retention decisions", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-retention-fixture-"));
    const store = createRunStore({ rootDir: root, kind: "sqlite" });
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
    });
    await store.updateRunStatus(run.runId, "succeeded");

    const meta = await store.readRunMeta(run.runId);
    expect(meta.finished_at).toBeDefined();
    expect(meta.slimmed_at).toBeUndefined();

    const db = new Database(path.join(storeRootFor(root), "state.db"));
    const cols = new Set(
      (db.prepare(`PRAGMA table_info(runs)`).all() as { name: string }[]).map(
        (c) => c.name,
      ),
    );
    for (const name of [
      "cancel_reason",
      "finished_at",
      "slimmed_at",
      "disk_bytes",
      "disk_measured_at",
    ]) {
      expect(cols.has(name)).toBe(true);
    }
    db.close();
  });
});
