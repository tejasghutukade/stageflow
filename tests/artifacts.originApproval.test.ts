import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentPublishArtifactTool } from "../src/agents/artifactTools.js";
import { agentProjectKey } from "../src/agents/store.js";
import { canonicalJson } from "../src/evals/canonical.js";
import { artifactStorageKey, stageOwnerKey } from "../src/artifacts/keys.js";
import {
  approveOrigins,
  declaredOriginCount,
  deleteOriginApprovals,
  isApproved,
  listOriginApprovals,
  normalizeOrigins,
  ORIGIN_APPROVAL_CAP,
  ORIGIN_APPROVAL_WARNING,
  originsHash,
  revokeOrigins,
} from "../src/artifacts/originApproval.js";
import { catalogRootsForArtifacts } from "../src/artifacts/projectScope.js";
import { deletePublishedArtifact, publishArtifact } from "../src/artifacts/publish.js";
import { readArtifact } from "../src/artifacts/query.js";
import { indexDeclaredDeliverables } from "../src/artifacts/indexDeclared.js";
import { ARTIFACT_USAGE, runArtifactCommand } from "../src/cli/artifactCommand.js";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";
import { createRunStore, sqliteConnectionFromStore } from "../src/runstore/createStore.js";
import type { RunStore } from "../src/runstore/port.js";
import { applySchemaThrough } from "./helpers/schemaAtVersion.js";
import { json } from "../src/server/createHttpHost.js";
import { handleArtifactRoutes } from "../src/server/artifactRoutes.js";
import { requiredScopeFor } from "../src/server/controlToken.js";
import { createPublishArtifactTool } from "../src/tools/publishArtifact.js";
import { publishSessionArtifact } from "../src/artifacts/sessionPublish.js";
import { TOOL_META } from "../src/toolkit/meta.js";
import { describeToolkit } from "../src/toolkit/index.js";

const cleanups: Array<() => Promise<void>> = [];
const previousHome = process.env.STAGEFLOW_HOME;
const PAGE = "<p>Hello</p>";
const OWNER = { kind: "stage" as const, pipeline: "sales", stage: "summarize" };
const OWNER_KEY = "stage:sales:summarize";

