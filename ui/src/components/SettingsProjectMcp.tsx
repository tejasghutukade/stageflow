import { useEffect, useRef, useState } from "react";
import {
  fetchProjectMcp,
  postProjectMcpProbe,
  type ProjectMcpCatalogList,
  type ProjectMcpCatalogListStatus,
  type ProjectMcpProbeResult,
  type ProjectMcpRowStatus,
} from "../api";

export const PROJECT_MCP_SETTINGS_COPY =
  "Servers from this project's git-root .mcp.json. Check tests whether a server can connect. It does not start a run and does not attach tools to stages. YAML mcp: still allowlists what a stage receives.";

export type ProjectMcpRow = {
  name: string;
  transport: "stdio" | "http";
  status: ProjectMcpRowStatus;
  error?: string;
};

export type ProjectMcpSettingsState = {
  loading: boolean;
  catalogStatus: ProjectMcpCatalogListStatus | null;
  servers: ProjectMcpRow[];
  error: string | null;
};

export type ProjectMcpSettingsDeps = {
  list: () => Promise<ProjectMcpCatalogList>;
  probe: (
    name: string,
    init?: { signal?: AbortSignal },
  ) => Promise<ProjectMcpProbeResult>;
};

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
      return "Needs auth";
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
    return "No git-root .mcp.json in this project.";
  }
  if (status === "invalid_config") {
    return "Project .mcp.json is invalid.";
  }
  return null;
}

export function createProjectMcpSettingsSession(deps: ProjectMcpSettingsDeps) {
  let state: ProjectMcpSettingsState = {
    loading: true,
    catalogStatus: null,
    servers: [],
    error: null,
  };
  let disposed = false;
  const controllers = new Map<string, AbortController>();
  const listeners = new Set<() => void>();

  const getState = (): ProjectMcpSettingsState => state;

  const notify = () => {
    for (const listener of listeners) listener();
  };

  const setRow = (name: string, patch: Partial<ProjectMcpRow>) => {
    state = {
      ...state,
      servers: state.servers.map((row) =>
        row.name === name ? { ...row, ...patch } : row,
      ),
    };
    notify();
  };

  const load = async () => {
    if (disposed) return;
    state = {
      loading: true,
      catalogStatus: null,
      servers: [],
      error: null,
    };
    notify();
    try {
      const listed = await deps.list();
      if (disposed) return;
      if (listed.status !== "ok") {
        state = {
          loading: false,
          catalogStatus: listed.status,
          servers: [],
          error: null,
        };
        notify();
        return;
      }
      state = {
        loading: false,
        catalogStatus: "ok",
        servers: listed.servers.map((server) => ({
          name: server.name,
          transport: server.transport,
          status: "not-yet-probed",
        })),
        error: null,
      };
      notify();
    } catch (err) {
      if (disposed) return;
      state = {
        loading: false,
        catalogStatus: null,
        servers: [],
        error: err instanceof Error ? err.message : String(err),
      };
      notify();
    }
  };

  const check = async (name: string) => {
    if (disposed || controllers.has(name)) return;
    const controller = new AbortController();
    controllers.set(name, controller);
    setRow(name, { status: "probing", error: undefined });
    try {
      const result = await deps.probe(name, { signal: controller.signal });
      if (disposed) return;
      setRow(name, {
        status: result.status,
        error: result.error,
      });
    } catch (err) {
      if (disposed || controller.signal.aborted) return;
      setRow(name, {
        status: "connect_failed",
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      controllers.delete(name);
    }
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

  return { getState, load, check, dispose, subscribe };
}

export function SettingsProjectMcp() {
  const sessionRef = useRef<ReturnType<
    typeof createProjectMcpSettingsSession
  > | null>(null);
  const [state, setState] = useState<ProjectMcpSettingsState>({
    loading: true,
    catalogStatus: null,
    servers: [],
    error: null,
  });

  useEffect(() => {
    const session = createProjectMcpSettingsSession({
      list: fetchProjectMcp,
      probe: postProjectMcpProbe,
    });
    sessionRef.current = session;
    setState(session.getState());
    const unsubscribe = session.subscribe(() => setState(session.getState()));
    void session.load();
    return () => {
      unsubscribe();
      session.dispose();
      if (sessionRef.current === session) sessionRef.current = null;
    };
  }, []);

  const sectionError = state.catalogStatus
    ? projectMcpSectionError(state.catalogStatus)
    : null;

  return (
    <section className="card">
      <div className="card__head">
        <h2>Project MCP servers</h2>
      </div>
      <p
        style={{
          margin: 0,
          color: "var(--color-text-secondary)",
          fontSize: "var(--font-size-sm)",
        }}
      >
        {PROJECT_MCP_SETTINGS_COPY}
      </p>

      {state.error ? (
        <p
          style={{
            color: "var(--color-text-red)",
            fontSize: "var(--font-size-sm)",
            marginBottom: "var(--spacing-3)",
          }}
        >
          {state.error}
        </p>
      ) : null}
      {sectionError ? (
        <p
          style={{
            color: "var(--color-text-red)",
            fontSize: "var(--font-size-sm)",
            marginBottom: "var(--spacing-3)",
          }}
        >
          {sectionError}
        </p>
      ) : null}

      {state.loading ? (
        <p className="muted">Loading project catalog…</p>
      ) : state.catalogStatus === "ok" && state.servers.length === 0 ? (
        <p className="muted">No servers in .mcp.json.</p>
      ) : (
        state.servers.map((row) => {
          const token = projectMcpDotToken(row.status);
          const probing = row.status === "probing";
          return (
            <div className="setting" key={row.name}>
              <span>
                <strong>{row.name}</strong>
                <p>{row.transport}</p>
                {row.error ? <p>{row.error}</p> : null}
              </span>
              <span
                style={{
                  display: "flex",
                  gap: "var(--spacing-2)",
                  alignItems: "center",
                }}
              >
                <span className="status">
                  <span className={`dot${token ? ` dot--${token}` : ""}`}></span>{" "}
                  {projectMcpStatusLabel(row.status)}
                </span>
                <button
                  type="button"
                  className="btn btn--ghost"
                  disabled={probing}
                  onClick={() => void sessionRef.current?.check(row.name)}
                >
                  {probing ? "Probing…" : "Check"}
                </button>
              </span>
            </div>
          );
        })
      )}
    </section>
  );
}
