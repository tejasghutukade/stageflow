import { useCallback, useEffect, useRef, useState } from "react";
import { abandonStage } from "../api";

export type StageAbandonState = {
  abandoningStageId: string | null;
  error: string | null;
};

export type StageAbandonDeps = {
  abandon: (stageId: string) => Promise<void>;
  onSuccess: () => void | Promise<void>;
  confirm?: (stageId: string) => boolean;
};

export const ABANDON_CONFIRM_MESSAGE =
  "This stage will be marked failed. Retry stage will become available.";

export function createStageAbandonSession(deps: StageAbandonDeps) {
  let state: StageAbandonState = { abandoningStageId: null, error: null };
  let inFlight = false;
  const listeners = new Set<() => void>();

  const getState = (): StageAbandonState => state;

  const notify = () => {
    for (const listener of listeners) listener();
  };

  const clearError = () => {
    if (state.error === null) return;
    state = { ...state, error: null };
    notify();
  };

  const abandon = async (stageId: string) => {
    if (inFlight) return;
    const confirmed =
      deps.confirm?.(stageId) ?? window.confirm(ABANDON_CONFIRM_MESSAGE);
    if (!confirmed) return;
    inFlight = true;
    state = { abandoningStageId: stageId, error: null };
    notify();
    try {
      await deps.abandon(stageId);
      await deps.onSuccess();
    } catch (err) {
      state = {
        ...state,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      inFlight = false;
      state = { ...state, abandoningStageId: null };
      notify();
    }
  };

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  return { getState, abandon, clearError, subscribe };
}

export function useStageAbandon(
  runId: string,
  onSuccess: () => void | Promise<void>,
) {
  const runIdRef = useRef(runId);
  runIdRef.current = runId;
  const onSuccessRef = useRef(onSuccess);
  onSuccessRef.current = onSuccess;

  const sessionRef = useRef<ReturnType<typeof createStageAbandonSession> | null>(
    null,
  );
  if (sessionRef.current === null) {
    sessionRef.current = createStageAbandonSession({
      abandon: async (stageId) => {
        await abandonStage(runIdRef.current, stageId);
      },
      onSuccess: () => onSuccessRef.current(),
    });
  }
  const session = sessionRef.current;

  const [state, setState] = useState(() => session.getState());

  useEffect(() => {
    return session.subscribe(() => setState(session.getState()));
  }, [session]);

  const abandon = useCallback(
    (stageId: string) => void session.abandon(stageId),
    [session],
  );

  const clearError = useCallback(() => session.clearError(), [session]);

  return {
    abandoningStageId: state.abandoningStageId,
    error: state.error,
    abandon,
    clearError,
  };
}
