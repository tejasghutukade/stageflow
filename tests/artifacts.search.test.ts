import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { publishArtifact, deletePublishedArtifact } from "../src/artifacts/publish.js";
import { ArtifactQueryError, listArtifacts } from "../src/artifacts/query.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { artifactKeyHash } from "../src/artifacts/store.js";
import {
  ARTIFACT_SEARCH_BODY_MAX_BYTES,
  ARTIFACT_SEARCH_REPAIR_BATCH,
  ARTIFACT_SEARCH_START_BUDGET_MS,
  artifactSearchPendingCount,
  ensureArtifactSearchIndex,
  extractSearchBody,
  hideArtifactFromSearch,
  repairArtifactSearchBudget,
  repairArtifactSearchOnHostStart,
  repairDirtyArtifactSearch,
  resetArtifactSearchForTests,
  setArtifactSearchBeforeRepairWriteForTests,
  stopArtifactSearchRepair,
  setArtifactSearchAfterUnindexForTests,
  setArtifactSearchDdlForTests,
  setArtifactSearchQueryFailureForTests,
  setArtifactSearchWriteFailureForTests,
  syncArtifactSearch,
} from "../src/artifacts/search.js";
import { setArtifactFtsCreateForTests } from "../src/runstore/sqlite/migrations/027-artifact-search.js";
import type { CatalogRoot } from "../src/config/resolveCatalogRoots.js";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";
import { expireIndexedRun } from "../src/runstore/artifactRetention.js";
import { createRunStore, sqliteConnectionFromStore } from "../src/runstore/createStore.js";
import type { RunStore } from "../src/runstore/port.js";
import { applySchemaThrough } from "./helpers/schemaAtVersion.js";
import { attemptArtifactsDir } from "../src/runstore/workspaceLayout.js";
import Database from "better-sqlite3";

const cleanups: Array<() => Promise<void>> = [];
const previousHome = process.env.STAGEFLOW_HOME;

