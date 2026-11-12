import { describe, expect, it, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { lstatSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { ensureGlobalHome, resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { buildStageEnvironment } from "../src/runtime/stageEnvironment.js";
import { SF_STAGE_WORKER } from "../src/runtime/stageWorkerProtocol.js";
import { startMcpServer } from "../src/server/mcpHost.js";
import {
  authHintBody,
  assertBindAllowed,
  authenticateBearer,
  BindRefusedError,
  clientAuthorizationHeaders,
  commitHostControlToken,
  CONTROL_TOKEN_FILENAME,
  enforceBearerAuth,
  ensureHostControlToken,
  generatedControlTokenLines,
  hasDriveToken,
  loadControlTokens,
  refuseBindMessage,
  requiredScopeFor,
  resolveClientBearerToken,
  retireGeneratedControlToken,
} from "../src/server/controlToken.js";

const DRIVE = "d".repeat(32);
const READ = "r".repeat(32);
const OTHER = "o".repeat(32);

describe("loadControlTokens", () => {
  it("rejects short and whitespace tokens", () => {
    expect(() =>
      loadControlTokens({ STAGEFLOW_CONTROL_TOKEN: "too-short" }),
    ).toThrow(/at least 32 characters/);
    expect(() =>
      loadControlTokens({ STAGEFLOW_CONTROL_TOKEN: `${"a".repeat(31)} bad` }),
    ).toThrow(/at least 32 characters/);
  });

  it("rejects both plain and _FILE for the same role", () => {
    expect(() =>
      loadControlTokens({
        STAGEFLOW_CONTROL_TOKEN: DRIVE,
        STAGEFLOW_CONTROL_TOKEN_FILE: "/tmp/x",
      }),
    ).toThrow(/only one of/);
  });

  it("trims a trailing newline from _FILE", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sf-token-"));
    const file = path.join(dir, "token");
    await writeFile(file, `${DRIVE}\n`, "utf8");
    const tokens = loadControlTokens({ STAGEFLOW_CONTROL_TOKEN_FILE: file });
    expect(hasDriveToken(tokens)).toBe(true);
    expect(authenticateBearer(tokens, `Bearer ${DRIVE}`)).toEqual({
      scope: "drive",
      caller_id: "default",
    });
  });
});

describe("authenticateBearer", () => {
  it("accepts the correct bearer via digest compare", () => {
    const tokens = loadControlTokens({ STAGEFLOW_CONTROL_TOKEN: DRIVE });
    expect(authenticateBearer(tokens, `Bearer ${DRIVE}`)).toEqual({
      scope: "drive",
      caller_id: "default",
    });
    expect(authenticateBearer(tokens, `Bearer ${OTHER}`)).toBeUndefined();
  });

  it("read token does not satisfy drive", () => {
    const tokens = loadControlTokens({ STAGEFLOW_READ_TOKEN: READ });
    expect(authenticateBearer(tokens, `Bearer ${READ}`)).toEqual({
      scope: "read",
      caller_id: "default",
    });
    expect(requiredScopeFor("POST", "/api/runs")).toBe("drive");
  });
});

describe("ensureHostControlToken", () => {
  it("writes a 0600 token the API requires and the stage environment does not see", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "sf-gen-token-"));
    const dir = path.join(parent, "home");
    const env: NodeJS.ProcessEnv = { STAGEFLOW_HOME: dir, PATH: "/usr/bin" };
    const ensured = ensureHostControlToken(env);
    expect(ensured.generated).toBe(true);
    expect(ensured.pendingWrite).toBe(true);
    expect(ensured.token).toMatch(/^[0-9a-f]{64}$/);
    expect(ensured.filePath).toBe(path.join(dir, CONTROL_TOKEN_FILENAME));
    expect(env.STAGEFLOW_CONTROL_TOKEN).toBeUndefined();
    expect(env.STAGEFLOW_CONTROL_TOKEN_FILE).toBeUndefined();
    expect(loadControlTokens(env, ensured.token).driveDigest).toEqual(
      loadControlTokens({ STAGEFLOW_CONTROL_TOKEN: ensured.token }).driveDigest,
    );
    await expect(stat(ensured.filePath!)).rejects.toMatchObject({ code: "ENOENT" });
    expect(generatedControlTokenLines(ensured, { revealToken: true })).toEqual([
      `Control token: ${ensured.token}`,
      `Control token file: ${ensured.filePath}`,
    ]);
    expect(generatedControlTokenLines(ensured)).toEqual([
      `Control token file: ${ensured.filePath}`,
    ]);
    commitHostControlToken(ensured, env);
    expect(ensured.pendingWrite).toBe(false);
    expect(env.STAGEFLOW_CONTROL_TOKEN).toBeUndefined();
    expect(env.STAGEFLOW_CONTROL_TOKEN_FILE).toBe(ensured.filePath);
    const info = await stat(ensured.filePath!);
    expect(info.mode & 0o777).toBe(0o600);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);

    const tokens = loadControlTokens(env);
    const denied = enforceBearerAuth(
      tokens,
      { headers: {} } as IncomingMessage,
      fakeRes(),
      "read",
    );
    expect(denied.ok).toBe(false);
    const allowed = enforceBearerAuth(
      tokens,
      { headers: { authorization: `Bearer ${ensured.token}` } } as IncomingMessage,
      fakeRes(),
      "drive",
    );
    expect(allowed.ok).toBe(true);

    const stage = buildStageEnvironment({ hostEnv: env });
    expect(stage.env.STAGEFLOW_CONTROL_TOKEN).toBeUndefined();
    expect(stage.env.STAGEFLOW_CONTROL_TOKEN_FILE).toBeUndefined();
    expect(JSON.stringify(stage.env)).not.toContain(ensured.token);
    expect(JSON.stringify(stage.env)).not.toContain(ensured.filePath);

    const root = await mkdtemp(path.join(tmpdir(), "sf-gen-api-"));
    const store = createRunStore({ rootDir: root });
    const started = await startMcpServer({
      agent: scriptedFakeAgent([]),
      cwd: root,
      rootDir: root,
      store,
      port: 0,
      mcpStateless: true,
      controlTokens: tokens,
    });
    try {
      expect((await fetch(`${started.url}/api/health`)).status).toBe(401);
      expect((await fetch(`${started.url}/livez`)).status).toBe(200);
      expect((await fetch(`${started.url}/readyz`)).status).toBe(200);
      const authed = await fetch(`${started.url}/api/health`, {
        headers: { Authorization: `Bearer ${ensured.token}` },
      });
      expect(authed.status).toBe(200);
    } finally {
      await new Promise<void>((resolve, reject) => {
        started.server.close((err) => (err ? reject(err) : resolve()));
      });
      await store.close();
    }
  });

  it("does not generate or print when the operator already set a token", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sf-op-token-"));
    const env: NodeJS.ProcessEnv = {
      STAGEFLOW_HOME: dir,
      STAGEFLOW_CONTROL_TOKEN: DRIVE,
    };
    const ensured = ensureHostControlToken(env);
    expect(ensured).toEqual({ generated: false });
    expect(generatedControlTokenLines(ensured)).toEqual([]);
    expect(env.STAGEFLOW_CONTROL_TOKEN_FILE).toBeUndefined();
    await expect(stat(path.join(dir, CONTROL_TOKEN_FILENAME))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not mint a default token when only a named drive token is set", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sf-named-token-"));
    const env: NodeJS.ProcessEnv = {
      STAGEFLOW_HOME: dir,
      STAGEFLOW_CONTROL_TOKEN_CI: "c".repeat(32),
    };
    const ensured = ensureHostControlToken(env);
    expect(ensured.generated).toBe(false);
    await expect(stat(path.join(dir, CONTROL_TOKEN_FILENAME))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("deletes a leftover generated token when the operator sets STAGEFLOW_CONTROL_TOKEN", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sf-retire-token-"));
    const file = path.join(dir, CONTROL_TOKEN_FILENAME);
    await writeFile(file, `${DRIVE}\n`, { mode: 0o600 });
    const env: NodeJS.ProcessEnv = {
      STAGEFLOW_HOME: dir,
      STAGEFLOW_CONTROL_TOKEN: OTHER,
    };
    const ensured = ensureHostControlToken(env);
    expect(ensured.generated).toBe(false);
    expect(ensured.filePath).toBeUndefined();
    retireGeneratedControlToken(ensured, env);
    await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(`${file}.retired`, "utf8")).toBe(`${DRIVE}\n`);
  });

  it("keeps the file when a named _FILE, a symlinked spelling, or a plain token value refers to it", async () => {
    const make = async (label: string) => {
      const dir = await mkdtemp(path.join(tmpdir(), `sf-keep-${label}-`));
      const file = path.join(dir, CONTROL_TOKEN_FILENAME);
      await writeFile(file, `${DRIVE}\n`, { mode: 0o600 });
      return { dir, file };
    };
    const cases: Array<(dir: string, file: string) => NodeJS.ProcessEnv> = [
      (dir, file) => ({ STAGEFLOW_HOME: dir, STAGEFLOW_CONTROL_TOKEN_CI_FILE: file }),
      (dir, file) => ({ STAGEFLOW_HOME: dir, STAGEFLOW_CONTROL_TOKEN_FILE: path.join(realpathSync(dir), path.basename(file)) }),
      (dir) => ({ STAGEFLOW_HOME: realpathSync(dir), STAGEFLOW_CONTROL_TOKEN_FILE: path.join(dir, ".", CONTROL_TOKEN_FILENAME) }),
      (dir) => ({ STAGEFLOW_HOME: dir, STAGEFLOW_CONTROL_TOKEN: DRIVE }),
    ];
    for (const [index, build] of cases.entries()) {
      const { dir, file } = await make(String(index));
      const env = build(dir, file);
      const ensured = ensureHostControlToken(env);
      retireGeneratedControlToken(ensured, env);
      expect(await readFile(file, "utf8"), `case ${index}`).toBe(`${DRIVE}\n`);
    }
  });

  it("warns instead of throwing when the file cannot be moved", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sf-retire-ro-"));
    const file = path.join(dir, CONTROL_TOKEN_FILENAME);
    await writeFile(file, `${DRIVE}\n`, { mode: 0o600 });
    await chmod(dir, 0o500);
    const lines: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    try {
      const env: NodeJS.ProcessEnv = { STAGEFLOW_HOME: dir, STAGEFLOW_CONTROL_TOKEN: OTHER };
      expect(() => retireGeneratedControlToken(ensureHostControlToken(env), env)).not.toThrow();
      expect(lines.join("\n")).toContain("Could not retire the generated control token file");
    } finally {
      spy.mockRestore();
      await chmod(dir, 0o700);
    }
  });

  it("keeps the file when STAGEFLOW_CONTROL_TOKEN_FILE points at it", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sf-keep-token-"));
    const file = path.join(dir, CONTROL_TOKEN_FILENAME);
    await writeFile(file, `${DRIVE}\n`, { mode: 0o600 });
    const env: NodeJS.ProcessEnv = {
      STAGEFLOW_HOME: dir,
      STAGEFLOW_CONTROL_TOKEN_FILE: file,
    };
    const ensured = ensureHostControlToken(env);
    retireGeneratedControlToken(ensured, env);
    expect(await readFile(file, "utf8")).toBe(`${DRIVE}\n`);
  });

  it("unlinks a leftover control-token symlink without following it", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sf-retire-symlink-"));
    const target = path.join(dir, "elsewhere");
    const file = path.join(dir, CONTROL_TOKEN_FILENAME);
    await writeFile(target, `${DRIVE}\n`, { mode: 0o600 });
    symlinkSync(target, file);
    const env: NodeJS.ProcessEnv = {
      STAGEFLOW_HOME: dir,
      STAGEFLOW_CONTROL_TOKEN: OTHER,
    };
    const ensured = ensureHostControlToken(env);
    retireGeneratedControlToken(ensured, env);
    await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(target, "utf8")).toBe(`${DRIVE}\n`);
  });

  it("does not generate when unauthenticated bind is explicitly opted in", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sf-allow-bind-"));
    const env: NodeJS.ProcessEnv = {
      STAGEFLOW_HOME: dir,
      STAGEFLOW_ALLOW_UNAUTHENTICATED_BIND: "1",
    };
    expect(ensureHostControlToken(env).generated).toBe(false);
    await expect(stat(path.join(dir, CONTROL_TOKEN_FILENAME))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("reuses a 0600 token file on a second boot", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sf-reuse-token-"));
    const env: NodeJS.ProcessEnv = { STAGEFLOW_HOME: dir };
    const first = ensureHostControlToken(env);
    commitHostControlToken(first, env);
    delete env.STAGEFLOW_CONTROL_TOKEN;
    delete env.STAGEFLOW_CONTROL_TOKEN_FILE;
    const second = ensureHostControlToken(env);
    expect(second.generated).toBe(false);
    expect(second.pendingWrite).toBeUndefined();
    expect(second.token).toBe(first.token);
    expect(generatedControlTokenLines(second, { revealToken: true })).toEqual([
      `Control token file: ${second.filePath}`,
    ]);
    expect((await readFile(second.filePath!, "utf8")).trim()).toBe(first.token);
    commitHostControlToken(second, env);
    expect((await readFile(second.filePath!, "utf8")).trim()).toBe(first.token);
  });

  it("replaces a 0644 token file and a symlink", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sf-bad-token-"));
    const file = path.join(dir, CONTROL_TOKEN_FILENAME);
    const loose = "c".repeat(64);
    await writeFile(file, loose, { mode: 0o644 });
    await chmod(file, 0o644);
    const env: NodeJS.ProcessEnv = { STAGEFLOW_HOME: dir };
    const replaced = ensureHostControlToken(env);
    expect(replaced.generated).toBe(true);
    expect(replaced.token).not.toBe(loose);
    commitHostControlToken(replaced, env);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await readFile(file, "utf8")).trim()).toBe(replaced.token);

    const target = path.join(dir, "elsewhere");
    const linked = "e".repeat(64);
    await writeFile(target, linked, { mode: 0o600 });
    const { unlinkSync } = await import("node:fs");
    unlinkSync(file);
    symlinkSync(target, file);
    delete env.STAGEFLOW_CONTROL_TOKEN;
    delete env.STAGEFLOW_CONTROL_TOKEN_FILE;
    const fromLink = ensureHostControlToken(env);
    expect(fromLink.generated).toBe(true);
    expect(fromLink.token).not.toBe(linked);
    commitHostControlToken(fromLink, env);
    expect(lstatSync(file).isSymbolicLink()).toBe(false);
    expect(lstatSync(file).isFile()).toBe(true);
    expect(readFileSync(target, "utf8").trim()).toBe(linked);
    expect(readFileSync(file, "utf8").trim()).toBe(fromLink.token);
  });
});

