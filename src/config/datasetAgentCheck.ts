import type { ConversationMode } from "../evals/types.js";

export type DatasetAgentNote = {
  code: "dataset.scenario_unknown_field" | "dataset.expected_invalid";
  message: string;
};

export type DatasetAgentCheckResult = {
  caseId: string;
  valid: boolean;
  message?: string;
  notes: DatasetAgentNote[];
};

const INPUT_KEYS = ["mode", "script", "opening", "persona", "goal", "facts", "tool_mocks"];
const MOCK_MAX_BYTES = 20 * 1024;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, min: number, max: number): value is string {
  return typeof value === "string" && value.length >= min && value.length <= max;
}

function stringList(value: unknown, maxItems: number, maxLength?: number): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= maxItems &&
    value.every((item) => typeof item === "string" && (maxLength === undefined || item.length <= maxLength))
  );
}

function toolMocksProblem(mocks: unknown): string | undefined {
  if (!isPlainObject(mocks)) return "scenario tool_mocks must be an object";
  const entries = Object.entries(mocks);
  if (entries.length > 50) return "scenario tool_mocks has more than 50 entries";
  for (const [tool, mock] of entries) {
    if (tool.length < 1 || tool.length > 128 || /\s/.test(tool)) {
      return `scenario tool_mocks key ${JSON.stringify(tool)} must be 1-128 characters with no whitespace`;
    }
    if (!isPlainObject(mock)) return `scenario tool_mocks "${tool}" must be an object`;
    const hasResult = "result" in mock;
    const hasError = "error" in mock;
    if (hasResult === hasError || Object.keys(mock).length !== 1) {
      return `scenario tool_mocks "${tool}" must have exactly one of result or error`;
    }
    if (hasError && !boundedString(mock.error, 0, 1000)) {
      return `scenario tool_mocks "${tool}" error must be text of at most 1000 characters`;
    }
    if (Buffer.byteLength(JSON.stringify(mock) ?? "", "utf8") > MOCK_MAX_BYTES) {
      return `scenario tool_mocks "${tool}" is larger than 20 KB`;
    }
  }
  return undefined;
}

function scenarioProblem(input: Record<string, unknown>, defaultMode: ConversationMode): string | undefined {
  let mode: ConversationMode = defaultMode;
  if (input.mode !== undefined) {
    if (input.mode !== "script" && input.mode !== "simulated") {
      return `scenario mode must be "script" or "simulated"`;
    }
    mode = input.mode;
  }
  if (mode === "script") {
    const { script } = input;
    if (
      !Array.isArray(script) ||
      script.length < 1 ||
      script.length > 40 ||
      !script.every((item) => boundedString(item, 1, 4000))
    ) {
      return "scenario script must be 1-40 messages of 1-4000 characters (script mode)";
    }
  } else {
    if (!boundedString(input.opening, 1, 2000)) {
      return "scenario opening must be a message of 1-2000 characters (simulated mode)";
    }
    if (!boundedString(input.persona, 1, 1000)) {
      return "scenario persona must be 1-1000 characters (simulated mode)";
    }
    if (!boundedString(input.goal, 1, 1000)) {
      return "scenario goal must be 1-1000 characters (simulated mode)";
    }
    if (input.facts !== undefined && !stringList(input.facts, 30, 300)) {
      return "scenario facts must be at most 30 strings of at most 300 characters";
    }
  }
  if (input.tool_mocks !== undefined) return toolMocksProblem(input.tool_mocks);
  return undefined;
}

function expectedNotes(caseId: string, expected: unknown): DatasetAgentNote[] {
  if (!isPlainObject(expected)) return [];
  const notes: DatasetAgentNote[] = [];
  const note = (message: string): void => {
    notes.push({ code: "dataset.expected_invalid", message: `case ${caseId}: ${message}` });
  };
  if (expected.outcome !== undefined && !boundedString(expected.outcome, 0, 500)) {
    note("expected.outcome must be a string of at most 500 characters");
  }
  for (const key of ["tools", "forbidden_tools"] as const) {
    if (expected[key] !== undefined && !stringList(expected[key], 50)) {
      note(`expected.${key} must be an array of at most 50 strings`);
    }
  }
  return notes;
}

export function checkDatasetAgainstAgent(
  cases: ReadonlyArray<{ id: string; input: Record<string, unknown>; expected?: unknown }>,
  conversation: { mode?: ConversationMode } = {},
): DatasetAgentCheckResult[] {
  const defaultMode = conversation.mode ?? "script";
  return cases.map((c) => {
    const notes: DatasetAgentNote[] = [];
    const unknown = Object.keys(c.input).filter((key) => !INPUT_KEYS.includes(key));
    if (unknown.length > 0) {
      notes.push({
        code: "dataset.scenario_unknown_field",
        message: `case ${c.id}: scenario has unknown field(s): ${unknown.join(", ")}`,
      });
    }
    notes.push(...expectedNotes(c.id, c.expected));
    const problem = scenarioProblem(c.input, defaultMode);
    return problem === undefined
      ? { caseId: c.id, valid: true, notes }
      : { caseId: c.id, valid: false, message: problem, notes };
  });
}
