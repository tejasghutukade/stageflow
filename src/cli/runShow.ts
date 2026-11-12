import { redactString } from "../logging/redact.js";
import type { RunDetail, RunSummary } from "../runstore/port.js";
import { hostBaseUrl } from "../server/ensureGlobalService.js";
import {
  paintProgressLine,
  progressLines,
  type ProgressLine,
} from "./runProgress.js";

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const RAIL = "│  ";

type Tone = "succeeded" | "failed" | "running" | "waiting";

function oneLine(value: string, max = 120): string {
  const flat = redactString(value).replace(/\s+/g, " ").trim();
  if (flat.length === 0 || flat === "stage failed") return "";
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1)}…`;
}

function field(label: string, value: string): string {
  return `${label.padEnd(10)}${value}`;
}

function formatMoney(amount: number): string {
  return `$${amount.toFixed(4)}`;
}

function formatRunDuration(ms: number): string {
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const remain = minutes % 60;
  return remain === 0 ? `${hours}h` : `${hours}h ${remain}m`;
}

export function formatUtcStamp(iso: string, withDate: boolean): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return iso;
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  const clock = `${hours}:${minutes} UTC`;
  if (!withDate) return clock;
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day} ${clock}`;
}

function sameUtcDay(a: string, b: string): boolean {
  return a.slice(0, 10) === b.slice(0, 10);
}

