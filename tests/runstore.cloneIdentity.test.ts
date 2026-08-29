import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCompletedOnlyStageHandle } from "../src/agent/port.js";
import { createRunStore } from "../src/runstore/createStore.js";
import {
  appendCloneInstances,
  linearCompatDagSnapshot,
} from "../src/runstore/pipelineDagSnapshot.js";
import { storeRootFor } from "../src/runstore/paths.js";
import { attemptWorkspaceDir } from "../src/runstore/workspaceLayout.js";
import { StageHitlController, waitKey } from "../src/runtime/stageHitl.js";

describe("clone instance identity collisions", () => {
  async function twoInstanceRun() {
    const root = await mkdtemp(path.join(tmpdir(), "sf-clone-id-"));
    const frozen = linearCompatDagSnapshot([
      "detect",
      "author-diagrams",
      "collect",
    ]);
    const { snapshot, instanceIds } = appendCloneInstances(frozen, {
      catalogId: "author-diagrams",
      predecessorId: "detect",
      count: 2,
    });
    const store = createRunStore({ rootDir: root, kind: "sqlite" });
    const run = await store.createRun({
      pipelineId: "clone-id",
      taskYaml: "id: t\ngoal: g\n",
      pipelineDag: snapshot,
    });
    await store.updatePipelineDag(run.runId, snapshot);
    for (const id of instanceIds) {
      await store.ensureStageWorkspace(run.runId, id);
      await store.createStageExecution(run.runId, id);
    }
    return { root, store, run, snapshot, instanceIds };
  }

  it("AE5: two instance ids do not share PK, directory, or track node", async () => {
    const { root, store, run, instanceIds } = await twoInstanceRun();
    const [id1, id2] = instanceIds;
    expect(id1).toBe("author-diagrams~1");
    expect(id2).toBe("author-diagrams~2");

    const db = new Database(path.join(storeRootFor(root), "state.db"));
    const stageRows = db
      .prepare(`SELECT stage_id FROM stages WHERE run_id = ? ORDER BY stage_id`)
      .all(run.runId) as { stage_id: string }[];
    expect(stageRows.map((r) => r.stage_id)).toEqual([id1, id2]);
    const cols = db.prepare(`PRAGMA table_info(stages)`).all() as {
      name: string;
    }[];
    expect(cols.map((c) => c.name)).not.toContain("definition_id");

    const exec1 = await store.listStageExecutions(run.runId, id1);
    const exec2 = await store.listStageExecutions(run.runId, id2);
    expect(exec1).toEqual([
      expect.objectContaining({ stage_id: id1, attempt: 1 }),
    ]);
    expect(exec2).toEqual([
      expect.objectContaining({ stage_id: id2, attempt: 1 }),
    ]);

    const ws = store.getWorkspaceDir(run.runId);
    expect(attemptWorkspaceDir(ws, id1, 1)).not.toBe(
      attemptWorkspaceDir(ws, id2, 1),
    );

    const detail = await store.readRun(run.runId);
    const cloneNodes = detail.pipeline_track.nodes.filter(
      (n) => n.definition_id === "author-diagrams",
    );
    expect(cloneNodes.map((n) => n.stage_id)).toEqual([id1, id2]);
    expect(detail.pipeline_track.nodes.map((n) => n.stage_id)).not.toContain(
      "author-diagrams",
    );
  });

  it("second execution on ~1 is attempt 2, not a third clone", async () => {
    const { store, run } = await twoInstanceRun();
    const retry = await store.createStageExecution(
      run.runId,
      "author-diagrams~1",
    );
    expect(retry.attempt).toBe(2);
    expect(retry.stage_id).toBe("author-diagrams~1");
    const other = await store.listStageExecutions(
      run.runId,
      "author-diagrams~2",
    );
    expect(other).toHaveLength(1);
    expect(other[0]?.attempt).toBe(1);
  });

  it("waitKeys differ; duplicate wait throws only for the same instance", async () => {
    const { store, run } = await twoInstanceRun();
    const runId = run.runId;
    expect(waitKey(runId, "author-diagrams~1")).not.toBe(
      waitKey(runId, "author-diagrams~2"),
    );

    const hitl = new StageHitlController({ store });
    const request = {
      kind: "free_text",
      id: "p1",
      message: "?",
    };
    const handle = (stageId: string) =>
      createCompletedOnlyStageHandle({
        stageId,
        run: () =>
          Promise.resolve({
            ok: true,
            envelope: { status: "success", summary: "x", artifacts: [] },
          }),
      });

    const parked1 = hitl.enterWait(
      runId,
      "author-diagrams~1",
      handle("author-diagrams~1"),
      request,
    );
    const parked2 = hitl.enterWait(
      runId,
      "author-diagrams~2",
      handle("author-diagrams~2"),
      request,
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(hitl.hasLiveWait(runId, "author-diagrams~1")).toBe(true);
    expect(hitl.hasLiveWait(runId, "author-diagrams~2")).toBe(true);

    const dup = hitl.enterWait(
      runId,
      "author-diagrams~1",
      handle("author-diagrams~1"),
      request,
    );
    await expect(parked1).rejects.toThrow(/duplicate wait/);
    expect(hitl.hasLiveWait(runId, "author-diagrams~2")).toBe(true);
    hitl.clearLiveWait(runId, "author-diagrams~1");
    hitl.clearLiveWait(runId, "author-diagrams~2");
    await dup.catch(() => undefined);
    await parked2.catch(() => undefined);
  });
});
