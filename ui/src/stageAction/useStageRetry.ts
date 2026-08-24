import { useCallback, useEffect, useRef, useState } from "react";
import { retryStage } from "../api";

export type StageRetryState = {
  retryingStageIds: ReadonlySet<string>;
  error: string | null;
};

export type StageRetryDeps = {
  retry: (stageId: string) => Promise<void>;
  onSuccess: () => void | Promise<void>;
};

export function createStageRetrySession(deps: StageRetryDeps) {
  let state: StageRetryState = { retryingStageIds: new Set(), error: null };
  const listeners = new Set<() => void>();

  const getState = (): StageRetryState => state;

  const notify = () => {
    for (const listener of listeners) listener();
  };

  const clearError = () => {
    if (state.error === null) return;
    state = { ...state, error: null };
    notify();
  };

  const retry = async (stageId: string) => {
    if (state.retryingStageIds.has(stageId)) return;
    const retryingStageIds = new Set(state.retryingStageIds);
    retryingStageIds.add(stageId);
    state = { retryingStageIds, error: null };
    notify();
    try {
      await deps.retry(stageId);
      await deps.onSuccess();
    } catch (err) {
      state = {
        ...state,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      const done = new Set(state.retryingStageIds);
      done.delete(stageId);
      state = { ...state, retryingStageIds: done };
      notify();
    }
  };

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  return { getState, retry, clearError, subscribe };
}

export function useStageRetry(
  runId: string,
  onSuccess: () => void | Promise<void>,
) {
  const runIdRef = useRef(runId);
  runIdRef.current = runId;
  const onSuccessRef = useRef(onSuccess);
  onSuccessRef.current = onSuccess;

  const sessionRef = useRef<ReturnType<typeof createStageRetrySession> | null>(
    null,
  );
  if (sessionRef.current === null) {
    sessionRef.current = createStageRetrySession({
      retry: async (stageId) => {
        await retryStage(runIdRef.current, stageId);
      },
      onSuccess: () => onSuccessRef.current(),
    });
  }
  const session = sessionRef.current;

  const [state, setState] = useState(() => session.getState());

  useEffect(() => {
    return session.subscribe(() => setState(session.getState()));
  }, [session]);

  const retry = useCallback(
    (stageId: string) => void session.retry(stageId),
    [session],
  );

  const clearError = useCallback(() => session.clearError(), [session]);

  return {
    retryingStageIds: state.retryingStageIds,
    error: state.error,
    retry,
    clearError,
  };
}
