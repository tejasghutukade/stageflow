import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  PROJECT_MCP_SETTINGS_COPY,
  createProjectMcpSettingsSession,
  projectMcpDotToken,
  projectMcpSectionError,
  projectMcpStatusLabel,
} from "./SettingsProjectMcp";

const here = path.dirname(fileURLToPath(import.meta.url));

function readUi(rel: string): string {
  return readFileSync(path.join(here, rel), "utf8");
}

describe("project MCP status paint", () => {
  it("keeps not-yet-probed, connected, needs_auth, and connect_failed distinct", () => {
    expect(projectMcpStatusLabel("not-yet-probed")).toBe("Not yet probed");
    expect(projectMcpStatusLabel("connected")).toBe("Connected");
    expect(projectMcpStatusLabel("needs_auth")).toBe("Needs auth");
    expect(projectMcpStatusLabel("connect_failed")).toBe("Connect failed");
    expect(projectMcpStatusLabel("probing")).toBe("Probing…");

    expect(projectMcpDotToken("not-yet-probed")).toBeUndefined();
    expect(projectMcpDotToken("connected")).toBe("succeeded");
    expect(projectMcpDotToken("needs_auth")).toBe("waiting");
    expect(projectMcpDotToken("connect_failed")).toBe("failed");
    expect(projectMcpDotToken("probing")).toBe("running");

    const paints = [
      "not-yet-probed",
      "connected",
      "needs_auth",
      "connect_failed",
    ] as const;
    const labels = paints.map(projectMcpStatusLabel);
    expect(new Set(labels).size).toBe(4);
    const tokens = paints.map(projectMcpDotToken);
    expect(new Set(tokens.map((token) => token ?? "muted")).size).toBe(4);
  });

  it("renders catalog failures as section errors, not rows", () => {
    expect(projectMcpSectionError("ok")).toBeNull();
    expect(projectMcpSectionError("missing_catalog")).toMatch(/\.mcp\.json/);
    expect(projectMcpSectionError("invalid_config")).toMatch(/invalid/i);
  });
});