function displayPath(full: string | undefined, root: string | undefined): string | undefined {
  if (!full) return undefined;
  if (root && (full === root || full.startsWith(`${root}/`))) {
    const relative = full.slice(root.length).replace(/^\//, "");
    if (relative.length > 0) return relative;
  }
  return full;
}

function bindingText(detail: RunDetail): string | undefined {
  const binding = detail.binding;
  if (binding.kind === "repository" && binding.repository) {
    const ref = binding.ref ?? binding.resolved_sha;
    return ref ? `${binding.repository} @ ${ref}` : binding.repository;
  }
  if (binding.kind === "checkout") return "local checkout";
  return undefined;
}

function statusOf(detail: RunDetail): { marker: string; word: string; tone: Tone } {
  if (
    detail.waiting_stage_id &&
    (detail.status === "running" || detail.status === "created" || detail.status === "queued")
  ) {
    return {
      marker: "○",
      word: `waiting on ${detail.waiting_stage_id}`,
      tone: "waiting",
    };
  }
  switch (detail.status) {
    case "succeeded":
      return { marker: "●", word: "succeeded", tone: "succeeded" };
    case "failed":
      return {
        marker: "✖",
        word: detail.failed_stage_id ? `failed at ${detail.failed_stage_id}` : "failed",
        tone: "failed",
      };
    case "cancelled":
      return { marker: "✖", word: "cancelled", tone: "failed" };
    case "running":
      return { marker: "●", word: "running", tone: "running" };
    case "queued":
      return { marker: "○", word: "queued", tone: "waiting" };
    default:
      return { marker: "○", word: "created", tone: "waiting" };
  }
}

function paintTone(text: string, tone: Tone, color: boolean): string {
  if (!color) return text;
  const code =
    tone === "succeeded" ? GREEN : tone === "failed" ? RED : tone === "running" ? CYAN : DIM;
  return `${code}${text}${RESET}`;
}

function endOf(detail: RunDetail): { label: string; at?: string } {
  if (detail.status === "succeeded") return { label: "finished", at: detail.finished_at ?? detail.updated_at };
  if (detail.status === "failed") return { label: "failed", at: detail.finished_at ?? detail.updated_at };
  if (detail.status === "cancelled") {
    return { label: "cancelled", at: detail.finished_at ?? detail.updated_at };
  }
  return { label: "updated", at: detail.updated_at };
}

function timingLine(detail: RunDetail, now: number): string {
  const started = formatUtcStamp(detail.created_at, true);
  const end = endOf(detail);
  let text = started;
  if (end.at) {
    text += `    ${end.label} ${formatUtcStamp(end.at, !sameUtcDay(detail.created_at, end.at))}`;
    const duration = Date.parse(end.at) - Date.parse(detail.created_at);
    if (Number.isFinite(duration) && duration >= 0) {
      text += `    ${formatRunDuration(duration)}`;
    }
  } else if (detail.status === "running" || detail.status === "queued") {
    const duration = now - Date.parse(detail.created_at);
    if (Number.isFinite(duration) && duration >= 0) {
      text += `    ${formatRunDuration(duration)}`;
    }
  }
  return field("started", text);
}

function withFailureReason(detail: RunDetail, lines: ProgressLine[]): ProgressLine[] {
  const reason = oneLine(detail.failed_reason ?? "");
  const stageId = detail.failed_stage_id;
  if (!reason || !stageId) return lines;
  if (lines.some((line) => line.stageId === stageId && line.role === "detail")) return lines;
  const detailLine: ProgressLine = {
    stageId,
    tone: "failed",
    role: "detail",
    lead: `${RAIL}${reason}`,
    aside: "",
    text: `${RAIL}${reason}`,
    stable: `${RAIL}${reason}`,
  };
  const index = lines.findIndex((line) => line.stageId === stageId && line.role === "head");
  if (index < 0) return [...lines, detailLine];
  return [...lines.slice(0, index + 1), detailLine, ...lines.slice(index + 1)];
}

function nextCommand(detail: RunDetail): string | undefined {
  const stageId = detail.waiting_stage_id;
  if (stageId && detail.waiting_kind === "feedback_loop_decision") {
    const loop = detail.active_feedback_loop?.loop_id;
    const loopFlag = loop ? ` --loop ${loop}` : "";
    return `sf runs feedback-decide --run ${detail.run_id} --stage ${stageId}${loopFlag} --decision extend|continue|abandon`;
  }
  if (stageId && (detail.status === "running" || detail.status === "created" || detail.status === "queued")) {
    return `sf runs answer --run ${detail.run_id} --stage ${stageId}`;
  }
  if (detail.status === "failed" && detail.failed_stage_id) {
    return `sf runs retry --run ${detail.run_id} --stage ${detail.failed_stage_id}`;
  }
  return undefined;
}

function consoleUrl(runId: string): string {
  return `${hostBaseUrl()}/#/runs/${encodeURIComponent(runId)}`;
}

export function formatRunShow(
  detail: RunDetail,
  options: { color?: boolean; now?: number } = {},
): string {
  const color = options.color === true;
  const now = options.now ?? Date.now();
  const status = statusOf(detail);
  const lines: string[] = [
    `${detail.run_id}  ${paintTone(`${status.marker} ${status.word}`, status.tone, color)}`,
    "",
    field("pipeline", detail.pipeline_id),
  ];
  const pipelinePath = displayPath(detail.pipeline_path, detail.project_root);
  if (pipelinePath) lines.push(field("path", pipelinePath));
  if (detail.task_id) lines.push(field("task", detail.task_id));
  else {
    const taskPath = displayPath(detail.task_path, detail.project_root);
    if (taskPath) lines.push(field("task", taskPath));
  }
  const binding = bindingText(detail);
  if (binding) lines.push(field("binding", binding));
  lines.push(timingLine(detail, now));
  if (detail.total_cost_usd !== undefined) {
    const inProgress =
      detail.status === "running" || detail.status === "queued" || detail.status === "created";
    const money = formatMoney(detail.total_cost_usd);
    lines.push(field("cost", inProgress ? `${money} so far` : money));
  }
  if (detail.status === "cancelled") {
    const reason = oneLine(detail.cancel_reason ?? "");
    if (reason) lines.push(field("reason", reason));
  }

  const stageLines = withFailureReason(
    detail,
    progressLines(detail, now, { stageCost: true, questions: true }),
  );
  if (stageLines.length > 0) {
    lines.push("");
    for (const line of stageLines) lines.push(paintProgressLine(line, color));
  }

  const next = nextCommand(detail);
  lines.push("");
  if (next) lines.push(next);
  lines.push(consoleUrl(detail.run_id));
  return lines.join("\n");
}

function listStatus(run: RunSummary): { marker: string; word: string; tone: Tone } {
  if (
    run.waiting_stage_id &&
    (run.status === "running" || run.status === "created" || run.status === "queued")
  ) {
    return { marker: "○", word: "waiting", tone: "waiting" };
  }
  switch (run.status) {
    case "succeeded":
      return { marker: "●", word: "succeeded", tone: "succeeded" };
    case "failed":
      return { marker: "✖", word: "failed", tone: "failed" };
    case "cancelled":
      return { marker: "✖", word: "cancelled", tone: "failed" };
    case "running":
      return { marker: "●", word: "running", tone: "running" };
    case "queued":
      return { marker: "○", word: "queued", tone: "waiting" };
    default:
      return { marker: "○", word: "created", tone: "waiting" };
  }
}

export function formatRunListLine(run: RunSummary, color = false): string {
  const status = listStatus(run);
  const head = paintTone(`${status.marker} ${status.word.padEnd(9)}`, status.tone, color);
  let where = "";
  if (status.word === "waiting" && run.waiting_stage_id) {
    where = `  on ${run.waiting_stage_id}`;
  } else if (run.status === "failed" && run.failed_stage_id) {
    where = `  at ${run.failed_stage_id}`;
  }
  return `${head}  ${formatUtcStamp(run.created_at, true)}  ${run.pipeline_id}  ${run.run_id}${where}`;
}

function textField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function formatWaitingEntry(item: Record<string, unknown>, color = false): string {
  const runId = textField(item.runId);
  const stageId = textField(item.stageId);
  const questions = Array.isArray(item.waiting_questions)
    ? item.waiting_questions.filter((entry): entry is string => typeof entry === "string")
    : [];
  const summary = oneLine(textField(item.waiting_summary) || questions[0] || "");
  const head = paintTone(`○ ${runId}  ${stageId}`, "waiting", color);
  const kind = textField(item.waiting_kind);
  const loop = textField(item.feedback_loop_id);
  const command =
    kind === "feedback_loop_decision"
      ? `sf runs feedback-decide --run ${runId} --stage ${stageId}${loop ? ` --loop ${loop}` : ""} --decision extend|continue|abandon`
      : `sf runs answer --run ${runId} --stage ${stageId}`;
  return summary ? `${head}  ${summary}\n  ${command}` : `${head}\n  ${command}`;
}
