import { useCallback, useEffect, useRef, useState } from "react";
import { resumeTimedOutStage } from "../api";

export type StageResumeState = {
  resumingStageIds: ReadonlySet<string>;
  error: string | null;
};

export type StageResumeDeps = {
  resume: (stageId: string) => Promise<void>;
  onSuccess: () => void | Promise<void>;
};

export function createStageResumeSession(deps: StageResumeDeps) {
  let state: StageResumeState = { resumingStageIds: new Set(), error: null };
  const listeners = new Set<() => void>();

  const getState = (): StageResumeState => state;

  const notify = () => {
    for (const listener of listeners) listener();
  };

  const clearError = () => {
    if (state.error === null) return;
    state = { ...state, error: null };
    notify();
  };

  const resume = async (stageId: string) => {
    if (state.resumingStageIds.has(stageId)) return;
    const resumingStageIds = new Set(state.resumingStageIds);
    resumingStageIds.add(stageId);
    state = { resumingStageIds, error: null };
    notify();
    try {
      await deps.resume(stageId);
      await deps.onSuccess();
    } catch (err) {
      state = {
        ...state,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      const done = new Set(state.resumingStageIds);
      done.delete(stageId);
      state = { ...state, resumingStageIds: done };
      notify();
    }
  };

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  return { getState, resume, clearError, subscribe };
}

export function useStageResume(
  runId: string,
  onSuccess: () => void | Promise<void>,
) {
  const runIdRef = useRef(runId);
  runIdRef.current = runId;
  const onSuccessRef = useRef(onSuccess);
  onSuccessRef.current = onSuccess;

  const sessionRef = useRef<ReturnType<typeof createStageResumeSession> | null>(
    null,
  );
  if (sessionRef.current === null) {
    sessionRef.current = createStageResumeSession({
      resume: async (stageId) => {
        await resumeTimedOutStage(runIdRef.current, stageId);
      },
      onSuccess: () => onSuccessRef.current(),
    });
  }

  const session = sessionRef.current;
  const [state, setState] = useState(session.getState);

  useEffect(() => session.subscribe(() => setState(session.getState())), [session]);

  const resume = useCallback(
    (stageId: string) => {
      void session.resume(stageId);
    },
    [session],
  );

  return {
    resumingStageIds: state.resumingStageIds,
    error: state.error,
    resume,
    clearError: session.clearError,
  };
}
