import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { STAGEFLOW_MCP_SERVER_NAME } from "../src/agent/claudeTools.js";
import {
  listProjectMcpCatalog,
  loadMcpCatalog,
  mcpCatalogPath,
  parseMcpCatalog,
  resolveStageMcpServers,
  stampStagePromptArtifactsDir,
} from "../src/config/resolveStageMcpServers.js";

describe("MCP catalog reader", () => {
  it("throws missing_catalog when the file is absent", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-mcp-cat-missing-"));
    await expect(loadMcpCatalog(root)).rejects.toMatchObject({
      name: "StageMcpError",
      code: "missing_catalog",
    });
  });

  it.each([
    { name: "invalid JSON", text: "{ not json", message: /./ },
    { name: "mcpServers is an array", text: JSON.stringify({ mcpServers: [] }), message: /./ },
    { name: "mcpServers is missing", text: JSON.stringify({}), message: /mcpServers/ },
    {
      name: "a server entry is not an object",
      text: JSON.stringify({ mcpServers: { github: "npx" } }),
      message: /github/,
    },
  ])("throws invalid_config when $name", ({ text, message }) => {
    expect(() => parseMcpCatalog(text, ".mcp.json")).toThrowError(
      expect.objectContaining({
        name: "StageMcpError",
        code: "invalid_config",
        message: expect.stringMatching(message),
      }),
    );
  });

  it("throws reserved_name when a catalog key is stageflow", () => {
    expect(() =>
      parseMcpCatalog(
        JSON.stringify({ mcpServers: { [STAGEFLOW_MCP_SERVER_NAME]: { command: "npx" } } }),
        ".mcp.json",
      ),
    ).toThrowError(
      expect.objectContaining({
        name: "StageMcpError",
        code: "reserved_name",
        message: expect.stringContaining(STAGEFLOW_MCP_SERVER_NAME),
      }),
    );
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
});

describe("stampStagePromptArtifactsDir", () => {
  it.each([
    ["save ${STAGEFLOW_STAGE_ARTIFACTS_DIR}/page.png", "save /tmp/run/artifacts/page.png"],
    ["no token here", "no token here"],
  ])("stamps %j", (prompt, expected) => {
    expect(stampStagePromptArtifactsDir(prompt, "/tmp/run/artifacts")).toBe(expected);
  });
});

async function writeCatalog(
  servers: Record<string, Record<string, unknown>>,
): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "sf-mcp-resolve-"));
  await writeFile(path.join(root, ".mcp.json"), JSON.stringify({ mcpServers: servers }));
  return root;
}

