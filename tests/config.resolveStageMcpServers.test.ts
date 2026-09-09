import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { STAGEFLOW_MCP_SERVER_NAME } from "../src/agent/claudeTools.js";
import {
  StageMcpError,
  assertMcpAllowlistKnown,
  listProjectMcpCatalog,
  loadMcpCatalog,
  mcpCatalogPath,
  parseMcpCatalog,
  resolveStageMcpServers,
  type ResolvedMcpServerConfig,
  type ResolvedMcpServers,
} from "../src/config/resolveStageMcpServers.js";
import type { StageConfig } from "../src/types/stage.js";

const STAGE_MCP_ERROR_CODES = [
  "missing_catalog",
  "unknown_server",
  "reserved_name",
  "unresolved_var",
  "invalid_config",
  "connect_failed",
] as const;

describe("StageMcpError", () => {
  it.each(STAGE_MCP_ERROR_CODES)(
    "constructs with name StageMcpError and code %s",
    (code) => {
      const error = new StageMcpError(`stage mcp: ${code}`, code);
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(StageMcpError);
      expect(error.name).toBe("StageMcpError");
      expect(error.code).toBe(code);
      expect(error.message).toBe(`stage mcp: ${code}`);
    },
  );
});

describe("stage MCP snapshot types", () => {
  it("accepts StageConfig.mcp as a string list and keeps skill valid", () => {
    const stage: StageConfig = {
      id: "implement",
      system_prompt: "Implement the change",
      model: "anthropic/claude-sonnet-4-5",
      skill: "ship",
      mcp: ["github"],
    };
    expect(stage.mcp).toEqual(["github"]);
    expect(stage.skill).toBe("ship");
  });

  it("imports ResolvedMcpServerConfig and ResolvedMcpServers", () => {
    const github: ResolvedMcpServerConfig = {
      type: "http",
      url: "https://api.github.com/mcp",
    };
    const resolved: ResolvedMcpServers = { github };
    expect(resolved.github).toEqual(github);
    expect(Object.keys(resolved)).toEqual(["github"]);
  });
});

describe("MCP catalog reader", () => {
  it("joins projectRoot with .mcp.json", () => {
    expect(mcpCatalogPath("/tmp/project")).toBe(path.join("/tmp/project", ".mcp.json"));
  });

  it("throws missing_catalog when the file is absent", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-mcp-cat-missing-"));
    await expect(loadMcpCatalog(root)).rejects.toMatchObject({
      name: "StageMcpError",
      code: "missing_catalog",
    });
  });

  it("throws invalid_config for invalid JSON", () => {
    expect(() => parseMcpCatalog("{ not json", ".mcp.json")).toThrow(StageMcpError);
    try {
      parseMcpCatalog("{ not json", ".mcp.json");
    } catch (err) {
      expect(err).toBeInstanceOf(StageMcpError);
      expect((err as StageMcpError).code).toBe("invalid_config");
    }
  });

  it("throws invalid_config when mcpServers is an array", () => {
    expect(() =>
      parseMcpCatalog(JSON.stringify({ mcpServers: [] }), ".mcp.json"),
    ).toThrow(StageMcpError);
    try {
      parseMcpCatalog(JSON.stringify({ mcpServers: [] }), ".mcp.json");
    } catch (err) {
      expect((err as StageMcpError).code).toBe("invalid_config");
    }
  });

  it("throws invalid_config when mcpServers is missing or a server entry is not an object", () => {
    expect(() => parseMcpCatalog(JSON.stringify({}), ".mcp.json")).toThrow(StageMcpError);
    try {
      parseMcpCatalog(JSON.stringify({}), ".mcp.json");
    } catch (err) {
      expect((err as StageMcpError).code).toBe("invalid_config");
      expect((err as StageMcpError).message).toMatch(/mcpServers/);
    }
    try {
      parseMcpCatalog(JSON.stringify({ mcpServers: { github: "npx" } }), ".mcp.json");
    } catch (err) {
      expect((err as StageMcpError).code).toBe("invalid_config");
      expect((err as StageMcpError).message).toContain("github");
    }
  });

  it("throws reserved_name when a catalog key is stageflow", () => {
    try {
      parseMcpCatalog(
        JSON.stringify({ mcpServers: { [STAGEFLOW_MCP_SERVER_NAME]: { command: "npx" } } }),
        ".mcp.json",
      );
      expect.fail("expected StageMcpError");
    } catch (err) {
      expect(err).toBeInstanceOf(StageMcpError);
      expect((err as StageMcpError).code).toBe("reserved_name");
      expect((err as StageMcpError).message).toContain(STAGEFLOW_MCP_SERVER_NAME);
    }
  });

  it("returns plain-object entries without interpolating env tokens", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-mcp-cat-ok-"));
    await writeFile(
      path.join(root, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          github: {
            type: "http",
            url: "${API_BASE_URL:-https://api.example.com}/mcp",
            headers: { Authorization: "Bearer ${GITHUB_TOKEN}" },
          },
        },
      }),
    );
    const catalog = await loadMcpCatalog(root);
    expect(catalog.path).toBe(mcpCatalogPath(root));
    expect(catalog.servers.github).toEqual({
      type: "http",
      url: "${API_BASE_URL:-https://api.example.com}/mcp",
      headers: { Authorization: "Bearer ${GITHUB_TOKEN}" },
    });
  });

  it("throws unknown_server when an allowlist name is absent", () => {
    try {
      assertMcpAllowlistKnown({ github: { command: "npx" } }, ["notion"]);
      expect.fail("expected StageMcpError");
    } catch (err) {
      expect(err).toBeInstanceOf(StageMcpError);
      expect((err as StageMcpError).code).toBe("unknown_server");
      expect((err as StageMcpError).message).toContain("notion");
    }
  });

  it("accepts allowlist names that exist as catalog keys", () => {
    expect(() =>
      assertMcpAllowlistKnown({ github: { command: "npx" } }, ["github"]),
    ).not.toThrow();
  });
});

