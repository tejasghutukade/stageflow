import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import Database from "better-sqlite3";
import { artifactStorageKey } from "../src/artifacts/keys.js";
import { ARTIFACT_TAG_PATTERN } from "../src/artifacts/limits.js";
import { catalogRootsForArtifacts } from "../src/artifacts/projectScope.js";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";
import {
  decodeArtifactCursor,
  encodeArtifactCursor,
  listArtifacts,
  parseArtifactKindFilter,
  parseArtifactListOrder,
  parseArtifactListSort,
  parseArtifactLiveFilter,
  parseArtifactTagFilter,
  ArtifactQueryError,
} from "../src/artifacts/query.js";
import { createRunStore, sqliteConnectionFromStore } from "../src/runstore/createStore.js";
import type { RunStore } from "../src/runstore/port.js";
import { attemptArtifactsDir } from "../src/runstore/workspaceLayout.js";
import { json } from "../src/server/createHttpHost.js";
import { handleArtifactRoutes } from "../src/server/artifactRoutes.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function temp(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix)).then((dir) => {
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    return dir;
  });
}

async function openStore(): Promise<RunStore> {
  const root = await temp("sf-art-list-");
  const store = createRunStore({ rootDir: root, kind: "sqlite" });
  cleanups.push(async () => {
    await store.close();
  });
  return store;
}

async function indexOne(
  store: RunStore,
  projectRoot: string,
  file: string,
  body: string,
  opts?: { pipelineId?: string; stageId?: string },
): Promise<string> {
  const stageId = opts?.stageId ?? "summarize";
  const pipelineId = opts?.pipelineId ?? "sales";
  const created = await store.createRun({
    pipelineId,
    taskYaml: "id: t\ngoal: g\n",
    projectRoot,
  });
  await store.createStageExecution(created.runId, stageId);
  const dir = attemptArtifactsDir(store.getWorkspaceDir(created.runId), stageId, 1);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, file), body);
  const db = sqliteConnectionFromStore(store);
  if (!db) throw new Error("expected sqlite");
  db.prepare(`UPDATE runs SET project_root = ? WHERE run_id = ?`).run(projectRoot, created.runId);
  await store.writeEnvelope(
    created.runId,
    stageId,
    { status: "success", summary: "ok", artifacts: [file], payload: {} },
    { attempt: 1 },
  );
  return created.runId;
}

function insertArtifact(
  db: Database.Database,
  opts: {
    projectId: string;
    id: string;
    title: string;
    kind: string;
    updatedAt: string;
    sizeBytes: number | null;
    tags?: string[];
    status?: string;
    pipeline?: string;
    stage?: string;
    agent?: string;
  },
): void {
  const ownerKind = opts.agent ? "agent" : "stage";
  const pipeline = opts.pipeline ?? "sales";
  const stage = opts.stage ?? "summarize";
  const ownerKey = opts.agent ? `agent:${opts.agent}` : `stage:${pipeline}:${stage}`;
  const key = artifactStorageKey(opts.projectId, ownerKey, opts.id);
  const tagsJson = JSON.stringify(opts.tags ?? []);
  db.prepare(
    `INSERT INTO artifacts (
       key, owner_kind, owner_pipeline, owner_stage, owner_agent, project_root_id, id, title, tags_json,
       kind, origin, current_version, hidden, status, created_at, updated_at
     ) VALUES (
       @key, @owner_kind, @pipeline, @stage, @agent, @project, @id, @title, @tags,
       @kind, 'indexed', 1, 0, @status, @updated, @updated
     )`,
  ).run({
    key,
    owner_kind: ownerKind,
    pipeline: opts.agent ? null : pipeline,
    stage: opts.agent ? null : stage,
    agent: opts.agent ?? null,
    project: opts.projectId,
    id: opts.id,
    title: opts.title,
    tags: tagsJson,
    kind: opts.kind,
    status: opts.status ?? "available",
    updated: opts.updatedAt,
  });
  if (opts.sizeBytes !== null) {
    db.prepare(
      `INSERT INTO artifact_versions (key, version, content_type, size_bytes, created_at, pinned)
       VALUES (@key, 1, 'text/plain', @size, @updated, 0)`,
    ).run({ key, size: opts.sizeBytes, updated: opts.updatedAt });
  }
}

async function getArtifacts(
  store: RunStore,
  route: string,
): Promise<{ status: number; body: any }> {
  const url = new URL(route, "http://127.0.0.1");
  let status = 0;
  let payload = "";
  const res = {
    writeHead(code: number) {
      status = code;
    },
    end(body?: string) {
      payload = body ?? "";
    },
  } as unknown as ServerResponse;
  const handled = await handleArtifactRoutes(
    {} as IncomingMessage,
    "GET",
    url.pathname,
    url,
    store,
    res,
    json,
  );
  expect(handled).toBe(true);
  return { status, body: payload ? JSON.parse(payload) : undefined };
}

