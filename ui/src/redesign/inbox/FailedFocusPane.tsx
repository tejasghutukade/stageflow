import { useEffect, useRef, useState } from "react";
import { fetchRun, type RunDetail, type RunSummary } from "../../api";
import { runLocatorSubtitle, runTaskLabel } from "../../catalog/displayCatalogPath";
import { miniTrackLabel, relativeTime } from "../../catalogJoin";
import { MiniTrack } from "../../components/MiniTrack";
import { canRetry } from "../../stageAction";
import {
  formatActivityDescription,
  formatActivityLabel,
} from "../../status/activityCopy";
import { Keycap } from "../Keycap";
import {
  lastDisplayableFailedStageEvents,
} from "./failedViews";
import { formatRunElapsed } from "./inboxViews";
import { matchLikelyFix } from "./likelyFixRules";
import {
  LuExternalLink,
  LuFileText,
  LuLightbulb,
  LuRefreshCw,
  LuRotateCcw,
  LuX,
} from "react-icons/lu";

const detailCache = new Map<string, RunDetail>();

const START_FRESH_CONFIRM =
  "Start a new run from the beginning? The failed run stays in history.";

export type FailedFocusPaneProps = {
  run: RunSummary | null;
  onOpenRun: (runId: string) => void;
  onRetry: (stageId: string) => void;
  onStartFresh: () => void;
  onDismiss: () => void;
  retrying: boolean;
  rerunning: boolean;
};

function failedReasonFromRun(
  run: RunSummary,
  stage: RunDetail["stages"][number] | undefined,
): string | null {
  if (run.failed_reason?.trim()) return run.failed_reason.trim();
  if (!stage) return null;
  for (let i = stage.events.length - 1; i >= 0; i--) {
    const ev = stage.events[i];
    if (ev.event === "failed" && typeof ev.reason === "string" && ev.reason.trim()) {
      return ev.reason.trim();
    }
    if (
      ev.event === "interrupted" &&
      typeof ev.reason === "string" &&
      ev.reason.trim()
    ) {
      return ev.reason.trim();
    }
  }
  return null;
}

