import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRunStore } from "../src/runstore/createStore.js";
import { storeRootFor } from "../src/runstore/paths.js";
import { normalizeProjectRoot } from "../src/runstore/normalizeCatalogPath.js";
import {
  applyPendingMigrations,
  CURRENT_SCHEMA_VERSION,
} from "../src/runstore/sqlite/migrations/index.js";
import { MIGRATION_001 } from "../src/runstore/sqlite/migrations/001-baseline.js";
import { MIGRATION_002 } from "../src/runstore/sqlite/migrations/002-repository-binding.js";
import { MIGRATION_003 } from "../src/runstore/sqlite/migrations/003-run-lifecycle.js";
import { MIGRATION_004 } from "../src/runstore/sqlite/migrations/004-auto-resume-count.js";
import { MIGRATION_005 } from "../src/runstore/sqlite/migrations/005-config-origins.js";
import { MIGRATION_006 } from "../src/runstore/sqlite/migrations/006-pipeline-body-and-caller.js";

describe("projects registry", () => {
  it("rejects missing path and non-directory", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "sf-proj-miss-home-"));
    const store = createRunStore({ rootDir: home });
    const missing = path.join(home, "no-such-dir");
    await expect(store.ensureProject(missing)).rejects.toThrow(
      /does not exist/,
    );
    const filePath = path.join(home, "not-a-dir");
    writeFileSync(filePath, "x");
    await expect(store.ensureProject(filePath)).rejects.toThrow(
      /not a directory/,
    );
    expect(await store.listRegisteredProjects()).toEqual([]);
  });

  it("ensureProject is idempotent and listRegisteredProjects returns stable key", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "sf-proj-reg-"));
    const project = mkdtempSync(path.join(tmpdir(), "sf-proj-dir-"));
    const store = createRunStore({ rootDir: home });
    const first = await store.ensureProject(project);
    expect(first).toBe(normalizeProjectRoot(project));
    const second = await store.ensureProject(path.join(project, "."));
    expect(second).toBe(first);
    expect(await store.listRegisteredProjects()).toEqual([first]);
  });

  it("normalizes symlink input to the realpath key", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "sf-proj-sym-home-"));
    const real = mkdtempSync(path.join(tmpdir(), "sf-proj-sym-real-"));
    const linkParent = mkdtempSync(path.join(tmpdir(), "sf-proj-sym-link-"));
    const link = path.join(linkParent, "alias");
    symlinkSync(real, link);
    const store = createRunStore({ rootDir: home });
    const ensured = await store.ensureProject(link);
    expect(ensured).toBe(normalizeProjectRoot(real));
    expect(await store.listRegisteredProjects()).toEqual([ensured]);
  });

  it("migration 007 backfills absolute project_root from historical runs", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "sf-proj-backfill-"));
    const storeRoot = storeRootFor(home);
    mkdirSync(storeRoot, { recursive: true });
    const dbPath = path.join(storeRoot, "state.db");
    const project = mkdtempSync(path.join(tmpdir(), "sf-proj-hist-"));
    const absoluteRoot = path.resolve(project);

    const db = new Database(dbPath);
    applyPendingMigrations(db, {
      migrations: [
        MIGRATION_001,
        MIGRATION_002,
        MIGRATION_003,
        MIGRATION_004,
        MIGRATION_005,
        MIGRATION_006,
      ],
    });
    expect(db.pragma("user_version", { simple: true })).toBe(6);
    db.prepare(
      `INSERT INTO runs (
        run_id, pipeline_id, task_yaml, status, created_at, updated_at, project_root
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "hist-run",
      "p",
      "id: t\ngoal: g\n",
      "succeeded",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
      absoluteRoot,
    );
    db.close();

    const store = createRunStore({ rootDir: home });
    const registered = await store.listRegisteredProjects();
    expect(registered).toEqual([normalizeProjectRoot(absoluteRoot)]);

    const check = new Database(dbPath);
    expect(check.pragma("user_version", { simple: true })).toBe(
      CURRENT_SCHEMA_VERSION,
    );
    const ledger = check
      .prepare(`SELECT name FROM schema_migrations WHERE version = 7`)
      .get() as { name: string } | undefined;
    expect(ledger?.name).toBe("007_projects_registry");
    check.close();
  });
});