function fakeRes(): ServerResponse {
  return {
    writeHead() {
      return this;
    },
    end() {},
  } as unknown as ServerResponse;
}

describe("resolveClientBearerToken", () => {
  it("prefers drive for any method and falls back to read only for GET", () => {
    expect(
      resolveClientBearerToken("POST", { STAGEFLOW_CONTROL_TOKEN: DRIVE }),
    ).toBe(DRIVE);
    expect(
      resolveClientBearerToken("GET", {
        STAGEFLOW_CONTROL_TOKEN: DRIVE,
        STAGEFLOW_READ_TOKEN: READ,
      }),
    ).toBe(DRIVE);
    expect(
      resolveClientBearerToken("GET", { STAGEFLOW_READ_TOKEN: READ }),
    ).toBe(READ);
    expect(
      resolveClientBearerToken("POST", { STAGEFLOW_READ_TOKEN: READ }),
    ).toBeUndefined();
    expect(
      clientAuthorizationHeaders("DELETE", { STAGEFLOW_CONTROL_TOKEN: DRIVE }),
    ).toEqual({ Authorization: `Bearer ${DRIVE}` });
    expect(clientAuthorizationHeaders("GET", {})).toEqual({});
  });

  it("reads the control-token file when STAGEFLOW_CONTROL_TOKEN is unset", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sf-cli-token-"));
    await writeFile(path.join(dir, CONTROL_TOKEN_FILENAME), `${DRIVE}\n`, {
      mode: 0o600,
    });
    const env = { STAGEFLOW_HOME: dir, STAGEFLOW_READ_TOKEN: READ };
    expect(resolveClientBearerToken("POST", env)).toBe(DRIVE);
    expect(resolveClientBearerToken("GET", env)).toBe(DRIVE);
    expect(clientAuthorizationHeaders("DELETE", env)).toEqual({
      Authorization: `Bearer ${DRIVE}`,
    });
    expect(
      resolveClientBearerToken("POST", {
        STAGEFLOW_HOME: dir,
        STAGEFLOW_CONTROL_TOKEN: OTHER,
      }),
    ).toBe(OTHER);
    expect(resolveClientBearerToken("POST", {})).toBeUndefined();
  });

  it("does not resolve the installed file from a stage worker", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sf-stage-token-"));
    await writeFile(path.join(dir, CONTROL_TOKEN_FILENAME), `${DRIVE}\n`, {
      mode: 0o600,
    });
    const env = { STAGEFLOW_HOME: dir };
    expect(resolveClientBearerToken("POST", env)).toBe(DRIVE);
    expect(
      resolveClientBearerToken("POST", { ...env, [SF_STAGE_WORKER]: "1" }),
    ).toBeUndefined();
  });
});

