import { useState, type ReactNode } from "react";
import { Collapsible } from "@astryxdesign/core/Collapsible";
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
};

// The step whose detail best explains a stage failure: the terminal
// "Stage failed" marker if one has landed yet, otherwise the tool call
// that most recently errored.
export function findFailingStepId(steps: LogStep[]): string | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i].kind === "system" && steps[i].status === "failed") return steps[i].id;
  }
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i].kind === "tool" && steps[i].status === "failed") return steps[i].id;
  }
  return undefined;
}

// The banner only appears once the stage has actually terminated in
// failure (the same terminal "system" step findFailingStepId prefers),
// not merely a tool call that errored and might still be retried.
export function failureBannerText(steps: LogStep[]): string | undefined {
  const failingId = findFailingStepId(steps);
  const step = steps.find((s) => s.id === failingId);
  if (!step || step.kind !== "system") return undefined;
  return step.detail ?? step.label;
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
// free-form text (shown in full).
const TOOL_LABEL_ARG: Record<string, { key: string; isPath: boolean }> = {
  Read: { key: "file_path", isPath: true },
  Write: { key: "file_path", isPath: true },
  Edit: { key: "file_path", isPath: true },
  NotebookEdit: { key: "notebook_path", isPath: true },
  Bash: { key: "command", isPath: false },
  Grep: { key: "pattern", isPath: false },
  Glob: { key: "pattern", isPath: false },
  WebFetch: { key: "url", isPath: false },
  WebSearch: { key: "query", isPath: false },
};

// Tools whose successful result is the content of a file rather than a
// summary of what happened — never surface that content in the log panel.
const SUPPRESS_RESULT_ON_SUCCESS = new Set(["Read"]);

function parseArgsPreview(argsPreview: string | undefined): Record<string, unknown> | undefined {
  if (!argsPreview) return undefined;
  try {
    const parsed: unknown = JSON.parse(argsPreview);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function basename(value: string): string {
  return value.split("/").pop() || value;
}

function toolCallLabel(call: ToolCallView): string {
  const mapping = TOOL_LABEL_ARG[call.name];
  if (!mapping) return call.name;
  const value = parseArgsPreview(call.args)?.[mapping.key];
  if (typeof value !== "string" || !value.trim()) return call.name;
  return `${call.name} ${mapping.isPath ? basename(value) : value}`;
}

function toolCallDetail(call: ToolCallView): string | undefined {
  if (call.status === "running") return call.progressPreview;
  if (call.status === "complete" && SUPPRESS_RESULT_ON_SUCCESS.has(call.name)) return undefined;
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

function operatorPromptStep(event: StageLogEvent, id: string): LogStep {
  return {
    id,
    kind: "operator_prompt",
    label: formatActivityLabel(event),
    status: "succeeded",
    detail: formatActivityDescription(event),
    at: event.at,
    defaultExpanded: false,
  };
}

function operatorAnswerStep(event: StageLogEvent, id: string): LogStep {
  return {
    id,
    kind: "operator_answer",
    label: formatActivityLabel(event),
    status: "succeeded",
    detail: formatActivityDescription(event),
    at: event.at,
    defaultExpanded: false,
  };
}

function systemStep(event: StageLogEvent, id: string): LogStep {
  return {
    id,
    kind: "system",
    label: formatActivityLabel(event),
    status: event.event === "failed" ? "failed" : "succeeded",
    detail: formatActivityDescription(event),
    at: event.at,
    defaultExpanded: false,
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
      steps.push(operatorPromptStep(turn.event, id));
    } else if (turn.kind === "operator_answer") {
      steps.push(operatorAnswerStep(turn.event, id));
    } else {
      steps.push(systemStep(turn.event, id));
    }
  }

  const failingStepId = findFailingStepId(steps);
  for (const step of steps) {
    step.defaultExpanded = step.status === "running" || step.id === failingStepId;
  }

  return steps;
}

function LogStepTrigger({ step, now }: { step: LogStep; now: number }) {
  const durationMs = stepDurationMs(step, now);
  return (
    <span className="logstep__trigger">
      <span className={`dot dot--${step.status}`}></span>
      <span className="logstep__label">{step.label}</span>
      {durationMs !== undefined ? (
        <span className="logstep__duration">{formatDuration(durationMs)}</span>
      ) : null}
    </span>
  );
}

function LogStepRow({ step, now }: { step: LogStep; now: number }) {
  // Tracks the running/failed-step auto-expand behavior until the operator
  // manually toggles a row, at which point their choice wins from then on.
  const [manualOverride, setManualOverride] = useState<boolean | null>(null);
  const isOpen = manualOverride ?? step.defaultExpanded;

  if (!step.detail) {
    return (
      <div id={`logstep-${step.id}`} className={`logstep logstep--${step.status}`}>
        <div className="logstep__row logstep__row--static">
          <LogStepTrigger step={step} now={now} />
        </div>
      </div>
    );
  }

  return (
    <div id={`logstep-${step.id}`} className={`logstep logstep--${step.status}`}>
      <Collapsible
        trigger={<LogStepTrigger step={step} now={now} />}
        isOpen={isOpen}
        onOpenChange={setManualOverride}
      >
        <pre className="logstep__detail">{step.detail}</pre>
      </Collapsible>
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
  const bannerText = failureBannerText(steps);

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
              <LogStepRow key={step.id} step={step} now={now} />
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
            onClick={() => jumpToFailingStep(failingStepId)}
          >
            Jump to failing step
          </button>
        </div>
      ) : null}
    </div>
  );
}
