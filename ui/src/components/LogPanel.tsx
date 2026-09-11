import { useState, type ReactNode } from "react";
import { Icon } from "@astryxdesign/core/Icon";
import type { StageLogEvent } from "../api";
import {
  formatActivityDescription,
  formatActivityLabel,
} from "../status/activityCopy";
import { buildTranscriptTurns, type ToolCallView } from "./TranscriptTurns";

export type LogStepKind =
  | "tool"
  | "message"
  | "operator_prompt"
  | "operator_answer"
  | "system";

export type LogStepStatus = "running" | "succeeded" | "failed";

export type LogStep = {
  id: string;
  kind: LogStepKind;
  label: string;
  status: LogStepStatus;
  detail?: string;
  at?: string;
  startedAt?: string;
  finishedAt?: string;
  defaultExpanded: boolean;
  // Raw StageLogEvent["event"] for "system" steps only — lets callers tell
  // a genuine stage-terminal marker (succeeded/failed) apart from an
  // in-between one (started/agent_start/...) without parsing the label.
  sourceEvent?: string;
};

// The step whose detail best explains a stage failure: the terminal
// "Stage failed" marker if one has landed yet, otherwise the most recent
// failing tool call — but only while the stage is still genuinely
// unresolved. Once a terminal "Stage succeeded" marker exists, an earlier
// tool error was evidently recovered from and shouldn't keep flagging as
// the failure.
export function findFailingStepId(steps: LogStep[]): string | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i].kind === "system" && steps[i].status === "failed") return steps[i].id;
  }
  const stageSucceeded = steps.some(
    (s) => s.kind === "system" && s.sourceEvent === "succeeded",
  );
  if (stageSucceeded) return undefined;
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i].kind === "tool" && steps[i].status === "failed") return steps[i].id;
  }
  return undefined;
}

// The banner only appears once the stage has actually terminated in
// failure (the same terminal "system" step findFailingStepId prefers),
// not merely a tool call that errored and might still be retried. Takes
// the failing step id rather than re-deriving it, since callers that
// already ran findFailingStepId shouldn't have to scan the array again.
export function failureBannerText(
  steps: LogStep[],
  failingStepId: string | undefined,
): string | undefined {
  const step = steps.find((s) => s.id === failingStepId);
  if (!step || step.kind !== "system") return undefined;
  return step.detail ?? step.label;
}

const PREVIEW_LENGTH_LIMIT = 160;

// Cuts `text` at or before `maxLen`, backing up to the nearest preceding
// space so a truncated preview never ends mid-word (e.g. "applicat…" with
// the rest of "application" resuming on the next line reads as broken, not
// continued). Falls back to a hard cutoff only when there's no space to
// back up to at all (one very long unbroken token, e.g. a URL).
function truncateAtWordBoundary(
  text: string,
  maxLen: number,
): { shown: string; cutIndex: number } {
  const slice = text.slice(0, maxLen);
  const lastSpace = slice.lastIndexOf(" ");
  if (lastSpace > 0) return { shown: slice.slice(0, lastSpace), cutIndex: lastSpace + 1 };
  return { shown: slice, cutIndex: maxLen };
}

