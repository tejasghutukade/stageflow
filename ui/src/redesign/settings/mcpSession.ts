import type {
  McpOAuthStatus,
  McpSecretsList,
  ProjectMcpCatalogListStatus,
  ProjectMcpRowStatus,
  ProjectMcpServerConfig,
} from "../../api";
import { projectMcpApi, type ProjectMcpApi } from "./mcpApi";
import { deleteNotice, importOutcome, saveNotice, signedInNotice } from "./mcpForm";

export const PROJECT_MCP_SETTINGS_COPY =
  "Servers agents and stages can use: those you add here, plus the project's git-root .mcp.json. Check tests whether a server can connect. It does not start a run and does not attach tools to stages. YAML mcp: still allowlists what a stage receives.";

export type ProjectMcpRow = {
  name: string;
  transport: "stdio" | "http";
  origin: "project" | "console";
  status: ProjectMcpRowStatus;
  error?: string;
};

/** One session owns the catalog, probe statuses, OAuth statuses, secrets and the in-progress sign-in/secret drafts. */
export type ProjectMcpSettingsState = {
  loading: boolean;
  catalogStatus: ProjectMcpCatalogListStatus | null;
  servers: ProjectMcpRow[];
  error: string | null;
  oauth: Record<string, McpOAuthStatus>;
  secrets: McpSecretsList | null;
  signingIn: string | null;
  secretDrafts: Record<string, string>;
};

/** Result of a user action; the panel shows `error` in the failure style and `notice` as a status line. */
export type ProjectMcpOutcome = { ok: true; notice: string | null } | { ok: false; error: string };

export type ProjectMcpDotToken = "waiting" | "running" | "succeeded" | "failed";

export function projectMcpStatusLabel(status: ProjectMcpRowStatus): string {
  switch (status) {
    case "not-yet-probed":
      return "Not yet probed";
    case "probing":
      return "Probing…";
    case "connected":
      return "Connected";
    case "needs_auth":
      return "Needs sign-in";
    case "connect_failed":
      return "Connect failed";
    case "unresolved_var":
      return "Unresolved variable";
    case "invalid_config":
      return "Invalid config";
    case "missing_catalog":
      return "Missing catalog";
    case "cancelled":
      return "Cancelled";
  }
}

/** Dot colour per token, as the CSS variable the redesign defines. */
export const PROJECT_MCP_DOT_VAR: Record<ProjectMcpDotToken, string> = {
  running: "var(--sf-running)",
  succeeded: "var(--sf-ok)",
  waiting: "var(--sf-needs)",
  failed: "var(--sf-fail)",
};

export function projectMcpDotColor(status: ProjectMcpRowStatus): string | undefined {
  const token = projectMcpDotToken(status);
  return token ? PROJECT_MCP_DOT_VAR[token] : undefined;
}

export function projectMcpDotToken(
  status: ProjectMcpRowStatus,
): ProjectMcpDotToken | undefined {
  switch (status) {
    case "probing":
      return "running";
    case "connected":
      return "succeeded";
    case "needs_auth":
      return "waiting";
    case "connect_failed":
    case "unresolved_var":
    case "invalid_config":
    case "missing_catalog":
      return "failed";
    case "not-yet-probed":
    case "cancelled":
      return undefined;
  }
}

export function projectMcpSectionError(
  status: ProjectMcpCatalogListStatus,
): string | null {
  if (status === "missing_catalog") {
    return null;
  }
  if (status === "invalid_config") {
    return "Project .mcp.json is invalid.";
  }
  return null;
}

export const OAUTH_POLL_MS = 2000;
export const OAUTH_POLL_TIMEOUT_MS = 5 * 60_000;

/**
 * Poll a server's OAuth status until it is authenticated, then call `onSignedIn` once.
 * Gives up after `timeoutMs` (calling `onTimeout`); the returned function stops it early.
 */
