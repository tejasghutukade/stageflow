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
};

function toolCallStatus(call: ToolCallView): LogStepStatus {
  if (call.status === "error") return "failed";
  if (call.status === "running") return "running";
  return "succeeded";
}

function toolCallLabel(call: ToolCallView): string {
  return call.name;
}

function toolCallDetail(call: ToolCallView): string | undefined {
  return call.status === "running" ? call.progressPreview : call.result;
}

function toolCallToStep(call: ToolCallView, id: string): LogStep {
  return {
    id,
    kind: "tool",
    label: toolCallLabel(call),
    status: toolCallStatus(call),
    detail: toolCallDetail(call),
    at: call.at,
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

function LogStepTrigger({ step }: { step: LogStep }) {
  return (
    <span className="logstep__trigger">
      <span className={`dot dot--${step.status}`}></span>
      <span className="logstep__label">{step.label}</span>
    </span>
  );
}

function LogStepRow({ step }: { step: LogStep }) {
  if (!step.detail) {
    return (
      <div className={`logstep logstep--${step.status}`}>
        <div className="logstep__row logstep__row--static">
          <LogStepTrigger step={step} />
        </div>
      </div>
    );
  }

  return (
    <div className={`logstep logstep--${step.status}`}>
      <Collapsible trigger={<LogStepTrigger step={step} />} defaultIsOpen={false}>
        <pre className="logstep__detail">{step.detail}</pre>
      </Collapsible>
    </div>
  );
}

export function LogPanel({ events }: { events: StageLogEvent[] }) {
  const steps = buildLogPanelSteps(events);

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
              <LogStepRow key={step.id} step={step} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
