import { describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { buildStageEnvironment } from "../src/runtime/stageEnvironment.js";
import { startMcpServer } from "../src/server/mcpHost.js";
import {
  assertBindAllowed,
  authenticateBearer,
  BindRefusedError,
  clientAuthorizationHeaders,
  CONTROL_TOKEN_FILENAME,
  enforceBearerAuth,
  ensureHostControlToken,
  generatedControlTokenLines,
  hasDriveToken,
  loadControlTokens,
  refuseBindMessage,
  requiredScopeFor,
  resolveClientBearerToken,
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
    const dir = await mkdtemp(path.join(tmpdir(), "sf-gen-token-"));
    const env: NodeJS.ProcessEnv = { STAGEFLOW_HOME: dir, PATH: "/usr/bin" };
    const ensured = ensureHostControlToken(env);
    expect(ensured.generated).toBe(true);
    expect(ensured.token).toMatch(/^[0-9a-f]{64}$/);
    expect(ensured.filePath).toBe(path.join(dir, CONTROL_TOKEN_FILENAME));
    expect(env.STAGEFLOW_CONTROL_TOKEN_FILE).toBe(ensured.filePath);
    expect(generatedControlTokenLines(ensured)).toEqual([
      `Control token: ${ensured.token}`,
      `Control token file: ${ensured.filePath}`,
    ]);
    const info = await stat(ensured.filePath!);
    expect(info.mode & 0o777).toBe(0o600);

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
