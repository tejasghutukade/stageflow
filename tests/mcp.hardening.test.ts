import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  hostMcpCatalogPath,
  McpHostStateError,
  mcpSecretsPath,
  readHostMcpServers,
  readMcpSecrets,
  saveHostMcpServer,
  setMcpSecret,
} from "../src/config/mcpHostCatalog.js";
import { ensureOAuthFileKey, oauthKeyPath, OAUTH_FILE_KEY_ENV } from "../src/config/mcpOAuth.js";
import {
  collectSecretValues,
  maskEntry,
  oauthDefinition,
  scrubText,
} from "../src/config/mcpRedaction.js";
import {
  loadMcpCatalog,
  resolveStageMcpServers,
} from "../src/config/resolveStageMcpServers.js";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";
import { isForeverDeniedSecret } from "../src/runtime/stageEnvironment.js";

let home: string;
let root: string;
let prevHome: string | undefined;

beforeEach(async () => {
  prevHome = process.env.STAGEFLOW_HOME;
  home = await mkdtemp(path.join(tmpdir(), "sf-mcp-hard-home-"));
  root = await mkdtemp(path.join(tmpdir(), "sf-mcp-hard-root-"));
  process.env.STAGEFLOW_HOME = home;
  resetGlobalStageflowHomeForTests();
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.STAGEFLOW_HOME;
  else process.env.STAGEFLOW_HOME = prevHome;
  resetGlobalStageflowHomeForTests();
});

const KEY_FILE_ENTRY = { url: "https://api.test/mcp", headers: { "X-Key": "${API_KEY}", "X-Other": "${OTHER}" } };

describe("resolve scopes", () => {
  it("a stage only sees console secrets it declared", async () => {
    saveHostMcpServer("api", KEY_FILE_ENTRY, home);
    setMcpSecret("API_KEY", "key-value-1", home);
    setMcpSecret("OTHER", "other-value-2", home);
    await expect(
      resolveStageMcpServers({
        projectRoot: root,
        allowlist: ["api"],
        env: {},
        scope: { kind: "stage", secrets: ["API_KEY"] },
      }),
    ).rejects.toMatchObject({ code: "unresolved_var" });
    const ok = await resolveStageMcpServers({
      projectRoot: root,
      allowlist: ["api"],
      env: {},
      scope: { kind: "stage", secrets: ["API_KEY", "OTHER"] },
    });
    expect((ok.api?.headers as Record<string, string>)["X-Key"]).toBe("key-value-1");
  });

  it("Host env is not used by agent/probe unless allow-listed, and both resolve identically", async () => {
    saveHostMcpServer("api", { url: "https://api.test/mcp", headers: { "X-Key": "${HOSTONLY}" } }, home);
    const hostEnv = { HOSTONLY: "from-host" };
    for (const kind of ["agent", "probe"] as const) {
      await expect(
        resolveStageMcpServers({ projectRoot: root, allowlist: ["api"], env: { HOSTONLY: "x" }, hostEnv, scope: { kind } }),
      ).rejects.toMatchObject({ code: "unresolved_var" });
    }
    const withAllow = { ...hostEnv, STAGEFLOW_MCP_ENV_ALLOW: "HOSTONLY" };
    const [agent, probe] = await Promise.all(
      (["agent", "probe"] as const).map((kind) =>
        resolveStageMcpServers({ projectRoot: root, allowlist: ["api"], env: {}, hostEnv: withAllow, scope: { kind } }),
      ),
    );
    expect(agent).toEqual(probe);
    expect((agent!.api?.headers as Record<string, string>)["X-Key"]).toBe("from-host");
  });

  it("validate scope checks placeholders without putting secret values in the output", async () => {
    saveHostMcpServer("api", KEY_FILE_ENTRY, home);
    setMcpSecret("API_KEY", "key-value-1", home);
    setMcpSecret("OTHER", "other-value-2", home);
    const out = await resolveStageMcpServers({ projectRoot: root, allowlist: ["api"], env: {}, scope: { kind: "validate" } });
    expect(JSON.stringify(out)).not.toContain("key-value-1");
    expect(JSON.stringify(out)).not.toContain("other-value-2");
  });

  it("project .mcp.json entries get shape and URL policy at resolve time", async () => {
    await writeFile(
      path.join(root, ".mcp.json"),
      JSON.stringify({ mcpServers: { meta: { url: "http://169.254.169.254/x" }, odd: { command: "x", args: [1] } } }),
    );
    await expect(
      resolveStageMcpServers({ projectRoot: root, allowlist: ["meta"], env: {} }),
    ).rejects.toMatchObject({ code: "invalid_config" });
    await expect(
      resolveStageMcpServers({ projectRoot: root, allowlist: ["odd"], env: {} }),
    ).rejects.toMatchObject({ code: "invalid_config" });
  });

  it("a url built from a placeholder is still blocked once resolved", async () => {
    saveHostMcpServer("p", { url: "${TARGET}" }, home);
    setMcpSecret("TARGET", "http://169.254.169.254/", home);
    await expect(
      resolveStageMcpServers({ projectRoot: root, allowlist: ["p"], env: {}, scope: { kind: "agent" } }),
    ).rejects.toMatchObject({ code: "invalid_config" });
  });
});

