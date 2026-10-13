import type { RunSummary } from "../../api";
import { runTaskLabel } from "../../catalog/displayCatalogPath";
import { runShortId } from "../../catalogJoin";
import { statusSignalFromStageStatus } from "../statusSignal";

export function runsPipelinePathTitle(run: RunSummary): string | undefined {
  return run.pipeline_path ?? run.task_path ?? undefined;
}

export function runsPipelineDisplayId(run: RunSummary): string {
  const path = run.pipeline_path;
  if (path) {
    const base = path.split("/").pop() ?? path;
    return base.replace(/\.pipeline\.yaml$/i, "");
  }
  return run.pipeline_id || "—";
}

export function runsPipelineStageLine(run: RunSummary): {
  pipelineId: string;
  stageLabel: string;
  stageClass: string;
} {
  const stages = run.stages ?? [];
  const total = stages.length;
  const pipelineId = runsPipelineDisplayId(run);
  let stageId = run.waiting_stage_id ?? run.failed_stage_id;
  if (!stageId) {
    const running = stages.find((s) => s.status === "running");
    stageId = running?.id;
  }
  if (!stageId && total > 0) {
    const lastActive = [...stages].reverse().find(
      (s) => s.status !== "pending",
    );
    stageId = lastActive?.id ?? stages[stages.length - 1]?.id;
  }
  const index = stageId ? stages.findIndex((s) => s.id === stageId) : -1;
  const n = index >= 0 ? index + 1 : total > 0 ? 1 : 0;
  const m = total || 0;
  const stageName = stageId ?? "—";
  const signal = stageId
    ? statusSignalFromStageStatus(
        stages.find((s) => s.id === stageId)?.status ?? "pending",
      )
    : "idle";
  const stageClass =
    signal === "fail"
      ? "text-[var(--sf-fail)]"
      : signal === "needs"
        ? "text-[var(--sf-needs)]"
        : signal === "running"
          ? "text-[var(--sf-running)]"
          : "text-[var(--sf-text-3)]";
  return {
    pipelineId,
    stageLabel: m > 0 ? `${stageName} · ${n}/${m}` : stageName,
    stageClass,
  };
}

export function runsTaskSecondLine(run: RunSummary): {
  text: string;
  className: string;
  title?: string;
} {
  if (run.waiting_summary) {
    return {
      text: run.waiting_summary,
      className:
        "min-w-0 truncate text-[var(--sf-needs)] font-['Geist_Mono',monospace] text-xs leading-[1.33333]",
      title: run.waiting_summary,
    };
  }
  if (run.failed_reason) {
    return {
      text: run.failed_reason,
      className:
        "min-w-0 truncate text-[#e39790] font-['Geist_Mono',monospace] text-xs leading-[1.33333]",
      title: run.failed_reason,
    };
  }
  const parts = [runShortId(run.run_id)];
  const meta = parts.join(" · ");
  return {
    text: meta,
    className:
      "min-w-0 truncate text-[var(--sf-text-3)] font-['Geist_Mono',monospace] text-xs leading-[1.33333]",
    title: meta,
  };
}

export function runsTaskGoal(run: RunSummary): string {
  return runTaskLabel(run);
}

export function runsTaskId(run: RunSummary): string {
  return run.task_id ?? runShortId(run.run_id);
}