export function FailedFocusPane({
  run,
  onOpenRun,
  onRetry,
  onStartFresh,
  onDismiss,
  retrying,
  rerunning,
}: FailedFocusPaneProps) {
  const paneRef = useRef<HTMLDivElement>(null);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [loading, setLoading] = useState(false);

  const stageId = run?.failed_stage_id ?? "";

  useEffect(() => {
    if (!run) {
      setDetail(null);
      return;
    }
    const cached = detailCache.get(run.run_id);
    if (cached) {
      setDetail(cached);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void fetchRun(run.run_id)
      .then((d) => {
        if (cancelled) return;
        detailCache.set(run.run_id, d);
        setDetail(d);
      })
      .catch(() => {
        if (!cancelled) setDetail(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [run?.run_id]);

  useEffect(() => {
    if (!run) return;
    paneRef.current?.focus();
  }, [run?.run_id, stageId]);

  if (!run || !stageId) {
    return (
      <div className="min-h-0 min-w-0 flex-1 bg-[var(--sf-panel)]" aria-hidden="true" />
    );
  }

  const stage = detail?.stages.find((s) => s.stage_id === stageId);
  const failedReason = failedReasonFromRun(run, stage);
  const likelyFix = matchLikelyFix(failedReason ?? undefined);
  const activity = lastDisplayableFailedStageEvents(stage?.events ?? []);
  const artifacts = stage?.artifacts ?? [];
  const canRetryStage = stage ? canRetry(stage.status) : false;
  const elapsed = formatRunElapsed(run);
  const cost =
    run.total_cost_usd != null ? `$${run.total_cost_usd.toFixed(2)}` : null;
  const metaRight = [elapsed, cost].filter(Boolean).join(" · ");

  const onStartFreshClick = () => {
    if (!window.confirm(START_FRESH_CONFIRM)) return;
    onStartFresh();
  };

  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-clip bg-[var(--sf-panel)]"
      ref={paneRef}
      tabIndex={-1}
    >
      <header className="flex shrink-0 flex-col gap-3.5 border-b border-b-[#ffffff0f] px-8 pb-[18px] pt-5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2 font-['Geist_Mono',monospace] text-xs text-[var(--sf-text-3)]">
            <span className="truncate">{runLocatorSubtitle(run)}</span>
            <span aria-hidden="true">·</span>
            <span className="truncate">{stageId}</span>
          </div>
          {run.finished_at || run.updated_at ? (
            <span className="shrink-0 font-['Geist_Mono',monospace] text-xs text-[var(--sf-text-3)]">
              {relativeTime(run.finished_at ?? run.updated_at ?? run.created_at)}
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-[22px] font-semibold tracking-[-0.44px] text-[var(--sf-text-1)]">
            {runTaskLabel(run)}
          </h2>
          <span className="flex h-6 items-center gap-1.5 rounded-full border border-[#ff6b6b4d] bg-[#ff6b6b1f] px-2 text-xs font-medium text-[var(--sf-fail)]">
            Failed
          </span>
        </div>
        <div className="flex items-center gap-4">
          <MiniTrack
            stages={run.stages.map((s) => ({ id: s.id, status: s.status }))}
            label={miniTrackLabel(run)}
            variant="bar"
          />
          {metaRight ? (
            <span className="ml-auto shrink-0 font-['Geist_Mono',monospace] text-xs text-[var(--sf-text-3)]">
              {metaRight}
            </span>
          ) : null}
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-8 py-7">
        {loading ? (
          <p className="text-sm text-[var(--sf-text-3)]">Loading run detail…</p>
        ) : null}

        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-medium uppercase tracking-[0.88px] text-[var(--sf-text-3)]">
            What failed
          </h3>
          <p
            className="rounded-lg border border-[#ffffff14] bg-[var(--sf-raised)] px-4 py-3 text-sm leading-relaxed text-[var(--sf-text-1)]"
            data-testid="failed-reason"
          >
            {failedReason ?? "No failure reason was recorded for this stage."}
          </p>
        </section>

        {activity.length > 0 ? (
          <section className="flex flex-col gap-2">
            <h3 className="text-xs font-medium uppercase tracking-[0.88px] text-[var(--sf-text-3)]">
              Recent activity
            </h3>
            <ul className="flex flex-col gap-1.5 rounded-lg border border-[#ffffff14] bg-[var(--sf-raised)] px-3 py-2">
              {activity.map((ev, index) => {
                const description = formatActivityDescription(ev);
                return (
                  <li
                    key={`${ev.event}-${ev.at ?? index}-${index}`}
                    className="flex flex-col gap-0.5 border-b border-[#ffffff0a] py-2 last:border-0"
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-xs font-medium text-[var(--sf-text-2)]">
                        {formatActivityLabel(ev)}
                      </span>
                      {ev.at ? (
                        <span className="shrink-0 font-['Geist_Mono',monospace] text-[10px] text-[var(--sf-text-3)]">
                          {relativeTime(ev.at)}
                        </span>
                      ) : null}
                    </div>
                    {description ? (
                      <p className="line-clamp-3 text-xs leading-snug text-[var(--sf-text-3)]">
                        {description}
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}

        {likelyFix ? (
          <section
            className="flex gap-3 rounded-lg border border-[#f5b54433] bg-[#f5b54414] px-4 py-3"
            data-testid="likely-fix"
          >
            <LuLightbulb
              className="mt-0.5 size-4 shrink-0 text-[var(--sf-needs)]"
              aria-hidden="true"
            />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <h3 className="text-sm font-medium text-[var(--sf-text-1)]">
                {likelyFix.title}
              </h3>
              <p className="text-xs leading-relaxed text-[var(--sf-text-2)]">
                {likelyFix.body}
              </p>
              <a
                href={likelyFix.settingsHref}
                className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-[var(--sf-needs)] hover:underline"
              >
                Open Providers settings
                <LuExternalLink className="size-3" aria-hidden="true" />
              </a>
            </div>
          </section>
        ) : null}

        {artifacts.length > 0 ? (
          <section className="flex flex-col gap-2">
            <h3 className="text-xs font-medium uppercase tracking-[0.88px] text-[var(--sf-text-3)]">
              Artifacts
            </h3>
            <ul className="flex flex-col gap-1">
              {artifacts.map((path) => (
                <li
                  key={path}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-[var(--sf-text-2)]"
                >
                  <LuFileText
                    className="size-3.5 shrink-0 text-[var(--sf-text-3)]"
                    aria-hidden="true"
                  />
                  <span className="min-w-0 truncate font-['Geist_Mono',monospace]">
                    {path}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>

      <footer className="flex shrink-0 flex-col gap-3 border-t border-t-[#ffffff0f] bg-[#0e0f11] px-8 py-[18px]">
        <div className="flex flex-wrap items-center gap-2.5">
          {canRetryStage ? (
            <button
              type="button"
              className="flex h-[34px] shrink-0 items-center gap-2 rounded-lg bg-[var(--sf-fail)] px-3.5 text-[13px] font-medium text-white disabled:opacity-50"
              disabled={retrying || rerunning}
              onClick={() => onRetry(stageId)}
            >
              <LuRefreshCw className="size-3.5" aria-hidden="true" />
              {retrying ? "Retrying…" : "Retry"}
              <Keycap>R</Keycap>
            </button>
          ) : null}
          <button
            type="button"
            className="flex h-[34px] shrink-0 items-center gap-2 rounded-lg border border-[#ffffff1a] bg-[var(--sf-raised)] px-3.5 text-[13px] text-[var(--sf-text-1)] disabled:opacity-50"
            disabled={retrying || rerunning}
            onClick={onStartFreshClick}
          >
            <LuRotateCcw className="size-3.5" aria-hidden="true" />
            {rerunning ? "Starting fresh…" : "Start fresh"}
          </button>
          <button
            type="button"
            className="flex h-[34px] shrink-0 items-center gap-2 rounded-lg border border-[#ffffff1a] bg-[var(--sf-raised)] px-3.5 text-[13px] text-[var(--sf-text-1)]"
            onClick={() => onOpenRun(run.run_id)}
          >
            Open run
            <Keycap>O</Keycap>
          </button>
          <button
            type="button"
            className="ml-auto flex h-[34px] shrink-0 items-center gap-2 rounded-lg px-3 text-[13px] text-[var(--sf-text-3)] hover:bg-[#ffffff0a] hover:text-[var(--sf-text-2)]"
            onClick={onDismiss}
          >
            <LuX className="size-3.5" aria-hidden="true" />
            Dismiss
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-xs text-[var(--sf-text-3)]">
          {canRetryStage ? (
            <span className="inline-flex items-center gap-1">
              <Keycap>R</Keycap>
              retry stage
            </span>
          ) : null}
          <span className="inline-flex items-center gap-1">
            <Keycap>O</Keycap>
            open run
          </span>
        </div>
      </footer>
    </div>
  );
}