describe("assertBindAllowed", () => {
  it("refuses non-loopback without drive", () => {
    const tokens = loadControlTokens({});
    expect(() => assertBindAllowed("0.0.0.0", tokens, {})).toThrow(BindRefusedError);
    expect(refuseBindMessage("0.0.0.0")).toContain("bind 0.0.0.0");
  });

  it("allows non-loopback without a token only when the local opt-in is exactly 1", () => {
    const tokens = loadControlTokens({});
    expect(() =>
      assertBindAllowed("0.0.0.0", tokens, {
        STAGEFLOW_ALLOW_UNAUTHENTICATED_BIND: "1",
      }),
    ).not.toThrow();
    expect(() =>
      assertBindAllowed("0.0.0.0", tokens, {
        STAGEFLOW_ALLOW_UNAUTHENTICATED_BIND: "true",
      }),
    ).toThrow(BindRefusedError);
  });

  it("allows loopback without token including 127.0.0.2", () => {
    const tokens = loadControlTokens({});
    expect(() => assertBindAllowed("127.0.0.1", tokens)).not.toThrow();
    expect(() => assertBindAllowed("127.0.0.2", tokens)).not.toThrow();
  });

  it("allows non-loopback with drive token", () => {
    const tokens = loadControlTokens({ STAGEFLOW_CONTROL_TOKEN: DRIVE });
    expect(() => assertBindAllowed("0.0.0.0", tokens)).not.toThrow();
  });
});

