import { describe, expect, it, vi } from "vitest";
import type { ProjectMcpApi } from "./mcpApi";
import {
  PROJECT_MCP_SETTINGS_COPY,
  createProjectMcpSettingsSession as createSession,
  pollOAuthSignIn,
  projectMcpDotColor,
  projectMcpDotToken,
  projectMcpSectionError,
  projectMcpStatusLabel,
} from "./mcpSession";

const entry = (name: string, transport: "stdio" | "http" = "http", origin: "project" | "console" = "console") => ({
  name,
  transport,
  origin,
});

/** A fake adapter: everything resolves to an empty/benign value unless overridden. */
function fakeApi(overrides: Partial<ProjectMcpApi> = {}): ProjectMcpApi {
  const unused = () => Promise.reject(new Error("unexpected call"));
  return {
    list: async () => ({ status: "ok", servers: [] }),
    getServer: unused,
    save: async (name) => ({ name, secretsStored: [] }),
    remove: async (name) => ({ name }),
    importJson: async () => ({ added: [], secretsStored: [], errors: [] }),
    probe: async (name) => ({ name, status: "connected" }),
    tools: unused,
    oauthStatus: async (name) => ({ name, status: "not_authenticated" }),
    oauthStart: unused,
    oauthComplete: unused,
    oauthRemove: async (name) => ({ name, status: "not_authenticated" }),
    secrets: async () => ({ secrets: [], needed: [] }),
    setSecret: async (name) => ({ name }),
    removeSecret: async (name) => ({ name }),
    ...overrides,
  };
}

const createProjectMcpSettingsSession = (deps: { list?: ProjectMcpApi["list"]; probe?: ProjectMcpApi["probe"] }) =>
  createSession(fakeApi(deps as Partial<ProjectMcpApi>));

describe("project MCP status paint", () => {
  it("keeps not-yet-probed, connected, needs_auth, and connect_failed distinct", () => {
    expect(projectMcpStatusLabel("not-yet-probed")).toBe("Not yet probed");
    expect(projectMcpStatusLabel("connected")).toBe("Connected");
    expect(projectMcpStatusLabel("needs_auth")).toBe("Needs sign-in");
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
    expect(projectMcpSectionError("missing_catalog")).toBeNull();
    expect(projectMcpSectionError("invalid_config")).toMatch(/invalid/i);
  });
});

