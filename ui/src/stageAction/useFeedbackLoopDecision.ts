import { useCallback, useEffect, useRef, useState } from "react";
import {
  postFeedbackDecision,
  type FeedbackLoopDecisionKind,
} from "../api";

export type FeedbackLoopDecisionState = {
  submitting: boolean;
  error: string | null;
};

export type FeedbackLoopDecisionDeps = {
  submit: (
    stageId: string,
    body: {
      decision: FeedbackLoopDecisionKind;
      loopId?: string;
      reason?: string;
    },
  ) => Promise<void>;
  onSuccess: () => void | Promise<void>;
};

export function createFeedbackLoopDecisionSession(
  deps: FeedbackLoopDecisionDeps,
) {
  let state: FeedbackLoopDecisionState = { submitting: false, error: null };
  const listeners = new Set<() => void>();

  const getState = (): FeedbackLoopDecisionState => state;

  const notify = () => {
    for (const listener of listeners) listener();
  };

  const clearError = () => {
    if (state.error === null) return;
    state = { ...state, error: null };
    notify();
  };

  const decide = async (
    stageId: string,
    body: {
      decision: FeedbackLoopDecisionKind;
      loopId?: string;
      reason?: string;
    },
  ) => {
    if (state.submitting) return;
    state = { submitting: true, error: null };
    notify();
    try {
      await deps.submit(stageId, body);
      await deps.onSuccess();
    } catch (err) {
      state = {
        ...state,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      state = { ...state, submitting: false };
      notify();
    }
  };

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  return { getState, decide, clearError, subscribe };
}

export function useFeedbackLoopDecision(
  runId: string,
  onSuccess: () => void | Promise<void>,
) {
  const runIdRef = useRef(runId);
  runIdRef.current = runId;
  const onSuccessRef = useRef(onSuccess);
  onSuccessRef.current = onSuccess;

  const sessionRef = useRef<ReturnType<
    typeof createFeedbackLoopDecisionSession
  > | null>(null);
  if (sessionRef.current === null) {
    sessionRef.current = createFeedbackLoopDecisionSession({
      submit: async (stageId, body) => {
        await postFeedbackDecision(runIdRef.current, stageId, body);
      },
      onSuccess: () => onSuccessRef.current(),
    });
  }
  const session = sessionRef.current;

  const [state, setState] = useState(() => session.getState());

  useEffect(() => {
    return session.subscribe(() => setState(session.getState()));
  }, [session]);

  const decide = useCallback(
    (
      stageId: string,
      body: {
        decision: FeedbackLoopDecisionKind;
        loopId?: string;
        reason?: string;
      },
    ) => void session.decide(stageId, body),
    [session],
  );

  const clearError = useCallback(() => session.clearError(), [session]);

  return {
    submitting: state.submitting,
    error: state.error,
    decide,
    clearError,
  };
}