describe("auth hint", () => {
  it("returns the token path to loopback and null otherwise, never the token", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "sf-auth-hint-"));
    const env: NodeJS.ProcessEnv = { STAGEFLOW_HOME: home };
    const token = "a".repeat(64);
    await writeFile(path.join(home, CONTROL_TOKEN_FILENAME), token, { mode: 0o600 });
    const loop = authHintBody("127.0.0.1", env);
    expect(loop).toEqual({ tokenFile: path.join(home, CONTROL_TOKEN_FILENAME) });
    expect(JSON.stringify(loop)).not.toContain(token);
    expect(authHintBody("::ffff:127.0.0.1", env).tokenFile).toBe(loop.tokenFile);
    expect(authHintBody("10.1.2.3", env)).toEqual({ tokenFile: null });
    expect(authHintBody(undefined, env)).toEqual({ tokenFile: null });

    const store = createRunStore({ rootDir: home });
    const started = await startMcpServer({
      agent: scriptedFakeAgent([]),
      cwd: home,
      rootDir: home,
      store,
      port: 0,
      mcpStateless: true,
    });
    const prev = process.env.STAGEFLOW_HOME;
    process.env.STAGEFLOW_HOME = home;
    try {
      const res = await fetch(`${started.url}/api/auth-hint`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ tokenFile: path.join(home, CONTROL_TOKEN_FILENAME) });
      expect(JSON.stringify(body)).not.toContain(token);
    } finally {
      if (prev === undefined) delete process.env.STAGEFLOW_HOME;
      else process.env.STAGEFLOW_HOME = prev;
      await new Promise<void>((resolve, reject) => {
        started.server.close((err) => (err ? reject(err) : resolve()));
      });
      await store.close();
    }
  });
});

