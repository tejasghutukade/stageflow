import { useCallback, useEffect, useRef, useState } from "react";
import { submitStageAnswer, type PendingPrompt } from "../api";
import { useRunCatalogHandle } from "../catalog/useRunCatalog";
import {
  createAnswerSession,
  isLocked,
  pendingIdentityKey,
  type AnswerSession,
  type OperatorIntent,
  type PromptRef,
} from "./answerRules";

export function useOperatorAnswer(
  runId: string,
  stageId: string | undefined,
  pending: PromptRef | null,
) {
  const catalog = useRunCatalogHandle();
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const targetRef = useRef({ runId, stageId });
  targetRef.current = { runId, stageId };
  const catalogRef = useRef(catalog);
  catalogRef.current = catalog;

  const sessionRef = useRef<AnswerSession | null>(null);
  if (sessionRef.current === null) {
    sessionRef.current = createAnswerSession({
      getPending: () => pendingRef.current,
      getTarget: () => targetRef.current,
      submit: (rid, sid, answer) => submitStageAnswer(rid, sid, answer),
      refresh: () => catalogRef.current.refresh(),
    });
  }
  const session = sessionRef.current;

  const [state, setState] = useState(() => session.getState());
  const identity = pendingIdentityKey(pending);

  useEffect(() => {
    session.syncPending();
    setState(session.getState());
  }, [identity, session]);

  const submitIntent = useCallback(
    async (intent: OperatorIntent, prompt?: PendingPrompt) => {
      const done = session.submitIntent(intent, prompt);
      setState(session.getState());
      await done;
      setState(session.getState());
    },
    [session],
  );

  return {
    submitting: state.submitting,
    awaitingClear: state.awaitingClear,
    error: state.error,
    locked: isLocked(state),
    submitIntent,
  };
}