async function writeCatalog(
  servers: Record<string, Record<string, unknown>>,
): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "sf-mcp-resolve-"));
  await writeFile(path.join(root, ".mcp.json"), JSON.stringify({ mcpServers: servers }));
  return root;
}

describe("resolveStageMcpServers", () => {
  it("returns only allowlisted keys when the catalog has more servers (AE1)", async () => {
    const root = await writeCatalog({
      github: {
        type: "http",
        url: "https://api.github.com/mcp",
        headers: { Authorization: "Bearer ${GITHUB_TOKEN}" },
      },
      notion: {
        type: "http",
        url: "https://api.notion.com/mcp",
        headers: { Authorization: "Bearer ${NOTION_TOKEN}" },
      },
    });
    const resolved = await resolveStageMcpServers({
      projectRoot: root,
      allowlist: ["github"],
      env: { GITHUB_TOKEN: "ghs_test_token" },
    });
    expect(Object.keys(resolved)).toEqual(["github"]);
    expect(resolved.github).toEqual({
      type: "http",
      url: "https://api.github.com/mcp",
      headers: { Authorization: "Bearer ghs_test_token" },
    });
    expect(resolved).not.toHaveProperty("notion");
  });

  it("throws unresolved_var when a required variable is unset (AE2)", async () => {
    const root = await writeCatalog({
      github: {
        url: "https://api.github.com/mcp",
        headers: { Authorization: "Bearer ${GITHUB_TOKEN}" },
      },
    });
    try {
      await resolveStageMcpServers({
        projectRoot: root,
        allowlist: ["github"],
        env: { OTHER_SECRET: "s3cret-value-do-not-print" },
      });
      expect.fail("expected StageMcpError");
    } catch (err) {
      expect(err).toBeInstanceOf(StageMcpError);
      expect((err as StageMcpError).code).toBe("unresolved_var");
      expect((err as StageMcpError).message).toContain("GITHUB_TOKEN");
      expect((err as StageMcpError).message).not.toContain("s3cret-value-do-not-print");
    }
  });

  it("uses ${VAR:-default} when the variable is unset (AE10)", async () => {
    const root = await writeCatalog({
      github: {
        type: "http",
        url: "${API_BASE_URL:-https://api.example.com}/mcp",
      },
    });
    const resolved = await resolveStageMcpServers({
      projectRoot: root,
      allowlist: ["github"],
      env: {},
    });
    expect(resolved.github.url).toBe("https://api.example.com/mcp");
  });

  it("interpolates a token inside a larger headers value", async () => {
    const root = await writeCatalog({
      github: {
        type: "http",
        url: "https://api.github.com/mcp",
        headers: { Authorization: "Bearer ${TOKEN}" },
      },
    });
    const resolved = await resolveStageMcpServers({
      projectRoot: root,
      allowlist: ["github"],
      env: { TOKEN: "abc123" },
    });
    expect(resolved.github.headers).toEqual({ Authorization: "Bearer abc123" });
    expect(resolved.github.type).toBe("http");
  });

  it("interpolates args entries and leaves type unchanged", async () => {
    const root = await writeCatalog({
      local: {
        type: "http",
        command: "node",
        args: ["${HOME}/bin"],
      },
    });
    const resolved = await resolveStageMcpServers({
      projectRoot: root,
      allowlist: ["local"],
      env: { HOME: "/Users/me" },
    });
    expect(resolved.local.args).toEqual(["/Users/me/bin"]);
    expect(resolved.local.type).toBe("http");
    expect(resolved.local.command).toBe("node");
  });

  it("interpolates env values with defaults and set vars", async () => {
    const root = await writeCatalog({
      local: {
        command: "npx",
        env: {
          UNSET_ONE: "${MISSING:-x}",
          SET_ONE: "${PRESENT:-x}",
        },
      },
    });
    const resolved = await resolveStageMcpServers({
      projectRoot: root,
      allowlist: ["local"],
      env: { PRESENT: "y" },
    });
    expect(resolved.local.env).toEqual({
      UNSET_ONE: "x",
      SET_ONE: "y",
    });
  });

  it("returns {} for an empty allowlist without reading a missing catalog", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-mcp-empty-allow-"));
    await expect(
      resolveStageMcpServers({ projectRoot: root, allowlist: [], env: {} }),
    ).resolves.toEqual({});
    await expect(
      resolveStageMcpServers({ projectRoot: root, allowlist: undefined, env: {} }),
    ).resolves.toEqual({});
  });

  it("treats connect_failed as a valid code and never throws it", async () => {
    expect(new StageMcpError("later", "connect_failed").code).toBe("connect_failed");
    const missingRoot = await mkdtemp(path.join(tmpdir(), "sf-mcp-no-cat-"));
    await expect(
      resolveStageMcpServers({
        projectRoot: missingRoot,
        allowlist: ["github"],
        env: {},
      }),
    ).rejects.toMatchObject({ name: "StageMcpError", code: "missing_catalog" });

    const root = await writeCatalog({
      github: { url: "${GITHUB_TOKEN}" },
    });
    try {
      await resolveStageMcpServers({
        projectRoot: root,
        allowlist: ["github"],
        env: {},
      });
      expect.fail("expected StageMcpError");
    } catch (err) {
      expect(err).toBeInstanceOf(StageMcpError);
      expect((err as StageMcpError).code).not.toBe("connect_failed");
      expect((err as StageMcpError).code).toBe("unresolved_var");
    }
  });

  it("interpolates multiple tokens in one string", async () => {
    const root = await writeCatalog({
      github: {
        url: "${HOST}/v1/${PATH}",
      },
    });
    const resolved = await resolveStageMcpServers({
      projectRoot: root,
      allowlist: ["github"],
      env: { HOST: "https://api.example.com", PATH: "mcp" },
    });
    expect(resolved.github.url).toBe("https://api.example.com/v1/mcp");
  });

  it("throws invalid_config for unrecognized interpolation forms", async () => {
    const root = await writeCatalog({
      github: { url: "${FOO:bar}" },
    });
    try {
      await resolveStageMcpServers({
        projectRoot: root,
        allowlist: ["github"],
        env: { FOO: "x" },
      });
      expect.fail("expected StageMcpError");
    } catch (err) {
      expect(err).toBeInstanceOf(StageMcpError);
      expect((err as StageMcpError).code).toBe("invalid_config");
    }
  });

  it("does not mutate catalog objects when interpolating", async () => {
    const root = await writeCatalog({
      github: {
        url: "${HOST}/mcp",
        args: ["${HOME}/bin"],
        env: { TOKEN: "${TOKEN}" },
        headers: { Authorization: "Bearer ${TOKEN}" },
      },
    });
    const catalog = await loadMcpCatalog(root);
    const resolved = await resolveStageMcpServers({
      projectRoot: root,
      allowlist: ["github"],
      env: { HOST: "https://api.example.com", HOME: "/h", TOKEN: "tok" },
    });
    expect(resolved.github.url).toBe("https://api.example.com/mcp");
    (resolved.github.args as string[]).push("mutated");
    (resolved.github.env as Record<string, string>).TOKEN = "mutated";
    (resolved.github.headers as Record<string, string>).Authorization = "mutated";
    expect(catalog.servers.github).toEqual({
      url: "${HOST}/mcp",
      args: ["${HOME}/bin"],
      env: { TOKEN: "${TOKEN}" },
      headers: { Authorization: "Bearer ${TOKEN}" },
    });
    const reread = await loadMcpCatalog(root);
    expect(reread.servers.github).toEqual(catalog.servers.github);
  });

  it("throws unknown_server for allowlist names missing from the catalog", async () => {
    const root = await writeCatalog({
      github: { command: "npx" },
    });
    await expect(
      resolveStageMcpServers({
        projectRoot: root,
        allowlist: ["notion"],
        env: {},
      }),
    ).rejects.toMatchObject({ name: "StageMcpError", code: "unknown_server" });
  });

  it("treats an empty-string env value as set", async () => {
    const root = await writeCatalog({
      github: { url: "https://example.com/${EMPTY_VAR:-fallback}" },
    });
    const resolved = await resolveStageMcpServers({
      projectRoot: root,
      allowlist: ["github"],
      env: { EMPTY_VAR: "" },
    });
    expect(resolved.github.url).toBe("https://example.com/");
  });

  it("stamps stdio cwd to projectRoot and resolves relative command/args against it", async () => {
    const root = await writeCatalog({
      echo: {
        command: "bin/echo-mcp",
        args: ["examples/stage-mcp/echo-mcp.mjs", "-y", "@modelcontextprotocol/server-github"],
      },
    });
    const resolved = await resolveStageMcpServers({
      projectRoot: root,
      allowlist: ["echo"],
      env: {},
    });
    expect(resolved.echo.cwd).toBe(path.resolve(root));
    expect(resolved.echo.command).toBe(path.resolve(root, "bin/echo-mcp"));
    expect(resolved.echo.args).toEqual([
      path.resolve(root, "examples/stage-mcp/echo-mcp.mjs"),
      "-y",
      "@modelcontextprotocol/server-github",
    ]);
  });

  it("keeps bare commands on PATH and still stamps spawn cwd to projectRoot", async () => {
    const root = await writeCatalog({
      local: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
      },
    });
    const resolved = await resolveStageMcpServers({
      projectRoot: root,
      allowlist: ["local"],
      env: {},
    });
    expect(resolved.local.command).toBe("npx");
    expect(resolved.local.args).toEqual(["-y", "@modelcontextprotocol/server-github"]);
    expect(resolved.local.cwd).toBe(path.resolve(root));
  });

  it("does not stamp cwd on url-only HTTP servers", async () => {
    const root = await writeCatalog({
      github: {
        type: "http",
        url: "https://api.github.com/mcp",
      },
    });
    const resolved = await resolveStageMcpServers({
      projectRoot: root,
      allowlist: ["github"],
      env: {},
    });
    expect(resolved.github).toEqual({
      type: "http",
      url: "https://api.github.com/mcp",
    });
    expect(resolved.github).not.toHaveProperty("cwd");
  });

  it("keeps an absolute cwd that canonicalizes inside projectRoot", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-mcp-resolve-"));
    await writeFile(
      path.join(root, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          local: {
            command: "node",
            args: ["server.mjs"],
            cwd: path.join(root, "tools", "mcp"),
          },
        },
      }),
    );
    const resolved = await resolveStageMcpServers({
      projectRoot: root,
      allowlist: ["local"],
      env: {},
    });
    expect(resolved.local.cwd).toBe(path.resolve(root, "tools", "mcp"));
    expect(resolved.local.command).toBe("node");
    expect(resolved.local.args).toEqual(["server.mjs"]);
  });

  it("fails closed when catalog cwd is relative", async () => {
    const root = await writeCatalog({
      local: {
        command: "node",
        cwd: "tools/mcp",
      },
    });
    try {
      await resolveStageMcpServers({
        projectRoot: root,
        allowlist: ["local"],
        env: {},
      });
      expect.fail("expected StageMcpError");
    } catch (err) {
      expect(err).toBeInstanceOf(StageMcpError);
      expect((err as StageMcpError).code).toBe("invalid_config");
      expect((err as StageMcpError).message).toMatch(/cwd/);
    }
  });

  it("fails closed when catalog cwd canonicalizes outside projectRoot", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-mcp-resolve-"));
    await writeFile(
      path.join(root, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          local: {
            command: "node",
            cwd: path.resolve(root, "..", "outside-mcp"),
          },
        },
      }),
    );
    try {
      await resolveStageMcpServers({
        projectRoot: root,
        allowlist: ["local"],
        env: {},
      });
      expect.fail("expected StageMcpError");
    } catch (err) {
      expect(err).toBeInstanceOf(StageMcpError);
      expect((err as StageMcpError).code).toBe("invalid_config");
      expect((err as StageMcpError).message).toMatch(/cwd/);
    }
  });
});

