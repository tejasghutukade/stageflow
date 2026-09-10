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
};

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
  if (!step.detail) {
    return (
      <div className={`logstep logstep--${step.status}`}>
        <div className="logstep__row logstep__row--static">
          <LogStepTrigger step={step} now={now} />
        </div>
      </div>
    );
  }

  return (
    <div className={`logstep logstep--${step.status}`}>
      <Collapsible trigger={<LogStepTrigger step={step} now={now} />} defaultIsOpen={false}>
        <pre className="logstep__detail">{step.detail}</pre>
      </Collapsible>
    </div>
  );
}

export function LogPanel({ events }: { events: StageLogEvent[] }) {
  const steps = buildLogPanelSteps(events);
  const now = Date.now();

  return (
    <div className="stream" style={{ height: "100%" }}>
      <header className="stream__head">
        <h3 className="stream__name">Logs</h3>
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
    </div>
  );
}
