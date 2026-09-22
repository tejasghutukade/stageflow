import { afterEach, describe, expect, it, vi } from "vitest";
import { httpDeleteRun, httpReadRun, httpStartRun } from "../src/cli/hostClient.js";

const DRIVE = "d".repeat(32);
const READ = "r".repeat(32);

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
