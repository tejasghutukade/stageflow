import { useCallback, useEffect, useRef, useState } from "react";
import { cancelRun, deleteRun } from "../api";
import {
  createRunCancelSession,
  createRunDeleteSession,
  isActiveRunStatus,
} from "./runActions";
import type { RunStatus } from "../api";

export function useRunCancel(
  runId: string,
  onSuccess: () => void | Promise<void>,
) {
  const runIdRef = useRef(runId);
  runIdRef.current = runId;
  const onSuccessRef = useRef(onSuccess);
  onSuccessRef.current = onSuccess;

  const sessionRef = useRef<ReturnType<typeof createRunCancelSession> | null>(
    null,
  );
  if (sessionRef.current === null) {
    sessionRef.current = createRunCancelSession({
      cancel: async (reason) => {
        await cancelRun(runIdRef.current, reason);
      },
      onSuccess: () => onSuccessRef.current(),
    });
  }
  const session = sessionRef.current;

  const [state, setState] = useState(() => session.getState());

  useEffect(() => {
    return session.subscribe(() => setState(session.getState()));
  }, [session]);

  const cancel = useCallback(() => void session.cancel(), [session]);
  const clearError = useCallback(() => session.clearError(), [session]);

  return {
    cancelling: state.cancelling,
    error: state.error,
    cancel,
    clearError,
  };
}

export function useRunDelete(
  runId: string,
  status: RunStatus | undefined,
  onSuccess: () => void | Promise<void>,
) {
  const runIdRef = useRef(runId);
  runIdRef.current = runId;
  const onSuccessRef = useRef(onSuccess);
  onSuccessRef.current = onSuccess;
  const isActive = status !== undefined && isActiveRunStatus(status);
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;

  const sessionRef = useRef<ReturnType<typeof createRunDeleteSession> | null>(
    null,
  );
  if (sessionRef.current === null) {
    sessionRef.current = createRunDeleteSession({
      deleteRun: async (force) => {
        await deleteRun(runIdRef.current, { force });
      },
      onSuccess: () => onSuccessRef.current(),
      get isActive() {
        return isActiveRef.current;
      },
    });
  }
  const session = sessionRef.current;

  const [state, setState] = useState(() => session.getState());

  useEffect(() => {
    return session.subscribe(() => setState(session.getState()));
  }, [session]);

  const remove = useCallback(
    () => void session.deleteRun(runIdRef.current),
    [session],
  );
  const clearError = useCallback(() => session.clearError(), [session]);

  return {
    deleting: state.deleting,
    error: state.error,
    deleteRun: remove,
    clearError,
  };
}