describe("listProjectMcpCatalog", () => {
  const secret = "u1-secret-mcp-token-9f3c2b1a";

  it("lists two servers as names plus stdio/http only", async () => {
    const root = await writeCatalog({
      local: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
        env: { GITHUB_TOKEN: secret },
      },
      github: {
        url: `https://secret-host.example/\${API_BASE}/mcp`,
        headers: { Authorization: `Bearer ${secret}` },
      },
    });
    const listed = await listProjectMcpCatalog(root);
    expect(listed).toEqual({
      status: "ok",
      servers: [
        { name: "local", transport: "stdio" },
        { name: "github", transport: "http" },
      ],
    });
    for (const row of listed.servers) {
      expect(Object.keys(row).sort()).toEqual(["name", "transport"]);
    }
  });

  it("returns an empty list for empty mcpServers", async () => {
    const root = await writeCatalog({});
    await expect(listProjectMcpCatalog(root)).resolves.toEqual({
      status: "ok",
      servers: [],
    });
  });

  it("omits env, headers, args, command, URLs, and fixture secrets", async () => {
    const root = await writeCatalog({
      local: {
        command: "npx",
        args: ["-y", "secret-bin"],
        env: { GITHUB_TOKEN: secret },
      },
      github: {
        url: "https://secret-host.example/${API_BASE}/mcp",
        headers: { Authorization: `Bearer ${secret}` },
      },
    });
    const listed = await listProjectMcpCatalog(root);
    const payload = JSON.stringify(listed);
    expect(payload).not.toContain(secret);
    expect(payload).not.toContain("secret-host.example");
    expect(payload).not.toContain("API_BASE");
    expect(payload).not.toContain("Authorization");
    expect(payload).not.toContain("secret-bin");
    expect(payload).not.toMatch(/"env"/);
    expect(payload).not.toMatch(/"headers"/);
    expect(payload).not.toMatch(/"args"/);
    expect(payload).not.toMatch(/"command"/);
    expect(payload).not.toMatch(/"url"/);
  });

  it("does not interpolate catalog tokens", async () => {
    const previous = process.env.API_BASE;
    process.env.API_BASE = "interpolated.example";
    try {
      const root = await writeCatalog({
        github: {
          url: "https://secret-host.example/${API_BASE}/mcp",
        },
      });
      const listed = await listProjectMcpCatalog(root);
      expect(listed).toEqual({
        status: "ok",
        servers: [{ name: "github", transport: "http" }],
      });
      expect(JSON.stringify(listed)).not.toContain("interpolated.example");
    } finally {
      if (previous === undefined) {
        delete process.env.API_BASE;
      } else {
        process.env.API_BASE = previous;
      }
    }
  });

  it("returns missing_catalog when the file is absent", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-mcp-list-missing-"));
    await expect(listProjectMcpCatalog(root)).resolves.toEqual({
      status: "missing_catalog",
      servers: [],
    });
  });

  it("returns invalid_config for invalid JSON or missing mcpServers", async () => {
    const invalidJson = await mkdtemp(path.join(tmpdir(), "sf-mcp-list-badjson-"));
    await writeFile(path.join(invalidJson, ".mcp.json"), "{ not json");
    await expect(listProjectMcpCatalog(invalidJson)).resolves.toEqual({
      status: "invalid_config",
      servers: [],
    });

    const missingKey = await mkdtemp(path.join(tmpdir(), "sf-mcp-list-nokey-"));
    await writeFile(path.join(missingKey, ".mcp.json"), JSON.stringify({}));
    await expect(listProjectMcpCatalog(missingKey)).resolves.toEqual({
      status: "invalid_config",
      servers: [],
    });
  });

  it("fails the whole catalog with no rows when stageflow is reserved", async () => {
    const root = await writeCatalog({
      [STAGEFLOW_MCP_SERVER_NAME]: { command: "npx" },
      github: { url: "https://secret-host.example/mcp" },
    });
    await expect(listProjectMcpCatalog(root)).resolves.toEqual({
      status: "invalid_config",
      servers: [],
    });
  });
});