export function pollOAuthSignIn(opts: {
  api: Pick<ProjectMcpApi, "oauthStatus">;
  name: string;
  onSignedIn: () => void;
  onTimeout?: () => void;
  intervalMs?: number;
  timeoutMs?: number;
}): () => void {
  let stopped = false;
  let inFlight = false;
  const stop = () => {
    stopped = true;
    clearInterval(timer);
    clearTimeout(deadline);
  };
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    opts.api.oauthStatus(opts.name).then(
      (res) => {
        inFlight = false;
        if (stopped || res.status !== "authenticated") return;
        stop();
        opts.onSignedIn();
      },
      () => {
        inFlight = false;
      },
    );
  }, opts.intervalMs ?? OAUTH_POLL_MS);
  const deadline = setTimeout(() => {
    if (stopped) return;
    stop();
    opts.onTimeout?.();
  }, opts.timeoutMs ?? OAUTH_POLL_TIMEOUT_MS);
  return stop;
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function createProjectMcpSettingsSession(api: ProjectMcpApi = projectMcpApi) {
  let state: ProjectMcpSettingsState = {
    loading: true,
    catalogStatus: null,
    servers: [],
    error: null,
    oauth: {},
    secrets: null,
    signingIn: null,
    secretDrafts: {},
  };
  let disposed = false;
  const controllers = new Map<string, AbortController>();
  const pending = new Set<Promise<void>>();
  const listeners = new Set<() => void>();

  const getState = (): ProjectMcpSettingsState => state;

  const set = (patch: Partial<ProjectMcpSettingsState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };

  const setRow = (name: string, patch: Partial<ProjectMcpRow>) =>
    set({ servers: state.servers.map((row) => (row.name === name ? { ...row, ...patch } : row)) });

  const known = (name: string) => state.servers.some((row) => row.name === name);

  /** Abort a probe in flight for `name`; its result is discarded. */
  const cancel = (name: string) => {
    const controller = controllers.get(name);
    if (!controller) return;
    controller.abort();
    controllers.delete(name);
    if (state.servers.find((row) => row.name === name)?.status === "probing") {
      setRow(name, { status: "not-yet-probed" });
    }
  };

  /** Drop everything the session holds for a server that is gone. */
  const forget = (name: string) => {
    cancel(name);
    const oauth = { ...state.oauth };
    delete oauth[name];
    const secretDrafts = { ...state.secretDrafts };
    delete secretDrafts[name];
    for (const row of [...(state.secrets?.needed ?? []), ...(state.secrets?.secrets ?? [])]) {
      if (row.usedBy.includes(name)) delete secretDrafts[row.name];
    }
    set({ oauth, secretDrafts, signingIn: state.signingIn === name ? null : state.signingIn });
  };

  const refreshOauth = async (names: string[]) => {
    await Promise.all(
      names.map((name) =>
        api.oauthStatus(name).then(
          (res) => {
            if (!disposed && known(name)) set({ oauth: { ...state.oauth, [name]: res.status } });
          },
          () => {},
        ),
      ),
    );
  };

  const refreshSecrets = async () => {
    const secrets = await api.secrets().catch(() => null);
    if (!disposed) set({ secrets });
  };

  const check = (name: string): Promise<void> => {
    if (disposed || controllers.has(name)) return Promise.resolve();
    const controller = new AbortController();
    controllers.set(name, controller);
    setRow(name, { status: "probing", error: undefined });
    const run = (async () => {
      try {
        const result = await api.probe(name, { signal: controller.signal });
        if (disposed || controller.signal.aborted) return;
        setRow(name, { status: result.status, error: result.error });
      } catch (err) {
        if (disposed || controller.signal.aborted) return;
        setRow(name, { status: "connect_failed", error: messageOf(err) });
      } finally {
        if (controllers.get(name) === controller) controllers.delete(name);
      }
    })();
    pending.add(run);
    void run.finally(() => pending.delete(run));
    return run;
  };

  /** Resolves when every probe started so far has settled. */
  const idle = async () => {
    while (pending.size > 0) await Promise.allSettled([...pending]);
  };

  const probeAffected = (names: string[]) => {
    for (const name of names) {
      cancel(name);
      if (known(name)) void check(name);
    }
  };

  const load = async () => {
    if (disposed) return;
    set({ loading: true, catalogStatus: null, servers: [], error: null });
    try {
      const listed = await api.list();
      if (disposed) return;
      if (listed.status !== "ok") {
        set({ loading: false, catalogStatus: listed.status, servers: [], error: null });
        return;
      }
      set({
        loading: false,
        catalogStatus: "ok",
        servers: listed.servers.map((server) => ({
          name: server.name,
          transport: server.transport,
          origin: server.origin,
          status: "not-yet-probed",
        })),
        error: null,
      });
      void refreshOauth(listed.servers.filter((s) => s.transport === "http").map((s) => s.name));
      void refreshSecrets();
    } catch (err) {
      if (disposed) return;
      set({ loading: false, catalogStatus: null, servers: [], error: messageOf(err) });
    }
  };

  /**
   * Re-read the catalog without a loading state: known rows keep their status and only the
   * `affected` servers are reset and probed again.
   */
  const refresh = async (affected: string[] = []) => {
    if (disposed) return;
    const touched = new Set(affected);
    try {
      const listed = await api.list();
      if (disposed) return;
      if (listed.status !== "ok") {
        for (const row of state.servers) forget(row.name);
        set({ catalogStatus: listed.status, servers: [], error: null });
        return;
      }
      const prev = new Map(state.servers.map((row) => [row.name, row]));
      for (const name of prev.keys()) {
        if (!listed.servers.some((s) => s.name === name)) forget(name);
      }
      set({
        catalogStatus: "ok",
        error: null,
        servers: listed.servers.map((server) => {
          const before = prev.get(server.name);
          const keep = before !== undefined && !touched.has(server.name);
          return {
            name: server.name,
            transport: server.transport,
            origin: server.origin,
            status: keep ? before.status : "not-yet-probed",
            ...(keep && before.error ? { error: before.error } : {}),
          };
        }),
      });
      probeAffected(affected);
      void refreshOauth(
        listed.servers.filter((s) => s.transport === "http" && (touched.has(s.name) || !(s.name in state.oauth))).map((s) => s.name),
      );
    } catch (err) {
      if (!disposed) set({ error: messageOf(err) });
    }
  };

  /** Check every row that has not been probed yet, a few at a time (each probe may start a process). */
  const checkAll = async (concurrency = 3) => {
    const queue = state.servers.filter((row) => row.status === "not-yet-probed").map((row) => row.name);
    const worker = async () => {
      for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
        if (disposed) return;
        // Another checkAll (or a click) may have taken this row since the queue was built.
        if (state.servers.find((row) => row.name === name)?.status !== "not-yet-probed") continue;
        await check(name);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  };

  const save = async (name: string, config: ProjectMcpServerConfig): Promise<ProjectMcpOutcome> => {
    cancel(name);
    try {
      const res = await api.save(name, config);
      await refresh([name]);
      void refreshSecrets();
      return { ok: true, notice: saveNotice(res) };
    } catch (err) {
      return { ok: false, error: messageOf(err) };
    }
  };

  const importJson = async (json: unknown): Promise<ProjectMcpOutcome> => {
    try {
      const res = await api.importJson(json);
      const outcome = importOutcome(res);
      if (!outcome.ok) return outcome;
      for (const name of res.added) cancel(name);
      await refresh(res.added);
      void refreshSecrets();
      return outcome;
    } catch (err) {
      return { ok: false, error: messageOf(err) };
    }
  };

  const remove = async (name: string): Promise<ProjectMcpOutcome> => {
    cancel(name);
    try {
      await api.remove(name);
    } catch (err) {
      return { ok: false, error: messageOf(err) };
    }
    forget(name);
    await refresh();
    void refreshSecrets();
    return { ok: true, notice: deleteNotice(name) };
  };

  const startSignIn = (name: string) => set({ signingIn: name });
  const cancelSignIn = () => set({ signingIn: null });

  /** Called when the Host reports the sign-in done; ignored if the dialog is already gone. */
  const signedIn = async (name: string): Promise<ProjectMcpOutcome> => {
    if (state.signingIn !== name || !known(name)) return { ok: true, notice: null };
    set({ signingIn: null });
    await refreshOauth([name]);
    probeAffected([name]);
    return { ok: true, notice: signedInNotice(name) };
  };

  const signOut = async (name: string): Promise<ProjectMcpOutcome> => {
    try {
      await api.oauthRemove(name);
    } catch (err) {
      return { ok: false, error: messageOf(err) };
    }
    await refreshOauth([name]);
    probeAffected([name]);
    return { ok: true, notice: null };
  };

  const setDraft = (name: string, value: string) => set({ secretDrafts: { ...state.secretDrafts, [name]: value } });

  const usedBy = (secret: string) =>
    [...(state.secrets?.needed ?? []), ...(state.secrets?.secrets ?? [])].find((row) => row.name === secret)?.usedBy ?? [];

  const saveSecret = async (name: string): Promise<ProjectMcpOutcome> => {
    const value = state.secretDrafts[name];
    if (!value) return { ok: true, notice: null };
    const affected = usedBy(name);
    try {
      await api.setSecret(name, value);
    } catch (err) {
      return { ok: false, error: messageOf(err) };
    }
    set({ secretDrafts: { ...state.secretDrafts, [name]: "" } });
    await refreshSecrets();
    probeAffected(affected);
    return { ok: true, notice: null };
  };

  const removeSecret = async (name: string): Promise<ProjectMcpOutcome> => {
    const affected = usedBy(name);
    try {
      await api.removeSecret(name);
    } catch (err) {
      return { ok: false, error: messageOf(err) };
    }
    await refreshSecrets();
    probeAffected(affected);
    return { ok: true, notice: null };
  };

  const dispose = () => {
    disposed = true;
    for (const controller of controllers.values()) {
      controller.abort();
    }
    controllers.clear();
  };

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  return {
    getState,
    load,
    refresh,
    check,
    checkAll,
    idle,
    save,
    importJson,
    remove,
    startSignIn,
    cancelSignIn,
    signedIn,
    signOut,
    setDraft,
    saveSecret,
    removeSecret,
    dispose,
    subscribe,
  };
}

export type ProjectMcpSession = ReturnType<typeof createProjectMcpSettingsSession>;
