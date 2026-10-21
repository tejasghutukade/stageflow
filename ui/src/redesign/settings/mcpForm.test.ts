import { describe, expect, it } from "vitest";
import {
  canSignIn,
  configToForm,
  deleteNotice,
  emptyMcpForm,
  formToConfig,
  importOutcome,
  isSignedIn,
  joinCommandLine,
  looksSecretKey,
  normalizeHeaderRow,
  parsePastedMcp,
  saveNotice,
  secretRowDetail,
  secretRows,
  secretsSummary,
  shouldMaskKey,
  shouldMaskValue,
  splitCommandLine,
} from "./mcpForm";

describe("command line", () => {
  it("splits like a shell for quotes", () => {
    expect(splitCommandLine("npx -y @scope/server")).toEqual(["npx", "-y", "@scope/server"]);
    expect(splitCommandLine(`node "my dir/s.js" --flag='a b' ""`)).toEqual(["node", "my dir/s.js", "--flag=a b", ""]);
    expect(splitCommandLine("  ")).toEqual([]);
  });
  it("round-trips through join", () => {
    const args = ["-y", "a b", 'q"x', ""];
    expect(splitCommandLine(joinCommandLine("npx", args))).toEqual(["npx", ...args]);
  });
});

describe("mcp form", () => {
  it("builds a stdio config from one command line", () => {
    expect(
      formToConfig({
        ...emptyMcpForm(),
        name: " gh ",
        commandLine: " npx -y @scope/server ",
        env: [{ key: "GITHUB_TOKEN", value: "${GITHUB_TOKEN}" }, { key: " ", value: "x" }],
      }),
    ).toEqual({
      ok: true,
      name: "gh",
      config: { command: "npx", args: ["-y", "@scope/server"], env: { GITHUB_TOKEN: "${GITHUB_TOKEN}" } },
    });
    expect(formToConfig({ ...emptyMcpForm(), name: "ok" }).ok).toBe(false);
    expect(formToConfig({ ...emptyMcpForm(), name: "bad name", commandLine: "x" }).ok).toBe(false);
  });

  const remote = { ...emptyMcpForm(), name: "d", transport: "http" as const, url: "https://d.test/mcp" };

  it("builds remote configs for each auth mode", () => {
    expect(formToConfig(remote)).toEqual({ ok: true, name: "d", config: { url: "https://d.test/mcp" } });
    expect(formToConfig({ ...remote, httpTransport: "sse" })).toMatchObject({ config: { httpTransport: "sse" } });
    expect(formToConfig({ ...remote, authMode: "bearer", bearerToken: " Bearer abc123 " })).toMatchObject({
      config: { headers: { Authorization: "Bearer abc123" } },
    });
    expect(formToConfig({ ...remote, authMode: "bearer", bearerRef: "D_AUTH" })).toMatchObject({
      config: { headers: { Authorization: "Bearer ${D_AUTH}" } },
    });
    expect(formToConfig({ ...remote, authMode: "bearer" }).ok).toBe(false);
    expect(
      formToConfig({ ...remote, authMode: "headers", headers: [{ key: "X-Key", value: "${K}" }, { key: "", value: "" }] }),
    ).toMatchObject({ config: { headers: { "X-Key": "${K}" } } });
    // headers typed then switched back to none are not sent
    expect(formToConfig({ ...remote, authMode: "none", headers: [{ key: "X", value: "y" }] })).toEqual({
      ok: true,
      name: "d",
      config: { url: "https://d.test/mcp" },
    });
    expect(formToConfig({ ...remote, url: "ftp://x" }).ok).toBe(false);
  });

  it("round-trips config to form", () => {
    expect(configToForm("gh", { command: "npx", args: ["a", "b c"], env: { K: "v" } })).toMatchObject({
      transport: "stdio",
      commandLine: 'npx a "b c"',
      env: [{ key: "K", value: "v" }],
    });
    expect(configToForm("d", { url: "https://x", httpTransport: "sse" })).toMatchObject({
      transport: "http",
      httpTransport: "sse",
      authMode: "none",
    });
    expect(configToForm("d", { url: "https://x", headers: { authorization: "Bearer ${D_TOKEN}" } })).toMatchObject({
      authMode: "bearer",
      bearerRef: "D_TOKEN",
    });
    expect(configToForm("d", { url: "https://x", headers: { Authorization: "Bearer ${A}", "X-Y": "z" } }).authMode).toBe(
      "headers",
    );
  });

  it("parses pasted JSON", () => {
    expect(parsePastedMcp('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(parsePastedMcp("[]").ok).toBe(false);
    expect(parsePastedMcp("nope").ok).toBe(false);
    expect(parsePastedMcp("  ").ok).toBe(false);
  });

  it("summarises moved secrets", () => {
    expect(secretsSummary([])).toBeNull();
    expect(secretsSummary(["A", "A"])).toContain("a token");
    expect(secretsSummary(["A", "B"])).toContain("2 tokens");
  });
});

describe("sign-in decisions", () => {
  it("offers sign in to remote servers that need it and are not signed in", () => {
    expect(isSignedIn("authenticated")).toBe(true);
    expect(isSignedIn("expired")).toBe(false);
    expect(canSignIn({ transport: "http", status: "needs_auth" }, undefined)).toBe(true);
    expect(canSignIn({ transport: "http", status: "connected" }, "expired")).toBe(true);
    expect(canSignIn({ transport: "http", status: "needs_auth" }, "authenticated")).toBe(false);
    expect(canSignIn({ transport: "http", status: "connected" }, "not_authenticated")).toBe(false);
    expect(canSignIn({ transport: "stdio", status: "needs_auth" }, undefined)).toBe(false);
  });
});

describe("secret rows", () => {
  const list = {
    secrets: [
      { name: "STORED", usedBy: ["a"] },
      { name: "ORPHAN", usedBy: [] },
    ],
    needed: [
      { name: "STORED", usedBy: ["a"], set: true },
      { name: "HOST", usedBy: ["b", "c"], set: true },
      { name: "MISSING", usedBy: ["d"], set: false },
    ],
  };
  it("labels stored, set on the Host and missing; lists unreferenced stored values last", () => {
    const rows = secretRows(list);
    expect(rows.map((r) => [r.name, r.label, r.stored])).toEqual([
      ["STORED", "stored", true],
      ["HOST", "set on the Host", false],
      ["MISSING", "missing", false],
      ["ORPHAN", "stored", true],
    ]);
    expect(secretRowDetail(rows[1]!)).toBe("used by b, c · set on the Host");
    expect(secretRowDetail(rows[3]!)).toBe("not used by any server · stored");
  });
});

describe("notices", () => {
  it("builds save, import and delete notices", () => {
    expect(saveNotice({ secretsStored: [] })).toBeNull();
    expect(saveNotice({ secretsStored: ["T"] })).toContain("a token");
    expect(deleteNotice("gh")).toBe("Removed gh.");
    expect(importOutcome({ added: [], secretsStored: [], errors: [] })).toEqual({ ok: false, error: "Nothing was added." });
    expect(importOutcome({ added: [], secretsStored: [], errors: [{ name: "x", error: "bad" }] })).toEqual({
      ok: false,
      error: "x: bad",
    });
    expect(importOutcome({ added: ["a"], secretsStored: [], errors: [] })).toEqual({ ok: true, notice: null });
    const mixed = importOutcome({ added: ["a"], secretsStored: ["T"], errors: [{ name: "x", error: "bad" }] });
    expect(mixed.ok && mixed.notice).toMatch(/a token.*Skipped: x \(bad\)\./);
  });
});

describe("secret-looking values", () => {
  it("recognises credential keys", () => {
    for (const key of ["Authorization", "X-Api-Key", "GITHUB_TOKEN", "client_secret", "DB_PASSWORD"]) {
      expect(looksSecretKey(key)).toBe(true);
    }
    expect(looksSecretKey("Content-Type")).toBe(false);
  });
  it("masks literal values but not ${NAME} references", () => {
    expect(shouldMaskValue("Authorization", "Bearer abc123")).toBe(true);
    expect(shouldMaskValue("Authorization", "Bearer ${GH_TOKEN}")).toBe(false);
    expect(shouldMaskValue("GITHUB_TOKEN", "${GITHUB_TOKEN}")).toBe(false);
    expect(shouldMaskValue("X-Trace", "abc")).toBe(false);
    expect(shouldMaskValue("", "Authorization: Bearer abc")).toBe(true);
    expect(shouldMaskKey("Authorization: Bearer abc")).toBe(true);
    expect(shouldMaskKey("Authorization")).toBe(false);
  });
  it("splits a pasted Authorization line into a header and still saves it", () => {
    expect(normalizeHeaderRow({ key: "Authorization: Bearer abc", value: "" })).toEqual({
      key: "Authorization",
      value: "Bearer abc",
    });
    expect(normalizeHeaderRow({ key: "", value: "Authorization: Bearer abc" })).toEqual({
      key: "Authorization",
      value: "Bearer abc",
    });
    expect(normalizeHeaderRow({ key: "X-Id", value: "1" })).toEqual({ key: "X-Id", value: "1" });
    const built = formToConfig({
      ...emptyMcpForm(),
      name: "d",
      transport: "http",
      url: "https://d.test/mcp",
      authMode: "headers",
      headers: [{ key: "", value: "Authorization: Bearer abc" }],
    });
    expect(built).toEqual({
      ok: true,
      name: "d",
      config: { url: "https://d.test/mcp", headers: { Authorization: "Bearer abc" } },
    });
  });
  it("accepts a pasted Authorization line as the bearer token", () => {
    const built = formToConfig({
      ...emptyMcpForm(),
      name: "d",
      transport: "http",
      url: "https://d.test/mcp",
      authMode: "bearer",
      bearerToken: "Authorization: Bearer abc",
    });
    expect(built.ok && built.config.headers).toEqual({ Authorization: "Bearer abc" });
  });
});
