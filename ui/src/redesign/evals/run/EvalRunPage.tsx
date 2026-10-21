import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cancelEvalRun, fetchEvalResults, fetchEvalRunByNumber } from "../../../api";
import type { EvalResultRow, EvalRunDetail, EvalRunStatus } from "../../../api/evalTypes";
import { evalComparePath, evalsPath, navigate, type EvalRunTab } from "../../../routes";
import { MODAL_SCRIM_PT, OVERLAY_SCRIM_CLASS } from "../../overlay/overlayScrimClasses";
import { useOverlayChrome } from "../../overlay/useOverlayChrome";
import { PageHeader } from "../../shell/PageHeader";
import { LiveProgress, StopButton } from "./LiveProgress";
import { RunResultsPage } from "../results/RunResultsPage";
import {
  POLL_INTERVAL_MS,
  STOP_CONFIRM_TEXT,
  buildLiveModel,
  decideFinish,
  isActiveStatus,
  liveSubtitle,
  runDatasetPath,
  type LiveCase,
} from "./liveProgressModel";
import { datasetIdOf } from "./runDialogModel";
import { readCompareIntent } from "./runDialogStore";
import { loadCases } from "./useRunDialogData";

type PollState = {
  run: EvalRunDetail | null;
  results: EvalResultRow[];
  error: string | null;
};

function useEvalRunPolling(evalId: string, runNumber: number, projectRoot?: string) {
  const [state, setState] = useState<PollState>({ run: null, results: [], error: null });
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    let lastActive = false;
    setState({ run: null, results: [], error: null });

    const tick = async () => {
      let again = true;
      try {
        const run = await fetchEvalRunByNumber(evalId, runNumber, projectRoot);
        if (cancelled) return;
        lastActive = isActiveStatus(run.status);
        let results: EvalResultRow[] | null = null;
        if (isActiveStatus(run.status)) {
          results = await fetchEvalResults(run.eval_run_id, { limit: 200 }).then(
            (page) => page.items,
            () => null,
          );
        } else {
          again = false;
        }
        if (cancelled) return;
        setState((prev) => ({ run, results: results ?? prev.results, error: null }));
      } catch (err) {
        if (cancelled) return;
        setState((prev) => ({ ...prev, error: err instanceof Error ? err.message : String(err) }));
        again = lastActive;
      }
      if (again && !cancelled) timer = window.setTimeout(() => void tick(), POLL_INTERVAL_MS);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [evalId, runNumber, projectRoot, nonce]);

  return { ...state, refresh };
}

function useCases(run: EvalRunDetail | null): LiveCase[] | null {
  const [cases, setCases] = useState<LiveCase[] | null>(null);
  const datasetPath = run ? runDatasetPath(run) : null;
  const evalId = run?.eval_id;
  const loaded = useRef<string | null>(null);
  const active = run ? isActiveStatus(run.status) : false;

  useEffect(() => {
    if (!active || !datasetPath || !evalId || loaded.current === `${evalId}\0${datasetPath}`) return;
    loaded.current = `${evalId}\0${datasetPath}`;
    loadCases(datasetIdOf(datasetPath), evalId).then(
      ({ cases: list }) => setCases(list.map((c, index) => ({ id: c.id, title: c.title ?? null, position: index + 1 }))),
      () => setCases(null),
    );
  }, [active, datasetPath, evalId]);

  return cases;
}

