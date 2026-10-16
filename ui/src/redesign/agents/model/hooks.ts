import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { fetchChannelConnections, fetchProjectMcp, fetchSkills } from "../../../api";
import { setStageflowCatalog } from "./definition";
import { agentsApi, type AgentDefinition, type AgentDetail, type AgentIssue, type StageflowToolCatalog } from "../../../api/agents";
import { asError, initialResource, missingKind, resourceReducer, type MissingKind } from "./resourceState";

/** Choices the editor offers. Each list is undefined while loading and [] when unavailable. */
export type EditorOptions = {
  mcpServers?: Array<{ name: string; transport: string }>;
  stageflow?: StageflowToolCatalog;
  mcpStatus?: "ok" | "missing_catalog" | "invalid_config" | "error";
  skills?: Array<{ name: string; description: string }>;
  connections?: Array<{ id: string; provider: string; displayName: string; enabled: boolean }>;
  agents?: Array<{ id: string; name: string; enabled: boolean; model: string; channelConnection: string | null }>;
};

export function useEditorOptions(): EditorOptions {
  const [options, setOptions] = useState<EditorOptions>({});
  useEffect(() => {
    let live = true;
    const set = (patch: EditorOptions) => live && setOptions((prev) => ({ ...prev, ...patch }));
    fetchProjectMcp().then(
      (result) => set({ mcpServers: result.servers, mcpStatus: result.status }),
      () => set({ mcpServers: [], mcpStatus: "error" }),
    );
    agentsApi.stageflowTools().then(
      (catalog) => {
        setStageflowCatalog(catalog);
        set({ stageflow: catalog });
      },
      () => set({ stageflow: { groups: [] } }),
    );
    fetchSkills().then(
      (result) => set({ skills: result.skills.map((skill) => ({ name: skill.name, description: skill.description })) }),
      () => set({ skills: [] }),
    );
    fetchChannelConnections().then(
      (result) =>
        set({
          connections: result.connections.map((c) => ({
            id: c.id,
            provider: c.provider,
            displayName: c.displayName,
            enabled: c.enabled,
          })),
        }),
      () => set({ connections: [] }),
    );
    agentsApi.list().then(
      (agents) =>
        set({
          agents: agents
            .filter((agent) => agent.revision > 0)
            .map((agent) => ({ id: agent.id, name: agent.name, enabled: agent.enabled, model: agent.model?.id ?? "project default", channelConnection: agent.channelConnection })),
        }),
      () => set({ agents: [] }),
    );
    return () => {
      live = false;
    };
  }, []);
  return options;
}

export type ValidationState = {
  issues: AgentIssue[];
  warnings: AgentIssue[];
  yaml: string | null;
  /** True while the latest draft hasn't been validated yet. */
  pending: boolean;
};

/** Server-side validation of the draft, debounced; the server is the only source of truth for issues. */
export function useDefinitionValidation(definition: AgentDefinition, delayMs = 300): ValidationState {
  const [state, setState] = useState<ValidationState>({ issues: [], warnings: [], yaml: null, pending: true });
  const latest = useRef(0);
  const serialized = JSON.stringify(definition);
  useEffect(() => {
    const ticket = ++latest.current;
    setState((prev) => ({ ...prev, pending: true }));
    const timer = window.setTimeout(() => {
      agentsApi.validate(JSON.parse(serialized)).then(
        (result) => {
          if (ticket !== latest.current) return;
          setState({ issues: result.issues, warnings: result.warnings, yaml: result.yaml, pending: false });
        },
        (error: unknown) => {
          if (ticket !== latest.current) return;
          setState({
            issues: [{ path: "", code: "agent.validate_failed", message: error instanceof Error ? error.message : "Could not validate" }],
            warnings: [],
            yaml: null,
            pending: false,
          });
        },
      );
    }, delayMs);
    return () => window.clearTimeout(timer);
  }, [serialized, delayMs]);
  return state;
}

export type Resource<T> = {
  data: T | null;
  loading: boolean;
  error: Error | null;
  /** Set when the host said 404 for this resource. */
  missing: MissingKind | null;
  /** When the data last arrived, for "now" clocks that follow polling. */
  updatedAt: number | null;
  reload: () => Promise<void>;
  setData: (data: T) => void;
};

/**
 * One fetch-with-state hook for agent pages. `key` identifies the resource (null = idle): a new key
 * drops the old data, and a response for an old key is ignored. While `active(data)` is true the
 * resource refetches every `pollMs` without flipping `loading`.
 */
export function useResource<T>(
  key: string | null,
  fetcher: () => Promise<T>,
  opts: { kind: MissingKind; pollMs?: number; active?: (data: T) => boolean },
): Resource<T> {
  const [state, dispatch] = useReducer(resourceReducer<T>, key, initialResource<T>);
  const fetchRef = useRef(fetcher);
  fetchRef.current = fetcher;
  const keyRef = useRef(key);
  keyRef.current = key;
  const ticket = useRef(0);

  // Until the effect catches up with a new key, show it clean rather than the previous resource.
  const view = state.key === key ? state : initialResource<T>(key);

  const run = useCallback(async (silent: boolean) => {
    const forKey = keyRef.current;
    const mine = ++ticket.current;
    dispatch({ type: "start", key: forKey, silent });
    if (forKey === null) return;
    try {
      const data = await fetchRef.current();
      if (mine === ticket.current) dispatch({ type: "ok", key: forKey, data, at: Date.now() });
    } catch (err) {
      if (mine === ticket.current) dispatch({ type: "fail", key: forKey, error: asError(err) });
    }
  }, []);

  useEffect(() => {
    void run(false);
    return () => {
      ticket.current++;
    };
  }, [key, run]);

  const polling = opts.pollMs !== undefined && view.data !== null && (opts.active ? opts.active(view.data) : true);
  useEffect(() => {
    if (!polling || opts.pollMs === undefined) return;
    const timer = window.setInterval(() => void run(true), opts.pollMs);
    return () => window.clearInterval(timer);
  }, [polling, opts.pollMs, run]);

  const reload = useCallback(() => run(false), [run]);
  const setData = useCallback(
    (data: T) => dispatch({ type: "set", key: keyRef.current, data, at: Date.now() }),
    [],
  );

  return {
    data: view.data,
    loading: view.loading,
    error: view.error,
    missing: missingKind(view.error, opts.kind),
    updatedAt: view.updatedAt,
    reload,
    setData,
  };
}

export type AgentLoad = {
  detail: AgentDetail | null;
  loading: boolean;
  error: Error | null;
  missing: MissingKind | null;
  reload: () => Promise<void>;
  setDetail: (detail: AgentDetail) => void;
};

export function useAgentDetail(agentId: string): AgentLoad {
  const resource = useResource(agentId, () => agentsApi.get(agentId), { kind: "agent" });
  return {
    detail: resource.data,
    loading: resource.loading,
    error: resource.error,
    missing: resource.missing,
    reload: resource.reload,
    setDetail: resource.setData,
  };
}