// A step's detail always shows a one-line preview under its label; expanding
// the row via the chevron reveals `rest` — everything after wherever the
// preview left off, never repeating what the preview already showed. Many
// tool results are a JSON-stringified blob with no real newlines at all (a
// single, very long "line"), so the cutoff can't rely on finding a newline
// alone — it also has to account for a first line that's simply too long to
// show in full, continuing from that character offset instead of a line.
// Leading blank lines are stripped from `rest` (but not other whitespace),
// since a detail with a blank line right after its first line would
// otherwise show an odd empty gap before the continuation.
export function stepPreview(
  detail: string,
): { preview: string; hasMore: boolean; rest: string } {
  const newlineIndex = detail.indexOf("\n");
  const firstLine = newlineIndex === -1 ? detail : detail.slice(0, newlineIndex);
  if (firstLine.length <= PREVIEW_LENGTH_LIMIT) {
    const rest = (newlineIndex === -1 ? "" : detail.slice(newlineIndex + 1)).replace(/^\n+/, "");
    return { preview: firstLine, hasMore: rest.trim().length > 0, rest };
  }
  const { shown, cutIndex } = truncateAtWordBoundary(firstLine, PREVIEW_LENGTH_LIMIT);
  return {
    preview: `${shown}…`,
    hasMore: true,
    rest: detail.slice(cutIndex).replace(/^\n+/, ""),
  };
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return "<1s";
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

export function stepDurationMs(step: LogStep, now: number): number | undefined {
  if (step.kind !== "tool" || !step.startedAt) return undefined;
  const start = Date.parse(step.startedAt);
  if (Number.isNaN(start)) return undefined;
  if (step.status === "running") return Math.max(0, now - start);
  if (!step.finishedAt) return undefined;
  const end = Date.parse(step.finishedAt);
  if (Number.isNaN(end)) return undefined;
  return Math.max(0, end - start);
}

function toolCallStatus(call: ToolCallView): LogStepStatus {
  if (call.status === "error") return "failed";
  if (call.status === "running") return "running";
  return "succeeded";
}

// Tool name -> which argument holds the thing worth showing in the label,
// and whether that argument is a path (shown as just its basename) or
// free-form text (shown in full). Keyed lowercase and looked up
// case-insensitively: the Claude backend names tools "Read"/"Bash", the Pi
// backend names the same built-ins "read"/"bash" — both need to match.
const TOOL_LABEL_ARG: Record<string, { key: string; isPath: boolean }> = {
  read: { key: "file_path", isPath: true },
  write: { key: "file_path", isPath: true },
  edit: { key: "file_path", isPath: true },
  notebookedit: { key: "notebook_path", isPath: true },
  bash: { key: "command", isPath: false },
  grep: { key: "pattern", isPath: false },
  glob: { key: "pattern", isPath: false },
  webfetch: { key: "url", isPath: false },
  websearch: { key: "query", isPath: false },
};

// Tools whose successful result is the content of a file rather than a
// summary of what happened — never surface that content in the log panel.
const SUPPRESS_RESULT_ON_SUCCESS = new Set(["read"]);

function parseArgsPreview(argsPreview: string | undefined): Record<string, unknown> | undefined {
  if (!argsPreview) return undefined;
  try {
    const parsed: unknown = JSON.parse(argsPreview);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// argsPreview is JSON.stringify(toolInput) truncated to a fixed character
// limit server-side, with no regard for JSON structure — a long
// old_string/content value on an Edit/Write call routinely truncates mid-
// string, making the whole thing invalid JSON even though an earlier key
// like file_path is still intact. Recover that one key directly from the
// raw string when structured parsing fails, rather than losing the label
// entirely.
function extractArgValue(argsPreview: string | undefined, key: string): string | undefined {
  const parsed = parseArgsPreview(argsPreview)?.[key];
  if (typeof parsed === "string") return parsed;
  if (!argsPreview) return undefined;
  const match = argsPreview.match(
    new RegExp(`"${escapeRegExp(key)}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`),
  );
  return match ? match[1] : undefined;
}

function basename(value: string): string {
  return value.split("/").pop() || value;
}

function toolCallLabel(call: ToolCallView): string {
  const mapping = TOOL_LABEL_ARG[call.name.toLowerCase()];
  if (!mapping) return call.name;
  const value = extractArgValue(call.args, mapping.key);
  if (typeof value !== "string" || !value.trim()) return call.name;
  return `${call.name} ${mapping.isPath ? basename(value) : value}`;
}

function toolCallDetail(call: ToolCallView): string | undefined {
  if (call.status === "running") return call.progressPreview;
  if (call.status === "complete" && SUPPRESS_RESULT_ON_SUCCESS.has(call.name.toLowerCase())) return undefined;
  return call.result;
}

function toolCallToStep(call: ToolCallView, id: string): LogStep {
  return {
    id,
    kind: "tool",
    label: toolCallLabel(call),
    status: toolCallStatus(call),
    detail: toolCallDetail(call),
    at: call.at,
    startedAt: call.startedAt,
    finishedAt: call.status === "running" ? undefined : call.at,
    defaultExpanded: false,
  };
}

function messageStep(event: StageLogEvent, id: string): LogStep {
  return {
    id,
    kind: "message",
    label: event.role ?? "message",
    status: "succeeded",
    detail: event.text?.trim(),
    at: event.at,
    defaultExpanded: false,
  };
}

// Shared shape for operator_prompt/operator_answer/system steps: all three
// derive label/detail/at the same way from the activity-copy helpers and
// differ only in `kind` and (for system events) whether they can fail.
function activityStep(
  kind: "operator_prompt" | "operator_answer" | "system",
  event: StageLogEvent,
  id: string,
): LogStep {
  return {
    id,
    kind,
    label: formatActivityLabel(event),
    status: kind === "system" && event.event === "failed" ? "failed" : "succeeded",
    detail: formatActivityDescription(event),
    at: event.at,
    defaultExpanded: false,
    sourceEvent: kind === "system" ? event.event : undefined,
  };
}

export function buildLogPanelSteps(events: StageLogEvent[]): LogStep[] {
  const turns = buildTranscriptTurns(events);
  const steps: LogStep[] = [];
  let index = 0;

  for (const turn of turns) {
    if (turn.kind === "tools") {
      for (const call of turn.calls) {
        steps.push(toolCallToStep(call, `step-${index}`));
        index += 1;
      }
      continue;
    }
    const id = `step-${index}`;
    index += 1;
    if (turn.kind === "message") {
      steps.push(messageStep(turn.event, id));
    } else if (turn.kind === "operator_prompt") {
      steps.push(activityStep("operator_prompt", turn.event, id));
    } else if (turn.kind === "operator_answer") {
      steps.push(activityStep("operator_answer", turn.event, id));
    } else {
      steps.push(activityStep("system", turn.event, id));
    }
  }

  const failingStepId = findFailingStepId(steps);
  for (const step of steps) {
    step.defaultExpanded = step.status === "running" || step.id === failingStepId;
  }

  return steps;
}

function LogStepRow({
  step,
  now,
  isOpen,
  onToggle,
}: {
  step: LogStep;
  now: number;
  isOpen: boolean;
  onToggle: (isOpen: boolean) => void;
}) {
  const durationMs = stepDurationMs(step, now);
  const { preview, hasMore, rest } = step.detail
    ? stepPreview(step.detail)
    : { preview: "", hasMore: false, rest: "" };

  return (
    <div id={`logstep-${step.id}`} className={`logstep logstep--${step.status}`}>
      <button
        type="button"
        className={`logstep__row${hasMore ? "" : " logstep__row--static"}`}
        disabled={!hasMore}
        aria-expanded={hasMore ? isOpen : undefined}
        onClick={hasMore ? () => onToggle(!isOpen) : undefined}
      >
        <Icon
          icon="chevronDown"
          size="sm"
          className={`logstep__chevron${hasMore ? (isOpen ? " logstep__chevron--open" : "") : " logstep__chevron--hidden"}`}
        />
        <span className={`dot dot--${step.status} logstep__dot`}></span>
        <span className="logstep__text">
          <span className="logstep__label-row">
            <span className="logstep__label">{step.label}</span>
            {durationMs !== undefined ? (
              <span className="logstep__duration">{formatDuration(durationMs)}</span>
            ) : null}
          </span>
          {preview ? <span className="logstep__preview">{preview}</span> : null}
        </span>
      </button>
      {hasMore && isOpen ? <pre className="logstep__detail">{rest}</pre> : null}
    </div>
  );
}

function jumpToFailingStep(stepId: string) {
  const el = document.getElementById(`logstep-${stepId}`);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.add("logstep--highlight");
  window.setTimeout(() => el.classList.remove("logstep--highlight"), 1500);
}

export function LogPanel({
  events,
  headerAction,
}: {
  events: StageLogEvent[];
  headerAction?: ReactNode;
}) {
  const steps = buildLogPanelSteps(events);
  const now = Date.now();
  const failingStepId = findFailingStepId(steps);
  const bannerText = failureBannerText(steps, failingStepId);

  // Explicit open/closed choices the operator has made, keyed by step id —
  // everything else falls back to the step's own live defaultExpanded, so
  // a step whose default changes (running -> succeeded, or "jump to
  // failing step" clearing a stale override) is reflected without the
  // operator's earlier choice on an unrelated step getting reset too.
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});

  return (
    <div className="stream" style={{ height: "100%" }}>
      <header className="stream__head">
        <h3 className="stream__name">Logs</h3>
        {headerAction ? (
          <>
            <span className="topbar__spacer"></span>
            <div className="stream__head-trail">{headerAction}</div>
          </>
        ) : null}
      </header>
      <div className="stream__body">
        {steps.length === 0 ? (
          <p className="muted">No activity yet.</p>
        ) : (
          <div className="logpanel">
            {steps.map((step) => (
              <LogStepRow
                key={step.id}
                step={step}
                now={now}
                isOpen={overrides[step.id] ?? step.defaultExpanded}
                onToggle={(next) =>
                  setOverrides((prev) => ({ ...prev, [step.id]: next }))
                }
              />
            ))}
          </div>
        )}
      </div>
      {bannerText && failingStepId ? (
        <div className="logpanel__banner">
          <span className="logpanel__banner-text">{bannerText}</span>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => {
              // Clear any earlier manual collapse so the row falls back to
              // its (now-true) defaultExpanded and actually shows the
              // failure the banner is pointing at.
              setOverrides((prev) => {
                if (!(failingStepId in prev)) return prev;
                const next = { ...prev };
                delete next[failingStepId];
                return next;
              });
              jumpToFailingStep(failingStepId);
            }}
          >
            Jump to failing step
          </button>
        </div>
      ) : null}
    </div>
  );
}