describe("requiredScopeFor", () => {
  it("maps mcp drive and api scopes including gated health", () => {
    expect(requiredScopeFor("GET", "/api/health")).toBe("read");
    expect(requiredScopeFor("GET", "/api/runs")).toBe("read");
    expect(requiredScopeFor("POST", "/api/runs")).toBe("drive");
    expect(requiredScopeFor("POST", "/api/projects")).toBe("drive");
    expect(requiredScopeFor("DELETE", "/api/runs/abc")).toBe("drive");
    expect(requiredScopeFor("POST", "/mcp")).toBe("drive");
  });

  it("reads A2A management with read and changes it with drive", () => {
    expect(requiredScopeFor("GET", "/api/a2a/status")).toBe("read");
    expect(requiredScopeFor("GET", "/api/a2a/callers")).toBe("read");
    expect(requiredScopeFor("GET", "/api/a2a/publications/x")).toBe("read");
    for (const [method, route] of [
      ["POST", "/api/a2a/enable"], ["POST", "/api/a2a/reload"], ["POST", "/api/a2a/callers"],
      ["DELETE", "/api/a2a/callers/x"], ["POST", "/api/a2a/publications"], ["PATCH", "/api/a2a/publications/x"],
      ["DELETE", "/api/a2a/publications/x"], ["POST", "/api/a2a/publications/preview"],
    ] as const) {
      expect(requiredScopeFor(method, route)).toBe("drive");
    }
  });

  it("requires drive for backup GET and POST (credential-bearing archives)", () => {
    expect(requiredScopeFor("GET", "/api/backup")).toBe("drive");
    expect(requiredScopeFor("GET", "/api/backup/stageflow.tar.gz")).toBe(
      "drive",
    );
    expect(requiredScopeFor("POST", "/api/backup")).toBe("drive");
    expect(requiredScopeFor("GET", "/api/export")).toBe("read");
  });
});