describe("createProjectMcpSettingsSession", () => {
  it("load lists names as not-yet-probed and does not probe", async () => {
    const list = vi.fn(async () => ({
      status: "ok" as const,
      servers: [
        { name: "local", transport: "stdio" as const, origin: "project" as const },
        { name: "github", transport: "http" as const, origin: "project" as const },
      ],
    }));
    const probe = vi.fn() as never;
    const session = createProjectMcpSettingsSession({ list, probe });
    await session.load();
    expect(list).toHaveBeenCalledOnce();
    expect(probe).not.toHaveBeenCalled();
    expect(session.getState()).toMatchObject({
      loading: false,
      catalogStatus: "ok",
      servers: [
        { name: "local", transport: "stdio", origin: "project", status: "not-yet-probed" },
        { name: "github", transport: "http", origin: "project", status: "not-yet-probed" },
      ],
      error: null,
    });
  });

  it("Check POSTs that name only and paints the mapped status", async () => {
    const list = vi.fn(async () => ({
      status: "ok" as const,
      servers: [
        { name: "local", transport: "stdio" as const, origin: "project" as const },
        { name: "github", transport: "http" as const, origin: "project" as const },
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
      servers: [{ name: "github", transport: "http" as const, origin: "project" as const }],
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
      servers: [{ name: "github", transport: "http" as const, origin: "project" as const }],
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
      servers: [{ name: "github", transport: "http" as const, origin: "project" as const }],
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
      probe: vi.fn() as never,
    });
    await missing.load();
    expect(missing.getState().catalogStatus).toBe("missing_catalog");
    expect(missing.getState().servers).toEqual([]);

    const invalid = createProjectMcpSettingsSession({
      list: async () => ({ status: "invalid_config", servers: [] }),
      probe: vi.fn() as never,
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

  it("checkAll probes every unprobed row, a few at a time, and skips ones already checked", async () => {
    let running = 0;
    let peak = 0;
    const probe = vi.fn(async (name: string) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running -= 1;
      return { name, status: "connected" as const };
    });
    const names = ["a", "b", "c", "d", "e"];
    const session = createProjectMcpSettingsSession({
      list: async () => ({
        status: "ok",
        servers: names.map((name) => ({ name, transport: "http" as const, origin: "project" as const })),
      }),
      probe,
    });
    await session.load();
    await session.check("a");
    probe.mockClear();
    await session.checkAll(2);
    expect(probe.mock.calls.map((c) => c[0]).sort()).toEqual(["b", "c", "d", "e"]);
    expect(peak).toBeLessThanOrEqual(2);
    expect(session.getState().servers.every((row) => row.status === "connected")).toBe(true);
  });
});

const catalog = (...names: string[]) => async () => ({ status: "ok" as const, servers: names.map((n) => entry(n)) });

describe("session lifecycle", () => {
  it("refresh keeps known statuses and re-probes only the affected server", async () => {
    const probe = vi.fn(async (name: string) => ({ name, status: "connected" as const }));
    const session = createSession(fakeApi({ list: catalog("a", "b", "c"), probe }));
    await session.load();
    await session.checkAll();
    probe.mockClear();
    let sawLoading = false;
    session.subscribe(() => {
      if (session.getState().loading) sawLoading = true;
    });
    await session.refresh(["b"]);
    await session.idle();
    expect(sawLoading).toBe(false);
    expect(probe.mock.calls.map((c) => c[0])).toEqual(["b"]);
    expect(session.getState().servers.map((r) => r.status)).toEqual(["connected", "connected", "connected"]);
  });

  it("refresh drops servers that disappeared and does not probe newcomers", async () => {
    let names = ["a", "b"];
    const probe = vi.fn(async (name: string) => ({ name, status: "connected" as const }));
    const session = createSession(fakeApi({ list: async () => ({ status: "ok", servers: names.map((n) => entry(n)) }), probe }));
    await session.load();
    names = ["b", "c"];
    await session.refresh([]);
    await session.idle();
    expect(session.getState().servers.map((r) => [r.name, r.status])).toEqual([
      ["b", "not-yet-probed"],
      ["c", "not-yet-probed"],
    ]);
    expect(probe).not.toHaveBeenCalled();
  });

  it("aborts and discards an in-flight probe when the server is saved", async () => {
    const signals: AbortSignal[] = [];
    const releases: Array<(status: "connected" | "connect_failed") => void> = [];
    const probe = vi.fn(
      (name: string, init?: { signal?: AbortSignal }) =>
        new Promise<{ name: string; status: "connected" | "connect_failed" }>((resolve) => {
          signals.push(init!.signal!);
          releases.push((status) => resolve({ name, status }));
        }),
    );
    const session = createSession(fakeApi({ list: catalog("a"), probe }));
    await session.load();
    void session.check("a");
    expect(session.getState().servers[0]?.status).toBe("probing");
    await session.save("a", { url: "https://x.test/mcp" });
    expect(signals[0]?.aborted).toBe(true);
    // the new probe is running; the stale one finishing late must not paint over it
    releases[0]!("connect_failed");
    await Promise.resolve();
    expect(session.getState().servers[0]?.status).toBe("probing");
    releases[1]!("connected");
    await session.idle();
    expect(session.getState().servers[0]?.status).toBe("connected");
  });

  it("delete clears sign-in, oauth entry and secret drafts for that server", async () => {
    let names = ["a", "b"];
    const session = createSession(
      fakeApi({
        list: async () => ({ status: "ok", servers: names.map((n) => entry(n)) }),
        oauthStatus: async (name) => ({ name, status: "authenticated" }),
        secrets: async () => ({
          secrets: [],
          needed: [
            { name: "A_TOKEN", usedBy: ["a"], set: false },
            { name: "B_TOKEN", usedBy: ["b"], set: false },
          ],
        }),
      }),
    );
    await session.load();
    await vi.waitFor(() => expect(session.getState().secrets).not.toBeNull());
    await vi.waitFor(() => expect(Object.keys(session.getState().oauth).sort()).toEqual(["a", "b"]));
    session.startSignIn("a");
    session.setDraft("A_TOKEN", "x");
    session.setDraft("B_TOKEN", "y");
    names = ["b"];
    const result = await session.remove("a");
    expect(result).toEqual({ ok: true, notice: "Removed a." });
    const state = session.getState();
    expect(state.signingIn).toBeNull();
    expect(state.oauth.a).toBeUndefined();
    expect(state.oauth.b).toBe("authenticated");
    expect(state.secretDrafts).toEqual({ B_TOKEN: "y" });
  });

  it("delete failure is reported as an error and leaves state alone", async () => {
    const session = createSession(
      fakeApi({
        list: catalog("a"),
        remove: async () => {
          throw new Error("boom");
        },
      }),
    );
    await session.load();
    session.startSignIn("a");
    expect(await session.remove("a")).toEqual({ ok: false, error: "boom" });
    expect(session.getState().signingIn).toBe("a");
    expect(session.getState().servers).toHaveLength(1);
  });

  it("setting a secret re-probes only the servers that use it", async () => {
    const probe = vi.fn(async (name: string) => ({ name, status: "connected" as const }));
    const session = createSession(
      fakeApi({
        list: catalog("a", "b"),
        probe,
        secrets: async () => ({ secrets: [], needed: [{ name: "K", usedBy: ["b"], set: false }] }),
      }),
    );
    await session.load();
    await vi.waitFor(() => expect(session.getState().secrets).not.toBeNull());
    session.setDraft("K", "v");
    expect(await session.saveSecret("K")).toEqual({ ok: true, notice: null });
    await session.idle();
    expect(probe.mock.calls.map((c) => c[0])).toEqual(["b"]);
    expect(session.getState().secretDrafts.K).toBe("");
  });

  it("signedIn runs once even if called twice", async () => {
    const probe = vi.fn(async (name: string) => ({ name, status: "connected" as const }));
    const session = createSession(fakeApi({ list: catalog("a"), probe }));
    await session.load();
    session.startSignIn("a");
    const first = await session.signedIn("a");
    const second = await session.signedIn("a");
    await session.idle();
    expect(first).toEqual({ ok: true, notice: "Signed in to a." });
    expect(second).toEqual({ ok: true, notice: null });
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("import reports nothing-added as an error and probes only what was added", async () => {
    const probe = vi.fn(async (name: string) => ({ name, status: "connected" as const }));
    let imported = { added: [] as string[], secretsStored: [] as string[], errors: [{ name: "x", error: "bad" }] };
    let names = ["a"];
    const session = createSession(
      fakeApi({
        list: async () => ({ status: "ok", servers: names.map((n) => entry(n)) }),
        importJson: async () => imported,
        probe,
      }),
    );
    await session.load();
    expect(await session.importJson({})).toEqual({ ok: false, error: "x: bad" });
    imported = { added: ["n"], secretsStored: [], errors: [] };
    names = ["a", "n"];
    expect((await session.importJson({})).ok).toBe(true);
    await session.idle();
    expect(probe.mock.calls.map((c) => c[0])).toEqual(["n"]);
  });
});

describe("projectMcpDotColor", () => {
  it("maps statuses to CSS variables", () => {
    expect(projectMcpDotColor("connected")).toBe("var(--sf-ok)");
    expect(projectMcpDotColor("needs_auth")).toBe("var(--sf-needs)");
    expect(projectMcpDotColor("probing")).toBe("var(--sf-running)");
    expect(projectMcpDotColor("connect_failed")).toBe("var(--sf-fail)");
    expect(projectMcpDotColor("not-yet-probed")).toBeUndefined();
  });
});

describe("pollOAuthSignIn", () => {
  it("calls onSignedIn once when authenticated, then stops polling", async () => {
    vi.useFakeTimers();
    try {
      let status: "not_authenticated" | "authenticated" = "not_authenticated";
      const oauthStatus = vi.fn(async (name: string) => ({ name, status }));
      const onSignedIn = vi.fn();
      pollOAuthSignIn({ api: { oauthStatus }, name: "a", onSignedIn, intervalMs: 10, timeoutMs: 1000 });
      await vi.advanceTimersByTimeAsync(30);
      expect(onSignedIn).not.toHaveBeenCalled();
      status = "authenticated";
      await vi.advanceTimersByTimeAsync(100);
      expect(onSignedIn).toHaveBeenCalledTimes(1);
      const calls = oauthStatus.mock.calls.length;
      await vi.advanceTimersByTimeAsync(100);
      expect(oauthStatus.mock.calls.length).toBe(calls);
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out and the stop function ends it", async () => {
    vi.useFakeTimers();
    try {
      const oauthStatus = vi.fn(async (name: string) => ({ name, status: "not_authenticated" as const }));
      const onTimeout = vi.fn();
      pollOAuthSignIn({ api: { oauthStatus }, name: "a", onSignedIn: vi.fn(), onTimeout, intervalMs: 10, timeoutMs: 50 });
      await vi.advanceTimersByTimeAsync(200);
      expect(onTimeout).toHaveBeenCalledTimes(1);
      const calls = oauthStatus.mock.calls.length;
      await vi.advanceTimersByTimeAsync(200);
      expect(oauthStatus.mock.calls.length).toBe(calls);

      const stopped = vi.fn(async (name: string) => ({ name, status: "not_authenticated" as const }));
      const stop = pollOAuthSignIn({ api: { oauthStatus: stopped }, name: "a", onSignedIn: vi.fn(), intervalMs: 10, timeoutMs: 1000 });
      stop();
      await vi.advanceTimersByTimeAsync(100);
      expect(stopped).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
