import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { connect as netConnect } from "node:net";
import { lstat, mkdir, mkdtemp, open, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { httpFixture } from "./fixtures/httpFixture.js";
import { FunctionBroker } from "../src/functions/broker.js";
import { installProxyDispatcher, resetProxyDispatcherForTests } from "../src/net/proxy.js";
import { Agent, setGlobalDispatcher } from "undici";

const CREDENTIAL = "broker-api-credential";
const GITHUB_SENTINEL = "github-token-sentinel";
const CONTROL_SENTINEL = "control-token-sentinel";
const SECRET_STORE_SENTINEL = "secret-store-sentinel";
const OTHER_FILE = "other-file-sentinel";
const OUTSIDE = "outside-root-sentinel";
const AUTH_JSON = "auth-json-sentinel";
const REDACTION = "redaction-secrets-sentinel";
const CREDENTIALS_DIR = "attempt-credentials-sentinel";
const HOME_FILE = "stageflow-home-sentinel";
const SLOW_BODY = "slow-response-sentinel";

const READ_REPORT = `
export default async function execute(context) {
  const report = await context.files.readJson("artifacts", "report.json");
  let other = "absent";
  try {
    other = await context.files.readText("artifacts", "other.txt");
  } catch {
    other = "absent";
  }
  return {
    passed: report.score >= Number(context.env.MIN_SCORE),
    score: report.score,
    envKeys: Object.keys(context.env).sort(),
    env: context.env,
    other,
  };
}
`;

const READ_PATHS = `
export default async function execute(context) {
  const paths = [
    "/etc/passwd",
    "../outside.txt",
    "escape",
    "devnull",
    "auth.json",
    ".stageflow/runs/run-1/stages/build/attempts/1/redaction-secrets.json",
    "attempts/2/credentials/token",
    "data-home/secret.txt",
  ];
  const results = [];
  for (const filePath of paths) {
    try {
      results.push(await context.files.readText("workspace", filePath));
    } catch {
      results.push("denied");
    }
  }
  let readme = "absent";
  try {
    readme = await context.files.readText("workspace", "readme.txt");
  } catch {
    readme = "absent";
  }
  return { results, readme };
}
`;

const CONTAINER_READS = `
export default async function execute(context) {
  const paths = ["/etc/passwd", "../secret.txt", "escape", "devnull", "auth.json", "redaction-secrets.json"];
  const results = [];
  for (const filePath of paths) {
    try {
      results.push(await context.files.readText("artifacts", filePath));
    } catch {
      results.push("denied");
    }
  }
  let report = "absent";
  try {
    report = await context.files.readText("artifacts", "report.json");
  } catch {
    report = "absent";
  }
  return { results, report };
}
`;

const NO_HOST_OBJECTS = `
export default function execute(context) {
  const names = ["process", "require", "fetch", "fs", "child_process", "net", "WebSocket", "XMLHttpRequest"];
  const found = {};
  for (const name of names) found[name] = typeof globalThis[name];
  return {
    found,
    shell: typeof context.shell,
    exec: typeof context.exec,
    bash: typeof context.bash,
    spawn: typeof context.spawn,
  };
}
`;

const MARKER_WRITE = `
export default async function execute(context) {
  await context.files.write("artifacts", "marker.txt", "guest-ran");
  return { ran: true };
}
`;

const HTTP_GET = `
export default async function execute(context) {
  try {
    const response = await context.http.request({
      method: "GET",
      origin: "https://allowed.test",
      path: "/v1/report",
    });
    return { status: response.status, body: response.body, env: context.env };
  } catch (error) {
    return { denied: true, env: context.env, message: String(error && error.message || error) };
  }
}
`;

const LIST_ROOTS = `
export default async function execute(context) {
  async function attempt(run) {
    try {
      return await run();
    } catch (error) {
      return { code: error.code, message: error.message };
    }
  }
  return {
    stolen: context.artifacts.stolen === true || context.workspace.stolen === true,
    listed: await context.artifacts.list(""),
    filesRead: await context.files.readText("artifacts", "a.txt"),
    report: await context.artifacts.readJson("report.json"),
    workspace: await context.workspace.list("."),
    denied: [await attempt(() => context.artifacts.list("/etc")), await attempt(() => context.artifacts.list("../outside.txt"))],
    missing: await attempt(() => context.artifacts.list("missing")),
    file: await attempt(() => context.artifacts.list("a.txt")),
    limited: await attempt(() => context.artifacts.list("many")),
  };
}
`;

const closures: Array<() => Promise<void>> = [];

afterEach(async () => {
  const pending = closures.splice(0);
  for (const close of pending) await close();
});

describe("function broker", () => {
  it("reads a granted artifact and a bound threshold, and nothing else", async () => {
    const root = await makeRoot();
    const artifacts = path.join(root, "artifacts");
    await mkdir(artifacts, { recursive: true });
    await writeFile(path.join(artifacts, "report.json"), '{"score":3}\n');
    await writeFile(path.join(artifacts, "other.txt"), OTHER_FILE);
    const broker = brokerFor(root, { MIN_SCORE: "2", GITHUB_TOKEN: GITHUB_SENTINEL, OTHER: "other-env" });

    const result = await broker.invoke({
      invocationId: "granted-report",
      kind: "verification",
      source: READ_REPORT,
      context: {},
      roots: { artifacts, workspace: root },
      projectRoot: root,
      grants: {
        files: [{ root: "artifacts", path: "report.json", access: "read" }],
        env: [{ alias: "MIN_SCORE", name: "MIN_SCORE", required: true }],
      },
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        passed: true,
        score: 3,
        envKeys: ["MIN_SCORE"],
        env: { MIN_SCORE: "2" },
        other: "absent",
      },
    });
    expect(JSON.stringify(result)).not.toContain(OTHER_FILE);
    expect(JSON.stringify(result)).not.toContain(GITHUB_SENTINEL);
    expect(await readFile(path.join(artifacts, "other.txt"), "utf8")).toBe(OTHER_FILE);
  });

  it("reads a granted artifact under the Stageflow home runs directory", async () => {
    const root = await makeRoot();
    const home = path.join(root, "data-home");
    const artifacts = path.join(home, "runs", "run-1", "stages", "write-report", "attempts", "1", "artifacts");
    await mkdir(artifacts, { recursive: true });
    await writeFile(path.join(artifacts, "report.json"), '{"score":82}');
    await writeFile(path.join(artifacts, "auth.json"), AUTH_JSON);
    await mkdir(path.join(artifacts, "attempts", "1", "credentials"), { recursive: true });
    await writeFile(path.join(artifacts, "attempts", "1", "credentials", "token"), CREDENTIALS_DIR);
    await writeFile(path.join(home, "secret.txt"), HOME_FILE);
    const broker = brokerFor(root, {}, home);
    const result = await broker.invoke({
      invocationId: "home-runs-read",
      kind: "verification",
      source: `
        export default async function execute(context) {
          const report = await context.artifacts.readJson("report.json");
          const denied = [];
          for (const read of [
            () => context.artifacts.readText("auth.json"),
            () => context.artifacts.readText("attempts/1/credentials/token"),
            () => context.files.readText("workspace", "secret.txt"),
          ]) {
            try {
              denied.push(await read());
            } catch {
              denied.push("denied");
            }
          }
          return { score: report.score, denied };
        }
      `,
      context: {},
      roots: { artifacts, workspace: home },
      projectRoot: root,
      grants: {
        files: [
          { root: "artifacts", path: ".", access: "read" },
          { root: "workspace", path: ".", access: "read" },
        ],
      },
    });
    expect(result).toMatchObject({
      ok: true,
      value: { score: 82, denied: ["denied", "denied", "denied"] },
    });
    expect(JSON.stringify(result)).not.toContain(AUTH_JSON);
    expect(JSON.stringify(result)).not.toContain(CREDENTIALS_DIR);
    expect(JSON.stringify(result)).not.toContain(HOME_FILE);
  });

  it("denies absolute paths, traversal, symlink escapes, devices, and credential files", async () => {
    const root = await makeRoot();
    const outside = path.join(path.dirname(root), "outside.txt");
    await writeFile(outside, OUTSIDE);
    await writeFile(path.join(root, "readme.txt"), "hello-project");
    await symlink(outside, path.join(root, "escape"));
    await symlink("/dev/null", path.join(root, "devnull"));
    await writeFile(path.join(root, "auth.json"), AUTH_JSON);
    const redaction = path.join(
      root,
      ".stageflow/runs/run-1/stages/build/attempts/1/redaction-secrets.json",
    );
    await mkdir(path.dirname(redaction), { recursive: true });
    await writeFile(redaction, REDACTION);
    const credentials = path.join(root, "attempts/2/credentials/token");
    await mkdir(path.dirname(credentials), { recursive: true });
    await writeFile(credentials, CREDENTIALS_DIR);
    const home = path.join(root, "data-home");
    await mkdir(home, { recursive: true });
    await writeFile(path.join(home, "secret.txt"), HOME_FILE);
    const broker = brokerFor(root, {}, home);

    const result = await broker.invoke({
      invocationId: "host-denies",
      kind: "verification",
      source: READ_PATHS,
      context: {},
      roots: { workspace: root, artifacts: path.join(root, "artifacts") },
      projectRoot: root,
      grants: { files: [{ root: "workspace", path: ".", access: "read" }] },
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        readme: "hello-project",
        results: Array.from({ length: 8 }, () => "denied"),
      },
    });
    const packed = JSON.stringify(result);
    for (const sentinel of [OUTSIDE, AUTH_JSON, REDACTION, CREDENTIALS_DIR, HOME_FILE]) {
      expect(packed).not.toContain(sentinel);
    }
    expect(await readFile(outside, "utf8")).toBe(OUTSIDE);
    expect(await readFile(redaction, "utf8")).toBe(REDACTION);
  });

  it("denies the same paths when the stage root is a container mount", async () => {
    const reads: string[] = [];
    const files = new Map<string, { text?: string; symlink?: string; device?: boolean }>([
      ["/workspace/artifacts/report.json", { text: '{"score":9}' }],
      ["/workspace/artifacts/secret.txt", { text: "container-secret" }],
      ["/etc/passwd", { text: "root-secret" }],
      ["/workspace/artifacts/escape", { symlink: "/etc/passwd" }],
      ["/workspace/artifacts/devnull", { device: true, text: "device-bytes" }],
      ["/workspace/artifacts/auth.json", { text: AUTH_JSON }],
      ["/workspace/artifacts/redaction-secrets.json", { text: REDACTION }],
    ]);
    const containerFiles = {
      async realPath(containerPath: string) {
        const entry = files.get(containerPath);
        if (entry?.symlink) return entry.symlink;
        return containerPath;
      },
      async stat(containerPath: string) {
        const entry = files.get(containerPath);
        if (!entry || entry.symlink) return entry?.symlink ? { file: true, directory: false, device: false, size: 1 } : undefined;
        return { file: true, directory: false, device: entry.device === true, size: entry.text?.length ?? 0 };
      },
      async readFile(containerPath: string) {
        reads.push(containerPath);
        const entry = files.get(containerPath);
        if (!entry?.text) throw new Error("missing");
        return entry.text;
      },
      async writeFile() {
        throw new Error("unexpected container write");
      },
      async list() {
        throw new Error("unexpected container list");
      },
    };
    const root = await makeRoot();
    const broker = new FunctionBroker({
      env: {},
      stageflowHome: path.join(root, "home"),
      containerFiles,
    });

    const result = await broker.invoke({
      invocationId: "container-denies",
      kind: "verification",
      source: CONTAINER_READS,
      context: {},
      containerName: "stage-container",
      containerDockerBin: "docker",
      roots: { artifacts: "/workspace/artifacts", workspace: "/workspace" },
      projectRoot: "/workspace",
      grants: { files: [{ root: "artifacts", path: ".", access: "read" }] },
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        report: '{"score":9}',
        results: ["denied", "denied", "denied", "denied", "denied", "denied"],
      },
    });
    expect(reads).toEqual(["/workspace/artifacts/report.json"]);
    expect(JSON.stringify(result)).not.toContain(AUTH_JSON);
    expect(JSON.stringify(result)).not.toContain(REDACTION);
    expect(JSON.stringify(result)).not.toContain("root-secret");
    expect(JSON.stringify(result)).not.toContain("device-bytes");
    expect(JSON.stringify(result)).not.toContain("container-secret");
  });

  it("has no process, shell, or raw network objects", async () => {
    const root = await makeRoot();
    const broker = brokerFor(root, {});
    const absent = await broker.invoke({
      invocationId: "no-host",
      kind: "tool",
      source: NO_HOST_OBJECTS,
      context: {},
      roots: { workspace: root },
      projectRoot: root,
      grants: {},
    });
    const imported = await broker.invoke({
      invocationId: "no-import",
      kind: "tool",
      source: "import child from 'node:child_process'; export default function execute(){ return child; }",
      context: {},
      roots: { workspace: root },
      projectRoot: root,
      grants: {},
    });

    expect(absent).toMatchObject({
      ok: true,
      value: {
        found: {
          process: "undefined",
          require: "undefined",
          fetch: "undefined",
          fs: "undefined",
          child_process: "undefined",
          net: "undefined",
          WebSocket: "undefined",
          XMLHttpRequest: "undefined",
        },
        shell: "undefined",
        exec: "undefined",
        bash: "undefined",
        spawn: "undefined",
      },
    });
    expect(imported.ok).toBe(false);
    expect(JSON.stringify(imported)).not.toContain("spawn");
  });

  it("allows origin-root and narrower API path prefixes", async () => {
    const server = await httpFixture({ status: 200, body: "path-ok" });
    track(async () => server.close());
    const root = await makeRoot();
    const broker = httpBroker(
      root,
      { "allowed.test": [["203.0.113.10"], ["203.0.113.10"]] },
      { "203.0.113.10": portOf(server.url) },
      0,
    );
    const guestHttp = (requestPath: string) => `
export default async function execute(context) {
  try {
    const response = await context.http.request({
      method: "GET",
      origin: "https://allowed.test",
      path: ${JSON.stringify(requestPath)},
    });
    return { allowed: true, status: response.status, body: response.body };
  } catch (error) {
    return { allowed: false, code: error.code, message: error.message };
  }
}
`;
    const invoke = async (pathPrefix: string, requestPath: string, invocationId: string) =>
      broker.invoke({
        invocationId,
        kind: "tool",
        source: guestHttp(requestPath),
        context: {},
        roots: { workspace: root },
        projectRoot: root,
        grants: {
          apis: [
            {
              origin: "https://allowed.test",
              methods: ["GET"],
              pathPrefix,
              access: "read",
              credential: "API_TOKEN",
            },
          ],
        },
      });

    server.requests.length = 0;
    expect(await invoke("/", "/")).toMatchObject({ ok: true, value: { allowed: true, status: 200 } });
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]?.url).toBe("/");

    server.requests.length = 0;
    expect(await invoke("/", "/v1/report")).toMatchObject({
      ok: true,
      value: { allowed: true, status: 200, body: "path-ok" },
    });
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]?.url).toBe("/v1/report");

    server.requests.length = 0;
    expect(await invoke("/v1", "/v1/report")).toMatchObject({ ok: true, value: { allowed: true, status: 200 } });
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]?.url).toBe("/v1/report");

    server.requests.length = 0;
    expect(await invoke("/v1", "/other")).toMatchObject({
      ok: true,
      value: { allowed: false, code: "permission_denied", message: "api access denied" },
    });
    expect(server.requests).toHaveLength(0);

    expect(await invoke("/v1", "//v1")).toMatchObject({
      ok: true,
      value: { allowed: false, code: "permission_denied", message: "api access denied" },
    });
    expect(server.requests).toHaveLength(0);
  });

  it("does not send credentials when a permitted host redirects or re-resolves to a private address", async () => {
    const proxy = await httpFixture({ status: 500, body: "proxy-should-not-run" });
    const sink = await httpFixture({ status: 200, body: SLOW_BODY });
    const allowed = await httpFixture({ status: 200, body: "permitted" });
    const other = await httpFixture({ status: 200, body: "other-host" });
    track(async () => {
      await proxy.close();
      await sink.close();
      await allowed.close();
      await other.close();
    });
    const previousProxy = process.env.HTTPS_PROXY;
    const previousHttp = process.env.HTTP_PROXY;
    const previousNo = process.env.NO_PROXY;
    process.env.HTTPS_PROXY = proxy.url;
    process.env.HTTP_PROXY = proxy.url;
    delete process.env.NO_PROXY;
    delete process.env.no_proxy;
    resetProxyDispatcherForTests();
    installProxyDispatcher(process.env);
    track(async () => {
      setGlobalDispatcher(new Agent());
      resetProxyDispatcherForTests();
      restoreEnv("HTTPS_PROXY", previousProxy);
      restoreEnv("HTTP_PROXY", previousHttp);
      restoreEnv("NO_PROXY", previousNo);
    });

    const sinkPort = portOf(sink.url);
    const cases: Array<{ name: string; location?: string; lookup: Record<string, string[][]>; expectAllowed: number }> = [
      {
        name: "loopback",
        location: `http://127.0.0.1:${sinkPort}/v1/steal`,
        lookup: { "allowed.test": [["203.0.113.10"], ["203.0.113.10"]] },
        expectAllowed: 1,
      },
      {
        name: "private",
        location: "https://10.2.0.8/v1/steal",
        lookup: {
          "allowed.test": [["203.0.113.10"], ["203.0.113.10"]],
          "10.2.0.8": [["10.2.0.8"]],
        },
        expectAllowed: 1,
      },
      {
        name: "link-local",
        location: "https://169.254.5.5/v1/steal",
        lookup: { "allowed.test": [["203.0.113.10"], ["203.0.113.10"]] },
        expectAllowed: 1,
      },
      {
        name: "metadata",
        location: "https://metadata.google.internal/v1/computeMetadata",
        lookup: {
          "allowed.test": [["203.0.113.10"], ["203.0.113.10"]],
          "metadata.google.internal": [["169.254.169.254"]],
        },
        expectAllowed: 1,
      },
      {
        name: "second-answer",
        lookup: { "allowed.test": [["203.0.113.10", "192.168.0.8"]] },
        expectAllowed: 0,
      },
      {
        name: "re-resolve",
        lookup: { "allowed.test": [["203.0.113.10"], ["127.0.0.1"]] },
        expectAllowed: 0,
      },
    ];

    const root = await makeRoot();
    for (const item of cases) {
      allowed.requests.length = 0;
      allowed.queue.length = 0;
      sink.requests.length = 0;
      proxy.requests.length = 0;
      allowed.queue.push({
        status: item.location ? 302 : 200,
        headers: item.location ? { location: item.location } : {},
        body: item.location ? "" : "permitted",
      });
      const broker = httpBroker(root, item.lookup, {
        "203.0.113.10": portOf(allowed.url),
        "198.51.100.20": portOf(other.url),
      }, portOf(sink.url));
      const result = await broker.invoke(httpInvoke(root, `redirect-${item.name}`));
      expect(sink.requests, item.name).toEqual([]);
      expect(proxy.requests, item.name).toEqual([]);
      expect(allowed.requests, item.name).toHaveLength(item.expectAllowed);
      expect(JSON.stringify(sink.requests)).not.toContain(CREDENTIAL);
      expect(JSON.stringify(proxy.requests)).not.toContain(CREDENTIAL);
      expect(JSON.stringify(result)).not.toContain(CREDENTIAL);
      expect(JSON.stringify(result)).not.toContain(SLOW_BODY);
      if (item.expectAllowed === 1) {
        expect(allowed.requests[0]?.headers.authorization).toBe(`Bearer ${CREDENTIAL}`);
      }
    }

    allowed.requests.length = 0;
    allowed.queue.length = 0;
    other.requests.length = 0;
    sink.requests.length = 0;
    proxy.requests.length = 0;
    allowed.queue.push({
      status: 302,
      headers: { location: "https://other.test/v1/next" },
      body: "",
    });
    const moved = httpBroker(
      root,
      {
        "allowed.test": [["203.0.113.10"], ["203.0.113.10"]],
        "other.test": [["198.51.100.20"], ["198.51.100.20"]],
      },
      {
        "203.0.113.10": portOf(allowed.url),
        "198.51.100.20": portOf(other.url),
      },
      portOf(sink.url),
    );
    await moved.invoke(httpInvoke(root, "redirect-new-host"));
    expect(other.requests).toHaveLength(1);
    expect(other.requests[0]?.headers.authorization).toBeUndefined();
    expect(JSON.stringify(other.requests)).not.toContain(CREDENTIAL);
    expect(sink.requests).toEqual([]);
    expect(proxy.requests).toEqual([]);
  });

  it("fails a missing required binding before guest code and keeps secrets out of context.env", async () => {
    const root = await makeRoot();
    const artifacts = path.join(root, "artifacts");
    await mkdir(artifacts, { recursive: true });
    const env = {
      MIN_SCORE: "2",
      GITHUB_TOKEN: GITHUB_SENTINEL,
      STAGEFLOW_CONTROL_TOKEN: CONTROL_SENTINEL,
      WEBHOOK_SECRET: SECRET_STORE_SENTINEL,
      STAGEFLOW_SECRET_REGISTRY: "WEBHOOK_SECRET",
    };
    const broker = brokerFor(root, env);
    const grants = {
      files: [{ root: "artifacts" as const, path: "marker.txt", access: "write" as const }],
    };

    const missing = await broker.invoke({
      invocationId: "missing-binding",
      kind: "tool",
      source: MARKER_WRITE,
      context: {},
      roots: { artifacts, workspace: root },
      projectRoot: root,
      grants: {
        ...grants,
        env: [{ alias: "MIN_SCORE", name: "NOT_CONFIGURED", required: true }],
      },
    });
    const optional = await broker.invoke({
      invocationId: "optional-binding",
      kind: "tool",
      source: "export default function execute(context){ return { keys: Object.keys(context.env).sort(), env: context.env }; }",
      context: {},
      roots: { artifacts, workspace: root },
      projectRoot: root,
      grants: {
        env: [
          { alias: "MIN_SCORE", name: "MIN_SCORE", required: true },
          { alias: "OPTIONAL_LIMIT", name: "OPTIONAL_LIMIT", required: false },
        ],
      },
    });
    const foreverDenied = await broker.invoke({
      invocationId: "forever-denied",
      kind: "tool",
      source: MARKER_WRITE,
      context: {},
      roots: { artifacts, workspace: root },
      projectRoot: root,
      grants: {
        ...grants,
        env: [{ alias: "CONTROL", name: "STAGEFLOW_CONTROL_TOKEN", required: true }],
      },
    });
    const provider = await broker.invoke({
      invocationId: "provider-token",
      kind: "tool",
      source: MARKER_WRITE,
      context: {},
      roots: { artifacts, workspace: root },
      projectRoot: root,
      grants: {
        ...grants,
        env: [{ alias: "GITHUB_TOKEN", name: "GITHUB_TOKEN", required: true }],
      },
    });
    const stored = await broker.invoke({
      invocationId: "secret-store",
      kind: "tool",
      source: MARKER_WRITE,
      context: {},
      roots: { artifacts, workspace: root },
      projectRoot: root,
      grants: {
        ...grants,
        env: [{ alias: "HOOK", name: "WEBHOOK_SECRET", required: true }],
      },
    });

    expect(missing).toMatchObject({ ok: false, code: "missing_binding" });
    expect(missing.pid).toBeUndefined();
    expect(optional).toMatchObject({
      ok: true,
      value: { keys: ["MIN_SCORE"], env: { MIN_SCORE: "2" } },
    });
    expect(foreverDenied).toMatchObject({ ok: false, code: "permission_denied" });
    expect(foreverDenied.pid).toBeUndefined();
    expect(provider).toMatchObject({ ok: false, code: "permission_denied" });
    expect(provider.pid).toBeUndefined();
    expect(stored).toMatchObject({ ok: false, code: "permission_denied" });
    expect(stored.pid).toBeUndefined();
    await expect(readFile(path.join(artifacts, "marker.txt"), "utf8")).rejects.toThrow();
    const packed = JSON.stringify({ missing, optional, foreverDenied, provider, stored });
    expect(packed).not.toContain(GITHUB_SENTINEL);
    expect(packed).not.toContain(CONTROL_SENTINEL);
    expect(packed).not.toContain(SECRET_STORE_SENTINEL);
  });

  it("rejects a write grant on verification and routing before guest code runs", async () => {
    const root = await makeRoot();
    const artifacts = path.join(root, "artifacts");
    await mkdir(artifacts, { recursive: true });
    const broker = brokerFor(root, {});
    for (const kind of ["verification", "routing"] as const) {
      const result = await broker.invoke({
        invocationId: `write-${kind}`,
        kind,
        source: MARKER_WRITE,
        context: {},
        roots: { artifacts, workspace: root },
        projectRoot: root,
        grants: { files: [{ root: "artifacts", path: "marker.txt", access: "write" }] },
      });
      expect(result).toMatchObject({ ok: false, code: "permission_denied" });
      expect(result.pid).toBeUndefined();
    }
    await expect(readFile(path.join(artifacts, "marker.txt"), "utf8")).rejects.toThrow();
  });

  it("leaves the previous file or no file when a write is killed", async () => {
    const root = await makeRoot();
    const artifacts = path.join(root, "artifacts");
    await mkdir(artifacts, { recursive: true });
    const existing = path.join(artifacts, "out.txt");
    await writeFile(existing, "previous-bytes");
    let broker!: FunctionBroker;
    broker = new FunctionBroker({
      env: {},
      stageflowHome: path.join(root, "home"),
      beforeFileCommit: () => broker.cancel("kill-write"),
    });
    const replaced = await broker.invoke({
      invocationId: "kill-write",
      kind: "tool",
      source: "export default async function execute(context){ await context.files.write('artifacts', 'out.txt', 'next-bytes'); return { wrote: true }; }",
      context: {},
      roots: { artifacts, workspace: root },
      projectRoot: root,
      grants: { files: [{ root: "artifacts", path: "out.txt", access: "write" }] },
    });
    expect(replaced).toMatchObject({ ok: false, code: "uncertain_outcome" });
    expect(await readFile(existing, "utf8")).toBe("previous-bytes");

    broker = new FunctionBroker({
      env: {},
      stageflowHome: path.join(root, "home"),
      beforeFileCommit: () => broker.cancel("kill-create"),
    });
    const created = await broker.invoke({
      invocationId: "kill-create",
      kind: "tool",
      source: "export default async function execute(context){ await context.files.write('artifacts', 'fresh.txt', 'next-bytes'); return { wrote: true }; }",
      context: {},
      roots: { artifacts, workspace: root },
      projectRoot: root,
      grants: { files: [{ root: "artifacts", path: "fresh.txt", access: "write" }] },
    });
    expect(created).toMatchObject({ ok: false, code: "uncertain_outcome" });
    await expect(readFile(path.join(artifacts, "fresh.txt"), "utf8")).rejects.toThrow();
  });

  it("aborts an in-flight file read and does not deliver the bytes", async () => {
    const root = await makeRoot();
    const artifacts = path.join(root, "artifacts");
    await mkdir(artifacts, { recursive: true });
    const fifo = path.join(artifacts, "slow.txt");
    execFileSync("mkfifo", [fifo]);
    const broker = brokerFor(root, {});
    const pending = broker.invoke({
      invocationId: "cancel-read",
      kind: "verification",
      source: "export default async function execute(context){ return { text: await context.files.readText('artifacts', 'slow.txt') }; }",
      context: {},
      roots: { artifacts, workspace: root },
      projectRoot: root,
      grants: { files: [{ root: "artifacts", path: "slow.txt", access: "read" }] },
    });
    const writer = await Promise.race([
      open(fifo, "w"),
      rejectAfter(5_000, "file read did not open"),
    ]);
    await broker.cancel("cancel-read");
    await writer.writeFile(SLOW_BODY).catch(() => undefined);
    await writer.close().catch(() => undefined);
    const result = await pending;
    expect(result).toMatchObject({ ok: false, code: "cancelled" });
    expect(JSON.stringify(result)).not.toContain(SLOW_BODY);
  });

  it("aborts an in-flight HTTP call and does not deliver the bytes", async () => {
    const root = await makeRoot();
    let sentBody = false;
    let releaseHeaders: () => void = () => {};
    let releaseClose: () => void = () => {};
    const headersSeen = new Promise<void>((resolve) => {
      releaseHeaders = resolve;
    });
    const closed = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const server = createServer((req, res) => {
      const timer = setTimeout(() => {
        sentBody = true;
        res.end(SLOW_BODY);
      }, 20_000);
      req.on("close", () => {
        clearTimeout(timer);
        releaseClose();
      });
      releaseHeaders();
    });
    const port = await listen(server);
    track(() => closeServer(server));
    const broker = httpBroker(
      root,
      { "slow.test": [["203.0.113.40"], ["203.0.113.40"]] },
      { "203.0.113.40": port },
      port,
    );
    const pending = broker.invoke({
      invocationId: "cancel-http",
      kind: "tool",
      source: `
        export default async function execute(context) {
          const response = await context.http.request({ method: "GET", origin: "https://slow.test", path: "/v1/slow" });
          return { body: response.body };
        }
      `,
      context: {},
      roots: { workspace: root },
      projectRoot: root,
      grants: {
        apis: [{ origin: "https://slow.test", methods: ["GET"], pathPrefix: "/v1", access: "read" }],
      },
    });
    await Promise.race([headersSeen, rejectAfter(5_000, "http call did not start")]);
    await broker.cancel("cancel-http");
    await Promise.race([closed, rejectAfter(5_000, "http call was not aborted")]);
    const result = await pending;
    expect(result).toMatchObject({ ok: false, code: "cancelled" });
    expect(sentBody).toBe(false);
    expect(JSON.stringify(result)).not.toContain(SLOW_BODY);
  });

  it("lists and reads through context.artifacts and context.workspace with the same grants", async () => {
    const root = await makeRoot();
    const artifacts = path.join(root, "artifacts");
    const reports = path.join(artifacts, "reports");
    await mkdir(reports, { recursive: true });
    await writeFile(path.join(reports, "summary.md"), "summary");
    await writeFile(path.join(artifacts, "b.txt"), "b");
    await writeFile(path.join(artifacts, "a.txt"), "aa");
    await writeFile(path.join(artifacts, "report.json"), '{"score":4}');
    await writeFile(path.join(artifacts, "auth.json"), AUTH_JSON);
    await mkdir(path.join(artifacts, ".stageflow"), { recursive: true });
    await writeFile(path.join(artifacts, ".stageflow", "secret"), "hidden-stageflow");
    const outside = path.join(root, "outside.txt");
    await writeFile(outside, OUTSIDE);
    await symlink(outside, path.join(artifacts, "escape"));
    await symlink(path.join(artifacts, "a.txt"), path.join(artifacts, "inside"));
    await symlink("/dev/null", path.join(artifacts, "devnull"));
    const workspace = path.join(root, "ws");
    await mkdir(workspace);
    await writeFile(path.join(workspace, "notes.txt"), "workspace-note");
    const broker = brokerFor(root, {});
    const many = path.join(artifacts, "many");
    await mkdir(many);
    await Promise.all(Array.from({ length: 1001 }, (_, index) => writeFile(path.join(many, `f${index}`), "x")));

    const listed = await broker.invoke({
      invocationId: "list-roots",
      kind: "verification",
      source: LIST_ROOTS,
      context: { artifacts: { stolen: true }, workspace: { stolen: true }, files: { stolen: true }, env: { LEAK: "no" } },
      roots: { artifacts, workspace },
      projectRoot: root,
      grants: { files: [{ root: "artifacts", path: ".", access: "read" }, { root: "workspace", path: "", access: "read" }] },
    });
    const reportsStat = await stat(reports);
    expect(listed).toMatchObject({
      ok: true,
      value: {
        stolen: false,
        filesRead: "aa",
        report: { score: 4 },
        workspace: [{ name: "notes.txt", type: "file", size: "workspace-note".length }],
        denied: [
          { code: "permission_denied", message: "file access denied" },
          { code: "permission_denied", message: "file access denied" },
        ],
        missing: { code: "not_found", message: "file not found" },
        file: { code: "not_a_directory", message: "not a directory" },
        limited: { code: "list_limit", message: "directory has more than 1000 entries" },
      },
    });
    const rows = (listed.ok ? listed.value : undefined) as { listed?: Array<{ name: string; type: string; size: number }> } | undefined;
    expect(rows?.listed).toEqual([
      { name: "a.txt", type: "file", size: 2 },
      { name: "b.txt", type: "file", size: 1 },
      { name: "inside", type: "file", size: 2 },
      { name: "many", type: "directory", size: (await lstat(many)).size },
      { name: "report.json", type: "file", size: '{"score":4}'.length },
      { name: "reports", type: "directory", size: reportsStat.size },
    ]);
    expect(JSON.stringify(listed)).not.toContain(AUTH_JSON);
    expect(JSON.stringify(listed)).not.toContain(OUTSIDE);
    expect(JSON.stringify(listed)).not.toContain("hidden-stageflow");

    const parent = await broker.invoke({
      invocationId: "list-parent-denied",
      kind: "verification",
      source: "export default async function execute(context){ try { return { rows: await context.artifacts.list('reports') }; } catch (error) { return { code: error.code, message: error.message }; } }",
      context: {},
      roots: { artifacts, workspace: root },
      projectRoot: root,
      grants: { files: [{ root: "artifacts", path: "reports/summary.md", access: "read" }] },
    });
    expect(parent).toMatchObject({ ok: true, value: { code: "permission_denied", message: "file access denied" } });

    const child = await broker.invoke({
      invocationId: "list-directory-grant",
      kind: "verification",
      source: "export default async function execute(context){ return { rows: await context.files.list('artifacts', 'reports') }; }",
      context: {},
      roots: { artifacts, workspace: root },
      projectRoot: root,
      grants: { files: [{ root: "artifacts", path: "reports", access: "read" }] },
    });
    expect(child).toMatchObject({
      ok: true,
      value: { rows: [{ name: "summary.md", type: "file", size: "summary".length }] },
    });

    const wrote = await broker.invoke({
      invocationId: "artifacts-write",
      kind: "tool",
      source: "export default async function execute(context){ await context.artifacts.write('out.txt', 'next'); return { wrote: true }; }",
      context: {},
      roots: { artifacts, workspace: root },
      projectRoot: root,
      grants: { files: [{ root: "artifacts", path: "", access: "write" }] },
    });
    expect(wrote).toMatchObject({ ok: true, value: { wrote: true } });
    expect(await readFile(path.join(artifacts, "out.txt"), "utf8")).toBe("next");

    const deniedWrite = await broker.invoke({
      invocationId: "artifacts-write-denied",
      kind: "verification",
      source: "export default async function execute(context){ try { await context.artifacts.write('out.txt', 'no'); return { wrote: true }; } catch (error) { return { code: error.code, message: error.message }; } }",
      context: {},
      roots: { artifacts, workspace: root },
      projectRoot: root,
      grants: { files: [{ root: "artifacts", path: ".", access: "read" }] },
    });
    expect(deniedWrite).toMatchObject({ ok: true, value: { code: "permission_denied", message: "file access denied" } });
  });

  it("lists a container directory and drops sensitive or escaping names", async () => {
    const containerFiles = {
      async realPath(containerPath: string) {
        if (containerPath === "/workspace/artifacts/escape") return "/etc/passwd";
        if (containerPath === "/etc/passwd") return "/etc/passwd";
        return containerPath;
      },
      async stat(containerPath: string) {
        if (containerPath === "/workspace/artifacts" || containerPath === "/workspace/artifacts/nested") {
          return { file: false, directory: true, device: false, size: 64 };
        }
        if (containerPath === "/workspace/artifacts/a.txt") return { file: true, directory: false, device: false, size: 2 };
        if (containerPath === "/etc/passwd") return { file: true, directory: false, device: false, size: 11 };
        return undefined;
      },
      async readFile() {
        throw new Error("unexpected container read");
      },
      async writeFile() {
        throw new Error("unexpected container write");
      },
      async list(containerPath: string) {
        if (containerPath !== "/workspace/artifacts") throw new Error(`unexpected list ${containerPath}`);
        return [
          { name: "b.txt", type: "file" as const, size: 1 },
          { name: "a.txt", type: "file" as const, size: 2 },
          { name: "auth.json", type: "file" as const, size: AUTH_JSON.length },
          { name: "escape", type: "symlink" as const, size: 4 },
          { name: "nested", type: "directory" as const, size: 64 },
        ];
      },
    };
    const root = await makeRoot();
    const broker = new FunctionBroker({ env: {}, stageflowHome: path.join(root, "home"), containerFiles });
    const result = await broker.invoke({
      invocationId: "container-list",
      kind: "verification",
      source: "export default async function execute(context){ return { rows: await context.artifacts.list('') }; }",
      context: { artifacts: { stolen: true }, workspace: "spoof" },
      containerName: "stage-container",
      roots: { artifacts: "/workspace/artifacts", workspace: "/workspace" },
      projectRoot: "/workspace",
      grants: { files: [{ root: "artifacts", path: ".", access: "read" }] },
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        rows: [
          { name: "a.txt", type: "file", size: 2 },
          { name: "b.txt", type: "file", size: 1 },
          { name: "nested", type: "directory", size: 64 },
        ],
      },
    });
    expect(JSON.stringify(result)).not.toContain(AUTH_JSON);
    expect(JSON.stringify(result)).not.toContain("/etc/passwd");
  });
});