afterEach(async () => {
  resetArtifactSearchForTests();
  setArtifactFtsCreateForTests(undefined);
  resetGlobalStageflowHomeForTests();
  if (previousHome === undefined) delete process.env.STAGEFLOW_HOME;
  else process.env.STAGEFLOW_HOME = previousHome;
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function temp(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function openStore(): Promise<{ store: RunStore; db: Database.Database; project: string; roots: CatalogRoot[] }> {
  const home = await temp("sf-search-home-");
  const project = await temp("sf-search-proj-");
  process.env.STAGEFLOW_HOME = home;
  resetGlobalStageflowHomeForTests();
  const store = createRunStore({ rootDir: home });
  const registered = await store.ensureProject(project);
  cleanups.push(() => store.close());
  const db = sqliteConnectionFromStore(store);
  if (!db) throw new Error("expected sqlite");
  const roots: CatalogRoot[] = [
    { project_root: registered, path: project, kind: "registered", read_only: false },
  ];
  return { store, db, project: registered, roots };
}

function titles(db: Database.Database, q: string, extra: Parameters<typeof listArtifacts>[1] = { limit: 20 }): string[] {
  return listArtifacts(db, { ...extra, q }, []).artifacts.map((row) => row.title);
}

function put(
  db: Database.Database,
  input: {
    id: string;
    title: string;
    description?: string | null;
    tags?: string[];
    summary?: string | null;
    owner?: string;
    body?: string;
    kind?: string;
    project?: string;
    status?: string;
    hidden?: number;
  },
): string {
  const project = input.project ?? "examples";
  const key = `${project}::stage:sales:summarize/${input.id}`;
  const now = "2026-11-24T12:00:00.000Z";
  db.prepare(
    `INSERT INTO artifacts (
       key, owner_kind, owner_pipeline, owner_stage, owner_agent, project_root_id, id,
       title, description, tags_json, summary, kind, origin, current_version, hidden,
       created_at, updated_at, status
     ) VALUES (
       @key, 'stage', 'sales', 'summarize', NULL, @project, @id,
       @title, @description, @tags, @summary, @kind, 'published', 1, @hidden,
       @now, @now, @status
     )`,
  ).run({
    key,
    project,
    id: input.id,
    title: input.title,
    description: input.description ?? null,
    tags: JSON.stringify(input.tags ?? []),
    summary: input.summary ?? null,
    kind: input.kind ?? "static.markdown",
    hidden: input.hidden ?? 0,
    now,
    status: input.status ?? "available",
  });
  syncArtifactSearch(db, {
    key,
    title: input.title,
    description: input.description ?? null,
    tagsJson: JSON.stringify(input.tags ?? []),
    summary: input.summary ?? null,
    ownerText: input.owner ?? "stage:sales:summarize sales summarize",
    projectRootId: project,
    kind: input.kind ?? "static.markdown",
    body: input.body ?? "",
    hidden: input.hidden ?? 0,
    status: input.status ?? "available",
    deleted: false,
  });
  return key;
}

describe("artifact search", () => {
  it("applies migration 027 on a fresh store and backfills an existing store", async () => {
    const fresh = await openStore();
    expect(fresh.db.pragma("user_version", { simple: true })).toBe(31);
    expect(fresh.db.prepare(`SELECT name FROM sqlite_master WHERE name = 'artifact_fts'`).get()).toBeTruthy();
    expect(
      (fresh.db.prepare(`SELECT value FROM artifact_search_meta WHERE key = 'fts'`).get() as { value: string }).value,
    ).toBe("available");

    const home = await temp("sf-search-old-");
    process.env.STAGEFLOW_HOME = home;
    resetGlobalStageflowHomeForTests();
    const dbPath = path.join(home, "state.db");
    const raw = new Database(dbPath);
    applySchemaThrough(raw, 26);
    raw
      .prepare(
        `INSERT INTO artifacts (
           key, owner_kind, owner_pipeline, owner_stage, project_root_id, id, title, tags_json,
           kind, origin, current_version, hidden, created_at, updated_at, status
         ) VALUES (
           'examples::stage:sales:summarize/kept', 'stage', 'sales', 'summarize', 'examples', 'kept',
           'backfilltitle', '[]', 'static.text', 'indexed', 1, 0, '2026-01-01T00:00:00.000Z',
           '2026-01-01T00:00:00.000Z', 'available'
         )`,
      )
      .run();
    raw.close();
    const migrated = createRunStore({ rootDir: home });
    cleanups.push(() => migrated.close());
    const migratedDb = sqliteConnectionFromStore(migrated)!;
    expect(migratedDb.pragma("user_version", { simple: true })).toBe(31);
    expect(titles(migratedDb, "backfill")).toEqual(["backfilltitle"]);
  });

  it("still migrates when FTS5 cannot be created and searches with a text scan", async () => {
    const home = await temp("sf-search-nofts-");
    setArtifactFtsCreateForTests(() => {
      throw new Error("fts5 missing");
    });
    const store = createRunStore({ rootDir: home });
    cleanups.push(() => store.close());
    const db = sqliteConnectionFromStore(store)!;
    expect(db.pragma("user_version", { simple: true })).toBe(31);
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE name = 'artifact_fts'`).get()).toBeUndefined();
    expect(
      (db.prepare(`SELECT value FROM artifact_search_meta WHERE key = 'fts'`).get() as { value: string }).value,
    ).toBe("unavailable");
    put(db, { id: "kept", title: "plain title", body: "bodyonlytoken" });
    expect(titles(db, "plain")).toEqual(["plain title"]);
    expect(titles(db, "bodyonlytoken")).toEqual([]);
  });

  it("matches title, description, tags, owner, summary, and text bodies", async () => {
    const { store, db, project } = await openStore();
    const stageId = "summarize";
    const created = await store.createRun({
      pipelineId: "sales",
      taskYaml: "id: t\ngoal: g\n",
      projectRoot: project,
    });
    await store.createStageExecution(created.runId, stageId);
    const dir = attemptArtifactsDir(store.getWorkspaceDir(created.runId), stageId, 1);
    await mkdir(dir, { recursive: true });
    const files: Record<string, string> = {
      "note.md": "markdownbodytoken",
      "sheet.csv": "csvbodytoken,1",
      "rows.json": '[{"k":"jsonbodytoken"}]',
      "plain.txt": "textbodytoken",
      "page.html": "<p>htmlbodytoken</p>",
      "pic.png": "imagebodytoken",
    };
    for (const [name, body] of Object.entries(files)) await writeFile(path.join(dir, name), body);
    db.prepare(`UPDATE runs SET project_root = ? WHERE run_id = ?`).run(project, created.runId);
    await store.writeEnvelope(
      created.runId,
      stageId,
      { status: "success", summary: "ok", artifacts: Object.keys(files), payload: {} },
      { attempt: 1 },
    );
    expect(titles(db, "markdownbodytoken")).toEqual(["note.md"]);
    expect(titles(db, "csvbodytoken")).toEqual(["sheet.csv"]);
    expect(titles(db, "jsonbodytoken")).toEqual(["rows.json"]);
    expect(titles(db, "textbodytoken")).toEqual(["plain.txt"]);
    expect(titles(db, "htmlbodytoken")).toEqual([]);
    expect(titles(db, "imagebodytoken")).toEqual([]);

    await publishArtifact(db, {
      owner: { kind: "stage", pipeline: "sales", stage: "summarize" },
      projectRoot: project,
      id: "fields",
      kind: "static.text",
      title: "Field card",
      description: "descwordunique",
      tags: ["tagwordunique"],
      summary: "summarywordunique",
      bytes: Buffer.from("field body"),
      publishSource: "api",
      roots: [{ project_root: project, path: project, kind: "registered", read_only: false }],
    });
    expect(titles(db, "descwordunique")).toEqual(["Field card"]);
    expect(titles(db, "tagwordunique")).toEqual(["Field card"]);
    expect(titles(db, "summarywordunique")).toEqual(["Field card"]);
    expect(titles(db, "sales")).toContain("Field card");

    put(db, { id: "titlehit", title: "ranktoken report", body: "other", project });
    put(db, { id: "bodyhit", title: "notes", body: "ranktoken sits in the body", project });
    expect(titles(db, "ranktoken", { limit: 10 })).toEqual(["ranktoken report", "notes"]);
    expect(extractSearchBody("live.declarative", Buffer.from("snapshotsecret"))).toBe("");
    expect(extractSearchBody("static.html", Buffer.from("<p>htmlsecret</p>"))).toBe("");
    expect(extractSearchBody("static.image", Buffer.from("imagesecret"))).toBe("");
  });

  it("supports prefix, diacritics, non-ASCII, and hostile queries", async () => {
    const { db } = await openStore();
    put(db, { id: "cafe", title: "Café menu" });
    put(db, { id: "week", title: "週報" });
    put(db, { id: "rev", title: "revenue report" });
    expect(titles(db, "cafe")).toEqual(["Café menu"]);
    expect(titles(db, "週報")).toEqual(["週報"]);
    expect(titles(db, "rev")).toContain("revenue report");
    const hostile = ["\"", "'", "(", ")", "NEAR", "AND", "OR", "NOT", "*", ":", "title:x", "a'", "revenue AND secret", "\"weekly"];
    for (const q of hostile) {
      try {
        const page = listArtifacts(db, { limit: 10, q }, []);
        expect(Array.isArray(page.artifacts)).toBe(true);
      } catch (error) {
        expect(error).toBeInstanceOf(ArtifactQueryError);
        expect((error as ArtifactQueryError).status).toBe(400);
        expect((error as ArtifactQueryError).code).toBe("artifact.invalid_filter");
      }
    }
  });

  it("replaces the index on publish, and removes it on delete, expire, and hide in one transaction", async () => {
    const opened = await openStore();
    const roots = opened.roots;
    const published = await publishArtifact(opened.db, {
      owner: { kind: "stage", pipeline: "sales", stage: "summarize" },
      projectRoot: opened.project,
      id: "weekly",
      kind: "static.markdown",
      title: "Weekly",
      bytes: Buffer.from("oldbodytoken"),
      publishSource: "api",
      roots,
    });
    expect(published.version).toBe(1);
    const next = await publishArtifact(opened.db, {
      owner: { kind: "stage", pipeline: "sales", stage: "summarize" },
      projectRoot: opened.project,
      id: "weekly",
      kind: "static.markdown",
      title: "Weekly",
      bytes: Buffer.from("newbodytoken"),
      publishSource: "api",
      roots,
    });
    expect(next.version).toBe(2);
    expect(titles(opened.db, "oldbodytoken")).toEqual([]);
    expect(titles(opened.db, "newbodytoken")).toEqual(["Weekly"]);

    setArtifactSearchAfterUnindexForTests(() => {
      throw new Error("after unindex");
    });
    await expect(
      deletePublishedArtifact(opened.db, "stage:sales:summarize", "weekly", opened.project, roots),
    ).rejects.toThrow(/after unindex/);
    expect(titles(opened.db, "newbodytoken")).toEqual(["Weekly"]);
    resetArtifactSearchForTests();
    await deletePublishedArtifact(opened.db, "stage:sales:summarize", "weekly", opened.project, roots);
    expect(titles(opened.db, "newbodytoken")).toEqual([]);

    const stageId = "summarize";
    const created = await opened.store.createRun({
      pipelineId: "sales",
      taskYaml: "id: t\ngoal: g\n",
      projectRoot: opened.project,
    });
    await opened.store.createStageExecution(created.runId, stageId);
    const dir = attemptArtifactsDir(opened.store.getWorkspaceDir(created.runId), stageId, 1);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "expire.md"), "expirebodytoken");
    opened.db.prepare(`UPDATE runs SET project_root = ?, status = 'succeeded', finished_at = ? WHERE run_id = ?`).run(
      opened.project,
      "2026-01-01T00:00:00.000Z",
      created.runId,
    );
    await opened.store.writeEnvelope(
      created.runId,
      stageId,
      { status: "success", summary: "ok", artifacts: ["expire.md"], payload: {} },
      { attempt: 1 },
    );
    expect(titles(opened.db, "expirebodytoken")).toEqual(["expire.md"]);
    setArtifactSearchAfterUnindexForTests(() => {
      throw new Error("after unindex");
    });
    expect(() => expireIndexedRun(opened.db, created.runId, "run_deleted", "2026-04-01T00:00:00.000Z")).toThrow(/after unindex/);
    expect(titles(opened.db, "expirebodytoken")).toEqual(["expire.md"]);
    const still = opened.db.prepare(`SELECT status FROM artifacts WHERE title = 'expire.md'`).get() as { status: string };
    expect(still.status).toBe("available");
    resetArtifactSearchForTests();
    expireIndexedRun(opened.db, created.runId, "run_deleted", "2026-04-01T00:00:00.000Z");
    expect(titles(opened.db, "expirebodytoken")).toEqual([]);

    const hiddenKey = put(opened.db, { id: "secret", title: "hiddentitle", project: opened.project });
    setArtifactSearchAfterUnindexForTests(() => {
      throw new Error("after unindex");
    });
    expect(() => hideArtifactFromSearch(opened.db, hiddenKey)).toThrow(/after unindex/);
    expect(titles(opened.db, "hiddentitle")).toEqual(["hiddentitle"]);
    resetArtifactSearchForTests();
    hideArtifactFromSearch(opened.db, hiddenKey);
    expect(titles(opened.db, "hiddentitle")).toEqual([]);
    expect((opened.db.prepare(`SELECT hidden FROM artifacts WHERE key = ?`).get(hiddenKey) as { hidden: number }).hidden).toBe(1);
  });

  it("repairs a dirty key after an index write failure", async () => {
    const opened = await openStore();
    setArtifactSearchWriteFailureForTests(true);
    await publishArtifact(opened.db, {
      owner: { kind: "stage", pipeline: "sales", stage: "summarize" },
      projectRoot: opened.project,
      id: "dirty",
      kind: "static.text",
      title: "Dirty",
      bytes: Buffer.from("dirtybodytoken"),
      publishSource: "api",
      roots: opened.roots,
    });
    expect(titles(opened.db, "dirtybodytoken")).toEqual([]);
    const dirty = opened.db.prepare(`SELECT COUNT(*) AS n FROM artifact_search_dirty`).get() as { n: number };
    expect(dirty.n).toBeGreaterThan(0);
    setArtifactSearchWriteFailureForTests(false);
    expect(ARTIFACT_SEARCH_REPAIR_BATCH).toBe(200);
    const repaired = await repairDirtyArtifactSearch(opened.db, () => opened.store.getWorkspaceDir("missing"), 2);
    expect(repaired).toBeGreaterThan(0);
    expect(titles(opened.db, "dirtybodytoken")).toEqual(["Dirty"]);
  });

  it("falls back when the full-text table is dropped or a query throws", async () => {
    const { db } = await openStore();
    put(db, { id: "kept", title: "fallback title", body: "fallbackbodytoken" });
    setArtifactSearchQueryFailureForTests(true);
    expect(titles(db, "fallback")).toEqual(["fallback title"]);
    expect(titles(db, "fallbackbodytoken")).toEqual([]);
    setArtifactSearchQueryFailureForTests(false);
    const errors: string[] = [];
    const original = console.error;
    console.error = (message?: unknown) => {
      errors.push(String(message));
    };
    try {
      db.exec(`DROP TABLE artifact_fts`);
      resetArtifactSearchForTests();
      expect(titles(db, "fallback")).toEqual(["fallback title"]);
      expect(titles(db, "fallback")).toEqual(["fallback title"]);
      expect(titles(db, "fallbackbodytoken")).toEqual([]);
      expect(errors.filter((line) => line.includes("text scan"))).toHaveLength(1);
    } finally {
      console.error = original;
    }
  });

  it("pages every hit once, keeps project scope, and combines filters", async () => {
    const { db } = await openStore();
    for (let index = 0; index < 5; index += 1) {
      put(db, { id: `p${index}`, title: `pagehit ${index}`, project: index < 3 ? "alpha" : "beta", kind: index === 4 ? "static.text" : "static.markdown" });
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
      const page = listArtifacts(db, { limit: 2, q: "pagehit", cursor }, []);
      seen.push(...page.artifacts.map((row) => row.id));
      if (page.next_cursor == null) break;
      cursor = page.next_cursor;
      expect(pageNumber).toBeLessThan(9);
    }
    expect(seen.sort()).toEqual(["p0", "p1", "p2", "p3", "p4"]);
    expect(new Set(seen).size).toBe(5);
    expect(listArtifacts(db, { limit: 10, q: "pagehit", projectRoot: "alpha" }, []).artifacts).toHaveLength(3);
    expect(listArtifacts(db, { limit: 10, q: "pagehit", kind: "static.text" }, []).artifacts.map((row) => row.id)).toEqual(["p4"]);
    put(db, { id: "gone", title: "pagehit expired", status: "expired", body: "expiredbodytoken" });
    expect(listArtifacts(db, { limit: 10, q: "pagehit", status: "expired" }, []).artifacts.map((row) => row.id)).toEqual(["gone"]);
    expect(listArtifacts(db, { limit: 10, q: "expiredbodytoken", status: "expired" }, []).artifacts.map((row) => row.id)).toEqual(["gone"]);
    expect(listArtifacts(db, { limit: 10, q: "pagehit", status: "available" }, []).artifacts.map((row) => row.id).sort()).toEqual(["p0", "p1", "p2", "p3", "p4"]);
    expect(listArtifacts(db, { limit: 10, q: "pagehit" }, []).artifacts.map((row) => row.id).sort()).toEqual(["gone", "p0", "p1", "p2", "p3", "p4"]);
  });

  it("searches 1,000 artifacts within the CI bound", async () => {
    const { db } = await openStore();
    const insert = db.prepare(
      `INSERT INTO artifacts (
         key, owner_kind, owner_pipeline, owner_stage, project_root_id, id, title, tags_json,
         kind, origin, current_version, hidden, created_at, updated_at, status
       ) VALUES (
         @key, 'stage', 'sales', 'summarize', 'examples', @id, @title, '[]',
         'static.text', 'published', 1, 0, @now, @now, 'available'
       )`,
    );
    db.transaction(() => {
      for (let index = 0; index < 1000; index += 1) {
        const id = `n${index}`;
        const key = `examples::stage:sales:summarize/${id}`;
        const title = `commonword ${index}`;
        insert.run({ key, id, title, now: "2026-11-24T12:00:00.000Z" });
        syncArtifactSearch(db, {
          key,
          title,
          description: null,
          tagsJson: "[]",
          summary: null,
          ownerText: "stage:sales:summarize sales summarize",
          projectRootId: "examples",
          kind: "static.text",
          body: "",
          hidden: 0,
          status: "available",
          deleted: false,
        });
      }
    })();
    const started = performance.now();
    const page = listArtifacts(db, { limit: 20, q: "commonword" }, []);
    const elapsed = performance.now() - started;
    expect(page.match_count).toBe(1000);
    expect(page.artifacts).toHaveLength(20);
    expect(elapsed).toBeLessThan(500);
  });

  it("keeps at most 64 KiB of body text and cuts on a character boundary", () => {
    const head = "headword ";
    const tail = "tailword";
    const filler = "日".repeat(40_000);
    const bytes = Buffer.from(`${head}${filler}${tail}`, "utf8");
    expect(bytes.length).toBeGreaterThan(ARTIFACT_SEARCH_BODY_MAX_BYTES);
    const text = extractSearchBody("static.text", bytes);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(ARTIFACT_SEARCH_BODY_MAX_BYTES);
    expect(text.startsWith("headword")).toBe(true);
    expect(text.includes("tailword")).toBe(false);
    expect(text.includes("\uFFFD")).toBe(false);
    expect(extractSearchBody("static.text", Buffer.from("a\u0000b\u0007c"))).toBe("a b c");
  });

  it("recreates a dropped FTS table, marks every row dirty, and restores body search", async () => {
    const opened = await openStore();
    await publishArtifact(opened.db, {
      owner: { kind: "stage", pipeline: "sales", stage: "summarize" },
      projectRoot: opened.project,
      id: "rebuilt",
      kind: "static.text",
      title: "Recreated",
      bytes: Buffer.from("rebuiltbodytoken"),
      publishSource: "api",
      roots: opened.roots,
    });
    expect(ensureArtifactSearchIndex(opened.db)).toBe(true);
    const pendingBefore = artifactSearchPendingCount(opened.db);
    expect(ensureArtifactSearchIndex(opened.db)).toBe(true);
    expect(artifactSearchPendingCount(opened.db)).toBe(pendingBefore);
    opened.db.exec(`DROP TABLE artifact_fts`);
    opened.db.exec(`DELETE FROM artifact_search_meta`);
    expect(ensureArtifactSearchIndex(opened.db)).toBe(true);
    expect(opened.db.prepare(`SELECT name FROM sqlite_master WHERE name = 'artifact_fts'`).get()).toBeTruthy();
    expect(artifactSearchPendingCount(opened.db)).toBeGreaterThan(0);
    await repairDirtyArtifactSearch(opened.db);
    expect(titles(opened.db, "rebuiltbodytoken")).toEqual(["Recreated"]);
  });

  it("logs once and stays on the text scan when the FTS DDL fails", async () => {
    const opened = await openStore();
    put(opened.db, { id: "plain", title: "plain title", body: "bodyonlytoken" });
    opened.db.exec(`DROP TABLE artifact_fts`);
    opened.db.exec(`DELETE FROM artifact_search_meta`);
    setArtifactSearchDdlForTests(() => {
      throw new Error("fts5 missing");
    });
    const errors: string[] = [];
    const original = console.error;
    console.error = (message?: unknown) => {
      errors.push(String(message));
    };
    try {
      resetArtifactSearchForTests();
      setArtifactSearchDdlForTests(() => {
        throw new Error("fts5 missing");
      });
      expect(ensureArtifactSearchIndex(opened.db)).toBe(false);
      expect(ensureArtifactSearchIndex(opened.db)).toBe(false);
      expect(titles(opened.db, "plain")).toEqual(["plain title"]);
      expect(titles(opened.db, "bodyonlytoken")).toEqual([]);
      expect(errors.filter((line) => line.includes("text scan"))).toHaveLength(1);
    } finally {
      console.error = original;
    }
  });

  it("indexes healthy rows ahead of stuck dirty keys", async () => {
    const { db } = await openStore();
    const insert = db.prepare(
      `INSERT INTO artifacts (
         key, owner_kind, owner_pipeline, owner_stage, project_root_id, id, title, tags_json,
         kind, origin, current_version, hidden, created_at, updated_at, status
       ) VALUES (
         @key, 'stage', 'sales', 'summarize', 'examples', @id, @title, '[]',
         'static.text', 'published', 1, 0, @now, @now, 'available'
       )`,
    );
    const version = db.prepare(
      `INSERT INTO artifact_versions (key, version, relative_path, storage, created_at)
       VALUES (@key, 1, 'missing.txt', 'store', @now)`,
    );
    const dirty = db.prepare(`INSERT INTO artifact_search_dirty (key) VALUES (?)`);
    db.transaction(() => {
      for (let index = 0; index < 120; index += 1) {
        const key = `a-stuck-${String(index).padStart(4, "0")}`;
        insert.run({ key, id: key, title: `stuck ${index}`, now: "2026-11-24T12:00:00.000Z" });
        version.run({ key, now: "2026-11-24T12:00:00.000Z" });
        dirty.run(key);
      }
      for (let index = 0; index < 10; index += 1) {
        const key = `z-healthy-${String(index).padStart(2, "0")}`;
        insert.run({ key, id: key, title: `healthy ${index}`, now: "2026-11-24T12:00:00.000Z" });
        dirty.run(key);
      }
    })();
    const limit = 50;
    const passes = Math.ceil(130 / limit);
    for (let pass = 0; pass < passes; pass += 1) {
      await repairDirtyArtifactSearch(db, undefined, limit);
    }
    expect(titles(db, "healthy", { limit: 20 }).sort()).toEqual(
      Array.from({ length: 10 }, (_, index) => `healthy ${index}`),
    );
    expect(artifactSearchPendingCount(db)).toBe(120);
    await repairDirtyArtifactSearch(db, undefined, limit);
    expect(artifactSearchPendingCount(db)).toBe(120);
  });

  it("finishes 500 pre-existing artifacts inside the bounded repair loop", async () => {
    const opened = await openStore();
    const home = process.env.STAGEFLOW_HOME!;
    const insert = opened.db.prepare(
      `INSERT INTO artifacts (
         key, owner_kind, owner_pipeline, owner_stage, project_root_id, id, title, tags_json,
         kind, origin, current_version, hidden, created_at, updated_at, status
       ) VALUES (
         @key, 'stage', 'sales', 'summarize', 'examples', @id, @title, '[]',
         'static.text', 'published', 1, 0, @now, @now, 'available'
       )`,
    );
    const version = opened.db.prepare(
      `INSERT INTO artifact_versions (key, version, relative_path, storage, created_at, size_bytes)
       VALUES (@key, 1, 'body.txt', 'store', @now, @size)`,
    );
    const dirty = opened.db.prepare(`INSERT OR IGNORE INTO artifact_search_dirty (key) VALUES (?)`);
    opened.db.transaction(() => {
      for (let index = 0; index < 500; index += 1) {
        const id = `bulk${index}`;
        const key = `examples::stage:sales:summarize/${id}`;
        const text = `bulktoken${index}`;
        insert.run({ key, id, title: `bulk ${index}`, now: "2026-11-24T12:00:00.000Z" });
        version.run({ key, now: "2026-11-24T12:00:00.000Z", size: Buffer.byteLength(text) });
        const dir = path.join(home, "artifacts", artifactKeyHash(key), "v1");
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, "body.txt"), text);
        dirty.run(key);
      }
    })();
    opened.db.exec(`DELETE FROM artifact_fts`);
    const result = await repairArtifactSearchBudget(opened.db, undefined, {
      budgetMs: 60_000,
      wait: async () => undefined,
    });
    expect(result.pending).toBe(0);
    expect(result.yielded).toBeGreaterThanOrEqual(2);
    expect(titles(opened.db, "bulktoken499")).toEqual(["bulk 499"]);
    expect(titles(opened.db, "bulktoken0")).toEqual(["bulk 0"]);
  });

  it("stops a repair tick at the time budget and yields to the event loop", async () => {
    const { db } = await openStore();
    const insert = db.prepare(
      `INSERT INTO artifacts (
         key, owner_kind, owner_pipeline, owner_stage, project_root_id, id, title, tags_json,
         kind, origin, current_version, hidden, created_at, updated_at, status
       ) VALUES (
         @key, 'stage', 'sales', 'summarize', 'examples', @id, @title, '[]',
         'static.text', 'published', 1, 0, @now, @now, 'available'
       )`,
    );
    const dirty = db.prepare(`INSERT INTO artifact_search_dirty (key) VALUES (?)`);
    db.transaction(() => {
      for (let index = 0; index < 250; index += 1) {
        const key = `clock-${String(index).padStart(4, "0")}`;
        insert.run({ key, id: key, title: `clock ${index}`, now: "2026-11-24T12:00:00.000Z" });
        dirty.run(key);
      }
    })();
    let now = 0;
    let yielded = 0;
    const ticks: Array<() => void> = [];
    const result = await repairArtifactSearchOnHostStart(db, undefined, {
      budgetMs: ARTIFACT_SEARCH_START_BUDGET_MS,
      now: () => now,
      wait: async () => {
        yielded += 1;
        now = ARTIFACT_SEARCH_START_BUDGET_MS;
      },
      scheduleTick: (run) => {
        ticks.push(run);
      },
    });
    expect(yielded).toBe(1);
    expect(result.yielded).toBe(1);
    expect(result.pending).toBeGreaterThan(0);
    expect(ticks).toHaveLength(1);
    expect(titles(db, "clock", { limit: 300 })).toHaveLength(200);
  });

  it("does not index a stale title when a publish lands during repair", async () => {
    const { db } = await openStore();
    const key = put(db, { id: "race", title: "OLDTEXT", body: "oldtoken", kind: "static.text" });
    db.prepare(`INSERT INTO artifact_search_dirty (key) VALUES (?)`).run(key);
    setArtifactSearchBeforeRepairWriteForTests(() => {
      db.prepare(
        `UPDATE artifacts SET title = 'NEWTEXT', current_version = current_version + 1, updated_at = '2099-01-01T00:00:00.000Z' WHERE key = ?`,
      ).run(key);
      syncArtifactSearch(db, {
        key,
        title: "NEWTEXT",
        description: null,
        tagsJson: "[]",
        summary: null,
        ownerText: "stage:sales:summarize sales summarize",
        projectRootId: "examples",
        kind: "static.text",
        body: "newtoken",
        hidden: 0,
        status: "available",
        deleted: false,
      });
    });
    await repairDirtyArtifactSearch(db);
    expect(titles(db, "NEWTEXT")).toEqual(["NEWTEXT"]);
    expect(titles(db, "OLDTEXT")).toEqual([]);
    const dirty = db.prepare(`SELECT 1 AS ok FROM artifact_search_dirty WHERE key = ?`).get(key) as
      | { ok: number }
      | undefined;
    expect(dirty).toBeTruthy();
  });

  it("stops repair before a closed database can reject", async () => {
    const home = await temp("sf-search-stop-");
    process.env.STAGEFLOW_HOME = home;
    resetGlobalStageflowHomeForTests();
    const store = createRunStore({ rootDir: home });
    cleanups.push(async () => {
      await store.close().catch(() => undefined);
    });
    const db = sqliteConnectionFromStore(store)!;
    const insert = db.prepare(
      `INSERT INTO artifacts (
         key, owner_kind, owner_pipeline, owner_stage, project_root_id, id, title, tags_json,
         kind, origin, current_version, hidden, created_at, updated_at, status
       ) VALUES (
         @key, 'stage', 'sales', 'summarize', 'examples', @id, @title, '[]',
         'static.html', 'published', 1, 0, @now, @now, 'available'
       )`,
    );
    const dirty = db.prepare(`INSERT INTO artifact_search_dirty (key) VALUES (?)`);
    db.transaction(() => {
      for (let index = 0; index < 5000; index += 1) {
        const key = `stop-${String(index).padStart(4, "0")}`;
        insert.run({ key, id: key, title: `stop ${index}`, now: "2026-11-24T12:00:00.000Z" });
        dirty.run(key);
      }
    })();
    const failures: unknown[] = [];
    const onException = (error: unknown) => failures.push(error);
    const onRejection = (error: unknown) => failures.push(error);
    process.on("uncaughtException", onException);
    process.on("unhandledRejection", onRejection);
    try {
      const running = repairArtifactSearchOnHostStart(db, undefined, {
        budgetMs: 60_000,
        batch: 50,
        wait: () => new Promise((resolve) => setTimeout(resolve, 15)),
      });
      await new Promise((resolve) => setTimeout(resolve, 40));
      stopArtifactSearchRepair();
      stopArtifactSearchRepair();
      db.close();
      await running.catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(failures).toEqual([]);
    } finally {
      process.off("uncaughtException", onException);
      process.off("unhandledRejection", onRejection);
    }
  });
});
