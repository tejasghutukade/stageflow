import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { artifactStorageKey, stageOwnerKey } from "../src/artifacts/keys.js";
import { artifactKeyHash } from "../src/artifacts/store.js";
import {
  artifactKeyHashCallCount,
  readPublishedArtifactStoreReport,
  resetArtifactKeyHashCallCount,
} from "../src/artifacts/storeInventory.js";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";
import { createRunStore, sqliteConnectionFromStore } from "../src/runstore/createStore.js";
import { RunManager } from "../src/runtime/runManager.js";

const cleanups: Array<() => Promise<void>> = [];
const previousHome = process.env.STAGEFLOW_HOME;

afterEach(async () => {
  resetArtifactKeyHashCallCount();
  resetGlobalStageflowHomeForTests();
  if (previousHome === undefined) delete process.env.STAGEFLOW_HOME;
  else process.env.STAGEFLOW_HOME = previousHome;
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("published artifact store report", () => {
  it("walks 5000 artifacts in linear time without blocking the event loop", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "sf-store-scale-"));
    process.env.STAGEFLOW_HOME = home;
    resetGlobalStageflowHomeForTests();
    const store = createRunStore({ rootDir: home });
    cleanups.push(async () => {
      await store.close().catch(() => undefined);
      await rm(home, { recursive: true, force: true });
    });
    const db = sqliteConnectionFromStore(store)!;
    const project = "examples";
    const owner = stageOwnerKey("pipe", "stage");
    const now = "2026-11-24T12:00:00.000Z";
    const body = "x";
    const contentHash = createHash("sha256").update(body).digest("hex");
    const insertArtifact = db.prepare(
      `INSERT INTO artifacts (
         key, owner_kind, owner_pipeline, owner_stage, project_root_id, id, title, tags_json,
         kind, origin, current_version, hidden, created_at, updated_at, status
       ) VALUES (
         @key, 'stage', 'pipe', 'stage', @project, @id, @id, '[]',
         'static.text', 'published', 1, 0, @now, @now, 'available'
       )`,
    );
    const insertVersion = db.prepare(
      `INSERT INTO artifact_versions (
         key, version, size_bytes, content_hash, manifest_json, created_at, pinned, relative_path, storage
       ) VALUES (
         @key, 1, 1, @hash, '{"kind":"static.text"}', @now, 0, 'body.txt', 'store'
       )`,
    );
    const count = 5000;
    db.transaction(() => {
      for (let index = 0; index < count; index += 1) {
        const id = `n${index}`;
        const key = artifactStorageKey(project, owner, id);
        const dir = path.join(home, "artifacts", artifactKeyHash(key), "v1");
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, "body.txt"), body);
        insertArtifact.run({ key, project, id, now });
        insertVersion.run({ key, hash: contentHash, now });
      }
    })();

    resetArtifactKeyHashCallCount();
    let maxGap = 0;
    let last = Date.now();
    const probe = setInterval(() => {
      const tick = Date.now();
      maxGap = Math.max(maxGap, tick - last);
      last = tick;
    }, 10);
    const started = Date.now();
    const report = await readPublishedArtifactStoreReport(db, home);
    const elapsed = Date.now() - started;
    clearInterval(probe);
    expect(report.artifact_count).toBe(count);
    expect(report.version_count).toBe(count);
    expect(report.hash_mismatches).toEqual([]);
    expect(report.missing_content).toEqual([]);
    expect(elapsed).toBeLessThan(5000);
    const hashes = artifactKeyHashCallCount();
    expect(hashes).toBeGreaterThanOrEqual(count);
    expect(hashes).toBeLessThan(count * 3);
    expect(maxGap).toBeLessThan(400);

    const manager = new RunManager({
      agent: scriptedFakeAgent([]),
      store,
      cwd: home,
      projectRoot: home,
    });
    const first = await manager.getHealthWithDisk();
    expect(first.disk?.published_artifact_count).toBe(count);
    expect(first.artifact_store?.computed_at).toEqual(expect.any(String));
    expect(first.artifact_store?.stale).toBe(false);
    const secondStarted = Date.now();
    const second = await manager.getHealthWithDisk();
    expect(Date.now() - secondStarted).toBeLessThan(200);
    expect(second.artifact_store?.computed_at).toBe(first.artifact_store?.computed_at);
    expect(second.disk?.published_version_count).toBe(count);
  }, 60_000);
});