describe("artifact list filters and sort", () => {
  it("rejects invalid filter params with artifact.invalid_filter", async () => {
    const store = await openStore();
    const root = await temp("sf-art-bad-");
    await store.ensureProject(root);
    expect(() => parseArtifactListSort("nope")).toThrow(ArtifactQueryError);
    expect(() => parseArtifactListSort("nope")).toThrow(expect.objectContaining({ code: "artifact.invalid_filter" }));
    expect(() => parseArtifactTagFilter("Bad")).toThrow(/lowercase/);
    const bad = await getArtifacts(store, "/api/artifacts?sort=size&order=sideways");
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("artifact.invalid_filter");
    const badStatus = await getArtifacts(store, "/api/artifacts?status=nope");
    expect(badStatus.status).toBe(400);
    expect(badStatus.body.code).toBe("artifact.invalid_filter");
    expect(parseArtifactTagFilter("2024")).toBe("2024");
    expect(parseArtifactTagFilter("_draft")).toBe("_draft");
    expect(ARTIFACT_TAG_PATTERN.test("2024")).toBe(true);
    expect(() => parseArtifactTagFilter("a".repeat(33))).toThrow(ArtifactQueryError);
  });

  it("filters by kind exact and family prefix, owner, tag, status, and live", async () => {
    const root = await temp("sf-art-filters-");
    const store = await openStore();
    await store.ensureProject(root);
    const db = sqliteConnectionFromStore(store)!;
    const projectId = root;
    insertArtifact(db, {
      projectId,
      id: "md-one",
      title: "Alpha",
      kind: "static.markdown",
      updatedAt: "2026-01-03T00:00:00.000Z",
      sizeBytes: 10,
      tags: ["weekly"],
    });
    insertArtifact(db, {
      projectId,
      id: "img-one",
      title: "Beta",
      kind: "static.image",
      updatedAt: "2026-01-02T00:00:00.000Z",
      sizeBytes: 20,
    });
    insertArtifact(db, {
      projectId,
      id: "live-one",
      title: "Gamma",
      kind: "live.declarative",
      updatedAt: "2026-01-01T00:00:00.000Z",
      sizeBytes: 30,
      tags: ["revenue"],
    });
    insertArtifact(db, {
      projectId,
      id: "expired-one",
      title: "Delta",
      kind: "static.text",
      updatedAt: "2026-01-04T00:00:00.000Z",
      sizeBytes: 5,
      status: "expired",
      pipeline: "ops",
      stage: "report",
    });

    const roots = await catalogRootsForArtifacts(store);
    expect(listArtifacts(db, { limit: 50 }, roots).artifacts).toHaveLength(4);
    const prefix = listArtifacts(db, { limit: 50, kind: "static" }, roots);
    expect(prefix.artifacts.map((r) => r.id).sort()).toEqual(["expired-one", "img-one", "md-one"]);

    const exact = listArtifacts(db, { limit: 50, kind: "static.markdown" }, roots);
    expect(exact.artifacts.map((r) => r.id)).toEqual(["md-one"]);

    expect(listArtifacts(db, { limit: 50, kind: "sta_ic" }, roots).artifacts).toHaveLength(0);
    expect(listArtifacts(db, { limit: 50, kind: "sta%ic" }, roots).artifacts).toHaveLength(0);
    const httpUnderscore = await getArtifacts(store, "/api/artifacts?kind=sta_ic");
    expect(httpUnderscore.status).toBe(200);
    expect(httpUnderscore.body.artifacts).toHaveLength(0);
    const livePrefix = listArtifacts(db, { limit: 50, kind: "live" }, roots);
    expect(livePrefix.artifacts.map((r) => r.id)).toEqual(["live-one"]);

    const live = listArtifacts(db, { limit: 50, live: true }, roots);
    expect(live.artifacts.map((r) => r.id)).toEqual(["live-one"]);

    const tag = listArtifacts(db, { limit: 50, tag: "weekly" }, roots);
    expect(tag.artifacts).toHaveLength(1);

    const ownerStage = listArtifacts(db, { limit: 50, owner: "stage:ops:report" }, roots);
    expect(ownerStage.artifacts.map((r) => r.id)).toEqual(["expired-one"]);

    const ownerSub = listArtifacts(db, { limit: 50, owner: "ops" }, roots);
    expect(ownerSub.artifacts.map((r) => r.id)).toEqual(["expired-one"]);

    const status = listArtifacts(db, { limit: 50, status: "expired" }, roots);
    expect(status.artifacts.map((r) => r.id)).toEqual(["expired-one"]);

    const httpKind = await getArtifacts(store, "/api/artifacts?kind=static.markdown");
    expect(httpKind.status).toBe(200);
    expect(httpKind.body.artifacts.map((r: { id: string }) => r.id)).toContain("md-one");
  });

  it("sorts and pages by updated, title, and size with stable key ties", async () => {
    const root = await temp("sf-art-sort-");
    const store = await openStore();
    await store.ensureProject(root);
    const db = sqliteConnectionFromStore(store)!;
    const projectId = root;
    const sameTime = "2026-06-01T12:00:00.000Z";
    insertArtifact(db, {
      projectId,
      id: "bbb",
      title: "Bravo",
      kind: "static.text",
      updatedAt: sameTime,
      sizeBytes: 100,
    });
    insertArtifact(db, {
      projectId,
      id: "aaa",
      title: "Alpha",
      kind: "static.text",
      updatedAt: sameTime,
      sizeBytes: 50,
    });
    insertArtifact(db, {
      projectId,
      id: "ccc",
      title: "Charlie",
      kind: "static.text",
      updatedAt: "2026-06-02T12:00:00.000Z",
      sizeBytes: 200,
    });

    const byTitle = listArtifacts(db, { limit: 10, sort: "title", order: "asc", projectRoot: root }, []);
    expect(byTitle.artifacts.map((r) => r.id)).toEqual(["aaa", "bbb", "ccc"]);

    const bySizeDesc = listArtifacts(db, { limit: 10, sort: "size", order: "desc", projectRoot: root }, []);
    expect(bySizeDesc.artifacts.map((r) => r.id)).toEqual(["ccc", "bbb", "aaa"]);

    const page1 = listArtifacts(db, { limit: 2, sort: "title", order: "asc", projectRoot: root }, []);
    expect(page1.artifacts.map((r) => r.id)).toEqual(["aaa", "bbb"]);
    expect(page1.next_cursor).toBeTruthy();
    const page2 = listArtifacts(
      db,
      { limit: 2, sort: "title", order: "asc", projectRoot: root, cursor: page1.next_cursor! },
      [],
    );
    expect(page2.artifacts.map((r) => r.id)).toEqual(["ccc"]);
    expect(page2.next_cursor).toBeNull();

    const tied = listArtifacts(db, { limit: 10, sort: "updated", order: "desc", projectRoot: root }, []);
    expect(tied.artifacts.filter((r) => r.updated_at === sameTime).map((r) => r.id)).toEqual(["aaa", "bbb"]);
  });

  it("encodes cursors with sort and order and rejects mismatched cursors", async () => {
    const cursor = encodeArtifactCursor("title", "asc", "Alpha", "key-a");
    expect(decodeArtifactCursor(cursor)).toEqual({
      sort: "title",
      order: "asc",
      primary: "Alpha",
      key: "key-a",
    });
    const legacy = Buffer.from("2026-01-01T00:00:00.000Z\nlegacy-key", "utf8").toString("base64url");
    expect(decodeArtifactCursor(legacy)?.sort).toBe("updated");
    const root = await temp("sf-art-cursor-");
    const store = await openStore();
    await store.ensureProject(root);
    const db = sqliteConnectionFromStore(store)!;
    insertArtifact(db, {
      projectId: root,
      id: "one",
      title: "One",
      kind: "static.text",
      updatedAt: "2026-01-01T00:00:00.000Z",
      sizeBytes: 1,
    });
    expect(() =>
      listArtifacts(db, {
        limit: 10,
        sort: "title",
        order: "asc",
        cursor: legacy,
        projectRoot: root,
      }, []),
    ).toThrow(/cursor does not match/);
  });

  it("lists 1,000 rows under 500 ms in-process", async () => {
    const root = await temp("sf-art-perf-");
    const store = await openStore();
    await store.ensureProject(root);
    const db = sqliteConnectionFromStore(store)!;
    for (let i = 0; i < 1000; i += 1) {
      const id = `row-${String(i).padStart(4, "0")}`;
      insertArtifact(db, {
        projectId: root,
        id,
        title: `Title ${i}`,
        kind: i % 3 === 0 ? "live.declarative" : "static.text",
        updatedAt: new Date(Date.UTC(2026, 0, 1, 0, i % 60, i % 60)).toISOString(),
        sizeBytes: i,
      });
    }
    const start = performance.now();
    const page = listArtifacts(db, { limit: 50, projectRoot: root }, []);
    const elapsed = performance.now() - start;
    expect(page.artifacts).toHaveLength(50);
    expect(elapsed).toBeLessThan(500);
  });

  it("combines project scope with filters over HTTP", async () => {
    const root = await temp("sf-art-http-f-");
    const store = await openStore();
    await store.ensureProject(root);
    await indexOne(store, root, "report.md", "# x");
    const db = sqliteConnectionFromStore(store)!;
    insertArtifact(db, {
      projectId: root,
      id: "live-x",
      title: "Live",
      kind: "live.html",
      updatedAt: "2026-02-01T00:00:00.000Z",
      sizeBytes: 1,
    });
    const res = await getArtifacts(
      store,
      `/api/artifacts?project_root=${encodeURIComponent(root)}&kind=static&sort=title&order=asc`,
    );
    expect(res.status).toBe(200);
    expect(res.body.artifacts.every((r: { kind: string }) => r.kind.startsWith("static."))).toBe(true);
  });

  function pageAll(
    db: Database.Database,
    query: { limit: number; sort: "updated" | "title" | "size"; order: "asc" | "desc"; projectRoot: string },
  ): string[] {
    const ids: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 20; guard += 1) {
      const page = listArtifacts(db, { ...query, cursor }, []);
      ids.push(...page.artifacts.map((row) => row.id));
      if (page.next_cursor === null) return ids;
      const decoded = decodeArtifactCursor(page.next_cursor);
      expect(decoded?.sort).toBe(query.sort);
      expect(decoded?.order).toBe(query.order);
      if (query.sort === "size") expect(typeof decoded?.primary).toBe("number");
      cursor = page.next_cursor;
    }
    throw new Error("paging did not finish");
  }

  it("pages tied updated, title, and size values in both orders", async () => {
    const root = await temp("sf-art-ties-");
    const store = await openStore();
    await store.ensureProject(root);
    const db = sqliteConnectionFromStore(store)!;
    const sameTime = "2026-06-01T12:00:00.000Z";
    const ids = Array.from({ length: 30 }, (_, index) => `tie-${String(index).padStart(2, "0")}`);
    for (const id of ids) {
      insertArtifact(db, {
        projectId: root,
        id,
        title: "Same",
        kind: "static.text",
        updatedAt: sameTime,
        sizeBytes: 64,
      });
    }
    const expected = ids
      .map((id) => ({ id, key: artifactStorageKey(root, "stage:sales:summarize", id) }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .map((row) => row.id);
    for (const sort of ["updated", "title", "size"] as const) {
      for (const order of ["asc", "desc"] as const) {
        const seen = pageAll(db, { limit: 7, sort, order, projectRoot: root });
        expect(seen, `${sort} ${order}`).toEqual(expected);
      }
    }
  });

  it("pages mixed and missing sizes without repeating a row", async () => {
    const root = await temp("sf-art-sizes-");
    const store = await openStore();
    await store.ensureProject(root);
    const db = sqliteConnectionFromStore(store)!;
    const rows = [
      { id: "s-missing", size: null },
      { id: "s-10-a", size: 10 },
      { id: "s-10-b", size: 10 },
      { id: "s-5", size: 5 },
      { id: "s-20", size: 20 },
      { id: "s-10-c", size: 10 },
      { id: "s-missing-b", size: null },
    ];
    for (const row of rows) {
      insertArtifact(db, {
        projectId: root,
        id: row.id,
        title: row.id,
        kind: "static.text",
        updatedAt: "2026-03-01T00:00:00.000Z",
        sizeBytes: row.size,
      });
    }
    const keyed = rows.map((row) => ({
      ...row,
      key: artifactStorageKey(root, "stage:sales:summarize", row.id),
      size: row.size ?? -1,
    }));
    for (const order of ["asc", "desc"] as const) {
      const expected = [...keyed]
        .sort((a, b) => {
          if (a.size !== b.size) return order === "asc" ? a.size - b.size : b.size - a.size;
          return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
        })
        .map((row) => row.id);
      expect(pageAll(db, { limit: 2, sort: "size", order, projectRoot: root })).toEqual(expected);
    }
  });

  it("pages titles with newlines, quotes, punctuation, and mixed case", async () => {
    const root = await temp("sf-art-titles-");
    const store = await openStore();
    await store.ensureProject(root);
    const db = sqliteConnectionFromStore(store)!;
    const titles = ["line1\nline2", 'say "hi"', "café 你好", "a|b", "a:b", "Alpha", "alpha", "BETA"];
    titles.forEach((title, index) => {
      insertArtifact(db, {
        projectId: root,
        id: `t-${index}`,
        title,
        kind: "static.text",
        updatedAt: "2026-04-01T00:00:00.000Z",
        sizeBytes: 3,
      });
    });
    const asciiFold = (value: string) => value.replace(/[A-Z]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 32));
    const expected = titles
      .map((title, index) => ({
        title,
        id: `t-${index}`,
        key: artifactStorageKey(root, "stage:sales:summarize", `t-${index}`),
      }))
      .sort((a, b) => {
        const left = asciiFold(a.title);
        const right = asciiFold(b.title);
        if (left < right) return -1;
        if (left > right) return 1;
        return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
      });
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 20; guard += 1) {
      const page = listArtifacts(db, { limit: 1, sort: "title", order: "asc", projectRoot: root, cursor }, []);
      expect(page.artifacts).toHaveLength(seen.length === expected.length ? 0 : 1);
      if (page.artifacts.length === 0) {
        expect(page.next_cursor).toBeNull();
        break;
      }
      seen.push(page.artifacts[0]!.title);
      if (page.next_cursor === null) break;
      expect(decodeArtifactCursor(page.next_cursor)?.primary).toBe(page.artifacts[0]!.title);
      cursor = page.next_cursor;
    }
    expect(seen).toEqual(expected.map((row) => row.title));
    const newlinePage = listArtifacts(db, { limit: 1, sort: "title", order: "asc", projectRoot: root }, []);
    let newlineCursor = newlinePage.next_cursor;
    let guard = 0;
    while (newlineCursor && decodeArtifactCursor(newlineCursor)?.primary !== "line1\nline2" && guard < 20) {
      const page = listArtifacts(
        db,
        { limit: 1, sort: "title", order: "asc", projectRoot: root, cursor: newlineCursor },
        [],
      );
      newlineCursor = page.next_cursor;
      guard += 1;
    }
    expect(decodeArtifactCursor(newlineCursor!)?.primary).toBe("line1\nline2");
    const http = await getArtifacts(
      store,
      `/api/artifacts?sort=title&order=asc&limit=2&cursor=${encodeURIComponent(newlineCursor!)}`,
    );
    expect(http.status, JSON.stringify(http.body)).toBe(200);
    expect(http.body.artifacts.length).toBeGreaterThan(0);
  });

  it("filters a published tag that starts with a digit", async () => {
    const home = await temp("sf-art-tag-home-");
    const previous = process.env.STAGEFLOW_HOME;
    process.env.STAGEFLOW_HOME = home;
    resetGlobalStageflowHomeForTests();
    try {
      const root = await temp("sf-art-tag-proj-");
      const store = await openStore();
      await store.ensureProject(root);
      const url = new URL("/api/artifacts", "http://127.0.0.1");
      let status = 0;
      let payload = "";
      const res = {
        writeHead(code: number) {
          status = code;
        },
        end(body?: string) {
          payload = body ?? "";
        },
      } as unknown as ServerResponse;
      const body = Buffer.from(
        JSON.stringify({
          owner: { kind: "stage", pipeline: "sales", stage: "summarize" },
          project_root: root,
          id: "year",
          kind: "static.markdown",
          title: "Year",
          content: "# 2024\n",
          tags: ["2024"],
        }),
      );
      const req = {
        async *[Symbol.asyncIterator]() {
          yield body;
        },
      } as unknown as IncomingMessage;
      const handled = await handleArtifactRoutes(req, "POST", url.pathname, url, store, res, json);
      expect(handled).toBe(true);
      expect(status, payload).toBe(200);
      expect(ARTIFACT_TAG_PATTERN.test("2024")).toBe(true);
      const listed = await getArtifacts(store, `/api/artifacts?project_root=${encodeURIComponent(root)}&tag=2024`);
      expect(listed.status).toBe(200);
      expect(listed.body.artifacts.map((row: { id: string }) => row.id)).toEqual(["year"]);
    } finally {
      if (previous === undefined) delete process.env.STAGEFLOW_HOME;
      else process.env.STAGEFLOW_HOME = previous;
      resetGlobalStageflowHomeForTests();
    }
  });

  it("parses live filter", () => {
    expect(parseArtifactLiveFilter(null)).toBeUndefined();
    expect(parseArtifactLiveFilter("true")).toBe(true);
    expect(parseArtifactLiveFilter("false")).toBe(false);
    expect(() => parseArtifactLiveFilter("maybe")).toThrow(ArtifactQueryError);
    expect(parseArtifactKindFilter("Static")).toBe("static");
  });
});