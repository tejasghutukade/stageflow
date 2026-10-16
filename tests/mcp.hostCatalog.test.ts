import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  hostMcpCatalogPath,
  listMcpSecretNames,
  mcpSecretsPath,
  parsePastedMcpJson,
  readMcpSecrets,
  removeHostMcpServer,
  saveHostMcpServer,
  setMcpSecret,
} from "../src/config/mcpHostCatalog.js";
import {
  listProjectMcpCatalog,
  loadMcpCatalog,
  mcpCatalogExists,
  resolveStageMcpServers,
} from "../src/config/resolveStageMcpServers.js";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";

let home: string;
let root: string;
let prevHome: string | undefined;

beforeEach(async () => {
  prevHome = process.env.STAGEFLOW_HOME;
  home = await mkdtemp(path.join(tmpdir(), "sf-mcp-home-"));
  root = await mkdtemp(path.join(tmpdir(), "sf-mcp-root-"));
  process.env.STAGEFLOW_HOME = home;
  resetGlobalStageflowHomeForTests();
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.STAGEFLOW_HOME;
  else process.env.STAGEFLOW_HOME = prevHome;
  resetGlobalStageflowHomeForTests();
});

describe("host MCP catalog", () => {
  it("works with no project .mcp.json and keeps the file private", async () => {
    expect(await listProjectMcpCatalog(root)).toEqual({ status: "missing_catalog", servers: [] });
    saveHostMcpServer("fs", { command: "npx", args: ["-y", "server-fs"] }, home);
    expect(await mcpCatalogExists(root, { host: true })).toBe(true);
    expect(await mcpCatalogExists(root)).toBe(false);
    const list = await listProjectMcpCatalog(root);
    expect(list.status).toBe("ok");
    expect(list.servers).toEqual([{ name: "fs", transport: "stdio", origin: "console" }]);
    expect((await stat(hostMcpCatalogPath(home))).mode & 0o777).toBe(0o600);
  });

  it("merges over the project file and the console entry wins", async () => {
    await writeFile(
      path.join(root, ".mcp.json"),
      JSON.stringify({ mcpServers: { a: { command: "one" }, b: { url: "https://b.test" } } }),
    );
    saveHostMcpServer("b", { command: "override" }, home);
    const cat = await loadMcpCatalog(root, { host: true });
    expect(cat.origins).toEqual({ a: "project", b: "console" });
    expect(cat.servers.b).toEqual({ command: "override" });
    const projectOnly = await loadMcpCatalog(root);
    expect(Object.keys(projectOnly.servers)).toEqual(["a", "b"]);
  });

  it("moves literal tokens into the secrets store and leaves placeholders", async () => {
    const res = saveHostMcpServer(
      "gh",
      {
        command: "npx",
        env: { GITHUB_TOKEN: "ghp_abcdefghijklmnopqrstuvwxyz0123456789", LOG_LEVEL: "debug" },
      },
      home,
    );
    expect(res.secretsStored).toEqual(["GITHUB_TOKEN"]);
    const file = await readFile(hostMcpCatalogPath(home), "utf8");
    expect(file).not.toContain("ghp_");
    expect(file).toContain("${GITHUB_TOKEN}");
    expect(file).toContain("debug");
    expect(readMcpSecrets(home).GITHUB_TOKEN).toBe("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect((await stat(mcpSecretsPath(home))).mode & 0o777).toBe(0o600);
  });

  it("keeps the Bearer prefix and names the secret after the server", () => {
    saveHostMcpServer("one", { url: "https://x.test", headers: { Authorization: "Bearer aaaa1111" } }, home);
    saveHostMcpServer("two", { url: "https://y.test", headers: { Authorization: "Bearer bbbb2222" } }, home);
    const secrets = readMcpSecrets(home);
    expect(secrets.ONE_TOKEN).toBe("aaaa1111");
    expect(secrets.TWO_TOKEN).toBe("bbbb2222");
    expect(JSON.stringify(JSON.parse(JSON.stringify(secrets)))).not.toContain("Bearer");
  });

  it("rejects bad configs", () => {
    expect(() => saveHostMcpServer("stageflow", { command: "x" }, home)).toThrow(/reserved/);
    expect(() => saveHostMcpServer("bad name", { command: "x" }, home)).toThrow(/Server name/);
    expect(() => saveHostMcpServer("x", { command: "a", url: "https://a" }, home)).toThrow(/exactly one/);
    expect(() => saveHostMcpServer("x", {}, home)).toThrow(/exactly one/);
    expect(() => saveHostMcpServer("x", { url: "ftp://a" }, home)).toThrow(/http/);
    expect(() => saveHostMcpServer("x", { command: "a", headers: { A: "b" } }, home)).toThrow(/headers/);
    expect(() => setMcpSecret("STAGEFLOW_CONTROL_TOKEN", "v", home)).toThrow(/usable/);
    expect(() => setMcpSecret("1bad", "v", home)).toThrow(/usable/);
  });

  it("parses the shapes people paste", () => {
    expect(Object.keys(parsePastedMcpJson({ mcpServers: { a: { command: "x" } } }))).toEqual(["a"]);
    expect(Object.keys(parsePastedMcpJson({ a: { command: "x" } }))).toEqual(["a"]);
    expect(() => parsePastedMcpJson({ command: "x" })).toThrow(/Wrap/);
    expect(() => parsePastedMcpJson({ mcpServers: {} })).toThrow(/No servers/);
    expect(() => parsePastedMcpJson([])).toThrow(/object/);
  });

  it("reports vars and fills them from stored secrets, env still wins", async () => {
    saveHostMcpServer("api", { url: "https://api.test", headers: { "X-Key": "${API_KEY}" } }, home);
    await expect(
      resolveStageMcpServers({ projectRoot: root, allowlist: ["api"], env: {}, host: true }),
    ).rejects.toMatchObject({ code: "unresolved_var" });
    setMcpSecret("API_KEY", "stored", home);
    const filled = await resolveStageMcpServers({ projectRoot: root, allowlist: ["api"], env: {}, host: true });
    expect((filled.api?.headers as Record<string, string>)["X-Key"]).toBe("stored");
    const overridden = await resolveStageMcpServers({
      projectRoot: root,
      allowlist: ["api"],
      env: { API_KEY: "from-env" },
      host: true,
    });
    expect((overridden.api?.headers as Record<string, string>)["X-Key"]).toBe("from-env");
    // workspace-sourced catalogs never see console servers or secrets
    await expect(
      resolveStageMcpServers({ projectRoot: root, allowlist: ["api"], env: {}, host: true, workspaceSourced: true, bindingKind: "checkout" }),
    ).rejects.toMatchObject({ code: "missing_catalog" });
  });

  it("removes servers and lists secret names only", () => {
    saveHostMcpServer("a", { command: "x" }, home);
    expect(removeHostMcpServer("a", home)).toBe(true);
    expect(removeHostMcpServer("a", home)).toBe(false);
    setMcpSecret("B", "v", home);
    setMcpSecret("A", "v", home);
    expect(listMcpSecretNames(home)).toEqual(["A", "B"]);
  });
});

describe("snippets from other tools", () => {
  it("maps serverUrl/httpUrl and type onto our shape", () => {
    saveHostMcpServer("a", { serverUrl: "https://a.test/mcp", type: "sse" }, home);
    saveHostMcpServer("b", { httpUrl: "https://b.test/mcp", type: "http" }, home);
    saveHostMcpServer("c", { command: "npx", type: "stdio" }, home);
    const file = JSON.parse(readFileSync(hostMcpCatalogPath(home), "utf8")).mcpServers;
    expect(file.a).toEqual({ url: "https://a.test/mcp", httpTransport: "sse" });
    expect(file.b).toEqual({ url: "https://b.test/mcp" });
    expect(file.c).toEqual({ command: "npx" });
  });

  it("rejects unknown types and a misplaced httpTransport", () => {
    expect(() => saveHostMcpServer("x", { url: "https://x", type: "websocket" }, home)).toThrow(/Unsupported/);
    expect(() => saveHostMcpServer("x", { command: "a", httpTransport: "sse" }, home)).toThrow(/url servers/);
    expect(() => saveHostMcpServer("x", { url: "https://x", httpTransport: "ws" }, home)).toThrow(/httpTransport/);
  });
});
