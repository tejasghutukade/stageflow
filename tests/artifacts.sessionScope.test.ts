import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { presentInline } from "../src/agents/presentUi.js";
import { LIBRARY_NAME, LIBRARY_VERSION } from "../src/artifacts/library/index.js";
import { catalogRootsForArtifacts } from "../src/artifacts/projectScope.js";
import { listArtifacts } from "../src/artifacts/query.js";
import {
  expireDueSessionArtifacts,
  promoteSessionArtifact,
  purgeSessionArtifacts,
  resetSessionArtifactLimiterForTests,
  SESSION_ARTIFACT_TTL_MS,
} from "../src/artifacts/sessionScope.js";
import { artifactStorageKey } from "../src/artifacts/keys.js";
import { agentProjectKey } from "../src/agents/store.js";
import type { McpToolDeps } from "../src/mcp/deps.js";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";
import { createRunStore, sqliteConnectionFromStore } from "../src/runstore/createStore.js";

const cleanups: Array<() => Promise<void>> = [];
const previousHome = process.env.STAGEFLOW_HOME;

afterEach(async () => {
  resetSessionArtifactLimiterForTests();
  resetGlobalStageflowHomeForTests();
  if (previousHome === undefined) delete process.env.STAGEFLOW_HOME;
  else process.env.STAGEFLOW_HOME = previousHome;
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function openStore() {
  const home = await mkdtemp(path.join(tmpdir(), "sf-session-art-"));
  const projectDir = await mkdtemp(path.join(tmpdir(), "sf-session-proj-"));
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
  db.prepare(
    `INSERT INTO agent_definitions (project_key, agent_id, current_revision, archived, created_at, updated_at)
     VALUES (?, 'helper', 1, 0, '2026-11-25T00:00:00.000Z', '2026-11-25T00:00:00.000Z')`,
  ).run(agentProjectKey(project));
  const roots = await catalogRootsForArtifacts(store);
  return { db, roots, project };
}

function manifest(program: string) {
  return {
    format: "openui-lang",
    library: { name: LIBRARY_NAME, version: LIBRARY_VERSION },
    bindings: [],
    kind: "live.declarative",
    program,
  };
}

describe("session artifacts", () => {
  it("saves an inline program, hides it from the default list, and promotes it", async () => {
    const { db, roots, project } = await openStore();
    const nowMs = Date.parse("2026-11-25T00:00:00.000Z");
    const shown = await presentInline({
      db,
      roots,
      projectRoot: project,
      program: 'root = TextContent("card")',
      manifest: manifest('root = TextContent("card")'),
      sessionId: "sess-1",
      agentId: "helper",
      presentedInMessage: 1,
      nowMs,
      allowedKinds: ["live.declarative"],
      consoleDeps: { cwd: project } as McpToolDeps,
      title: "Card",
    });
    expect(shown.ok).toBe(true);
    if (!shown.ok) return;
    expect(shown.envelope.ui.key.startsWith("agent:helper/")).toBe(true);
    const hidden = listArtifacts(db, { limit: 20 }, roots);
    expect(hidden.artifacts.map((row) => row.key)).not.toContain(shown.envelope.ui.key);
    const sessionList = listArtifacts(db, { limit: 20, scope: "session" }, roots);
    expect(sessionList.artifacts.map((row) => row.key)).toEqual([shown.envelope.ui.key]);
    expect(sessionList.artifacts[0]?.scope).toBe("session");
    expect(Date.parse(sessionList.artifacts[0]!.expires_at!)).toBe(nowMs + SESSION_ARTIFACT_TTL_MS);

    const record = sessionList.artifacts[0]!;
    promoteSessionArtifact(db, artifactStorageKey(record.project.id, `agent:${record.owner.kind === "agent" ? record.owner.agent : ""}`, record.id));
    const after = listArtifacts(db, { limit: 20 }, roots);
    expect(after.artifacts.map((row) => row.key)).toContain(shown.envelope.ui.key);
    expect(after.artifacts[0]?.scope).toBe("project");
    expect(after.artifacts[0]?.expires_at).toBeNull();
  });

  it("titles an untitled markdown artifact from its first heading", async () => {
    const { db, roots, project } = await openStore();
    const program = "# Visitor checklist\n\n- one\n- two";
    const shown = await presentInline({
      db,
      roots,
      projectRoot: project,
      program,
      manifest: { kind: "static.markdown" },
      sessionId: "sess-1",
      agentId: "helper",
      presentedInMessage: 1,
      allowedKinds: ["static.markdown"],
      consoleDeps: { cwd: project } as McpToolDeps,
    });
    expect(shown.ok).toBe(true);
    if (!shown.ok) return;
    expect(shown.envelope.ui.title).toBe("Visitor checklist");
  });

  it("tells the agent which kinds it may use when manifest.kind is missing", async () => {
    const { db, roots, project } = await openStore();
    const shown = await presentInline({
      db,
      roots,
      projectRoot: project,
      program: "# Plan",
      manifest: {},
      sessionId: "sess-1",
      agentId: "helper",
      presentedInMessage: 1,
      allowedKinds: ["static.markdown", "live.html"],
      consoleDeps: { cwd: project } as McpToolDeps,
    });
    expect(shown).toMatchObject({ ok: false, code: "artifact.invalid_shape" });
    if (shown.ok) return;
    expect(shown.message).toContain("static.markdown, live.html");
  });

  it("returns the validation error and does not store an invalid program", async () => {
    const { db, roots, project } = await openStore();
    const shown = await presentInline({
      db,
      roots,
      projectRoot: project,
      program: 'root = NotAThing("x")',
      manifest: manifest('root = NotAThing("x")'),
      sessionId: "sess-1",
      agentId: "helper",
      presentedInMessage: 1,
      allowedKinds: ["live.declarative"],
      consoleDeps: { cwd: project } as McpToolDeps,
    });
    expect(shown.ok).toBe(false);
    if (shown.ok) return;
    expect(shown.code).toBe("artifact.program_invalid");
    expect(shown.message.length).toBeGreaterThan(0);
    expect(listArtifacts(db, { limit: 20, scope: "session" }, roots).artifacts).toEqual([]);
  });

  it("omits eval-session artifacts from every list and purges them with the session", async () => {
    const { db, roots, project } = await openStore();
    db.prepare(
      `INSERT INTO agent_sessions (
         session_id, project_key, agent_id, revision, backend, status, source, created_at, updated_at
       ) VALUES ('eval-1', 'p', 'helper', 1, 'pi', 'closed', 'eval', '2026-11-25T00:00:00.000Z', '2026-11-25T00:00:00.000Z')`,
    ).run();
    const shown = await presentInline({
      db,
      roots,
      projectRoot: project,
      program: 'root = TextContent("card")',
      manifest: manifest('root = TextContent("card")'),
      sessionId: "eval-1",
      agentId: "helper",
      presentedInMessage: 1,
      allowedKinds: ["live.declarative"],
      consoleDeps: { cwd: project } as McpToolDeps,
    });
    expect(shown.ok).toBe(true);
    expect(listArtifacts(db, { limit: 20 }, roots).artifacts).toEqual([]);
    expect(listArtifacts(db, { limit: 20, scope: "session" }, roots).artifacts).toEqual([]);
    const removed = await purgeSessionArtifacts(db, ["eval-1"]);
    expect(removed).toBe(1);
    const left = db.prepare(`SELECT COUNT(*) AS n FROM artifacts WHERE source_session_id = 'eval-1'`).get() as { n: number };
    expect(left.n).toBe(0);
  });

  it("expires a session artifact when its expiry has passed", async () => {
    const { db, roots, project } = await openStore();
    const shown = await presentInline({
      db,
      roots,
      projectRoot: project,
      program: 'root = TextContent("card")',
      manifest: manifest('root = TextContent("card")'),
      sessionId: "sess-2",
      agentId: "helper",
      presentedInMessage: 1,
      nowMs: Date.parse("2026-01-01T00:00:00.000Z"),
      allowedKinds: ["live.declarative"],
      consoleDeps: { cwd: project } as McpToolDeps,
    });
    expect(shown.ok).toBe(true);
    expect(expireDueSessionArtifacts(db, "2026-11-25T00:00:00.000Z")).toBe(1);
    const page = listArtifacts(db, { limit: 20, scope: "session" }, roots);
    expect(page.artifacts[0]?.status).toBe("expired");
    expect(page.artifacts[0]?.expired_reason).toBe("session_expired");
  });
});
