import { useCallback, useEffect, useState } from "react";
import { fetchEvalAgentTargets } from "../../../api/evalsClient";
import type { EvalAgentTarget } from "../../../api/evalTypes";

export type AgentTargetsState = {
  loading: boolean;
  error: string | null;
  items: EvalAgentTarget[];
  reload: () => void;
};

/** `GET /api/evals/agent-targets`, loaded once when an agent picker is on screen. */
export function useAgentTargets(enabled: boolean, projectRoot?: string): AgentTargetsState {
  const [state, setState] = useState<Omit<AgentTargetsState, "reload">>({ loading: enabled, error: null, items: [] });
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));
    fetchEvalAgentTargets(projectRoot).then(
      (res) => {
        if (!cancelled) setState({ loading: false, error: null, items: res.items });
      },
      (err: unknown) => {
        if (!cancelled) setState({ loading: false, error: err instanceof Error ? err.message : String(err), items: [] });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [enabled, projectRoot, nonce]);

  return { ...state, reload };
}
