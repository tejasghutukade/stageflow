import { afterEach, describe, expect, it, vi } from "vitest";

const renameSyncControl = vi.hoisted(() => ({ fail: false, lostRace: false }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync: ((...args: Parameters<typeof actual.renameSync>) => {
      if (renameSyncControl.fail) {
        const err = new Error(
          "EXDEV: cross-device link not permitted",
        ) as NodeJS.ErrnoException;
        err.code = "EXDEV";
        throw err;
      }
      if (renameSyncControl.lostRace) {
        actual.renameSync(...args);
        const err = new Error("ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return actual.renameSync(...args);
    }) as typeof actual.renameSync,
  };
});

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createRunStore,
  DISK_STORE_REJECTED,
} from "../src/runstore/createStore.js";
import { storeRootFor } from "../src/runstore/paths.js";
import { SqliteRunStore } from "../src/runstore/sqlite/SqliteRunStore.js";
import { plantDiskEraRun } from "./helpers/plantDiskEraRun.js";

const LEGACY_STORE_DIRNAME = ".software-factory";

function legacyStoreRoot(rootDir: string): string {
  return path.join(rootDir, LEGACY_STORE_DIRNAME);
}

describe("store root and one-shot migrate", () => {
  afterEach(() => {
    renameSyncControl.fail = false;
    renameSyncControl.lostRace = false;
  });

  it("storeRootFor ends with .stageflow and not .software-factory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-store-root-name-"));
    const storeRoot = storeRootFor(root);
    expect(path.basename(storeRoot)).toBe(".stageflow");
    expect(storeRoot.endsWith(LEGACY_STORE_DIRNAME)).toBe(false);
  });

  it("moves a populated legacy store to .stageflow and drops the old directory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-store-migrate-old-"));
    const oldRoot = legacyStoreRoot(root);
    await mkdir(oldRoot, { recursive: true });
    await writeFile(path.join(oldRoot, "settings.json"), "legacy-marker\n");

    createRunStore({ rootDir: root, kind: "sqlite" });

    expect(existsSync(oldRoot)).toBe(false);
    expect(
      await readFile(path.join(storeRootFor(root), "settings.json"), "utf8"),
    ).toBe("legacy-marker\n");
  });

  it("keeps an already-populated .stageflow and does not use a leftover legacy sibling as the live root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-store-new-wins-"));
    const newRoot = path.join(root, ".stageflow");
    const oldRoot = legacyStoreRoot(root);
    await mkdir(newRoot, { recursive: true });
    await writeFile(path.join(newRoot, "from-new.txt"), "new-live\n");
    await mkdir(path.join(oldRoot, "runs", "old-run"), { recursive: true });
    await writeFile(
      path.join(oldRoot, "runs", "old-run", "meta.json"),
      `${JSON.stringify({
        run_id: "old-run",
        pipeline_id: "docs-only",
        created_at: "2020-01-01T00:00:00.000Z",
        status: "succeeded",
      }, null, 2)}\n`,
    );
    await writeFile(
      path.join(oldRoot, "runs", "old-run", "task.copy.yaml"),
      "id: leftover\ngoal: unused\n",
    );
    await writeFile(path.join(oldRoot, "from-old.txt"), "old-sibling\n");

    const store = createRunStore({ rootDir: root, kind: "sqlite" });
    if (store instanceof SqliteRunStore) {
      await store.ready();
    }

    expect(await readFile(path.join(newRoot, "from-new.txt"), "utf8")).toBe(
      "new-live\n",
    );
    expect(existsSync(path.join(newRoot, "from-old.txt"))).toBe(false);
    expect(await readFile(path.join(oldRoot, "from-old.txt"), "utf8")).toBe(
      "old-sibling\n",
    );
    const runs = await store.listRuns();
    expect(runs.some((r) => r.run_id === "old-run")).toBe(false);
  });

  it("creates .stageflow and initializes SQLite when neither store directory exists", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-store-neither-"));
    const store = createRunStore({ rootDir: root, kind: "sqlite" });
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
      taskId: "t",
    });

    expect(existsSync(path.join(root, ".stageflow"))).toBe(true);
    expect(existsSync(path.join(root, ".stageflow", "state.db"))).toBe(true);
    expect(existsSync(legacyStoreRoot(root))).toBe(false);
    expect(run.runId.length).toBeGreaterThan(0);
  });

  it("renames a populated legacy store over an empty .stageflow", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-store-empty-new-"));
    await mkdir(path.join(root, ".stageflow"));
    const oldRoot = legacyStoreRoot(root);
    await mkdir(oldRoot, { recursive: true });
    await writeFile(path.join(oldRoot, "settings.json"), "from-old\n");

    createRunStore({ rootDir: root, kind: "sqlite" });

    expect(existsSync(oldRoot)).toBe(false);
    expect(
      await readFile(path.join(root, ".stageflow", "settings.json"), "utf8"),
    ).toBe("from-old\n");
  });

  it("uses .stageflow only when both directories have content and does not merge the legacy sibling", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-store-both-content-"));
    const newRoot = path.join(root, ".stageflow");
    const oldRoot = legacyStoreRoot(root);
    await mkdir(newRoot, { recursive: true });
    await mkdir(oldRoot, { recursive: true });
    await writeFile(path.join(newRoot, "from-new.txt"), "keep-new\n");
    await writeFile(path.join(oldRoot, "from-old.txt"), "leave-old\n");

    createRunStore({ rootDir: root, kind: "sqlite" });

    expect(await readFile(path.join(newRoot, "from-new.txt"), "utf8")).toBe(
      "keep-new\n",
    );
    expect(existsSync(path.join(newRoot, "from-old.txt"))).toBe(false);
    expect(await readFile(path.join(oldRoot, "from-old.txt"), "utf8")).toBe(
      "leave-old\n",
    );
    expect(existsSync(oldRoot)).toBe(true);
  });

  it("fails closed when rename of the legacy store fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-store-rename-fail-"));
    const oldRoot = legacyStoreRoot(root);
    await mkdir(oldRoot, { recursive: true });
    await writeFile(path.join(oldRoot, "settings.json"), "must-remain\n");
    renameSyncControl.fail = true;

    expect(() => createRunStore({ rootDir: root, kind: "sqlite" })).toThrow();

    expect(
      await readFile(path.join(oldRoot, "settings.json"), "utf8"),
    ).toBe("must-remain\n");
    expect(existsSync(path.join(root, ".stageflow"))).toBe(false);
    expect(existsSync(path.join(root, ".stageflow", "state.db"))).toBe(false);
  });

  it("treats a lost rename race as already migrated when the new root is populated", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-store-lost-race-"));
    const oldRoot = legacyStoreRoot(root);
    await mkdir(oldRoot, { recursive: true });
    await writeFile(path.join(oldRoot, "settings.json"), "raced\n");
    renameSyncControl.lostRace = true;

    createRunStore({ rootDir: root, kind: "sqlite" });

    expect(existsSync(oldRoot)).toBe(false);
    expect(
      await readFile(path.join(storeRootFor(root), "settings.json"), "utf8"),
    ).toBe("raced\n");
  });

  it("plantDiskEraRun plus empty SQLite import still lists the planted run", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-store-plant-import-"));
    await plantDiskEraRun(root, {
      runId: "planted-run",
      pipelineId: "docs-only",
      taskYaml: "id: planted\ngoal: import me\n",
      taskId: "planted",
      status: "succeeded",
    });

    const store = createRunStore({ rootDir: root, kind: "sqlite" });
    if (store instanceof SqliteRunStore) {
      await store.ready();
    }
    const runs = await store.listRuns();
    expect(runs.some((r) => r.run_id === "planted-run")).toBe(true);
  });

  it("rejects SF_STORE=disk with a message that names .stageflow", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-store-disk-reject-"));
    expect(DISK_STORE_REJECTED).toMatch(/\.stageflow\/runs/);
    expect(DISK_STORE_REJECTED).not.toMatch(/\.software-factory/);
    expect(() => createRunStore({ rootDir: root, kind: "disk" })).toThrow(
      DISK_STORE_REJECTED,
    );
  });
});
