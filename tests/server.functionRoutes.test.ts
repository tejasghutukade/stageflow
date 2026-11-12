import { Readable } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { handleFunctionRoutes } from "../src/server/functionRoutes.js";
import { createFunctionInvoker } from "../src/functions/invoke.js";
import { FunctionService } from "../src/functions/service.js";
import { FunctionStore } from "../src/functions/store.js";
import { createRunStoreWithConnection } from "../src/runstore/createStore.js";

const SOURCE = "export default function execute(context) {\n  return { passed: true };\n}\n";

function definition(id: string, description = "Checks a report") {
  return {
    id,
    name: `Function ${id}`,
    description,
    kind: "verification",
    source: SOURCE,
    capabilities: [],
    bindings: [],
  };
}

function request(method: string, url: string, body?: unknown): IncomingMessage {
  const payload = body === undefined ? "" : JSON.stringify(body);
  const stream = Readable.from(payload ? [Buffer.from(payload)] : []);
  return Object.assign(stream, {
    method,
    url,
    headers: {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(payload)),
    },
  }) as IncomingMessage;
}

function capture() {
  const sent: { status?: number; body?: Record<string, unknown> } = {};
  const res = {
    headersSent: false,
    writableEnded: false,
    end() {
      this.writableEnded = true;
    },
  } as ServerResponse;
  const json = (_res: ServerResponse, status: number, body: unknown) => {
    sent.status = status;
    sent.body = body as Record<string, unknown>;
    res.headersSent = true;
  };
  return { res, json, sent };
}

describe("function routes", () => {
  const dirs: string[] = [];
  const closers: Array<() => void> = [];

  afterEach(async () => {
    for (const close of closers.splice(0)) close();
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function open() {
    const home = await mkdtemp(path.join(tmpdir(), "sf-fn-http-home-"));
    const project = await mkdtemp(path.join(tmpdir(), "sf-fn-http-project-"));
    dirs.push(home, project);
    const { connection } = createRunStoreWithConnection({ rootDir: home, openerMode: "migrate" });
    closers.push(() => connection.close());
    const service = new FunctionService({ store: new FunctionStore(connection) });
    const invoker = createFunctionInvoker({ db: connection, env: {}, stageflowHome: home });
    const call = async (method: string, pathname: string, body?: unknown) => {
      const { res, json, sent } = capture();
      const handled = await handleFunctionRoutes(request(method, pathname, body), method, pathname, service, project, res, json, invoker);
      expect(handled).toBe(true);
      return sent;
    };
    return { call };
  }

  it("creates, conflicts on a stale revision, and duplicates", async () => {
    const { call } = await open();
    const created = await call("POST", "/api/functions", { definition: definition("score") });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ id: "score", revision: 1 });

    const first = call("PUT", "/api/functions/score", {
      baseRevision: 1,
      definition: definition("score", "one"),
    });
    const second = call("PUT", "/api/functions/score", {
      baseRevision: 1,
      definition: definition("score", "two"),
    });
    const settled = await Promise.all([first, second]);
    const statuses = settled.map((result) => result.status).sort();
    expect(statuses).toEqual([200, 409]);
    const conflict = settled.find((result) => result.status === 409);
    expect(conflict?.body).toMatchObject({ code: "function.conflict", current_revision: 2 });

    const copy = await call("POST", "/api/functions/score/duplicate", { id: "score_copy" });
    expect(copy.status).toBe(201);
    expect(copy.body).toMatchObject({ id: "score_copy", revision: 1 });

    const listed = await call("GET", "/api/functions");
    expect(listed.status).toBe(200);
    expect((listed.body?.functions as Array<{ id: string }>).map((row) => row.id).sort()).toEqual(["score", "score_copy"]);
  });

  it("derives capabilities from a declared source and rejects a conflicting list", async () => {
    const { call } = await open();
    const source = 'export const access = { artifacts: "read", env: ["MIN_SCORE"], network: [] };\nexport default function execute(){ return { passed: true }; }\n';
    const created = await call("POST", "/api/functions", {
      definition: { id: "score", name: "Score", kind: "verification", source },
    });
    expect(created.status).toBe(201);
    const fetched = await call("GET", "/api/functions/score");
    expect(fetched.status).toBe(200);
    expect(fetched.body?.definition).toMatchObject({
      capabilities: [
        { id: "artifacts", type: "file", root: "artifacts", path: "", access: "read" },
        { id: "env_min_score", type: "env", alias: "MIN_SCORE" },
      ],
      bindings: [{ alias: "MIN_SCORE", required: true }],
    });

    const conflict = await call("POST", "/api/functions", {
      definition: {
        id: "wide",
        name: "Wide",
        kind: "verification",
        source,
        capabilities: [{ id: "workspace", type: "file", root: "workspace", path: "", access: "read" }],
      },
    });
    expect(conflict.status).toBe(422);
    expect(conflict.body).toMatchObject({
      code: "function.invalid",
      issues: expect.arrayContaining([expect.objectContaining({ code: "function.access_conflict", path: "capabilities" })]),
    });
  });

  it("runs a real console test against the saved function", async () => {
    const { call } = await open();
    await call("POST", "/api/functions", { definition: definition("score") });
    const tested = await call("POST", "/api/functions/score/test", { real: true });
    expect(tested.status).toBe(200);
    expect(tested.body).toMatchObject({ ok: true, kind: "test", value: { passed: true } });
  });
});
