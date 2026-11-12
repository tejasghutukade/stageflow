import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import * as childProcess from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect as netConnect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { functionSourceHash } from "../src/config/loadFunction.js";
import { createFunctionInvoker } from "../src/functions/invoke.js";
import { recordFunctionInvocation } from "../src/functions/history.js";
import { agentProjectKey } from "../src/functions/store.js";
import { FunctionService } from "../src/functions/service.js";
import { FunctionStore } from "../src/functions/store.js";
import { handleFunctionRoutes } from "../src/server/functionRoutes.js";
import { createRunStoreWithConnection } from "../src/runstore/createStore.js";
import { httpFixture } from "./fixtures/httpFixture.js";

const SAVED_SOURCE = "export default function execute() {\n  return { passed: true };\n}\n";
const SECRET = "sk-abcdefghijklmnopqrst";
const PROVIDER_BODY = "provider-body-9f3a";
const REQUEST_URL = `https://hooks.test/v1/send?token=${SECRET}`;
const REAL_REPORT = "real-report-bytes";
const UNGRANTED = "ungranted-bytes";
const WIDEN = "widen-secret-bytes";

const READ_REPORT = `
export default async function execute(context) {
  const text = await context.files.readText("artifacts", "report.txt");
  return { text, sample: context.sample };
}
`;

const READ_SECRET = `
export default async function execute(context) {
  const text = await context.files.readText("artifacts", "secret.txt");
  return { text };
}
`;

const ACTION = `
export default async function execute(context) {
  await context.http.request({
    method: "POST",
    origin: "https://hooks.test",
    path: ${JSON.stringify(`/v1/send?token=${SECRET}`)},
  });
  context.log(${JSON.stringify(PROVIDER_BODY)});
  return { sent: true, body: ${JSON.stringify(PROVIDER_BODY)} };
}
`;