describe("control token reuse edges", () => {
  it("reuses a token file on win32 without a uid", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sf-win-token-"));
    const file = path.join(dir, CONTROL_TOKEN_FILENAME);
    const token = "b".repeat(64);
    await writeFile(file, token, "utf8");
    await chmod(file, 0o644);
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    const getuid = Object.getOwnPropertyDescriptor(process, "getuid");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    Object.defineProperty(process, "getuid", { value: undefined, configurable: true });
    try {
      const ensured = ensureHostControlToken({ STAGEFLOW_HOME: dir });
      expect(ensured.generated).toBe(false);
      expect(ensured.token).toBe(token);
    } finally {
      if (platform) Object.defineProperty(process, "platform", platform);
      if (getuid) Object.defineProperty(process, "getuid", getuid);
    }
  });

  it("says when a 0644 token file is replaced", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sf-open-token-"));
    const file = path.join(dir, CONTROL_TOKEN_FILENAME);
    const token = "c".repeat(64);
    await writeFile(file, token, "utf8");
    await chmod(file, 0o644);
    const lines: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    try {
      const ensured = ensureHostControlToken({ STAGEFLOW_HOME: dir });
      expect(ensured.generated).toBe(true);
      expect(ensured.token).not.toBe(token);
      expect(lines.join("\n")).toContain(
        `Ignoring ${file}: its mode is 0644, not 0600. A new token was created.`,
      );
      expect(lines.join("\n")).not.toContain(token);
    } finally {
      spy.mockRestore();
    }
  });

  it("names invalid content as the reason a 0600 token file is ignored", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sf-bad-token-"));
    const file = path.join(dir, CONTROL_TOKEN_FILENAME);
    await writeFile(file, "short", "utf8");
    await chmod(file, 0o600);
    const lines: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    try {
      expect(ensureHostControlToken({ STAGEFLOW_HOME: dir }).generated).toBe(true);
      expect(lines.join("\n")).toContain(`Ignoring ${file}: it does not hold a valid token`);
    } finally {
      spy.mockRestore();
    }
  });

  it("shows the operator's token file, or no file for a plain env token, in the auth hint", () => {
    expect(
      authHintBody("127.0.0.1", { STAGEFLOW_CONTROL_TOKEN_FILE: "/run/secrets/sf", STAGEFLOW_HOME: "/data" }),
    ).toEqual({ tokenFile: "/run/secrets/sf" });
    expect(authHintBody("127.0.0.1", { STAGEFLOW_CONTROL_TOKEN: DRIVE, STAGEFLOW_HOME: "/data" })).toEqual({
      tokenFile: null,
      source: "env",
    });
    expect(authHintBody("127.0.0.1", { STAGEFLOW_HOME: "/data" })).toEqual({
      tokenFile: path.join("/data", CONTROL_TOKEN_FILENAME),
    });
    expect(authHintBody("10.0.0.5", { STAGEFLOW_CONTROL_TOKEN_FILE: "/run/secrets/sf" })).toEqual({
      tokenFile: null,
    });
  });

  it("tightens an existing home directory to 0700", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "sf-home-mode-"));
    await chmod(home, 0o755);
    const prev = process.env.STAGEFLOW_HOME;
    process.env.STAGEFLOW_HOME = home;
    resetGlobalStageflowHomeForTests();
    try {
      ensureGlobalHome();
      expect((await stat(home)).mode & 0o777).toBe(0o700);
    } finally {
      if (prev === undefined) delete process.env.STAGEFLOW_HOME;
      else process.env.STAGEFLOW_HOME = prev;
      resetGlobalStageflowHomeForTests();
    }
  });
});
