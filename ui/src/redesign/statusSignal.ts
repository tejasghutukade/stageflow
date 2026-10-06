import type { IconType } from "react-icons";
import {
  LuBan,
  LuCheck,
  LuClock,
  LuHand,
  LuLoaderCircle,
  LuX,
} from "react-icons/lu";
import type { RunStatus, RunSummary, StageReadiness, StageSnapshot } from "../api";
import { runDisplayStatus } from "../status/runStatus";

export type StatusSignal =
  | "needs"
  | "running"
  | "ok"
  | "fail"
  | "queued"
  | "skipped";

export type StageStatusForSignal = StageSnapshot["status"] | "interrupted" | "skipped";

export function statusSignalFromRunStatus(
  status: RunStatus | "waiting_for_input" | "queued" | "cancelled",
): StatusSignal {
  switch (status) {
    case "waiting_for_input":
      return "needs";
    case "running":
      return "running";
    case "succeeded":
      return "ok";
    case "failed":
      return "fail";
    case "cancelled":
      return "skipped";
    case "created":
    case "queued":
      return "queued";
  }
}

export function statusSignalFromStageStatus(
  status: StageStatusForSignal,
): StatusSignal {
  switch (status) {
    case "waiting_for_input":
      return "needs";
    case "interrupted":
      return "fail";
    case "running":
      return "running";
    case "succeeded":
      return "ok";
    case "failed":
      return "fail";
    case "skipped":
      return "skipped";
    case "pending":
      return "queued";
  }
}

export function statusSignalFromReadiness(
  readiness: StageReadiness,
): StatusSignal {
  switch (readiness) {
    case "waiting":
      return "needs";
    case "interrupted":
      return "fail";
    case "running":
      return "running";
    case "succeeded":
      return "ok";
    case "failed":
      return "fail";
    case "skipped":
      return "skipped";
    case "blocked":
    case "ready":
      return "queued";
  }
}

export function statusSignalFromRun(run: RunSummary): StatusSignal {
  return statusSignalFromRunStatus(runDisplayStatus(run));
}

export function signalLabel(signal: StatusSignal): string {
  switch (signal) {
    case "needs":
      return "Needs you";
    case "running":
      return "Running";
    case "ok":
      return "Succeeded";
    case "fail":
      return "Failed";
    case "queued":
      return "Queued";
    case "skipped":
      return "Skipped";
  }
}

export function signalIcon(signal: StatusSignal): IconType {
  switch (signal) {
    case "needs":
      return LuHand;
    case "running":
      return LuLoaderCircle;
    case "ok":
      return LuCheck;
    case "fail":
      return LuX;
    case "queued":
      return LuClock;
    case "skipped":
      return LuBan;
  }
}

export function stageStatusPillLabel(status: StageStatusForSignal): string {
  if (status === "interrupted") return "Interrupted";
  return signalLabel(statusSignalFromStageStatus(status));
}

export function runStatusPillLabel(
  status: RunStatus | "waiting_for_input",
): string {
  if (status === "cancelled") return "Cancelled";
  return signalLabel(statusSignalFromRunStatus(status));
}