function definition(id: string, source: string, capabilities: unknown[] = []) {
  return {
    id,
    name: `Function ${id}`,
    kind: "verification",
    source,
    capabilities,
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
  const sent: { status?: number; body?: unknown } = {};
  const res = {
    headersSent: false,
    writableEnded: false,
    end() {
      this.writableEnded = true;
    },
  } as ServerResponse;
  const json = (_res: ServerResponse, status: number, body: unknown) => {
    sent.status = status;
    sent.body = body;
    res.headersSent = true;
  };
  return { res, json, sent };
}

function fakeChild(): ChildProcess & { emitSuccess: () => void } {
  const child = new EventEmitter() as ChildProcess & { emitSuccess: () => void };
  child.stdout = null;
  child.stderr = null;
  child.send = (() => true) as ChildProcess["send"];
  child.kill = (() => true) as ChildProcess["kill"];
  child.disconnect = () => {};
  child.emitSuccess = () => {
    child.emit("message", {
      type: "result",
      ok: true,
      value: { ok: true },
      logs: "",
      logsTruncated: false,
      disposed: true,
    });
    child.emit("exit", 0, null);
  };
  return child;
}

describe("function invoke", () => {
  const dirs: string[] = [];
  const closers: Array<() => void> = [];

  afterEach(async () => {
    for (const close of closers.splice(0)) close();
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function open(options: { env?: Record<string, string>; lookup?: (hostname: string) => Promise<readonly string[]>; dial?: (address: string, port: number, servername: string) => Promise<Socket>; forkFn?: typeof childProcess.fork } = {}) {
    const home = await mkdtemp(path.join(tmpdir(), "sf-fn-invoke-home-"));
    const project = await mkdtemp(path.join(tmpdir(), "sf-fn-invoke-project-"));
    dirs.push(home, project);
    const { connection } = createRunStoreWithConnection({ rootDir: home, openerMode: "migrate" });
    closers.push(() => connection.close());
    const service = new FunctionService({ store: new FunctionStore(connection) });
    const invoker = createFunctionInvoker({
      db: connection,
      env: options.env ?? {},
      stageflowHome: home,
      ...(options.lookup ? { lookup: options.lookup } : {}),
      ...(options.dial ? { dial: options.dial } : {}),
      ...(options.forkFn ? { forkFn: options.forkFn } : {}),
    });
    const call = async (method: string, pathname: string, body?: unknown) => {
      const { res, json, sent } = capture();
      const handled = await handleFunctionRoutes(
        request(method, pathname, body),
        method,
        pathname,
        service,
        project,
        res,
        json,
        invoker,
      );
      expect(handled).toBe(true);
      return sent;
    };
    return { project, connection, service, invoker, call };
  }

  it("runs an unsaved mock test and a production call on one executor, and refuses a real test without the flag or the grant", async () => {
    const { project, service, invoker, call } = await open();
    const report = { id: "report", type: "file", root: "artifacts", path: "report.txt", access: "read" };
    const created = await service.create(project, definition("score", SAVED_SOURCE, [report]), { source: "file" });
    expect(created.revision).toBe(1);
    await service.create(project, definition("bare", SAVED_SOURCE), { source: "file" });
    await mkdir(path.join(project, "artifacts"), { recursive: true });
    await writeFile(path.join(project, "artifacts", "report.txt"), REAL_REPORT);
    await writeFile(path.join(project, "artifacts", "secret.txt"), WIDEN);
    await writeFile(path.join(project, "artifacts", "ungranted.txt"), UNGRANTED);

    const produced = await invoker.call(project, { functionId: "score", kind: "verification" });
    expect(produced).toMatchObject({ ok: true, revision: 1, kind: "verification", status: "succeeded", sourceHash: functionSourceHash(SAVED_SOURCE) });
    expect(produced.value).toEqual({ passed: true });

    const mocked = await call("POST", "/api/functions/score/test", {
      source: READ_REPORT,
      input: { sample: "case-a" },
      mocks: { files: [{ root: "artifacts", path: "report.txt", text: "mock-score" }] },
    });
    expect(mocked.status).toBe(200);
    expect(mocked.body).toMatchObject({
      ok: true,
      revision: null,
      kind: "test",
      status: "succeeded",
      sourceHash: functionSourceHash(READ_REPORT),
      value: { text: "mock-score", sample: "case-a" },
    });
    expect(JSON.stringify(mocked.body)).not.toContain(REAL_REPORT);

    const still = await service.get(project, "score");
    expect(still.revision).toBe(1);
    expect(still.sourceHash).toBe(functionSourceHash(SAVED_SOURCE));

    const missing = await call("POST", "/api/functions/score/test", { source: READ_REPORT });
    expect(missing.status).toBe(200);
    expect(missing.body).toMatchObject({ ok: false, code: "missing_fixture", revision: null, kind: "test" });
    expect(JSON.stringify(missing.body)).not.toContain(REAL_REPORT);

    const real = await call("POST", "/api/functions/score/test", { source: READ_REPORT, real: true, input: { sample: "live" } });
    expect(real.body).toMatchObject({ ok: true, value: { text: REAL_REPORT, sample: "live" }, revision: null, kind: "test" });

    const noFlag = await call("POST", "/api/functions/score/test", { source: READ_REPORT, real: false });
    expect(noFlag.body).toMatchObject({ ok: false, code: "missing_fixture" });
    expect(JSON.stringify(noFlag.body)).not.toContain(REAL_REPORT);

    const ungrantedSource = `
      export default async function execute(context) {
        return { text: await context.files.readText("artifacts", "ungranted.txt") };
      }
    `;
    const noGrant = await call("POST", "/api/functions/bare/test", { source: ungrantedSource, real: true });
    expect(noGrant.body).toMatchObject({ ok: false, code: "permission_denied" });
    expect(JSON.stringify(noGrant.body)).not.toContain(UNGRANTED);

    const widened = await call("POST", "/api/functions/score/test", {
      source: READ_SECRET,
      real: true,
      grants: [{ id: "extra", root: "artifacts", path: "secret.txt", access: "write" }],
    });
    expect(widened.body).toMatchObject({ ok: false, code: "permission_denied" });
    expect(JSON.stringify(widened.body)).not.toContain(WIDEN);

    const timeout = await call("POST", "/api/functions/score/test", { source: SAVED_SOURCE, timeoutMs: 30_001 });
    expect(timeout.body).toMatchObject({ ok: false, code: "timeout" });
    const memory = await call("POST", "/api/functions/score/test", {
      source: SAVED_SOURCE,
      memoryLimitBytes: 64 * 1024 * 1024 + 1,
    });
    expect(memory.body).toMatchObject({ ok: false, code: "memory" });

    const history = await call("GET", "/api/functions/score/invocations");
    expect(history.status).toBe(200);
    const rows = (history.body as { invocations: Array<Record<string, unknown>> }).invocations;
    expect(rows.some((row) => row.kind === "verification" && row.revision === 1 && row.code == null)).toBe(true);
    expect(rows.some((row) => row.kind === "test" && row.revision == null && row.sourceHash === functionSourceHash(READ_REPORT))).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(REAL_REPORT);
    expect(JSON.stringify(rows)).not.toContain(WIDEN);
    expect(produced.durationMs).toEqual(expect.any(Number));
    expect(typeof (mocked.body as { logs: unknown }).logs).toBe("string");
  });

  it("stores a side-effecting API timeout as an uncertain outcome and does not resend it", async () => {
    const fixture = await httpFixture({ status: 200, body: PROVIDER_BODY, delayMs: 20_000 });
    closers.push(() => fixture.close());
    const port = Number(new URL(fixture.url).port);
    const seen = new Map<string, number>();
    const { project, service, call } = await open({
      env: { API_TOKEN: SECRET, STAGEFLOW_SECRET_REGISTRY: "API_TOKEN" },
      lookup: async (hostname) => {
        const rows = hostname === "hooks.test" ? [["203.0.113.50"], ["203.0.113.50"]] : [["127.0.0.1"]];
        const at = seen.get(hostname) ?? 0;
        seen.set(hostname, at + 1);
        return rows[Math.min(at, rows.length - 1)] ?? ["127.0.0.1"];
      },
      dial: (address) => connectPort(address === "203.0.113.50" ? port : 1),
    });
    await service.create(
      project,
      {
        id: "notify",
        name: "Notify",
        kind: "tool",
        tool_name: "notify",
        tool_description: "Sends a notice",
        input_schema: { type: "object", properties: {} },
        source: ACTION,
        capabilities: [
          {
            id: "hooks",
            type: "api",
            origin: "https://hooks.test",
            methods: ["POST"],
            path_prefix: "/v1",
            effect: "action",
            credential_ref: "API_TOKEN",
          },
        ],
        bindings: [],
      },
      { source: "file" },
    );

    const tested = await call("POST", "/api/functions/notify/test", { real: true, timeoutMs: 4_000 });
    expect(tested.status).toBe(200);
    expect(tested.body).toMatchObject({ ok: false, code: "uncertain_outcome", kind: "test", status: "uncertain" });
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.requests[0]?.url).toContain(SECRET);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(fixture.requests).toHaveLength(1);

    const history = await call("GET", "/api/functions/notify/invocations");
    const packed = JSON.stringify({ result: tested.body, history: history.body });
    expect(packed).toContain("uncertain_outcome");
    expect(packed).not.toContain(SECRET);
    expect(packed).not.toContain(PROVIDER_BODY);
    expect(packed).not.toContain(REQUEST_URL);
    expect(packed).not.toContain("Bearer");
  });

  it("shows a revision and a sanitized code for a test, a verification, a route, and a tool call", async () => {
    const { project, connection, call, service } = await open();
    await service.create(project, definition("audit", SAVED_SOURCE), { source: "file" });
    const projectKey = agentProjectKey(project);
    const secretDetail = `authorization=${SECRET} body=${PROVIDER_BODY} url=${REQUEST_URL}`;
    const kinds = [
      { kind: "test" as const, revision: null, code: "missing_fixture" },
      { kind: "verification" as const, revision: 3, code: "permission_denied" },
      { kind: "route" as const, revision: 2, code: "timeout" },
      { kind: "tool" as const, revision: 7, code: "uncertain_outcome" },
    ];
    for (const entry of kinds) {
      const recorded = recordFunctionInvocation(connection, {
        projectKey,
        functionId: "audit",
        revision: entry.revision,
        sourceHash: functionSourceHash(`source-${entry.kind}`),
        kind: entry.kind,
        status: entry.code === "uncertain_outcome" ? "uncertain" : "failed",
        durationMs: 12,
        code: entry.code,
        detail: secretDetail,
        body: PROVIDER_BODY,
        requestUrl: REQUEST_URL,
        attachmentId: `attach-${entry.kind}`,
        runId: entry.kind === "verification" ? "run-1" : null,
        stageId: entry.kind === "route" ? "route-stage" : null,
        attempt: entry.kind === "tool" ? 2 : null,
        sessionId: entry.kind === "tool" ? "sess-1" : null,
      });
      expect(recorded).toMatchObject({ kind: entry.kind, revision: entry.revision, code: entry.code });
      expect(JSON.stringify(recorded)).not.toContain(SECRET);
      expect(JSON.stringify(recorded)).not.toContain(PROVIDER_BODY);
    }

    const history = await call("GET", "/api/functions/audit/invocations");
    const rows = (history.body as { invocations: Array<Record<string, unknown>> }).invocations;
    for (const entry of kinds) {
      expect(rows).toContainEqual(expect.objectContaining({ kind: entry.kind, revision: entry.revision, code: entry.code }));
    }
    const packed = JSON.stringify(rows);
    expect(packed).not.toContain(SECRET);
    expect(packed).not.toContain(PROVIDER_BODY);
    expect(packed).not.toContain("hooks.test");
    const stored = connection.prepare(`SELECT * FROM function_invocations WHERE function_id = ?`).all("audit");
    const raw = JSON.stringify(stored);
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain(PROVIDER_BODY);
    expect(raw).not.toContain("request_url");
    expect(raw).not.toContain("hooks.test");
  });

  it("returns the resource limit when the shared queue is full and does not start another child", async () => {
    let started = 0;
    let release = false;
    const hanging: Array<() => void> = [];
    const { project, service, invoker } = await open({
      forkFn: (() => {
        started += 1;
        const child = fakeChild();
        child.send = (() => {
          if (release) queueMicrotask(() => child.emitSuccess());
          else hanging.push(() => child.emitSuccess());
          return true;
        }) as ChildProcess["send"];
        return child;
      }) as typeof childProcess.fork,
    });
    await service.create(project, definition("score", SAVED_SOURCE), { source: "file" });

    const running = ["r1", "r2", "r3", "r4"].map((name) =>
      invoker.call(project, { functionId: "score", kind: "verification", input: { name } }),
    );
    await vi.waitFor(() => expect(started).toBe(4));
    const waiting = Array.from({ length: 16 }, (_, index) =>
      invoker.call(project, { functionId: "score", kind: "verification", input: { index } }),
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(started).toBe(4);

    const overflow = await invoker.test(project, "score", { source: SAVED_SOURCE });
    expect(overflow).toMatchObject({ ok: false, code: "resource_limit", kind: "test", status: "failed" });
    expect(started).toBe(4);

    release = true;
    for (const finish of hanging) finish();
    const outcomes = await Promise.all(running.concat(waiting));
    expect(outcomes.every((result) => result.ok)).toBe(true);
    expect(started).toBe(20);
  });
});

function connectPort(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host: "127.0.0.1", port }, () => resolve(socket));
    socket.once("error", reject);
  });
}
