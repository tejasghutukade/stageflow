import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  httpDeleteRun,
  httpRequestJson,
  httpEnsureProject,
  httpReadRun,
  httpStartRun,
} from "../src/cli/hostClient.js";

const DRIVE = "d".repeat(32);
const READ = "r".repeat(32);
const previousHome = process.env.STAGEFLOW_HOME;
const previousCredentialHome = process.env.STAGEFLOW_CREDENTIAL_HOME;
process.env.STAGEFLOW_HOME = mkdtempSync(path.join(tmpdir(), "sf-host-client-"));

afterAll(() => {
  if (previousHome === undefined) delete process.env.STAGEFLOW_HOME;
  else process.env.STAGEFLOW_HOME = previousHome;
  if (previousCredentialHome === undefined) delete process.env.STAGEFLOW_CREDENTIAL_HOME;
  else process.env.STAGEFLOW_CREDENTIAL_HOME = previousCredentialHome;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.STAGEFLOW_CONTROL_TOKEN;
  delete process.env.STAGEFLOW_CONTROL_TOKEN_FILE;
  delete process.env.STAGEFLOW_READ_TOKEN;
  delete process.env.STAGEFLOW_READ_TOKEN_FILE;
});

function stubFetch(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Response,
): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => handler(input, init)),
  );
}

describe("hostClient Authorization", () => {
  it("attaches drive Bearer on POST when STAGEFLOW_CONTROL_TOKEN is set", async () => {
    process.env.STAGEFLOW_CONTROL_TOKEN = DRIVE;
    const auths: Array<string | null> = [];
    stubFetch((_input, init) => {
      const headers = new Headers(init?.headers);
      auths.push(headers.get("Authorization"));
      if ((init?.method ?? "GET") === "POST") {
        return new Response(JSON.stringify({ runId: "r1" }), { status: 202 });
      }
      return new Response(
        JSON.stringify({ run_id: "r1", status: "succeeded" }),
        { status: 200 },
      );
    });

    const started = await httpStartRun("http://127.0.0.1:3847", {
      pipeline: "/p.yaml",
      task: "/t.yaml",
    });
    expect(started.ok).toBe(true);
    if (started.ok) await started.done;

    expect(auths[0]).toBe(`Bearer ${DRIVE}`);
    expect(auths.slice(1).every((a) => a === `Bearer ${DRIVE}`)).toBe(true);
  });

  it("attaches drive Bearer on GET when control token is set", async () => {
    process.env.STAGEFLOW_CONTROL_TOKEN = DRIVE;
    let auth: string | null = null;
    stubFetch((_input, init) => {
      const headers = new Headers(init?.headers);
      auth = headers.get("Authorization");
      return new Response(
        JSON.stringify({
          run_id: "r1",
          status: "succeeded",
        }),
        { status: 200 },
      );
    });

    await httpReadRun("http://127.0.0.1:3847", "r1");
    expect(auth).toBe(`Bearer ${DRIVE}`);
  });

  it("uses read token for GET when only STAGEFLOW_READ_TOKEN is set", async () => {
    process.env.STAGEFLOW_READ_TOKEN = READ;
    let auth: string | null = null;
    stubFetch((_input, init) => {
      const headers = new Headers(init?.headers);
      auth = headers.get("Authorization");
      return new Response(
        JSON.stringify({ run_id: "r1", status: "succeeded" }),
        { status: 200 },
      );
    });

    await httpReadRun("http://127.0.0.1:3847", "r1");
    expect(auth).toBe(`Bearer ${READ}`);
  });

  it("does not use read token for POST/DELETE", async () => {
    process.env.STAGEFLOW_READ_TOKEN = READ;
    const auths: Array<string | null> = [];
    stubFetch((_input, init) => {
      const headers = new Headers(init?.headers);
      auths.push(headers.get("Authorization"));
      if (init?.method === "DELETE") {
        return new Response(JSON.stringify({ runId: "r1" }), { status: 200 });
      }
      if ((init?.method ?? "GET") === "POST") {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
        });
      }
      return new Response(
        JSON.stringify({ run_id: "r1", status: "succeeded" }),
        { status: 200 },
      );
    });

    await httpStartRun("http://127.0.0.1:3847", {
      pipeline: "/p.yaml",
      task: "/t.yaml",
    });
    await httpDeleteRun("http://127.0.0.1:3847", "r1");

    expect(auths[0]).toBeNull();
    expect(auths[auths.length - 1]).toBeNull();
  });

  it("omits Authorization when no tokens are set", async () => {
    let auth: string | null = "sentinel";
    stubFetch((_input, init) => {
      const headers = new Headers(init?.headers);
      auth = headers.get("Authorization");
      return new Response(
        JSON.stringify({ run_id: "r1", status: "succeeded" }),
        { status: 200 },
      );
    });

    await httpReadRun("http://127.0.0.1:3847", "r1");
    expect(auth).toBeNull();
  });
});

describe("httpEnsureProject", () => {
  it("POSTs /api/projects with project_root and drive Bearer", async () => {
    process.env.STAGEFLOW_CONTROL_TOKEN = DRIVE;
    let urlSeen = "";
    let auth: string | null = null;
    let bodySeen: unknown;
    stubFetch((input, init) => {
      urlSeen = String(input);
      const headers = new Headers(init?.headers);
      auth = headers.get("Authorization");
      bodySeen = JSON.parse(String(init?.body ?? "{}"));
      return new Response(JSON.stringify({ project_root: "/proj/a" }), {
        status: 200,
      });
    });

    const result = await httpEnsureProject("http://127.0.0.1:3847", "/proj/a");
    expect(result).toEqual({ ok: true, project_root: "/proj/a" });
    expect(urlSeen).toBe("http://127.0.0.1:3847/api/projects");
    expect(auth).toBe(`Bearer ${DRIVE}`);
    expect(bodySeen).toEqual({ project_root: "/proj/a" });
  });

  it("maps ensure_project_not_allowed failures", async () => {
    stubFetch(
      () =>
        new Response(
          JSON.stringify({
            error: "ensure_project is only allowed from trusted local clients",
            code: "ensure_project_not_allowed",
          }),
          { status: 403 },
        ),
    );

    const result = await httpEnsureProject("http://127.0.0.1:3847", "/proj/a");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
      expect(result.code).toBe("ensure_project_not_allowed");
    }
  });
});

describe("httpRequestJson timeout", () => {
  it("fails with a clear error when the Host never answers", async () => {
    const server = createServer(() => undefined);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected TCP address");
    try {
      await expect(httpRequestJson(`http://127.0.0.1:${address.port}`, "POST", "/api/a2a/reload", undefined, 100)).rejects.toThrow(
        /timed out after 100ms; the change may or may not have been applied/,
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("answers normally within the timeout", async () => {
    stubFetch(() => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    expect(await httpRequestJson("http://x", "GET", "/api/a2a/status")).toEqual({ status: 200, body: { ok: true } });
  });
});