function StopConfirm({ onConfirm, onClose }: { onConfirm: () => void; onClose: () => void }) {
  useOverlayChrome(true);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return createPortal(
    <div className={`${OVERLAY_SCRIM_CLASS} ${MODAL_SCRIM_PT}`} role="presentation" onClick={onClose}>
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="sf-stop-title"
        onClick={(e) => e.stopPropagation()}
        className="flex w-[420px] flex-col gap-4 rounded-[14px] border border-[#ffffff1a] bg-[var(--sf-panel)] p-5 shadow-[0px_32px_96px_rgba(0,0,0,0.65)]"
      >
        <div className="flex flex-col gap-1">
          <h2 id="sf-stop-title" className="text-base font-semibold text-[var(--sf-text-1)]">
            Stop this run?
          </h2>
          <p className="text-[13px] text-[var(--sf-text-2)]">{STOP_CONFIRM_TEXT}</p>
        </div>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 items-center rounded-lg border border-[var(--sf-hairline-strong)] px-3 text-[13px] font-medium text-[var(--sf-text-1)]"
          >
            Keep running
          </button>
          <button
            type="button"
            autoFocus
            onClick={onConfirm}
            className="flex h-8 items-center rounded-lg bg-[var(--sf-text-1)] px-3 text-[13px] font-medium text-[var(--sf-ground)]"
          >
            Stop run
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function StatusChip({ status }: { status: EvalRunStatus }) {
  return (
    <span className="flex items-center gap-1.5 rounded-md bg-[var(--sf-running-bg)] px-2 py-0.5 text-xs text-[var(--sf-running)]">
      <span className="block size-1.5 rounded-full bg-[var(--sf-running)]" />
      {status === "queued" ? "Queued" : "Running"}
    </span>
  );
}

export function EvalRunPage({
  evalId,
  runNumber,
  tab,
  caseId,
  repeat,
}: {
  evalId: string;
  runNumber: number;
  tab?: EvalRunTab;
  caseId?: string;
  repeat?: number;
}) {
  const { run, results, error, refresh } = useEvalRunPolling(evalId, runNumber);
  const cases = useCases(run);
  const [now, setNow] = useState(() => Date.now());
  const [confirming, setConfirming] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const previousStatus = useRef<EvalRunStatus | null>(null);

  const active = run ? isActiveStatus(run.status) : false;

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);

  useEffect(() => {
    previousStatus.current = null;
  }, [evalId, runNumber]);

  useEffect(() => {
    if (!run) return;
    const route = decideFinish({
      previousStatus: previousStatus.current,
      run,
      compareWith: readCompareIntent(evalId, runNumber),
    });
    previousStatus.current = run.status;
    if (route.kind === "compare") navigate(evalComparePath(evalId, { a: route.a, b: route.b }));
  }, [run, evalId, runNumber]);

  const model = useMemo(
    () => (run && active ? buildLiveModel({ run, results, cases, now }) : null),
    [run, active, results, cases, now],
  );

  async function stop() {
    if (!run) return;
    setConfirming(false);
    setStopping(true);
    setStopError(null);
    try {
      await cancelEvalRun(run.eval_run_id);
      refresh();
    } catch (err) {
      setStopError(err instanceof Error ? err.message : String(err));
    } finally {
      setStopping(false);
    }
  }

  const crumbs = [{ label: "Evals", onClick: () => navigate(evalsPath()) }];

  if (!run) {
    return (
      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-[var(--sf-ground)]">
        <PageHeader title={evalId} crumbs={crumbs} />
        <p className={`px-5 py-4 text-xs ${error ? "text-[var(--sf-fail)]" : "text-[var(--sf-text-3)]"}`} role={error ? "alert" : undefined}>
          {error ?? "Loading run…"}
        </p>
      </div>
    );
  }

  if (!active || !model) return <RunResultsPage run={run} tab={tab} caseId={caseId} repeat={repeat} />;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-[var(--sf-ground)]">
      <PageHeader
        title={run.eval_id}
        crumbs={crumbs}
        subtitle={liveSubtitle(run, now)}
        titleAddon={
          <>
            <span className={`rounded-md border border-[var(--sf-hairline-strong)] bg-[var(--sf-raised)] px-2 py-0.5 text-xs text-[var(--sf-text-1)] font-['Geist_Mono',monospace]`}>
              Run #{run.run_number}
            </span>
            <StatusChip status={run.status} />
          </>
        }
        actions={<StopButton busy={stopping} onClick={() => setConfirming(true)} />}
      />
      {stopError ? (
        <p className="px-5 pt-3 text-xs text-[var(--sf-fail)]" role="alert">
          {stopError}
        </p>
      ) : null}
      {error ? (
        <p className="px-5 pt-3 text-xs text-[var(--sf-needs)]">Connection problem: {error}</p>
      ) : null}
      <LiveProgress model={model} runNumber={run.run_number} />
      {confirming ? <StopConfirm onConfirm={() => void stop()} onClose={() => setConfirming(false)} /> : null}
    </div>
  );
}
