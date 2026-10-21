import { AgentApiError } from "../../../api/agents";

/** What a 404 means for the page that asked: the thing it was loading is gone. */
export type MissingKind = "agent" | "session" | "run";

export type ResourceState<T> = {
  /** Which resource the data belongs to; a change of key drops the old data. */
  key: string | null;
  data: T | null;
  loading: boolean;
  error: Error | null;
  /** When `data` last arrived from the server. */
  updatedAt: number | null;
};

export type ResourceAction<T> =
  | { type: "start"; key: string | null; silent?: boolean }
  | { type: "ok"; key: string | null; data: T; at: number }
  | { type: "fail"; key: string | null; error: Error }
  | { type: "set"; key: string | null; data: T; at: number };

export function initialResource<T>(key: string | null): ResourceState<T> {
  return { key, data: null, loading: key !== null, error: null, updatedAt: null };
}

/**
 * A new key starts clean (no old agent's data under a new id); a result for a key that is no longer
 * current is ignored. A silent start (polling) neither flips `loading` nor clears anything.
 */
export function resourceReducer<T>(state: ResourceState<T>, action: ResourceAction<T>): ResourceState<T> {
  if (action.type === "start") {
    if (action.key !== state.key) return initialResource(action.key);
    return action.silent ? state : { ...state, loading: true };
  }
  if (action.key !== state.key) return state;
  if (action.type === "fail") return { ...state, loading: false, error: action.error };
  return { ...state, data: action.data, loading: false, error: null, updatedAt: action.at };
}

export function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/** `kind` when the host answered 404, otherwise null (a network or server failure is not "missing"). */
export function missingKind(error: Error | null, kind: MissingKind): MissingKind | null {
  return error instanceof AgentApiError && error.status === 404 ? kind : null;
}

export const MISSING_COPY: Record<MissingKind, { title: string; body: string; back: string }> = {
  agent: { title: "Agent not found", body: "This agent is not in the project.", back: "All agents" },
  session: { title: "Session not found", body: "This session does not exist for this agent.", back: "Back to agent" },
  run: { title: "Run not found", body: "This run is not in the session.", back: "Back to session" },
};
