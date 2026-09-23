import { describe, expect, it } from "vitest";
import { cp, mkdtemp, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { clearFindProjectRootCacheForTests } from "../src/project/findProjectRoot.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { normalizeProjectRoot } from "../src/runstore/normalizeCatalogPath.js";
import {
  isTrustedLocalHttpRequest,
  resolveAllowedHosts,
} from "../src/server/allowedHosts.js";
import { loadControlTokens } from "../src/server/controlToken.js";
import { isMutatingApi, startUiServer } from "../src/server/http.js";
import { FIXTURES_ROOT, netPipeline } from "./helpers/fixturePaths.js";
import { initTempGitRepo } from "./helpers/projectContext.js";

const DRIVE = "d".repeat(32);

async function closeServer(server: {
  close: (cb: (err?: Error | null) => void) => void;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

describe("POST /api/projects ensure", () => {
  it("isMutatingApi includes ensure", () => {
    expect(isMutatingApi("POST", "/api/projects")).toBe(true);
    expect(isMutatingApi("GET", "/api/projects")).toBe(false);
  });

  it("loopback ensure registers project_root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-ensure-loop-"));
    const project = await mkdtemp(path.join(tmpdir(), "sf-ensure-proj-"));
    const store = createRunStore({ rootDir: root });
    const { server, url } = await startUiServer({
      agent: scriptedFakeAgent([]),
      cwd: root,
      rootDir: root,
      store,
      port: 0,
      uiDistDir: path.join(root, "missing-ui"),
    });
    try {
      const res = await fetch(`${url}/api/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project_root: project }),
      });
      const body = (await res.json()) as { project_root?: string };
      expect(res.status).toBe(200);
      expect(body.project_root).toBe(normalizeProjectRoot(project));
      expect(await store.listRegisteredProjects()).toEqual([body.project_root]);

      const listed = await fetch(
        `${url}/api/pipelines?project_root=${encodeURIComponent(body.project_root!)}`,
      );
      expect(listed.status).toBe(200);
    } finally {
      await closeServer(server);
    }
  });

  it("rejects missing project_root with invalid_project_root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-ensure-miss-"));
    const store = createRunStore({ rootDir: root });
    const { server, url } = await startUiServer({
      agent: scriptedFakeAgent([]),
      cwd: root,
      rootDir: root,
      store,
      port: 0,
      uiDistDir: path.join(root, "missing-ui"),
    });
    try {
      const missing = path.join(root, "does-not-exist");
      const res = await fetch(`${url}/api/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project_root: missing }),
      });
      const body = (await res.json()) as { code?: string; error?: string };
      expect(res.status).toBe(400);
      expect(body.code).toBe("invalid_project_root");
      expect(body.error).toMatch(/does not exist/);
      expect(await store.listRegisteredProjects()).toEqual([]);
    } finally {
      await closeServer(server);
    }
  });

  it("rejects Host spoof when remote peer is not loopback", () => {
    expect(
      isTrustedLocalHttpRequest({
        headers: { host: "127.0.0.1:3847" },
        socket: { remoteAddress: "10.0.0.1" },
      } as IncomingMessage),
    ).toBe(false);
  });

  it("rejects non-loopback Host with ensure_project_not_allowed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-ensure-remote-"));
    const project = await mkdtemp(path.join(tmpdir(), "sf-ensure-remote-proj-"));
    const store = createRunStore({ rootDir: root });
    const tokens = loadControlTokens({ STAGEFLOW_CONTROL_TOKEN: DRIVE });
    const allowedHosts = resolveAllowedHosts({
      STAGEFLOW_ALLOWED_HOSTS: "build-box:3847",
    });
    const { server, port } = await startUiServer({
      agent: scriptedFakeAgent([]),
      cwd: root,
      rootDir: root,
      store,
      port: 0,
      uiDistDir: path.join(root, "missing-ui"),
      controlTokens: tokens,
      allowedHosts,
    });
    try {
      const result = await new Promise<{
        status: number;
        json: { code?: string; error?: string };
      }>((resolve, reject) => {
        const payload = JSON.stringify({ project_root: project });
        const req = request(
          {
            hostname: "127.0.0.1",
            port,
            path: "/api/projects",
            method: "POST",
            headers: {
              Host: "build-box:3847",
              Authorization: `Bearer ${DRIVE}`,
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(payload),
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => {
              resolve({
                status: res.statusCode ?? 0,
                json: JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
                  code?: string;
                  error?: string;
                },
              });
            });
          },
        );
        req.on("error", reject);
        req.write(payload);
        req.end();
      });
      expect(result.status).toBe(403);
      expect(result.json.code).toBe("ensure_project_not_allowed");
      expect(await store.listRegisteredProjects()).toEqual([]);
    } finally {
      await closeServer(server);
    }
  });

  it("remote start with unregistered absolute project_root is unknown_project_root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-ensure-start-"));
    const foreign = await mkdtemp(path.join(tmpdir(), "sf-ensure-foreign-"));
    const store = createRunStore({ rootDir: root });
    const { server, url } = await startUiServer({
      agent: scriptedFakeAgent([]),
      cwd: root,
      rootDir: root,
      store,
      port: 0,
      uiDistDir: path.join(root, "missing-ui"),
    });
    try {
      const started = await fetch(`${url}/api/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pipeline: netPipeline("single"),
          task: { id: "t", goal: "g" },
          project_root: path.resolve(foreign),
        }),
      });
      const body = (await started.json()) as { code?: string };
      expect(started.status).toBe(400);
      expect(body.code).toBe("unknown_project_root");
    } finally {
      await closeServer(server);
    }
  });

  it("after loopback ensure, list filter accepts root and registered project can start", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "sf-ensure-then-start-home-"));
    const { root: project, cleanup } = await initTempGitRepo();
    clearFindProjectRootCacheForTests();
    await cp(path.join(FIXTURES_ROOT, "pipelines"), path.join(project, "pipelines"), {
      recursive: true,
    });
    await cp(path.join(FIXTURES_ROOT, "stages"), path.join(project, "stages"), {
      recursive: true,
    });
    await cp(path.join(FIXTURES_ROOT, "tasks"), path.join(project, "tasks"), {
      recursive: true,
    });
    await writeFile(
      path.join(project, "stageflow.yaml"),
      [
        "version: 1",
        "catalog:",
        "  pipelines:",
        "    - pipelines",
        "  tasks:",
        "    - tasks",
        "  patterns:",
        '    pipeline: "*.yaml"',
        '    task: "*.yaml"',
        "",
      ].join("\n"),
    );

    const store = createRunStore({ rootDir: home });
    const { server, url } = await startUiServer({
      agent: scriptedFakeAgent([
        {
          type: "emit",
          envelope: {
            status: "success",
            summary: "ok",
            artifacts: [],
          },
        },
      ]),
      cwd: project,
      rootDir: home,
      store,
      port: 0,
      uiDistDir: path.join(home, "missing-ui"),
    });
    try {
      const stranger = await mkdtemp(path.join(tmpdir(), "sf-ensure-stranger-"));
      const ensured = await fetch(`${url}/api/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project_root: stranger }),
      });
      const ensuredBody = (await ensured.json()) as { project_root: string };
      expect(ensured.status).toBe(200);

      const listed = await fetch(
        `${url}/api/pipelines?project_root=${encodeURIComponent(ensuredBody.project_root)}`,
      );
      expect(listed.status).toBe(200);

      const ensureProject = await fetch(`${url}/api/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project_root: project }),
      });
      expect(ensureProject.status).toBe(200);
      const ensureProjectBody = (await ensureProject.json()) as {
        project_root: string;
      };

      const started = await fetch(`${url}/api/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pipeline: "pipelines/single.pipeline.yaml",
          task: { id: "t", goal: "g" },
          project_root: ensureProjectBody.project_root,
        }),
      });
      const startBody = (await started.json()) as {
        runId?: string;
        code?: string;
      };
      expect(started.status).toBe(202);
      expect(startBody.runId).toBeTruthy();
    } finally {
      await closeServer(server);
      await cleanup();
    }
  });
});
