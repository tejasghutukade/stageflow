import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertBindAllowed,
  authenticateBearer,
  BindRefusedError,
  clientAuthorizationHeaders,
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
});

describe("assertBindAllowed", () => {
  it("refuses non-loopback without drive", () => {
    const tokens = loadControlTokens({});
    expect(() => assertBindAllowed("0.0.0.0", tokens)).toThrow(BindRefusedError);
    expect(refuseBindMessage("0.0.0.0")).toContain("bind 0.0.0.0");
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

  it("requires drive for backup GET and POST (credential-bearing archives)", () => {
    expect(requiredScopeFor("GET", "/api/backup")).toBe("drive");
    expect(requiredScopeFor("GET", "/api/backup/stageflow.tar.gz")).toBe(
      "drive",
    );
    expect(requiredScopeFor("POST", "/api/backup")).toBe("drive");
    expect(requiredScopeFor("GET", "/api/export")).toBe("read");
  });
});