describe("createProjectMcpSettingsSession", () => {
  it("load lists names as not-yet-probed and does not probe", async () => {
    const list = vi.fn(async () => ({
      status: "ok" as const,
      servers: [
        { name: "local", transport: "stdio" as const },
        { name: "github", transport: "http" as const },
      ],
    }));
    const probe = vi.fn();
    const session = createProjectMcpSettingsSession({ list, probe });
    await session.load();
    expect(list).toHaveBeenCalledOnce();
    expect(probe).not.toHaveBeenCalled();
    expect(session.getState()).toEqual({
      loading: false,
      catalogStatus: "ok",
      servers: [
        { name: "local", transport: "stdio", status: "not-yet-probed" },
        { name: "github", transport: "http", status: "not-yet-probed" },
      ],
      error: null,
    });
  });

  it("Check POSTs that name only and paints the mapped status", async () => {
    const list = vi.fn(async () => ({
      status: "ok" as const,
      servers: [
        { name: "local", transport: "stdio" as const },
        { name: "github", transport: "http" as const },
      ],
    }));
    const probe = vi.fn(async (name: string) => {
      if (name === "github") {
        return { name, status: "needs_auth" as const };
      }
      return { name, status: "connect_failed" as const, error: "refused" };
    });
    const session = createProjectMcpSettingsSession({ list, probe });
    await session.load();
    await session.check("github");
    expect(probe).toHaveBeenCalledOnce();
    expect(probe).toHaveBeenCalledWith(
      "github",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    const github = session.getState().servers.find((row) => row.name === "github");
    const local = session.getState().servers.find((row) => row.name === "local");
    expect(github?.status).toBe("needs_auth");
    expect(local?.status).toBe("not-yet-probed");

    await session.check("local");
    expect(probe).toHaveBeenCalledTimes(2);
    expect(session.getState().servers.find((row) => row.name === "local")?.status).toBe(
      "connect_failed",
    );
    expect(session.getState().servers.find((row) => row.name === "github")?.status).toBe(
      "needs_auth",
    );
  });

  it("shows probing while Check is waiting", async () => {
    let release!: (value: { name: string; status: "connected" }) => void;
    const list = vi.fn(async () => ({
      status: "ok" as const,
      servers: [{ name: "github", transport: "http" as const }],
    }));
    const probe = vi.fn(
      () =>
        new Promise<{ name: string; status: "connected" }>((resolve) => {
          release = resolve;
        }),
    );
    const session = createProjectMcpSettingsSession({ list, probe });
    await session.load();
    const pending = session.check("github");
    expect(session.getState().servers[0]?.status).toBe("probing");
    release({ name: "github", status: "connected" });
    await pending;
    expect(session.getState().servers[0]?.status).toBe("connected");
  });

  it("remount resets every row to not-yet-probed", async () => {
    const list = vi.fn(async () => ({
      status: "ok" as const,
      servers: [{ name: "github", transport: "http" as const }],
    }));
    const probe = vi.fn(async (name: string) => ({
      name,
      status: "connected" as const,
    }));
    const first = createProjectMcpSettingsSession({ list, probe });
    await first.load();
    await first.check("github");
    expect(first.getState().servers[0]?.status).toBe("connected");

    const second = createProjectMcpSettingsSession({ list, probe });
    await second.load();
    expect(second.getState().servers[0]?.status).toBe("not-yet-probed");
  });

  it("dispose aborts the in-flight probe", async () => {
    const list = vi.fn(async () => ({
      status: "ok" as const,
      servers: [{ name: "github", transport: "http" as const }],
    }));
    let seen: AbortSignal | undefined;
    const probe = vi.fn((_name: string, init?: { signal?: AbortSignal }) => {
      seen = init?.signal;
      return new Promise<{ name: string; status: "connected" }>(() => {});
    });
    const session = createProjectMcpSettingsSession({ list, probe });
    await session.load();
    void session.check("github");
    expect(seen?.aborted).toBe(false);
    session.dispose();
    expect(seen?.aborted).toBe(true);
  });

  it("missing_catalog and invalid_config leave no server rows", async () => {
    const missing = createProjectMcpSettingsSession({
      list: async () => ({ status: "missing_catalog", servers: [] }),
      probe: vi.fn(),
    });
    await missing.load();
    expect(missing.getState().catalogStatus).toBe("missing_catalog");
    expect(missing.getState().servers).toEqual([]);

    const invalid = createProjectMcpSettingsSession({
      list: async () => ({ status: "invalid_config", servers: [] }),
      probe: vi.fn(),
    });
    await invalid.load();
    expect(invalid.getState().catalogStatus).toBe("invalid_config");
    expect(invalid.getState().servers).toEqual([]);
  });
});

describe("project catalog Settings copy and wiring", () => {
  it("explains inspect without attach, run, or enable/disable", () => {
    expect(PROJECT_MCP_SETTINGS_COPY).toMatch(/git-root/);
    expect(PROJECT_MCP_SETTINGS_COPY).toMatch(/\.mcp\.json/);
    expect(PROJECT_MCP_SETTINGS_COPY).toMatch(/does not start a run/i);
    expect(PROJECT_MCP_SETTINGS_COPY).toMatch(/does not attach/i);
    expect(PROJECT_MCP_SETTINGS_COPY).toMatch(/mcp:/);
    expect(PROJECT_MCP_SETTINGS_COPY).not.toMatch(/enable|disable/i);
    expect(PROJECT_MCP_SETTINGS_COPY).not.toMatch(/SDLC/i);
  });

  it("mounts two differently titled MCP sections (Project MCP servers vs operator-host MCP)", () => {
    const page = readUi("../pages/SettingsPage.tsx");
    expect(page).toMatch(/SettingsProjectMcp/);
    expect(page).toMatch(/SettingsMcp/);
    const mcp = readUi("./SettingsMcp.tsx");
    expect(mcp).toMatch(/<h2>Operator-host MCP<\/h2>/);
    expect(mcp).not.toMatch(/<h2>MCP<\/h2>/);
    const project = readUi("./SettingsProjectMcp.tsx");
    expect(project).toMatch(/<h2>Project MCP servers<\/h2>/);
    expect(project).not.toMatch(/<h2>Operator-host MCP<\/h2>/);
    expect(project).toMatch(/className="setting"/);
    expect(project).toMatch(/className=\{`dot/);
  });
});
