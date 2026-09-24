import { afterEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runRunCommand } from "../src/cli/runCommand.js";
import { SAMPLE_TASK, SINGLE_PIPELINE } from "./helpers/fixturePaths.js";

const fixtures = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sf run ensure-then-start", () => {
  it("POSTs /api/projects before /api/runs with relativized project_root", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body =
          init?.body !== undefined
            ? JSON.parse(String(init.body))
            : undefined;
        calls.push({ url, body });
        if (url.endsWith("/api/projects")) {
          return new Response(
            JSON.stringify({ project_root: path.resolve(fixtures) }),
            { status: 200 },
          );
        }
        if (url.endsWith("/api/runs") && (init?.method ?? "GET") === "POST") {
          return new Response(JSON.stringify({ runId: "r-ensure" }), {
            status: 202,
          });
        }
        if (url.includes("/api/runs/r-ensure")) {
          return new Response(
            JSON.stringify({ run_id: "r-ensure", status: "succeeded" }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ error: `unexpected ${url}` }), {
          status: 500,
        });
      }),
    );

    const code = await runRunCommand(
      ["--task", SAMPLE_TASK, "--pipeline", SINGLE_PIPELINE, "--json"],
      {
        cwd: fixtures,
        hostBaseUrl: "http://127.0.0.1:3847",
        ensureService: async () => ({ ok: true, alreadyRunning: true }),
        io: { log: () => {}, error: () => {} },
      },
    );
    expect(code).toBe(0);
    expect(calls[0]?.url).toBe("http://127.0.0.1:3847/api/projects");
    expect(calls[0]?.body).toEqual({
      project_root: path.resolve(fixtures),
    });
    expect(calls[1]?.url).toBe("http://127.0.0.1:3847/api/runs");
    expect(calls[1]?.body).toMatchObject({
      project_root: path.resolve(fixtures),
      pipeline: expect.stringMatching(/^pipelines\//),
    });
  });

  it("sends --checkout as catalog-relative path (not absolute)", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body =
          init?.body !== undefined
            ? JSON.parse(String(init.body))
            : undefined;
        calls.push({ url, body });
        if (url.endsWith("/api/projects")) {
          return new Response(
            JSON.stringify({ project_root: path.resolve(fixtures) }),
            { status: 200 },
          );
        }
        if (url.endsWith("/api/runs") && (init?.method ?? "GET") === "POST") {
          return new Response(JSON.stringify({ runId: "r-checkout" }), {
            status: 202,
          });
        }
        if (url.includes("/api/runs/r-checkout")) {
          return new Response(
            JSON.stringify({ run_id: "r-checkout", status: "succeeded" }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ error: `unexpected ${url}` }), {
          status: 500,
        });
      }),
    );

    const absCheckout = path.join(fixtures, "checkouts", "elsewhere");
    const code = await runRunCommand(
      [
        "--task",
        SAMPLE_TASK,
        "--pipeline",
        SINGLE_PIPELINE,
        "--checkout",
        absCheckout,
        "--json",
      ],
      {
        cwd: fixtures,
        hostBaseUrl: "http://127.0.0.1:3847",
        ensureService: async () => ({ ok: true, alreadyRunning: true }),
        io: { log: () => {}, error: () => {} },
      },
    );
    expect(code).toBe(0);
    const startBody = calls.find((c) => c.url.endsWith("/api/runs"))?.body as {
      checkoutOverride?: string;
      project_root?: string;
    };
    expect(startBody?.checkoutOverride).toBe("checkouts/elsewhere");
    expect(path.isAbsolute(startBody?.checkoutOverride ?? "/")).toBe(false);
    expect(startBody?.project_root).toBe(path.resolve(fixtures));
  });
});