describe("validation", () => {
  it("rejects placeholders for denied and provider/cloud names unless allow-listed", () => {
    expect(() => saveHostMcpServer("x", { command: "a", env: { T: "${STAGEFLOW_CONTROL_TOKEN}" } }, home)).toThrow(/never/);
    expect(() => saveHostMcpServer("x", { command: "a", env: { T: "${PI_MCP_ADAPTER_OAUTH_FILE_KEY}" } }, home)).toThrow(/never/);
    expect(() => saveHostMcpServer("x", { command: "a", env: { T: "${AWS_SECRET_ACCESS_KEY}" } }, home)).toThrow(/provider or cloud/);
    process.env.STAGEFLOW_MCP_ENV_ALLOW = "AWS_SECRET_ACCESS_KEY";
    try {
      expect(() => saveHostMcpServer("x", { command: "a", env: { T: "${AWS_SECRET_ACCESS_KEY}" } }, home)).not.toThrow();
    } finally {
      delete process.env.STAGEFLOW_MCP_ENV_ALLOW;
    }
  });

  it("denies the OAuth file key as a secret name", () => {
    expect(isForeverDeniedSecret("PI_MCP_ADAPTER_OAUTH_FILE_KEY")).toBe(true);
    expect(() => setMcpSecret("PI_MCP_ADAPTER_OAUTH_FILE_KEY", "v", home)).toThrow(/usable/);
  });

  it("blocks link-local and metadata URLs but allows loopback and LAN", () => {
    for (const url of ["http://169.254.169.254/", "http://169.254.1.1:80/", "https://metadata.google.internal/", "http://[fd00:ec2::254]/", "http://[fe80::1]/"]) {
      expect(() => saveHostMcpServer("u", { url }, home), url).toThrow(/link-local|metadata/);
    }
    for (const url of ["http://localhost:3000/", "http://127.0.0.1/", "http://10.0.0.5/", "http://192.168.0.2/"]) {
      expect(() => saveHostMcpServer("u", { url }, home), url).not.toThrow();
    }
  });
});

