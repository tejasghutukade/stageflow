import { useCallback, useEffect, useState } from "react";
import {
  EvalApiError,
  acceptEvalSuggestions,
  dismissEvalSuggestions,
  fetchEvalClassifierStatus,
  fetchEvalSuggestions,
  sortEvalFailures,
} from "../../../api/evalsClient";
import type {
  EvalClassifierName,
  EvalClassifierStatus,
  EvalSortResult,
  EvalSuggestionsResponse,
} from "../../../api/evalTypes";

export type SortState =
  | { phase: "idle" }
  | { phase: "sorting" }
  | { phase: "done"; result: EvalSortResult }
  | { phase: "unavailable" }
  | { phase: "error"; message: string };

export type Triage = {
  status: EvalClassifierStatus | null;
  suggestions: EvalSuggestionsResponse | null;
  suggestionsError: string | null;
  sort: SortState;
  notice: string | null;
  busy: boolean;
  runSort: (classifier?: EvalClassifierName | "auto") => Promise<void>;
  accept: (input: { ids?: string[]; min_confidence?: number }) => Promise<{ accepted: number; tagged: number } | null>;
  dismiss: (ids: string[]) => Promise<void>;
  reload: () => void;
};

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function useTriage(evalRunId: string, onTagsChanged: () => void): Triage {
  const [status, setStatus] = useState<EvalClassifierStatus | null>(null);
  const [suggestions, setSuggestions] = useState<EvalSuggestionsResponse | null>(null);
  const [suggestionsError, setSuggestionsError] = useState<string | null>(null);
  const [sort, setSort] = useState<SortState>({ phase: "idle" });
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    setSort({ phase: "idle" });
    setNotice(null);
    setStatus(null);
    setSuggestions(null);
  }, [evalRunId]);

  useEffect(() => {
    let cancelled = false;
    fetchEvalClassifierStatus(evalRunId).then(
      (s) => {
        if (!cancelled) setStatus(s);
      },
      () => {
        if (!cancelled) setStatus({ classifiers: { jev: { available: false, model: null }, judge: { available: false, model: null } }, default: null });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [evalRunId, nonce]);

  useEffect(() => {
    let cancelled = false;
    fetchEvalSuggestions(evalRunId).then(
      (r) => {
        if (!cancelled) {
          setSuggestions(r);
          setSuggestionsError(null);
        }
      },
      (err) => {
        if (!cancelled) setSuggestionsError(messageOf(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [evalRunId, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  const runSort = useCallback(
    async (classifier: EvalClassifierName | "auto" = "auto") => {
      setSort({ phase: "sorting" });
      setNotice(null);
      try {
        const result = await sortEvalFailures(evalRunId, { classifier });
        setSort({ phase: "done", result });
        reload();
      } catch (err) {
        if (err instanceof EvalApiError && err.code === "EVAL_CLASSIFIER_UNAVAILABLE") setSort({ phase: "unavailable" });
        else setSort({ phase: "error", message: messageOf(err) });
      }
    },
    [evalRunId, reload],
  );

  const accept = useCallback(
    async (input: { ids?: string[]; min_confidence?: number }) => {
      setBusy(true);
      setNotice(null);
      try {
        const r = await acceptEvalSuggestions(evalRunId, input);
        reload();
        onTagsChanged();
        return r;
      } catch (err) {
        setNotice(messageOf(err));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [evalRunId, reload, onTagsChanged],
  );

  const dismiss = useCallback(
    async (ids: string[]) => {
      setBusy(true);
      setNotice(null);
      try {
        await dismissEvalSuggestions(evalRunId, ids);
        reload();
      } catch (err) {
        setNotice(messageOf(err));
      } finally {
        setBusy(false);
      }
    },
    [evalRunId, reload],
  );

  return { status, suggestions, suggestionsError, sort, notice, busy, runSort, accept, dismiss, reload };
}