afterEach(async () => {
  resetGlobalStageflowHomeForTests();
  if (previousHome === undefined) delete process.env.STAGEFLOW_HOME;
  else process.env.STAGEFLOW_HOME = previousHome;
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function openStore(): Promise<{ store: RunStore; home: string; project: string }> {
  const home = await mkdtemp(path.join(tmpdir(), "sf-origin-home-"));
  const project = await mkdtemp(path.join(tmpdir(), "sf-origin-proj-"));
  process.env.STAGEFLOW_HOME = home;
  resetGlobalStageflowHomeForTests();
  const store = createRunStore({ rootDir: home });
  const registered = await store.ensureProject(project);
  cleanups.push(async () => {
    await store.close().catch(() => undefined);
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });
  return { store, home, project: registered };
}

function csp(connect: string[], resource: string[] = [], base: string[] = []) {
  return {
    ...(connect.length > 0 ? { connectDomains: connect } : {}),
    ...(resource.length > 0 ? { resourceDomains: resource } : {}),
    ...(base.length > 0 ? { baseUriDomains: base } : {}),
  };
}

async function publishHtml(
  store: RunStore,
  project: string,
  id: string,
  manifest: Record<string, unknown>,
  bytes = PAGE,
) {
  const db = sqliteConnectionFromStore(store)!;
  const roots = await catalogRootsForArtifacts(store);
  return publishArtifact(db, {
    owner: OWNER,
    projectRoot: project,
    id,
    kind: "live.html",
    title: "Page",
    bytes: Buffer.from(bytes),
    manifest,
    publishSource: "api",
    roots,
  });
}

function request(body?: unknown, raw?: Buffer): IncomingMessage {
  const payload = raw ?? (body === undefined ? undefined : Buffer.from(JSON.stringify(body)));
  if (payload === undefined) return {} as IncomingMessage;
  return {
    async *[Symbol.asyncIterator]() {
      yield payload;
    },
  } as unknown as IncomingMessage;
}

async function call(store: RunStore, method: string, pathname: string, body?: unknown, raw?: Buffer) {
  const sent: { status?: number; body?: Record<string, unknown> } = {};
  const url = new URL(pathname, "http://127.0.0.1");
  const res = {
    writeHead(status: number) {
      sent.status = status;
    },
    end() {},
  } as unknown as ServerResponse;
  await handleArtifactRoutes(request(body, raw), method, url.pathname, url, store, res, (response, status, payload) => {
    json(response, status, payload);
    sent.status = status;
    sent.body = payload as Record<string, unknown>;
  });
  return sent;
}

describe("origin normalisation", () => {
  it("sorts, lowercases, dedupes, and ignores frame domains", () => {
    const messy = {
      connectDomains: ["https://B.Example.com", "https://a.example.com:443", "https://a.example.com"],
      resourceDomains: ["https://*.CDN.Example.com", "HTTPS://*.cdn.example.com"],
      baseUriDomains: ["https://Base.Example.com:8443"],
      frameDomains: ["https://frame.example.com"],
    };
    expect(normalizeOrigins(messy)).toEqual({
      connect: ["https://a.example.com", "https://b.example.com"],
      resource: ["https://*.cdn.example.com"],
      base: ["https://base.example.com:8443"],
    });
    const canonical = canonicalJson(normalizeOrigins(messy));
    expect(canonical).toBe(
      '{"base":["https://base.example.com:8443"],"connect":["https://a.example.com","https://b.example.com"],"resource":["https://*.cdn.example.com"]}',
    );
    const digest = createHash("sha256").update(canonical).digest("hex");
    expect(originsHash(messy)).toBe(digest);
    expect(originsHash({ connectDomains: ["https://b.example.com", "https://a.example.com"] })).toBe(
      originsHash({ connectDomains: ["https://A.Example.com:443", "https://b.example.com", "https://b.example.com"] }),
    );
    expect(originsHash({})).toBe(originsHash({ frameDomains: ["https://frame.example.com"] }));
    expect(declaredOriginCount({})).toBe(0);
  });
});

describe("origin approvals", () => {
  it("approves the current set, keeps it across a republish, and requires a new approval when the set changes", async () => {
    const { store, project } = await openStore();
    const db = sqliteConnectionFromStore(store)!;
    const roots = await catalogRootsForArtifacts(store);
    const first = await publishHtml(store, project, "page", { format: "html", csp: csp(["https://API.Example.com"]) });
    expect(first.warnings?.map((warning) => warning.message)).toContain(ORIGIN_APPROVAL_WARNING);
    const key = artifactStorageKey(project, stageOwnerKey("sales", "summarize"), "page");
    const hash = originsHash({ connectDomains: ["https://api.example.com"] });
    expect(isApproved(db, key, hash)).toBe(false);
    const record = readArtifact(db, OWNER_KEY, "page", project, roots);
    expect(record.live?.origins).toMatchObject({ connect: ["https://api.example.com"], hash, approved: false, approved_at: null });

    const approved = approveOrigins(db, key, { originsHash: hash, by: "api" });
    expect(approved.approved).toBe(true);
    expect(isApproved(db, key, hash)).toBe(true);
    expect(readArtifact(db, OWNER_KEY, "page", project, roots).live?.origins?.approved).toBe(true);

    const same = await publishHtml(store, project, "page", { format: "html", csp: csp(["https://api.example.com"]) }, "<p>Again</p>");
    expect(same.version).toBe(2);
    expect(isApproved(db, key, hash)).toBe(true);
    expect(readArtifact(db, OWNER_KEY, "page", project, roots).live?.origins?.approved).toBe(true);

    const nextHash = originsHash({ connectDomains: ["https://other.example.com"] });
    await publishHtml(store, project, "page", { format: "html", csp: csp(["https://other.example.com"]) }, "<p>Third</p>");
    expect(isApproved(db, key, hash)).toBe(true);
    expect(isApproved(db, key, nextHash)).toBe(false);
    expect(readArtifact(db, OWNER_KEY, "page", project, roots).live?.origins).toMatchObject({
      connect: ["https://other.example.com"],
      hash: nextHash,
      approved: false,
    });
    expect(() => approveOrigins(db, key, { originsHash: hash, by: "cli" })).toThrow(
      expect.objectContaining({ status: 409, code: "artifact.origins_mismatch", details: { current_hash: nextHash } }),
    );
  });

  it("rejects an empty set, a static artifact, a hidden eval artifact, and a missing version", async () => {
    const { store, project } = await openStore();
    const db = sqliteConnectionFromStore(store)!;
    const roots = await catalogRootsForArtifacts(store);
    await publishHtml(store, project, "plain", { format: "html" });
    const plain = artifactStorageKey(project, stageOwnerKey("sales", "summarize"), "plain");
    expect(readArtifact(db, OWNER_KEY, "plain", project, roots).live?.origins?.approved).toBe(true);
    expect(() => approveOrigins(db, plain, { originsHash: originsHash({}), by: "console" })).toThrow(
      expect.objectContaining({ status: 400, code: "artifact.invalid_shape", message: "no origins to approve" }),
    );
    await publishArtifact(db, {
      owner: OWNER,
      projectRoot: project,
      id: "note",
      kind: "static.text",
      title: "Note",
      bytes: Buffer.from("hi"),
      publishSource: "api",
      roots,
    });
    const note = artifactStorageKey(project, stageOwnerKey("sales", "summarize"), "note");
    expect(() => approveOrigins(db, note, { originsHash: "a".repeat(64), by: "api" })).toThrow(
      expect.objectContaining({ message: "no origins to approve" }),
    );
    await publishArtifact(db, {
      owner: OWNER,
      projectRoot: project,
      id: "secret",
      kind: "live.html",
      title: "Secret",
      bytes: Buffer.from(PAGE),
      manifest: { format: "html", csp: csp(["https://api.example.com"]) },
      publishSource: "api",
      roots,
      hidden: true,
      ownerNamespace: "eval",
    });
    const secret = artifactStorageKey(project, `eval:${stageOwnerKey("sales", "summarize")}`, "secret");
    expect(() => approveOrigins(db, secret, { originsHash: originsHash(csp(["https://api.example.com"])), by: "api" })).toThrow(
      expect.objectContaining({ status: 404, code: "artifact.not_found" }),
    );
    const page = artifactStorageKey(project, stageOwnerKey("sales", "summarize"), "plain");
    expect(() => approveOrigins(db, page, { originsHash: "e".repeat(64), version: 9, by: "api" })).toThrow(
      expect.objectContaining({ status: 404, code: "artifact.not_found" }),
    );
  });

  it("keeps eight approvals and deletes them with the artifact and with indexed rows", async () => {
    const { store, project } = await openStore();
    const db = sqliteConnectionFromStore(store)!;
    await publishHtml(store, project, "page", { format: "html", csp: csp(["https://api.example.com"]) });
    const key = artifactStorageKey(project, stageOwnerKey("sales", "summarize"), "page");
    const hash = originsHash(csp(["https://api.example.com"]));
    for (let index = 0; index < ORIGIN_APPROVAL_CAP; index += 1) {
      db.prepare(
        `INSERT INTO artifact_origin_approvals (artifact_key, origins_hash, origins_json, approved_at, approved_by)
         VALUES (?, ?, '{}', ?, 'api')`,
      ).run(key, index.toString(16).padStart(64, "0"), `2020-01-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`);
    }
    approveOrigins(db, key, { originsHash: hash, by: "console" });
    const rows = listOriginApprovals(db, key);
    expect(rows).toHaveLength(ORIGIN_APPROVAL_CAP);
    expect(rows.some((row) => row.origins_hash === hash)).toBe(true);
    expect(rows.some((row) => row.origins_hash === "0".repeat(64))).toBe(false);
    expect(rows[0]?.approved_by).toBe("console");

    const revoked = revokeOrigins(db, key, hash);
    expect(revoked.revoked).toBe(1);
    expect(revoked.origins?.approved).toBe(false);
    expect(revokeOrigins(db, key).revoked).toBe(ORIGIN_APPROVAL_CAP - 1);
    expect(listOriginApprovals(db, key)).toEqual([]);

    approveOrigins(db, key, { originsHash: hash, by: "cli" });
    const roots = await catalogRootsForArtifacts(store);
    await deletePublishedArtifact(db, OWNER_KEY, "page", project, roots);
    expect(listOriginApprovals(db, key)).toEqual([]);

    const now = "2026-11-25T00:00:00.000Z";
    db.prepare(
      `INSERT INTO runs (run_id, pipeline_id, task_yaml, status, created_at, updated_at)
       VALUES ('run-idx', 'sales', 'id: t\ngoal: g\n', 'succeeded', ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO artifacts (
         key, owner_kind, owner_pipeline, owner_stage, project_root_id, id, title, tags_json,
         kind, origin, current_version, hidden, created_at, updated_at, source_run_id, source_stage_id, source_attempt
       ) VALUES (
         'indexed-live', 'stage', 'sales', 'summarize', ?, 'indexedid', 'Indexed', '[]',
         'static.text', 'indexed', 1, 0, ?, ?, 'run-idx', 'summarize', 1
       )`,
    ).run(project, now, now);
    db.prepare(
      `INSERT INTO artifact_origin_approvals (artifact_key, origins_hash, origins_json, approved_at, approved_by)
       VALUES ('indexed-live', ?, '{}', ?, 'api')`,
    ).run("b".repeat(64), now);
    await indexDeclaredDeliverables({
      db,
      store,
      runId: "run-idx",
      stageId: "summarize",
      attempt: 1,
      envelope: { status: "failed", artifacts: [] } as never,
    });
    expect(listOriginApprovals(db, "indexed-live")).toEqual([]);
    deleteOriginApprovals(db, []);
  });

  it("adds migration 030 on a fresh store and on a store at version 29", async () => {
    const fresh = await openStore();
    const freshDb = sqliteConnectionFromStore(fresh.store)!;
    expect(freshDb.pragma("user_version", { simple: true })).toBe(30);
    expect(freshDb.prepare(`SELECT name FROM sqlite_master WHERE name = 'artifact_origin_approvals'`).get()).toBeTruthy();

    const home = await mkdtemp(path.join(tmpdir(), "sf-origin-v29-"));
    process.env.STAGEFLOW_HOME = home;
    resetGlobalStageflowHomeForTests();
    const db = new Database(path.join(home, "state.db"));
    applySchemaThrough(db, 29);
    expect(db.pragma("user_version", { simple: true })).toBe(29);
    db.close();
    cleanups.push(async () => {
      await rm(home, { recursive: true, force: true });
    });
    const migrated = createRunStore({ rootDir: home });
    cleanups.push(() => migrated.close());
    const migratedDb = sqliteConnectionFromStore(migrated)!;
    expect(migratedDb.pragma("user_version", { simple: true })).toBe(30);
    expect(migratedDb.prepare(`SELECT name FROM sqlite_master WHERE name = 'artifact_origin_approvals'`).get()).toBeTruthy();
  });
});

describe("origin approval routes", () => {
  it("requires drive scope and approves, mismatches, and revokes through the routes", async () => {
    expect(requiredScopeFor("POST", "/api/artifacts/stage:sales:summarize/page/origins/approve")).toBe("drive");
    expect(requiredScopeFor("DELETE", "/api/artifacts/stage:sales:summarize/page/origins/approval")).toBe("drive");
    const { store, project } = await openStore();
    const root = `project_root=${encodeURIComponent(project)}`;
    const base = `/api/artifacts/${OWNER_KEY}/page`;
    const published = await call(store, "POST", "/api/artifacts", {
      owner: OWNER,
      project_root: project,
      id: "page",
      kind: "live.html",
      title: "Page",
      content: PAGE,
      manifest: { format: "html", csp: csp(["https://api.example.com"], ["https://cdn.example.com"]) },
    });
    expect(published.status).toBe(200);
    expect(published.body?.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ message: ORIGIN_APPROVAL_WARNING })]),
    );
    const hash = originsHash(csp(["https://api.example.com"], ["https://cdn.example.com"]));
    const shown = await call(store, "GET", `${base}?${root}`);
    expect(shown.body?.live).toMatchObject({ origins: { hash, approved: false } });

    const missing = await call(store, "POST", `${base}/origins/approve?${root}`, { origins_hash: hash, extra: true });
    expect(missing.status).toBe(400);
    expect(missing.body?.code).toBe("artifact.invalid_shape");
    const mismatch = await call(store, "POST", `${base}/origins/approve?${root}`, { origins_hash: "c".repeat(64) });
    expect(mismatch.status).toBe(409);
    expect(mismatch.body).toMatchObject({ code: "artifact.origins_mismatch", current_hash: hash });
    const empty = await call(store, "POST", `/api/artifacts/${OWNER_KEY}/missing/origins/approve?${root}`, {
      origins_hash: hash,
    });
    expect(empty.status).toBe(404);
    const method = await call(store, "GET", `${base}/origins/approve?${root}`);
    expect(method.status).toBe(405);
    const huge = await call(store, "POST", `${base}/origins/approve?${root}`, undefined, Buffer.alloc(64 * 1024 + 1, 0x61));
    expect(huge.status).toBe(413);

    const ok = await call(store, "POST", `${base}/origins/approve?${root}`, { origins_hash: hash });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ approved: true, origins: { hash, approved: true } });
    const gone = await call(store, "DELETE", `${base}/origins/approval?${root}&origins_hash=${hash}`);
    expect(gone.status).toBe(200);
    expect(gone.body).toMatchObject({ revoked: 1, origins: { approved: false } });
  });

  it("asks for project_root when the same artifact id is in two projects", async () => {
    const { store, project } = await openStore();
    const other = await mkdtemp(path.join(tmpdir(), "sf-origin-other-"));
    cleanups.push(() => rm(other, { recursive: true, force: true }));
    const otherId = await store.ensureProject(other);
    await publishHtml(store, project, "page", { format: "html", csp: csp(["https://api.example.com"]) });
    await publishHtml(store, otherId, "page", { format: "html", csp: csp(["https://api.example.com"]) });
    const hash = originsHash(csp(["https://api.example.com"]));
    const ambiguous = await call(store, "POST", `/api/artifacts/${OWNER_KEY}/page/origins/approve`, { origins_hash: hash });
    expect(ambiguous.status).toBe(409);
    expect(ambiguous.body?.code).toBe("artifact.ambiguous");
  });
});