describe("redaction", () => {
  it("moves query, userinfo and arg tokens to the secrets store", async () => {
    const res = saveHostMcpServer(
      "svc",
      {
        url: "https://user:hunter2hunter2@svc.test/mcp?token=qtoken123456&x=1",
      },
      home,
    );
    expect(res.secretsStored.length).toBe(2);
    const file = await readFile(hostMcpCatalogPath(home), "utf8");
    expect(file).not.toContain("hunter2");
    expect(file).not.toContain("qtoken123456");
    expect(file).toContain("x=1");
    saveHostMcpServer("cli", { command: "npx", args: ["srv", "--api-key=abcdef123456", "--password", "pw-value-99"] }, home);
    const cli = readHostMcpServers(home).cli!;
    expect(JSON.stringify(cli)).not.toContain("abcdef123456");
    expect(JSON.stringify(cli)).not.toContain("pw-value-99");
    expect(Object.values(readMcpSecrets(home))).toEqual(expect.arrayContaining(["abcdef123456", "pw-value-99", "qtoken123456", "hunter2hunter2"]));
  });

  it("masks literals on read-back and keeps placeholders", () => {
    const masked = maskEntry({
      url: "https://u:pw123456@h.test/p?api_key=rawrawraw1&ok=1&t=${T}",
      args: ["--token=rawtoken123"],
      headers: { Authorization: "Bearer rawbearer123", Accept: "json" },
    });
    expect(JSON.stringify(masked)).not.toMatch(/pw123456|rawrawraw1|rawtoken123|rawbearer123/);
    expect((masked.headers as Record<string, string>).Authorization).toBe("Bearer ••••");
    expect(String(masked.url)).toContain("${T}");
  });

  it("scrubs urls, args and headers from error text and ignores short values", () => {
    const resolved = {
      url: "https://svc.test/mcp?token=qtoken123456",
      args: ["--secret=argsecret99"],
      env: { SHORT: "ab", LONG: "envvalue-123" },
    };
    const values = collectSecretValues(resolved);
    const out = scrubText("fail qtoken123456 argsecret99 envvalue-123 ab ab ab", values);
    expect(out).toBe("fail [redacted] [redacted] [redacted] ab ab ab");
  });

  it("oauthDefinition drops env/command and secret headers", () => {
    const def = oauthDefinition({
      url: "https://x.test",
      headers: { Authorization: "Bearer abcdefghij", "X-Region": "eu" },
      env: { A: "b" },
      command: "x",
    });
    expect(def).toEqual({ url: "https://x.test", headers: { "X-Region": "eu" } });
  });
});

describe("host state files", () => {
  it("a corrupt catalog or secrets file throws and is never overwritten", async () => {
    await mkdir(path.dirname(hostMcpCatalogPath(home)), { recursive: true });
    await writeFile(hostMcpCatalogPath(home), "{ nope");
    expect(() => readHostMcpServers(home)).toThrow(McpHostStateError);
    expect(() => saveHostMcpServer("a", { command: "x" }, home)).toThrow(McpHostStateError);
    expect(await readFile(hostMcpCatalogPath(home), "utf8")).toBe("{ nope");
    await expect(loadMcpCatalog(root, { scope: { kind: "agent" } })).rejects.toMatchObject({ code: "host_state_corrupt" });

    await writeFile(hostMcpCatalogPath(home), JSON.stringify({ mcpServers: {} }));
    await mkdir(path.dirname(mcpSecretsPath(home)), { recursive: true });
    await writeFile(mcpSecretsPath(home), "[1,2]");
    expect(() => readMcpSecrets(home)).toThrow(McpHostStateError);
    expect(() => setMcpSecret("A", "v", home)).toThrow(McpHostStateError);
    expect(await readFile(mcpSecretsPath(home), "utf8")).toBe("[1,2]");
  });

  it("writes the secrets dir 0700 and files 0600, and rolls secrets back if the catalog write fails", async () => {
    saveHostMcpServer("ok", { command: "x", env: { MY_TOKEN: "tok-aaaaaaaaaaaa" } }, home);
    expect((await stat(path.dirname(mcpSecretsPath(home)))).mode & 0o777).toBe(0o700);
    expect((await stat(mcpSecretsPath(home))).mode & 0o777).toBe(0o600);
    expect((await stat(hostMcpCatalogPath(home))).mode & 0o777).toBe(0o600);
    const before = await readFile(mcpSecretsPath(home), "utf8");
    // make the catalog write fail: its path becomes a directory
    const { rmSync, mkdirSync } = await import("node:fs");
    rmSync(hostMcpCatalogPath(home));
    mkdirSync(hostMcpCatalogPath(home));
    expect(() => saveHostMcpServer("bad", { command: "x", env: { NEW_TOKEN: "tok-bbbbbbbbbbbb" } }, home)).toThrow();
    expect(await readFile(mcpSecretsPath(home), "utf8")).toBe(before);
  });

  it("ensureOAuthFileKey never replaces or reads an empty key file", async () => {
    const prev = process.env[OAUTH_FILE_KEY_ENV];
    delete process.env[OAUTH_FILE_KEY_ENV];
    try {
      await mkdir(path.dirname(oauthKeyPath(home)), { recursive: true });
      await writeFile(oauthKeyPath(home), "");
      expect(() => ensureOAuthFileKey(home)).toThrow(/empty/);
      expect(await readFile(oauthKeyPath(home), "utf8")).toBe("");
    } finally {
      if (prev !== undefined) process.env[OAUTH_FILE_KEY_ENV] = prev;
    }
  });
});
