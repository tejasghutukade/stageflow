import { redactSecrets } from "../../agent/streamLogRedact.js";
import { renderTranscript } from "../graders/transcript.js";
import type { EvalCaseRow, EvalResultWithGrades } from "../storeTypes.js";
import { TRIAGE_STATE_MAX_CHARS } from "./constants.js";
import type { GraderQuestion } from "./types.js";

export type TriageState = {
  state: string;
  truncated: boolean;
  graderQuestions: GraderQuestion[];
};

type Caps = {
  input: number;
  expected: number;
  transcript: number;
  payload: number;
  graderDefinition: number;
  reason: number;
  error: number;
};

const BASE_CAPS: Caps = {
  input: 3_000,
  expected: 2_000,
  transcript: 12_000,
  payload: 5_000,
  graderDefinition: 1_500,
  reason: 600,
  error: 500,
};

const QUESTIONED_GRADER_TYPES = new Set(["code", "rubric"]);

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

class Capper {
  truncated = new Set<string>();
  cap(field: string, value: unknown, max: number): unknown {
    if (value === undefined || value === null) return value;
    const raw = text(value);
    if (raw.length <= max) return value;
    this.truncated.add(field);
    return `${raw.slice(0, max)}…[truncated ${raw.length - max} chars]`;
  }
}

function outputView(output: unknown, capper: Capper, caps: Caps): unknown {
  const rec = asRecord(output);
  if (Object.keys(rec).length === 0) return null;
  if (rec.kind === "conversation" && Array.isArray(rec.messages) && Array.isArray(rec.tool_calls)) {
    const transcript = renderTranscript({
      messages: rec.messages as never,
      tool_calls: rec.tool_calls as never,
    });
    return {
      kind: "conversation",
      stop_reason: rec.stop_reason,
      turns: rec.turns,
      transcript: capper.cap("output.transcript", transcript, caps.transcript),
      final_reply: capper.cap("output.final_reply", rec.final_reply, Math.min(2_000, caps.transcript)),
    };
  }
  return {
    status: rec.status,
    summary: capper.cap("output.summary", rec.summary, 1_000),
    payload: capper.cap("output.payload", rec.payload, caps.payload),
  };
}

function render(
  input: BuildInput,
  caps: Caps,
): { state: string; truncated: boolean; graderQuestions: GraderQuestion[] } {
  const capper = new Capper();
  const { result, caseRow } = input;
  const caseJson = asRecord(caseRow?.case);
  const defs = new Map(input.graderDefinitions.map((def) => [text(asRecord(def).id), asRecord(def)]));
  const failed = result.grades.filter((g) => g.status === "error" || g.passed === false);
  const passed = result.grades.filter((g) => g.status === "graded" && g.passed === true).map((g) => g.graderId);
  const graderQuestions: GraderQuestion[] = [];
  const failedView = failed.map((g) => {
    const def = defs.get(g.graderId) ?? {};
    const { id: _id, ...definition } = def;
    if (QUESTIONED_GRADER_TYPES.has(g.graderType)) graderQuestions.push({ graderId: g.graderId, type: g.graderType });
    return {
      id: g.graderId,
      type: g.graderType,
      reason: capper.cap(`grader.${g.graderId}.reason`, g.reason, caps.reason),
      error_code: g.errorCode,
      weight: def.weight ?? 1,
      must_pass: def.must_pass ?? false,
      definition: capper.cap(`grader.${g.graderId}.definition`, definition, caps.graderDefinition),
    };
  });
  const body = {
    target_kind: input.targetKind,
    case: {
      id: result.caseId,
      title: caseJson.title,
      tags: caseJson.tags,
      input: capper.cap("case.input", caseJson.input, caps.input),
      expected: capper.cap("case.expected", caseJson.expected, caps.expected),
    },
    result: {
      status: result.status,
      error_code: result.errorCode,
      error_message: capper.cap("result.error_message", result.errorMessage, caps.error),
    },
    output: outputView(result.output, capper, caps),
    failed_graders: failedView,
    passed_graders: passed,
    truncated_fields: [...capper.truncated],
  };
  return { state: redactSecrets(JSON.stringify(body)), truncated: capper.truncated.size > 0, graderQuestions };
}

export type BuildInput = {
  targetKind: "stage" | "agent";
  caseRow: EvalCaseRow | undefined;
  result: EvalResultWithGrades;
  /** The eval file's grader definitions from the run's config snapshot. */
  graderDefinitions: unknown[];
};

/**
 * The bounded JSON text both classifiers read: case, output, failed graders with their definitions, passing grader ids.
 * Capped at TRIAGE_STATE_MAX_CHARS; caps shrink in steps and a hard cut is the last resort. Redacted before it leaves.
 */
export function buildTriageState(input: BuildInput, maxChars = TRIAGE_STATE_MAX_CHARS): TriageState {
  let last = render(input, BASE_CAPS);
  let truncated = last.truncated;
  for (const factor of [0.5, 0.25, 0.1]) {
    if (last.state.length <= maxChars) break;
    const caps = Object.fromEntries(
      Object.entries(BASE_CAPS).map(([key, value]) => [key, Math.max(100, Math.floor(value * factor))]),
    ) as Caps;
    last = render(input, caps);
    truncated = true;
  }
  if (last.state.length > maxChars) {
    truncated = true;
    last = { ...last, state: `${last.state.slice(0, maxChars)}…[truncated]` };
  }
  return { state: last.state, truncated, graderQuestions: last.graderQuestions };
}
