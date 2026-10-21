import { describe, expect, it } from "vitest";
import { decideWorkspaceConfigTrust } from "../src/config/configOrigin.js";

describe("decideWorkspaceConfigTrust", () => {
  it("refuses workspace config for repository binding", () => {
    const d = decideWorkspaceConfigTrust({
      bindingKind: "repository",
      projectRoot: "/repo",
      source: "workspace",
    });
    expect(d.allow).toBe(false);
    expect(d.code).toBe("untrusted_config_origin");
  });

  it("allows workspace config for checkout binding", () => {
    const d = decideWorkspaceConfigTrust({
      bindingKind: "checkout",
      projectRoot: "/checkout",
      source: "workspace",
    });
    expect(d.allow).toBe(true);
    expect(d.origin).toBe("workspace");
  });

  it("allows when trust_workspace_config lists the root", () => {
    const d = decideWorkspaceConfigTrust({
      bindingKind: "repository",
      projectRoot: "/repo",
      trustWorkspaceConfig: ["/repo"],
      source: "workspace",
    });
    expect(d.allow).toBe(true);
  });

  it("allows catalog/inline without trust", () => {
    expect(
      decideWorkspaceConfigTrust({
        bindingKind: "repository",
        projectRoot: "/repo",
        source: "catalog",
      }).allow,
    ).toBe(true);
  });
});

describe("resolveStageMcpServers workspace trust", () => {
  it("throws untrusted_config_origin when workspaceSourced under repository", async () => {
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const {
      resolveStageMcpServers,
      StageMcpError,
    } = await import("../src/config/resolveStageMcpServers.js");
    const root = await mkdtemp(path.join(tmpdir(), "sf-origin-ws-"));
    await writeFile(
      path.join(root, ".mcp.json"),
      JSON.stringify({
        mcpServers: { github: { command: "npx", args: ["-y", "x"] } },
      }),
      "utf8",
    );
    await expect(
      resolveStageMcpServers({
        projectRoot: root,
        allowlist: ["github"],
        env: {},
        workspaceSourced: true,
        bindingKind: "repository",
        trustProjectRoot: "/factory",
        trustWorkspaceConfig: [],
      }),
    ).rejects.toMatchObject({
      name: "StageMcpError",
      code: "untrusted_config_origin",
    } satisfies Partial<InstanceType<typeof StageMcpError>>);
  });
});
