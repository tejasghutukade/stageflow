import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { catalogRootsForArtifacts } from "../src/artifacts/projectScope.js";
import { publishSessionArtifact } from "../src/artifacts/sessionPublish.js";
import { withPublishedArtifacts } from "../src/cli/runOutput.js";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";
import { createRunStore, sqliteConnectionFromStore } from "../src/runstore/createStore.js";

const cleanups: Array<() => Promise<void>> = [];
const previousHome = process.env.STAGEFLOW_HOME;

afterEach(async () => {
  resetGlobalStageflowHomeForTests();
  if (previousHome === undefined) delete process.env.STAGEFLOW_HOME;
  else process.env.STAGEFLOW_HOME = previousHome;
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("published_artifacts JSON field", () => {
  it("adds the field only on a stage that published during the run", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "sf-cli-pub-"));
    const projectDir = await mkdtemp(path.join(tmpdir(), "sf-cli-proj-"));
    process.env.STAGEFLOW_HOME = home;
    resetGlobalStageflowHomeForTests();
    const store = createRunStore({ rootDir: home });
    const project = await store.ensureProject(projectDir);
    cleanups.push(async () => {
      await store.close().catch(() => undefined);
      await rm(home, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
    });
    const db = sqliteConnectionFromStore(store);
    expect(db).toBeDefined();
    if (!db) return;
    const roots = await catalogRootsForArtifacts(store);
    await publishSessionArtifact(
      { db, roots },
      {
        owner: { kind: "stage", pipeline: "publish-note", stage: "publish-note" },
        projectRoot: project,
        source: { runId: "run-9", stageId: "publish-note", attempt: 1 },
      },
      { id: "weekly-note", kind: "static.markdown", title: "Weekly", bytes: Buffer.from("# Weekly\n") },
    );
    const stages = [
      { stage_id: "publish-note", status: "succeeded" as const },
      { stage_id: "clarify", status: "succeeded" as const },
    ];
    const attached = withPublishedArtifacts(store, "run-9", stages);
    expect(attached[0]).toMatchObject({
      stage_id: "publish-note",
      published_artifacts: [
        {
          key: "stage:publish-note:publish-note/weekly-note",
          version: 1,
          kind: "static.markdown",
          title: "Weekly",
        },
      ],
    });
    expect(attached[1]).toEqual(stages[1]);
    expect("published_artifacts" in attached[1]!).toBe(false);
    expect(withPublishedArtifacts(store, "run-other", stages)).toEqual(stages);
  });

  it("keeps each run's published list when a later run republishes", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "sf-cli-pub-"));
    const projectDir = await mkdtemp(path.join(tmpdir(), "sf-cli-proj-"));
    process.env.STAGEFLOW_HOME = home;
    resetGlobalStageflowHomeForTests();
    const store = createRunStore({ rootDir: home });
    const project = await store.ensureProject(projectDir);
    cleanups.push(async () => {
      await store.close().catch(() => undefined);
      await rm(home, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
    });
    const db = sqliteConnectionFromStore(store)!;
    const roots = await catalogRootsForArtifacts(store);
    const stages = [{ stage_id: "publish-note", status: "succeeded" as const }];
    const publish = (runId: string, bytes: string) =>
      publishSessionArtifact(
        { db, roots },
        {
          owner: { kind: "stage", pipeline: "publish-note", stage: "publish-note" },
          projectRoot: project,
          source: { runId, stageId: "publish-note", attempt: 1 },
        },
        { id: "same", kind: "static.markdown", title: "Same", bytes: Buffer.from(bytes) },
      );
    const listed = (runId: string) => withPublishedArtifacts(store, runId, stages)[0]?.published_artifacts;
    await publish("run1", "v1");
    const before = db.prepare(`SELECT version, source_run_id, source_attempt FROM artifact_versions ORDER BY version`).all();
    const second = await publish("run2", "v1");
    expect(second.unchanged).toBe(true);
    expect(db.prepare(`SELECT version, source_run_id, source_attempt FROM artifact_versions ORDER BY version`).all()).toEqual(before);
    expect(listed("run1")).toEqual([
      { key: "stage:publish-note:publish-note/same", version: 1, kind: "static.markdown", title: "Same" },
    ]);
    expect(listed("run2")).toEqual([
      { key: "stage:publish-note:publish-note/same", version: 1, kind: "static.markdown", title: "Same" },
    ]);
    const third = await publish("run3", "v2");
    expect(third.version).toBe(2);
    expect(third.unchanged).toBeUndefined();
    expect(db.prepare(`SELECT version, source_run_id FROM artifact_versions ORDER BY version`).all()).toEqual([
      { version: 1, source_run_id: "run1" },
      { version: 2, source_run_id: "run3" },
    ]);
    expect(listed("run1")).toEqual([
      { key: "stage:publish-note:publish-note/same", version: 1, kind: "static.markdown", title: "Same" },
    ]);
    expect(listed("run2")).toEqual([
      { key: "stage:publish-note:publish-note/same", version: 1, kind: "static.markdown", title: "Same" },
    ]);
    expect(listed("run3")).toEqual([
      { key: "stage:publish-note:publish-note/same", version: 2, kind: "static.markdown", title: "Same" },
    ]);
  });
});