function brokerFor(root: string, env: Record<string, string>, stageflowHome = path.join(root, "home")): FunctionBroker {
  return new FunctionBroker({ env, stageflowHome });
}

function httpBroker(
  root: string,
  scripts: Record<string, string[][]>,
  ports: Record<string, number>,
  sinkPort: number,
): FunctionBroker {
  const seen = new Map<string, number>();
  return new FunctionBroker({
    env: { API_TOKEN: CREDENTIAL, STAGEFLOW_SECRET_REGISTRY: "API_TOKEN" },
    stageflowHome: path.join(root, "home"),
    lookup: async (hostname: string) => {
      const rows = scripts[hostname] ?? [["127.0.0.1"]];
      const at = seen.get(hostname) ?? 0;
      seen.set(hostname, at + 1);
      return rows[Math.min(at, rows.length - 1)] ?? ["127.0.0.1"];
    },
    dial: (address: string) => {
      const port = ports[address] ?? sinkPort;
      return connectPort(port);
    },
  });
}

function httpInvoke(root: string, invocationId: string) {
  return {
    invocationId,
    kind: "tool" as const,
    source: HTTP_GET,
    context: {},
    roots: { workspace: root },
    projectRoot: root,
    grants: {
      apis: [
        {
          origin: "https://allowed.test",
          methods: ["GET"],
          pathPrefix: "/v1",
          access: "read" as const,
          credential: "API_TOKEN",
        },
      ],
    },
  };
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "sf-fn-broker-"));
  track(() => rm(root, { recursive: true, force: true }));
  track(() => rm(path.join(path.dirname(root), "outside.txt"), { force: true }));
  return root;
}

function track(close: () => Promise<void> | void): void {
  closures.push(async () => {
    await close();
  });
}

function portOf(url: string): number {
  return Number(new URL(url).port);
}

function connectPort(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host: "127.0.0.1", port }, () => resolve(socket));
    socket.once("error", reject);
  });
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("missing port"));
        return;
      }
      resolve(address.port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

function restoreEnv(name: "HTTPS_PROXY" | "HTTP_PROXY" | "NO_PROXY", value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function rejectAfter(ms: number, message: string): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(message)), ms);
  });
}
