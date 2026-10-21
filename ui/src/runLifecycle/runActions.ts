import type { RunStatus } from "../api";

export type RunCancelState = {
  cancelling: boolean;
  error: string | null;
};

export type RunDeleteState = {
  deleting: boolean;
  error: string | null;
};

export type RunCancelDeps = {
  cancel: (reason: string) => Promise<void>;
  onSuccess: () => void | Promise<void>;
  promptReason?: () => string | null;
};

export type RunDeleteDeps = {
  deleteRun: (force: boolean) => Promise<void>;
  onSuccess: () => void | Promise<void>;
  confirmTyped?: (runId: string) => boolean;
  isActive: boolean;
};

export const CANCEL_REASON_PROMPT =
  "Cancel this run? Enter a short reason (required):";

export const DEFAULT_CANCEL_REASON = "Cancelled from operator console";

export function canCancelRun(status: RunStatus): boolean {
  return status === "created" || status === "queued" || status === "running";
}

export function canDeleteRun(status: RunStatus): boolean {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "created" ||
    status === "queued" ||
    status === "running"
  );
}

export function isActiveRunStatus(status: RunStatus): boolean {
  return status === "created" || status === "queued" || status === "running";
}

export function typedDeleteConfirm(
  runId: string,
  promptFn: (message: string) => string | null = window.prompt.bind(window),
): boolean {
  const typed = promptFn(
    `Type the run id to permanently delete it:\n${runId}`,
  );
  return typed === runId;
}

export function createRunCancelSession(deps: RunCancelDeps) {
  let state: RunCancelState = { cancelling: false, error: null };
  let inFlight = false;
  const listeners = new Set<() => void>();

  const getState = (): RunCancelState => state;

  const notify = () => {
    for (const listener of listeners) listener();
  };

  const clearError = () => {
    if (state.error === null) return;
    state = { ...state, error: null };
    notify();
  };

  const cancel = async () => {
    if (inFlight) return;
    const reasonRaw = deps.promptReason
      ? deps.promptReason()
      : window.prompt(CANCEL_REASON_PROMPT, DEFAULT_CANCEL_REASON);
    if (reasonRaw === null) return;
    const reason = reasonRaw.trim();
    if (reason === "") return;
    inFlight = true;
    state = { cancelling: true, error: null };
    notify();
    try {
      await deps.cancel(reason);
      await deps.onSuccess();
    } catch (err) {
      state = {
        ...state,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      inFlight = false;
      state = { ...state, cancelling: false };
      notify();
    }
  };

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  return { getState, cancel, clearError, subscribe };
}

export function createRunDeleteSession(deps: RunDeleteDeps) {
  let state: RunDeleteState = { deleting: false, error: null };
  let inFlight = false;
  const listeners = new Set<() => void>();

  const getState = (): RunDeleteState => state;

  const notify = () => {
    for (const listener of listeners) listener();
  };

  const clearError = () => {
    if (state.error === null) return;
    state = { ...state, error: null };
    notify();
  };

  const deleteRun = async (runId: string) => {
    if (inFlight) return;
    const confirmed =
      deps.confirmTyped?.(runId) ?? typedDeleteConfirm(runId);
    if (!confirmed) return;
    inFlight = true;
    state = { deleting: true, error: null };
    notify();
    try {
      await deps.deleteRun(deps.isActive);
      await deps.onSuccess();
    } catch (err) {
      state = {
        ...state,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      inFlight = false;
      state = { ...state, deleting: false };
      notify();
    }
  };

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  return { getState, deleteRun, clearError, subscribe };
}
