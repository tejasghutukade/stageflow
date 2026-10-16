import { describe, expect, it } from "vitest";
import {
  configToForm,
  emptyMcpForm,
  formToConfig,
  joinCommandLine,
  parsePastedMcp,
  secretsSummary,
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
