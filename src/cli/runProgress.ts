import path from "node:path";
import { redactString } from "../logging/redact.js";
import type { RunDetail, StageLogEvent, StageSnapshot } from "../runstore/port.js";

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

const HEAD_WIDTH = 56;
const RAIL = "│  ";

export type ProgressTone = "running" | "succeeded" | "failed" | "skipped" | "waiting";

export type ProgressLine = {
  stageId: string;
  tone: ProgressTone;
  role: "head" | "detail";
  /** Marker and name, or the detail body including the rail. */
  lead: string;
  aside: string;
  text: string;
  /** Identity used when stdout is not a terminal, so a ticking clock does not reprint. */
  stable: string;
};

export function cliProgressColor(
  tty: boolean,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.FORCE_COLOR === "0") return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "") return true;
  return tty;
}

function oneLine(value: string, max: number): string {
  const flat = redactString(value).replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1)}…`;
}

function bashCommand(toolName: string, argsPreview: string | undefined): string | undefined {
  if (toolName.toLowerCase() !== "bash" || !argsPreview) return undefined;
  const trimmed = argsPreview.trim();
  let command = trimmed;
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as { command?: unknown };
      if (typeof parsed.command !== "string") return undefined;
      command = parsed.command;
    } catch {
      return undefined;
    }
  }
  const line = oneLine(command, 60);
  return line.length > 0 ? line : undefined;
}

function usefulReason(reason: string | undefined): string | undefined {
  if (!reason) return undefined;
  const line = oneLine(reason, 120);
  if (line.length === 0 || line === "stage failed") return undefined;
  return line;
}

function isStageKickoff(text: string): boolean {
  return /^(?:Begin this stage\b|Reminder \d+ of \d+)/i.test(text.trim());
}

function activityLine(events: StageLogEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (!event) continue;
    switch (event.event) {
      case "tool_start": {
        const command = bashCommand(event.toolName, event.argsPreview);
        return command
          ? `calling ${event.toolName}: ${command}`
          : `calling ${event.toolName}`;
      }
      case "tool_progress": {
        const text = event.textPreview ? oneLine(event.textPreview, 60) : "";
        return text.length > 0
          ? `running ${event.toolName}: ${text}`
          : `running ${event.toolName}`;
      }
      case "tool_end":
        return event.isError ? `${event.toolName} failed` : `finished ${event.toolName}`;
      case "message":
        if (event.role === "thinking") return "thinking";
        if (event.text && !isStageKickoff(event.text)) {
          const text = oneLine(event.text, 120);
          if (text.length > 0) return text;
        }
        break;
      case "waiting_for_input":
      case "operator_prompt":
        return "waiting for input";
      case "turn_start":
      case "agent_start":
      case "started":
        break;
      default:
        break;
    }
  }
  return undefined;
}

function failureDetail(stage: StageSnapshot): string | undefined {
  for (let i = stage.events.length - 1; i >= 0; i--) {
    const event = stage.events[i];
    if (event?.event === "failed") return usefulReason(event.reason);
    if (event?.event === "interrupted") return usefulReason(event.reason) ?? "interrupted";
  }
  return undefined;
}

function eventAt(events: StageLogEvent[], name: string): number | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event?.event !== name || !event.at) continue;
    const parsed = Date.parse(event.at);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function elapsedMs(stage: StageSnapshot, now: number): number | undefined {
  const started =
    eventAt(stage.events, "started") ??
    stage.events
      .map((event) => (event.at ? Date.parse(event.at) : Number.NaN))
      .find((value) => Number.isFinite(value));
  if (started === undefined) return undefined;
  const ended =
    eventAt(stage.events, "succeeded") ??
    eventAt(stage.events, "failed") ??
    eventAt(stage.events, "interrupted") ??
    eventAt(stage.events, "skipped") ??
    (stage.status === "waiting_for_input"
      ? (eventAt(stage.events, "waiting_for_input") ?? now)
      : stage.status === "running"
        ? now
        : undefined);
  if (ended === undefined) return undefined;
  return Math.max(0, ended - started);
}

function formatElapsed(ms: number): string {
  if (ms < 10_000) {
    const seconds = ms / 1000;
    return `${seconds.toFixed(1)}s`;
  }
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function finishedResult(stage: StageSnapshot): string | undefined {
  const summary = stage.envelope?.summary?.trim();
  if (summary) {
    const line = oneLine(summary, 120);
    if (line.length > 0) return line;
  }
  const artifact = stage.artifacts.at(-1);
  if (artifact) {
    const base = path.basename(artifact);
    if (base.length > 0) return oneLine(`wrote ${base}`, 120);
  }
  return undefined;
}

function marker(stage: StageSnapshot): string {
  switch (stage.status) {
    case "failed":
    case "interrupted":
      return "✖";
    case "pending":
    case "skipped":
      return "○";
    default:
      return "●";
  }
}

function toneFor(stage: StageSnapshot): ProgressTone {
  switch (stage.status) {
    case "succeeded":
      return "succeeded";
    case "failed":
    case "interrupted":
      return "failed";
    case "skipped":
      return "skipped";
    case "running":
    case "waiting_for_input":
      return "running";
    default:
      return "waiting";
  }
}

function asideFor(
  stage: StageSnapshot,
  elapsed: number | undefined,
  stageCost: boolean,
): string {
  let aside: string;
  if (stage.status === "pending") aside = "waiting";
  else if (stage.status === "skipped") aside = "skipped";
  else if (elapsed === undefined) aside = "";
  else aside = formatElapsed(elapsed);
  if (stageCost && stage.cost_usd !== undefined && stage.cost_usd > 0) {
    const cost = `$${stage.cost_usd.toFixed(4)}`;
    aside = aside ? `${aside}  ${cost}` : cost;
  }
  return aside;
}

function composeHead(lead: string, aside: string): string {
  if (!aside) return lead;
  const gap = Math.max(2, HEAD_WIDTH - lead.length - aside.length);
  return `${lead}${" ".repeat(gap)}${aside}`;
}

function askText(stage: StageSnapshot): string | undefined {
  const prompt = stage.pending_prompt;
  if (!prompt) return undefined;
  if (prompt.kind === "multi_question") {
    const message = prompt.questions.find((question) => question.message.trim().length > 0)
      ?.message;
    return message ? oneLine(message, 120) : undefined;
  }
  const message = prompt.message.trim();
  return message.length > 0 ? oneLine(message, 120) : undefined;
}

function headLine(
  stage: StageSnapshot,
  elapsed: number | undefined,
  stageCost: boolean,
): ProgressLine {
  const tone = toneFor(stage);
  const lead = `${marker(stage)} ${stage.stage_id}`;
  const aside = asideFor(stage, elapsed, stageCost);
  const text = composeHead(lead, aside);
  const stable = tone === "running" ? lead : text;
  return { stageId: stage.stage_id, tone, role: "head", lead, aside, text, stable };
}

function detailLine(stage: StageSnapshot, body: string, tone: ProgressTone): ProgressLine {
  const text = `${RAIL}${body}`;
  return {
    stageId: stage.stage_id,
    tone,
    role: "detail",
    lead: text,
    aside: "",
    text,
    stable: text,
  };
}

export type ProgressLineOptions = {
  /** Append a stage's cost when it is above zero. The live timeline leaves this off. */
  stageCost?: boolean;
  /** Prefer the operator's question over "waiting for input". */
  questions?: boolean;
};

function linesFor(
  stage: StageSnapshot,
  now: number,
  options: ProgressLineOptions,
): ProgressLine[] {
  const elapsed = elapsedMs(stage, now);
  const head = headLine(stage, elapsed, options.stageCost === true);
  if (stage.status === "pending" || stage.status === "skipped") return [head];
  if (stage.status === "failed" || stage.status === "interrupted") {
    const reason = failureDetail(stage);
    return reason ? [head, detailLine(stage, reason, "failed")] : [head];
  }
  if (stage.status === "succeeded") {
    const result = finishedResult(stage);
    return result ? [head, detailLine(stage, result, "succeeded")] : [head];
  }
  const activity =
    stage.status === "waiting_for_input"
      ? (options.questions ? askText(stage) : undefined) ?? "waiting for input"
      : (activityLine(stage.events) ?? "starting");
  return [head, detailLine(stage, activity, "running")];
}

export function progressLines(
  detail: { stages: StageSnapshot[] },
  now = Date.now(),
  options: ProgressLineOptions = {},
): ProgressLine[] {
  const lines: ProgressLine[] = [];
  for (const stage of detail.stages) lines.push(...linesFor(stage, now, options));
  return lines;
}

export function paintProgressLine(line: ProgressLine, color: boolean): string {
  if (!color) return line.text;
  if (line.role === "detail") {
    const body = line.text.startsWith(RAIL) ? line.text.slice(RAIL.length) : line.text;
    const rail = `${DIM}${RAIL}${RESET}`;
    if (line.tone === "failed") return `${rail}${RED}${body}${RESET}`;
    if (line.tone === "running") return `${rail}${body}`;
    return `${rail}${DIM}${body}${RESET}`;
  }
  const leadColor =
    line.tone === "succeeded"
      ? GREEN
      : line.tone === "failed"
        ? RED
        : line.tone === "running"
          ? CYAN
          : DIM;
  if (!line.aside) return `${leadColor}${line.lead}${RESET}`;
  const gap = line.text.slice(line.lead.length, line.text.length - line.aside.length);
  return `${leadColor}${line.lead}${RESET}${gap}${DIM}${line.aside}${RESET}`;
}

export type RunProgressWriter = {
  update(detail: Pick<RunDetail, "stages">): void;
  /** Forget the drawn block so the next update prints below a prompt. */
  reset(): void;
};

export function createRunProgressWriter(options: {
  write: (chunk: string) => void;
  tty: boolean;
  color: boolean;
  now?: () => number;
}): RunProgressWriter {
  let drawn = 0;
  let prevStable: string[] = [];
  let lastPlain = "";
  let lastStable = "";

  return {
    update(detail) {
      const lines = progressLines(detail, options.now?.() ?? Date.now(), {
        questions: true,
      });
      const plain = lines.map((line) => line.text);
      const stable = lines.map((line) => line.stable);
      const plainKey = plain.join("\n");
      const stableKey = stable.join("\n");
      if (options.tty ? plainKey === lastPlain : stableKey === lastStable) return;
      const painted = lines.map((line) => paintProgressLine(line, options.color));
      if (options.tty) {
        let chunk = "";
        if (drawn > 0) chunk += `\x1b[${drawn}A`;
        for (const line of painted) chunk += `\x1b[2K${line}\n`;
        const extra = drawn - painted.length;
        if (extra > 0) {
          for (let i = 0; i < extra; i++) chunk += "\x1b[2K\n";
          chunk += `\x1b[${extra}A`;
        }
        options.write(chunk);
        drawn = painted.length;
      } else if (stableKey !== lastStable) {
        const changed: string[] = [];
        for (let i = 0; i < stable.length; i++) {
          if (stable[i] !== prevStable[i]) changed.push(painted[i] ?? "");
        }
        if (changed.length > 0) options.write(`${changed.join("\n")}\n`);
      }
      prevStable = stable;
      lastPlain = plainKey;
      lastStable = stableKey;
    },
    reset() {
      drawn = 0;
      prevStable = [];
      lastPlain = "";
      lastStable = "";
    },
  };
}