async function resolveOne(
  server: Record<string, unknown>,
  env: Record<string, string> = {},
  extra: { stageId?: string } = {},
) {
  const root = await writeCatalog({ srv: server });
  return resolveStageMcpServers({ projectRoot: root, allowlist: ["srv"], env, ...extra });
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
  });

  it("throws unresolved_var without echoing other env values (AE2)", async () => {
    const root = await writeCatalog({
      github: {
        url: "https://api.github.com/mcp",
        headers: { Authorization: "Bearer ${GITHUB_TOKEN}" },
      },
    });
    const rejection = resolveStageMcpServers({
      projectRoot: root,
      allowlist: ["github"],
      env: { OTHER_SECRET: "s3cret-value-do-not-print" },
    });
    await expect(rejection).rejects.toMatchObject({
      name: "StageMcpError",
      code: "unresolved_var",
      message: expect.stringContaining("GITHUB_TOKEN"),
    });
    await expect(rejection).rejects.toSatisfy(
      (err: Error) => !err.message.includes("s3cret-value-do-not-print"),
    );
  });

  it("unresolved_var names the stage when stageId is provided", async () => {
    await expect(
      resolveOne(
        { url: "${GITHUB_TOKEN}" },
        {},
        { stageId: "publish-github-release" },
      ),
    ).rejects.toMatchObject({
      code: "unresolved_var",
      message: expect.stringContaining('stage "publish-github-release"'),
    });
  });

  it.each([
    {
      name: "${VAR:-default} when the variable is unset (AE10)",
      server: { type: "http", url: "${API_BASE_URL:-https://api.example.com}/mcp" },
      env: {},
      expected: { type: "http", url: "https://api.example.com/mcp" },
    },
    {
      name: "a token inside a larger headers value",
      server: {
        type: "http",
        url: "https://api.github.com/mcp",
        headers: { Authorization: "Bearer ${TOKEN}" },
      },
      env: { TOKEN: "abc123" },
      expected: {
        type: "http",
        url: "https://api.github.com/mcp",
        headers: { Authorization: "Bearer abc123" },
      },
    },
    {
      name: "args entries without changing type or command",
      server: { type: "http", command: "node", args: ["${HOME}/bin"] },
      env: { HOME: "/Users/me" },
      expected: { type: "http", command: "node", args: ["/Users/me/bin"] },
    },
    {
      name: "env values with defaults and set vars",
      server: {
        command: "npx",
        env: { UNSET_ONE: "${MISSING:-x}", SET_ONE: "${PRESENT:-x}" },
      },
      env: { PRESENT: "y" },
      expected: { command: "npx", env: { UNSET_ONE: "x", SET_ONE: "y" } },
    },
    {
      name: "multiple tokens in one string",
      server: { url: "${HOST}/v1/${PATH}" },
      env: { HOST: "https://api.example.com", PATH: "mcp" },
      expected: { url: "https://api.example.com/v1/mcp" },
    },
    {
      name: "an empty-string env value as set",
      server: { url: "https://example.com/${EMPTY_VAR:-fallback}" },
      env: { EMPTY_VAR: "" },
      expected: { url: "https://example.com/" },
    },
  ])("interpolates $name", async ({ server, env, expected }) => {
    const resolved = await resolveOne(server, env);
    expect(resolved.srv).toMatchObject(expected);
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

  it("throws missing_catalog when an allowlist is set but .mcp.json is absent", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-mcp-no-cat-"));
    await expect(
      resolveStageMcpServers({ projectRoot: root, allowlist: ["github"], env: {} }),
    ).rejects.toMatchObject({ name: "StageMcpError", code: "missing_catalog" });
  });

  it("throws invalid_config for unrecognized interpolation forms", async () => {
    await expect(resolveOne({ url: "${FOO:bar}" }, { FOO: "x" })).rejects.toMatchObject({
      name: "StageMcpError",
      code: "invalid_config",
    });
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
    const root = await writeCatalog({ github: { command: "npx" } });
    await expect(
      resolveStageMcpServers({ projectRoot: root, allowlist: ["notion"], env: {} }),
    ).rejects.toMatchObject({
      name: "StageMcpError",
      code: "unknown_server",
      message: expect.stringContaining("notion"),
    });
  });

  describe("cwd stamping", () => {
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
        local: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
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
      const resolved = await resolveOne({
        type: "http",
        url: "https://api.github.com/mcp",
      });
      expect(resolved.srv).toEqual({ type: "http", url: "https://api.github.com/mcp" });
      expect(resolved.srv).not.toHaveProperty("cwd");
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

    it.each([
      { name: "is relative", cwd: () => "tools/mcp" },
      {
        name: "canonicalizes outside projectRoot",
        cwd: (root: string) => path.resolve(root, "..", "outside-mcp"),
      },
    ])("fails closed when catalog cwd $name", async ({ cwd }) => {
      const root = await mkdtemp(path.join(tmpdir(), "sf-mcp-resolve-"));
      await writeFile(
        path.join(root, ".mcp.json"),
        JSON.stringify({ mcpServers: { local: { command: "node", cwd: cwd(root) } } }),
      );
      await expect(
        resolveStageMcpServers({ projectRoot: root, allowlist: ["local"], env: {} }),
      ).rejects.toMatchObject({
        name: "StageMcpError",
        code: "invalid_config",
        message: expect.stringMatching(/cwd/),
      });
    });
  });
});

describe("listProjectMcpCatalog", () => {
  const secret = "u1-secret-mcp-token-9f3c2b1a";

  it("lists names plus stdio/http only and omits env, headers, args, command, URLs, secrets", async () => {
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
    expect(listed).toEqual({
      status: "ok",
      servers: [
        { name: "local", transport: "stdio" },
        { name: "github", transport: "http" },
      ],
    });
    const payload = JSON.stringify(listed);
    for (const leaked of [secret, "secret-host.example", "API_BASE", "Authorization", "secret-bin"]) {
      expect(payload).not.toContain(leaked);
    }
    for (const key of ["env", "headers", "args", "command", "url"]) {
      expect(payload).not.toContain(`"${key}"`);
    }
  });

  it("returns an empty list for empty mcpServers", async () => {
    const root = await writeCatalog({});
    await expect(listProjectMcpCatalog(root)).resolves.toEqual({
      status: "ok",
      servers: [],
    });
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

  it.each([
    { name: "invalid JSON", file: "{ not json" },
    { name: "missing mcpServers", file: JSON.stringify({}) },
    {
      name: "the reserved stageflow name (whole catalog fails, no rows)",
      file: JSON.stringify({
        mcpServers: {
          [STAGEFLOW_MCP_SERVER_NAME]: { command: "npx" },
          github: { url: "https://secret-host.example/mcp" },
        },
      }),
    },
  ])("returns invalid_config for $name", async ({ file }) => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-mcp-list-bad-"));
    await writeFile(path.join(root, ".mcp.json"), file);
    await expect(listProjectMcpCatalog(root)).resolves.toEqual({
      status: "invalid_config",
      servers: [],
    });
  });
});