describe("origin approval is operator-only", () => {
  it("is absent from the MCP toolset and the agent tool list", () => {
    const names = [
      ...Object.keys(TOOL_META),
      ...describeToolkit().toolsets.flatMap((toolset) => toolset.tools),
      ...describeToolkit().groups.flatMap((group) => group.tools.map((tool) => tool.name)),
      createAgentPublishArtifactTool({
        agentId: "helper",
        projectRoot: "/tmp",
        stageflowHome: "/tmp",
        publish: async () => ({ key: "k", version: 1, project_root: "/tmp", url: "/a", unchanged: false }),
      }).name,
      createPublishArtifactTool({
        runWorkspaceDir: "/tmp",
        stageId: "summarize",
        attempt: 1,
        publish: async () => ({ key: "k", version: 1, unchanged: false }),
      }).name,
    ];
    expect(names.filter((name) => /approve|revoke|origin/i.test(name))).toEqual([]);
    expect(describeToolkit().toolsets.find((toolset) => toolset.id === "artifacts")?.tools.sort()).toEqual([
      "delete_artifact",
      "get_artifact",
      "refresh_artifact",
      "save_artifact",
    ]);
  });

  it("puts the approval warning on the stage and agent tool results", async () => {
    const { store, project } = await openStore();
    const db = sqliteConnectionFromStore(store)!;
    const roots = await catalogRootsForArtifacts(store);
    db.prepare(
      `INSERT INTO agent_definitions (project_key, agent_id, current_revision, archived, created_at, updated_at)
       VALUES (?, 'helper', 1, 0, '2026-11-25T00:00:00.000Z', '2026-11-25T00:00:00.000Z')`,
    ).run(agentProjectKey(project));
    const stageTool = createPublishArtifactTool({
      runWorkspaceDir: project,
      stageId: "summarize",
      attempt: 1,
      publish: (body) =>
        publishSessionArtifact(
          { db, roots },
          { owner: OWNER, projectRoot: project, source: {} },
          body,
        ),
    });
    const stage = await stageTool.execute("call", {
      id: "page",
      kind: "live.html",
      title: "Page",
      content: PAGE,
      format: "html",
      csp: { connectDomains: ["https://api.example.com"] },
    });
    expect(JSON.parse(stage.content[0]!.text).warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ message: ORIGIN_APPROVAL_WARNING })]),
    );
    const agentTool = createAgentPublishArtifactTool({
      agentId: "helper",
      projectRoot: project,
      stageflowHome: project,
      publish: (body) =>
        publishSessionArtifact(
          { db, roots },
          { owner: { kind: "agent", agent: "helper" }, projectRoot: project, source: { sessionId: "sess" } },
          body,
        ),
    });
    const agent = await agentTool.execute("call", {
      id: "board",
      kind: "live.html",
      title: "Board",
      content: PAGE,
      format: "html",
      csp: { resourceDomains: ["https://cdn.example.com"] },
    });
    expect(JSON.parse(agent.content[0]!.text).warnings.map((warning: { message: string }) => warning.message)).toContain(
      ORIGIN_APPROVAL_WARNING,
    );
  });
});

