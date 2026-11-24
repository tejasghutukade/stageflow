import { mkdtemp, mkdir, rm, symlink, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { realpathSync } from "node:fs";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { ARTIFACT_CONTENT_MAX_BYTES, contentTooLarge, servedArtifactMediaType } from "../src/artifacts/content.js";
import { artifactIdFromRelative } from "../src/artifacts/keys.js";
import { createRunStore, sqliteConnectionFromStore } from "../src/runstore/createStore.js";
import type { RunStore } from "../src/runstore/port.js";
import { attemptArtifactsDir } from "../src/runstore/workspaceLayout.js";
import { buildArtifactListedPath } from "../src/runtime/artifactPath.js";
import { json } from "../src/server/createHttpHost.js";
import { handleArtifactRoutes } from "../src/server/artifactRoutes.js";
import { startTestService } from "./helpers/testInProcessService.js";

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
  const root = await temp("sf-art-content-");
  const store = createRunStore({ rootDir: root, kind: "sqlite" });
  cleanups.push(async () => {
    await store.close();
  });
  return store;
}

async function indexFiles(
  store: RunStore,
  options: { projectRoot: string; files: Record<string, string | Buffer> },
): Promise<string> {
  const stageId = "summarize";
  const created = await store.createRun({
    pipelineId: "sales",
    taskYaml: "id: t\ngoal: g\n",
    projectRoot: options.projectRoot,
  });
  await store.createStageExecution(created.runId, stageId);
  const dir = attemptArtifactsDir(store.getWorkspaceDir(created.runId), stageId, 1);
  await mkdir(dir, { recursive: true });
  for (const [rel, body] of Object.entries(options.files)) {
    const full = path.join(dir, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, body);
  }
  const db = sqliteConnectionFromStore(store);
  if (!db) throw new Error("expected sqlite");
  db.prepare(`UPDATE runs SET project_root = ? WHERE run_id = ?`).run(options.projectRoot, created.runId);
  await store.writeEnvelope(
    created.runId,
    stageId,
    {
      status: "success",
      summary: "ok",
      artifacts: Object.keys(options.files),
      payload: {},
    },
    { attempt: 1 },
  );
  return created.runId;
}

function captureResponse(): {
  res: ServerResponse;
  read: () => { status: number; headers: Record<string, string | number | string[]>; raw: Buffer; json?: { error?: string; code?: string; project_roots?: string[] } };
} {
  let status = 0;
  let headers: Record<string, string | number | string[]> = {};
  const chunks: Buffer[] = [];
  const res = {
    writeHead(code: number, next?: Record<string, string | number | string[]>) {
      status = code;
      headers = next ?? {};
    },
    end(body?: string | Buffer) {
      if (body === undefined) return;
      chunks.push(Buffer.isBuffer(body) ? body : Buffer.from(body));
    },
  } as unknown as ServerResponse;
  return {
    res,
    read: () => {
      const raw = Buffer.concat(chunks);
      const type = String(headers["Content-Type"] ?? "");
      return {
        status,
        headers,
        raw,
        json: type.includes("application/json") ? JSON.parse(raw.toString("utf8")) as { error?: string; code?: string; project_roots?: string[] } : undefined,
      };
    },
  };
}

async function getContent(store: RunStore, route: string) {
  const url = new URL(route, "http://127.0.0.1");
  const captured = captureResponse();
  const handled = await handleArtifactRoutes(
    {} as IncomingMessage,
    "GET",
    url.pathname,
    url,
    store,
    captured.res,
    json,
  );
  expect(handled).toBe(true);
  return captured.read();
}

function contentUrl(file: string, projectRoot: string): string {
  const owner = encodeURIComponent("stage:sales:summarize");
  const id = artifactIdFromRelative(file);
  return `/api/artifacts/${owner}/${id}/content?project_root=${encodeURIComponent(projectRoot)}`;
}

