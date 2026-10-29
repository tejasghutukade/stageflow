import { useCallback, useEffect, useState } from "react";
import {
  fetchEvalFailureTypes,
  fetchEvalResultCase,
  fetchEvalResults,
  fetchEvalRuns,
  fetchRun,
} from "../../../api";
import type {
  EvalCaseResults,
  EvalResultRow,
  EvalResultsPage,
  EvalResultsQuery,
} from "../../../api/evalTypes";
import { agentsApi } from "../../../api/agents";
import { fetchRunExport, type RunExport } from "./resultsApi";
import { errorMessage } from "./errorText";

type Async<T> = { data: T | null; error: string | null; loading: boolean };

export function useRunNumbers(evalId: string, projectRoot?: string): number[] {
  const [numbers, setNumbers] = useState<number[]>([]);
  useEffect(() => {
    let cancelled = false;
    fetchEvalRuns({ eval_id: evalId, limit: 200, project_root: projectRoot }).then(
      (page) => {
        if (!cancelled) setNumbers(page.items.map((item) => item.run_number));
      },
      () => {
        if (!cancelled) setNumbers([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [evalId, projectRoot]);
  return numbers;
}

export function useAllRows(evalRunId: string): EvalResultRow[] | null {
  const [rows, setRows] = useState<EvalResultRow[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    setRows(null);
    (async () => {
      const all: EvalResultRow[] = [];
      let cursor: string | undefined;
      do {
        const page = await fetchEvalResults(evalRunId, { limit: 200, ...(cursor ? { cursor } : {}) });
        all.push(...page.items);
        cursor = page.next_cursor ?? undefined;
      } while (cursor);
      if (!cancelled) setRows(all);
    })().catch(() => {
      if (!cancelled) setRows([]);
    });
    return () => {
      cancelled = true;
    };
  }, [evalRunId]);
  return rows;
}

export function useResultsPage(evalRunId: string, query: EvalResultsQuery, nonce = 0): Async<EvalResultsPage> {
  const key = JSON.stringify(query);
  const [state, setState] = useState<Async<EvalResultsPage>>({ data: null, error: null, loading: true });
  useEffect(() => {
    let cancelled = false;
    setState((prev) => ({ ...prev, loading: true, error: null }));
    fetchEvalResults(evalRunId, JSON.parse(key) as EvalResultsQuery).then(
      (data) => {
        if (!cancelled) setState({ data, error: null, loading: false });
      },
      (err) => {
        if (!cancelled) setState((prev) => ({ ...prev, error: errorMessage(err), loading: false }));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [evalRunId, key, nonce]);
  return state;
}

/** Every page of results for a query, for client-side filters the API does not know (suggestion buckets). */
export function useAllResultsFor(evalRunId: string, query: EvalResultsQuery, enabled: boolean): Async<EvalResultRow[]> {
  const key = JSON.stringify(query);
  const [state, setState] = useState<Async<EvalResultRow[]>>({ data: null, error: null, loading: false });
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setState((prev) => ({ ...prev, loading: true, error: null }));
    (async () => {
      const all: EvalResultRow[] = [];
      let cursor: string | undefined;
      do {
        const page = await fetchEvalResults(evalRunId, { ...(JSON.parse(key) as EvalResultsQuery), limit: 200, ...(cursor ? { cursor } : {}) });
        all.push(...page.items);
        cursor = page.next_cursor ?? undefined;
      } while (cursor);
      if (!cancelled) setState({ data: all, error: null, loading: false });
    })().catch((err) => {
      if (!cancelled) setState({ data: null, error: errorMessage(err), loading: false });
    });
    return () => {
      cancelled = true;
    };
  }, [evalRunId, key, enabled]);
  return state;
}

export function useCaseResults(evalRunId: string, caseId: string | null) {
  const [state, setState] = useState<Async<EvalCaseResults>>({ data: null, error: null, loading: false });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (caseId === null) return;
    let cancelled = false;
    setState({ data: null, error: null, loading: true });
    fetchEvalResultCase(evalRunId, caseId).then(
      (data) => {
        if (!cancelled) setState({ data, error: null, loading: false });
      },
      (err) => {
        if (!cancelled) setState({ data: null, error: errorMessage(err), loading: false });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [evalRunId, caseId, nonce]);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { ...state, reload };
}

export function useFailureTypes(evalId: string, projectRoot?: string) {
  const [items, setItems] = useState<string[]>([]);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let cancelled = false;
    fetchEvalFailureTypes(evalId, projectRoot).then(
      (res) => {
        if (!cancelled) setItems(res.items);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [evalId, projectRoot, nonce]);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { items, reload };
}

export function useRunExport(evalRunId: string, enabled: boolean): Async<RunExport> {
  const [state, setState] = useState<Async<RunExport>>({ data: null, error: null, loading: false });
  useEffect(() => {
    setState({ data: null, error: null, loading: false });
  }, [evalRunId]);
  useEffect(() => {
    if (!enabled || state.data || state.loading || state.error) return;
    let cancelled = false;
    setState({ data: null, error: null, loading: true });
    fetchRunExport(evalRunId).then(
      (data) => {
        if (!cancelled) setState({ data, error: null, loading: false });
      },
      (err) => {
        if (!cancelled) setState({ data: null, error: errorMessage(err), loading: false });
      },
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [evalRunId, enabled]);
  return state;
}

export type AgentSessionState = { status: "none" | "loading" | "found" | "deleted"; runId: string };

/** Whether the eval session still exists, and the first turn to open on the Agent run page. */
export function useAgentSession(agentId: string | null, sessionId: string | null): AgentSessionState {
  const [state, setState] = useState<AgentSessionState>({ status: "none", runId: "1" });
  useEffect(() => {
    if (!agentId || !sessionId) {
      setState({ status: "none", runId: "1" });
      return;
    }
    let cancelled = false;
    setState({ status: "loading", runId: "1" });
    agentsApi.session(agentId, sessionId).then(
      (detail) => {
        if (!cancelled) setState({ status: "found", runId: String(detail.turns[0]?.seq ?? 1) });
      },
      () => {
        if (!cancelled) setState({ status: "deleted", runId: "1" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [agentId, sessionId]);
  return state;
}

export function useStageRunExists(stageRunId: string | null): boolean {
  const [exists, setExists] = useState(false);
  useEffect(() => {
    setExists(false);
    if (!stageRunId) return;
    let cancelled = false;
    fetchRun(stageRunId).then(
      () => {
        if (!cancelled) setExists(true);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [stageRunId]);
  return exists;
}