describe("sf artifact origins", () => {
  it("shows, approves with confirmation, and revokes", async () => {
    expect(ARTIFACT_USAGE).toContain("sf artifact approve-origins");
    expect(ARTIFACT_USAGE).toContain("sf artifact revoke-origins");
    const { store, project } = await openStore();
    await publishHtml(store, project, "page", { format: "html", csp: csp(["https://api.example.com"]) });
    const key = `${OWNER_KEY}/page`;
    const shown = capture();
    expect(
      await runArtifactCommand(["origins", key, "--project-root", project, "--json"], { cwd: project, io: shown.io }),
    ).toBe(0);
    const body = JSON.parse(shown.stdout.join("\n")) as { origins: { hash: string; approved: boolean } };
    expect(body.origins.approved).toBe(false);

    const refused = capture();
    expect(
      await runArtifactCommand(["approve-origins", key, "--project-root", project, "--json"], {
        cwd: project,
        io: refused.io,
        stdinIsTTY: false,
      }),
    ).toBe(1);
    expect(JSON.parse(refused.stdout.join("\n")).code).toBe("artifact.confirmation_required");
    expect(refused.stderr.join("\n")).toContain("https://api.example.com");

    const mismatch = capture();
    expect(
      await runArtifactCommand(["approve-origins", key, "--hash", "d".repeat(64), "--yes", "--project-root", project, "--json"], {
        cwd: project,
        io: mismatch.io,
      }),
    ).toBe(1);
    expect(JSON.parse(mismatch.stdout.join("\n"))).toMatchObject({
      code: "artifact.origins_mismatch",
      current_hash: body.origins.hash,
    });

    const approved = capture();
    expect(
      await runArtifactCommand(["approve-origins", key, "--project-root", project, "--json"], {
        cwd: project,
        io: approved.io,
        confirm: async () => true,
      }),
    ).toBe(0);
    expect(JSON.parse(approved.stdout.join("\n")).approved).toBe(true);

    const revoked = capture();
    expect(
      await runArtifactCommand(["revoke-origins", key, "--hash", body.origins.hash, "--project-root", project, "--json"], {
        cwd: project,
        io: revoked.io,
      }),
    ).toBe(0);
    expect(JSON.parse(revoked.stdout.join("\n")).revoked).toBe(1);
  });

  it("refuses approve and revoke inside a stage or agent session", async () => {
    const { store, project } = await openStore();
    await publishHtml(store, project, "page", { format: "html", csp: csp(["https://api.example.com"]) });
    const key = `${OWNER_KEY}/page`;
    const markers = ["SF_STAGE_WORKER", "STAGEFLOW_RUN_WORKSPACE", "STAGEFLOW_STAGE_ARTIFACTS_DIR", "STAGEFLOW_RUN_ID", "STAGEFLOW_STAGE_ID"];
    const previous = new Map(markers.map((name) => [name, process.env[name]]));
    try {
      process.env.SF_STAGE_WORKER = "1";
      const approved = capture();
      expect(
        await runArtifactCommand(["approve-origins", key, "--yes", "--project-root", project, "--json"], {
          cwd: project,
          io: approved.io,
        }),
      ).toBe(1);
      expect(JSON.parse(approved.stdout.join("\n"))).toMatchObject({
        code: "artifact.operator_only",
        error: "approval is an operator action: refused inside a stage or agent session",
      });
      delete process.env.SF_STAGE_WORKER;
      process.env.STAGEFLOW_RUN_WORKSPACE = "/tmp/run";
      const revoked = capture();
      expect(
        await runArtifactCommand(["revoke-origins", key, "--project-root", project, "--json"], {
          cwd: project,
          io: revoked.io,
        }),
      ).toBe(1);
      expect(JSON.parse(revoked.stdout.join("\n")).error).toBe(
        "approval is an operator action: refused inside a stage or agent session",
      );
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});

function capture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      log: (line: string) => stdout.push(line),
      error: (line: string) => stderr.push(line),
    },
  };
}
