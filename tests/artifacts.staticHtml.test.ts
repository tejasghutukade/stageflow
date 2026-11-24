import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import {
  isHtmlContentPath,
  STATIC_HTML_CONTENT_SECURITY_POLICY,
} from "../src/artifacts/content.js";
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
  const root = await temp("sf-art-html-");
  const store = createRunStore({ rootDir: root, kind: "sqlite" });
  cleanups.push(async () => {
    await store.close();
  });
  return store;
}

async function indexFiles(
  store: RunStore,
  options: { projectRoot: string; files: Record<string, string> },
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
    await writeFile(path.join(dir, rel), body);
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
  read: () => { status: number; headers: Record<string, string | number | string[]>; raw: Buffer };
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
    read: () => ({ status, headers, raw: Buffer.concat(chunks) }),
  };
}

describe("isHtmlContentPath", () => {
  it("matches .html and .htm and ignores lookalike names", () => {
    expect(isHtmlContentPath("stages/a/attempts/1/artifacts/page.html")).toBe(true);
    expect(isHtmlContentPath("page.HTM")).toBe(true);
    expect(isHtmlContentPath("file.xhtml")).toBe(false);
    expect(isHtmlContentPath("file.html.txt")).toBe(false);
    expect(isHtmlContentPath("notes.txt")).toBe(false);
  });
});

describe("static html response headers", () => {
  it("sends the sandbox policy for static.html and leaves other kinds as text", async () => {
    const root = await temp("sf-art-html-root-");
    const store = await openStore();
    await store.ensureProject(root);
    await indexFiles(store, {
      projectRoot: root,
      files: {
        "page.html": "<p>hi</p>",
        "page.htm": "<p>htm</p>",
        "notes.txt": "plain",
      },
    });
    const read = async (file: string) => {
      const url = new URL(
        `/api/artifacts/${encodeURIComponent("stage:sales:summarize")}/${artifactIdFromRelative(file)}/content?project_root=${encodeURIComponent(root)}`,
        "http://127.0.0.1",
      );
      const captured = captureResponse();
      const handled = await handleArtifactRoutes({} as IncomingMessage, "GET", url.pathname, url, store, captured.res, json);
      expect(handled).toBe(true);
      return captured.read();
    };
    const html = await read("page.html");
    expect(html.status).toBe(200);
    expect(html.headers["Content-Type"]).toBe("text/plain; charset=utf-8");
    expect(html.headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(html.headers["Content-Security-Policy"]).toBe(STATIC_HTML_CONTENT_SECURITY_POLICY);
    expect(html.raw.toString("utf8")).toBe("<p>hi</p>");
    const htm = await read("page.htm");
    expect(htm.headers["Content-Type"]).toBe("text/plain; charset=utf-8");
    expect(htm.headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(htm.headers["Content-Security-Policy"]).toBe(STATIC_HTML_CONTENT_SECURITY_POLICY);
    const text = await read("notes.txt");
    expect(text.headers["Content-Type"]).toBe("text/plain; charset=utf-8");
    expect(text.headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(text.headers["Content-Security-Policy"]).toBeUndefined();
    expect(text.raw.toString("utf8")).toBe("plain");
  });

  it("adds the sandbox policy on the run artifact route for html and htm only", async () => {
    const root = await temp("sf-art-html-run-");
    const store = await openStore();
    await store.ensureProject(root);
    const runId = await indexFiles(store, {
      projectRoot: root,
      files: {
        "page.html": "<p>hi</p><script>bad()</script>",
        "page.htm": "<p>htm</p>",
        "notes.txt": "plain",
      },
    });
    const service = await startTestService(store, scriptedFakeAgent([]), root);
    cleanups.push(() => service.stop());
    const fetchFile = (relative: string) => {
      const listed = buildArtifactListedPath({ stageId: "summarize", attempt: 1, relative });
      return fetch(
        `${service.baseUrl}/api/runs/${encodeURIComponent(runId)}/artifact?path=${encodeURIComponent(listed)}`,
      );
    };
    const html = await fetchFile("page.html");
    expect(html.status).toBe(200);
    expect(html.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(html.headers.get("x-content-type-options")).toBe("nosniff");
    expect(html.headers.get("content-security-policy")).toBe(STATIC_HTML_CONTENT_SECURITY_POLICY);
    expect(await html.text()).toBe("<p>hi</p><script>bad()</script>");
    const htm = await fetchFile("page.htm");
    expect(htm.status).toBe(200);
    expect(htm.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(htm.headers.get("x-content-type-options")).toBe("nosniff");
    expect(htm.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
    expect(await htm.text()).toBe("<p>htm</p>");
    const text = await fetchFile("notes.txt");
    expect(text.status).toBe(200);
    expect(text.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(text.headers.get("content-security-policy")).toBeNull();
    expect(await text.text()).toBe("plain");
  });
});