describe("artifact content", () => {
  it("picks a text content type for markdown, csv, json, html and text, and an image type for images", () => {
    const hello = Buffer.from("hello");
    expect(servedArtifactMediaType("static.markdown", "report.md", hello)).toBe("text/plain; charset=utf-8");
    expect(servedArtifactMediaType("static.table", "numbers.csv", hello)).toBe("text/plain; charset=utf-8");
    expect(servedArtifactMediaType("static.table", "rows.json", hello)).toBe("text/plain; charset=utf-8");
    expect(servedArtifactMediaType("static.html", "page.html", Buffer.from("<html></html>"))).toBe("text/plain; charset=utf-8");
    expect(servedArtifactMediaType("static.text", "notes.txt", hello)).toBe("text/plain; charset=utf-8");
    expect(servedArtifactMediaType("static.image", "shot.png", Buffer.from([0, 1, 2]))).toBe("image/png");
    expect(servedArtifactMediaType("static.text", "blob.bin", Buffer.from([0xff, 0xfe]))).toBe("application/octet-stream");
    expect(contentTooLarge(ARTIFACT_CONTENT_MAX_BYTES, false)).toBe(false);
    expect(contentTooLarge(ARTIFACT_CONTENT_MAX_BYTES + 1, false)).toBe(true);
    expect(contentTooLarge(ARTIFACT_CONTENT_MAX_BYTES + 1, true)).toBe(false);
  });

  it("serves indexed files with nosniff and refuses a path outside the run workspace", async () => {
    const root = await temp("sf-art-body-");
    const store = await openStore();
    await store.ensureProject(root);
    const runId = await indexFiles(store, {
      projectRoot: root,
      files: {
        "report.md": "# report",
        "numbers.csv": "a,b\n1,2\n",
        "rows.json": '[{"n":1}]',
        "page.html": "<p>hi</p>",
        "notes.txt": "plain",
        "shot.png": Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      },
    });
    const cases: Array<[string, string]> = [
      ["report.md", "text/plain; charset=utf-8"],
      ["numbers.csv", "text/plain; charset=utf-8"],
      ["rows.json", "text/plain; charset=utf-8"],
      ["page.html", "text/plain; charset=utf-8"],
      ["notes.txt", "text/plain; charset=utf-8"],
      ["shot.png", "image/png"],
    ];
    for (const [file, type] of cases) {
      const response = await getContent(store, contentUrl(file, root));
      expect(response.status).toBe(200);
      expect(response.headers["Content-Type"]).toBe(type);
      expect(response.headers["X-Content-Type-Options"]).toBe("nosniff");
      expect(String(response.headers["Content-Type"])).not.toContain("text/html");
      expect(typeof response.headers["X-Artifact-Content-Hash"]).toBe("string");
    }
    expect((await getContent(store, contentUrl("report.md", root))).raw.toString("utf8")).toBe("# report");

    const outside = await temp("sf-art-outside-");
    const secret = "TOP-SECRET-BYTES";
    await writeFile(path.join(outside, "secret.txt"), secret);
    const db = sqliteConnectionFromStore(store)!;
    const id = artifactIdFromRelative("report.md");
    db.prepare(`UPDATE artifact_versions SET relative_path = ? WHERE key IN (SELECT key FROM artifacts WHERE id = ?)`).run(
      `../../../../../../${path.relative(path.join(attemptArtifactsDir(store.getWorkspaceDir(runId), "summarize", 1)), path.join(outside, "secret.txt"))}`,
      id,
    );
    const traversal = await getContent(store, contentUrl("report.md", root));
    expect(traversal.status).toBe(403);
    expect(traversal.json?.code).toBe("artifact.content_unavailable");
    expect(traversal.raw.toString("utf8")).not.toContain(secret);

    const dir = attemptArtifactsDir(store.getWorkspaceDir(runId), "summarize", 1);
    await symlink(path.join(outside, "secret.txt"), path.join(dir, "escape.txt"));
    db.prepare(`UPDATE artifact_versions SET relative_path = 'escape.txt' WHERE key IN (SELECT key FROM artifacts WHERE id = ?)`).run(id);
    const escaped = await getContent(store, contentUrl("report.md", root));
    expect(escaped.status).toBe(403);
    expect(escaped.json?.code).toBe("artifact.content_unavailable");
    expect(escaped.raw.toString("utf8")).not.toContain(secret);

    await unlink(path.join(dir, "notes.txt"));
    const gone = await getContent(store, contentUrl("notes.txt", root));
    expect(gone.status).toBe(404);
    expect(gone.json?.code).toBe("artifact.content_unavailable");

    const missing = await getContent(store, `/api/artifacts/stage:sales:summarize/not_a_real_artifact?project_root=${encodeURIComponent(root)}`);
    expect(missing.status).toBe(404);
    expect(missing.json?.code).toBe("artifact.not_found");
  });

  it("refuses a path that leaves the attempt artifacts directory", async () => {
    const root = await temp("sf-art-contain-");
    const store = await openStore();
    await store.ensureProject(root);
    const runId = await indexFiles(store, { projectRoot: root, files: { "report.md": "# report" } });
    const db = sqliteConnectionFromStore(store)!;
    const id = artifactIdFromRelative("report.md");
    const artifactsDir = attemptArtifactsDir(store.getWorkspaceDir(runId), "summarize", 1);
    const sibling = path.join(path.dirname(artifactsDir), "envelope.json");
    const secret = "SIBLING-ENVELOPE-SECRET";
    await writeFile(sibling, secret);
    const setPath = (relativePath: string) => {
      db.prepare(
        `UPDATE artifact_versions SET relative_path = ? WHERE key IN (SELECT key FROM artifacts WHERE id = ?)`,
      ).run(relativePath, id);
    };

    setPath("../envelope.json");
    const traversal = await getContent(store, contentUrl("report.md", root));
    expect(traversal.status).toBe(403);
    expect(traversal.json).toMatchObject({ code: "artifact.content_unavailable", error: "Artifact path denied" });
    expect(traversal.raw.toString("utf8")).not.toContain(secret);

    await symlink(sibling, path.join(artifactsDir, "escape-sibling.txt"));
    setPath("escape-sibling.txt");
    const escaped = await getContent(store, contentUrl("report.md", root));
    expect(escaped.status).toBe(403);
    expect(escaped.json).toMatchObject({ code: "artifact.content_unavailable", error: "Artifact path denied" });
    expect(escaped.raw.toString("utf8")).not.toContain(secret);

    setPath(sibling);
    const absolute = await getContent(store, contentUrl("report.md", root));
    expect(absolute.status).toBe(403);
    expect(absolute.json).toMatchObject({ code: "artifact.content_unavailable", error: "Artifact path denied" });
    expect(absolute.raw.toString("utf8")).not.toContain(secret);
  });

  it("returns artifact.content_unavailable for an expired row even when the file exists", async () => {
    const root = await temp("sf-art-expired-body-");
    const store = await openStore();
    await store.ensureProject(root);
    await indexFiles(store, { projectRoot: root, files: { "notes.txt": "still-here" } });
    const db = sqliteConnectionFromStore(store)!;
    db.prepare(`UPDATE artifacts SET status = 'expired', expired_at = ?, expired_reason = 'run_purged' WHERE id = ?`).run(
      "2026-06-01T00:00:00.000Z",
      artifactIdFromRelative("notes.txt"),
    );
    const response = await getContent(store, contentUrl("notes.txt", root));
    expect(response.status).toBe(404);
    expect(response.json).toMatchObject({
      code: "artifact.content_unavailable",
      error: "Artifact content is unavailable (run_purged)",
    });
    expect(response.raw.toString("utf8")).not.toContain("still-here");
  });

  it("refuses text over 5 MiB and still serves a larger image", async () => {
    const root = await temp("sf-art-large-");
    const store = await openStore();
    await store.ensureProject(root);
    const runId = await indexFiles(store, {
      projectRoot: root,
      files: { "notes.txt": "small", "shot.png": "png" },
    });
    const dir = attemptArtifactsDir(store.getWorkspaceDir(runId), "summarize", 1);
    await writeFile(path.join(dir, "notes.txt"), Buffer.alloc(ARTIFACT_CONTENT_MAX_BYTES + 1, 1));
    const tooLarge = await getContent(store, contentUrl("notes.txt", root));
    expect(tooLarge.status).toBe(413);
    expect(tooLarge.json?.code).toBe("artifact.too_large");
    await writeFile(path.join(dir, "shot.png"), Buffer.alloc(ARTIFACT_CONTENT_MAX_BYTES + 1, 2));
    const image = await getContent(store, contentUrl("shot.png", root));
    expect(image.status).toBe(200);
    expect(image.headers["Content-Type"]).toBe("image/png");
    expect(image.raw.length).toBe(ARTIFACT_CONTENT_MAX_BYTES + 1);
  });

  it("returns artifact.ambiguous when the owner and id exist in two projects", async () => {
    const alpha = await temp("sf-art-ca-");
    const beta = await temp("sf-art-cb-");
    const store = await openStore();
    await store.ensureProject(alpha);
    await store.ensureProject(beta);
    await indexFiles(store, { projectRoot: alpha, files: { "report.md": "a" } });
    await indexFiles(store, { projectRoot: beta, files: { "report.md": "b" } });
    const id = artifactIdFromRelative("report.md");
    const ambiguous = await getContent(store, `/api/artifacts/stage:sales:summarize/${id}/content`);
    expect(ambiguous.status).toBe(409);
    expect(ambiguous.json?.code).toBe("artifact.ambiguous");
    expect(ambiguous.json?.project_roots?.sort()).toEqual([realpathSync(alpha), realpathSync(beta)].sort());
    const one = await getContent(store, contentUrl("report.md", alpha));
    expect(one.status).toBe(200);
    expect(one.raw.toString("utf8")).toBe("a");
  });

  it("keeps the run artifact route serving the same file", async () => {
    const root = await temp("sf-art-run-route-");
    const store = await openStore();
    await store.ensureProject(root);
    const runId = await indexFiles(store, { projectRoot: root, files: { "report.md": "# same" } });
    const service = await startTestService(store, scriptedFakeAgent([]), root);
    cleanups.push(() => service.stop());
    const listed = buildArtifactListedPath({ stageId: "summarize", attempt: 1, relative: "report.md" });
    const runFile = await fetch(
      `${service.baseUrl}/api/runs/${encodeURIComponent(runId)}/artifact?path=${encodeURIComponent(listed)}`,
    );
    expect(runFile.status).toBe(200);
    expect(await runFile.text()).toBe("# same");
    const content = await fetch(`${service.baseUrl}${contentUrl("report.md", root)}`);
    expect(content.status).toBe(200);
    expect(content.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await content.text()).toBe("# same");
  });
});
