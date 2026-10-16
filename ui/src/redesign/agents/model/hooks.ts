import { useCallback, useEffect, useRef, useState } from "react";
import { fetchChannelConnections, fetchProjectMcp, fetchSkills } from "../../../api";
import { setStageflowCatalog } from "./definition";
import { agentsApi, AgentApiError, type AgentDefinition, type AgentDetail, type AgentIssue, type StageflowToolCatalog } from "../../../api/agents";

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

export type AgentLoad = {
  detail: AgentDetail | null;
  loading: boolean;
  error: AgentApiError | Error | null;
  reload: () => Promise<void>;
  setDetail: (detail: AgentDetail) => void;
};

export function useAgentDetail(agentId: string): AgentLoad {
  const [detail, setDetail] = useState<AgentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<AgentApiError | Error | null>(null);
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setDetail(await agentsApi.get(agentId));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, [agentId]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { detail, loading, error, reload, setDetail };
}
