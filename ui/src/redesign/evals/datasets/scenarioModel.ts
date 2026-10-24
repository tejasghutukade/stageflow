import type { EvalCaseInput, EvalConversationMode } from "../../../api/evalTypes";
import { CASE_ID_PATTERN, nextCaseId, parseTagsText } from "./datasetModel";

export const SCRIPT_MAX_ITEMS = 40;
export const SCRIPT_MAX_CHARS = 4000;
export const OPENING_MAX = 2000;
export const PERSONA_MAX = 1000;
export const GOAL_MAX = 1000;
export const FACTS_MAX_ITEMS = 30;
export const FACT_MAX_CHARS = 300;
export const MOCKS_MAX = 50;
export const MOCK_MAX_BYTES = 20 * 1024;
export const MOCK_ERROR_MAX = 1000;
export const OUTCOME_MAX = 500;
export const EXPECTED_TOOLS_MAX = 50;
export const TITLE_MAX = 120;

export type MockKind = "result" | "error";
export type MockRow = { tool: string; kind: MockKind; text: string };

export type ScenarioDraft = {
  id: string;
  title: string;
  tags: string;
  mode: EvalConversationMode;
  opening: string;
  persona: string;
  goal: string;
  facts: string[];
  script: string[];
  outcome: string;
  tools: string[];
  forbiddenTools: string[];
  mocks: MockRow[];
};

export type ScenarioErrors = Record<string, string>;

export function emptyScenario(mode: EvalConversationMode, existingIds: readonly string[]): ScenarioDraft {
  return {
    id: nextCaseId(existingIds),
    title: "",
    tags: "",
    mode,
    opening: "",
    persona: "",
    goal: "",
    facts: [],
    script: [""],
    outcome: "",
    tools: [],
    forbiddenTools: [],
    mocks: [],
  };
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function modeOfCase(c: Pick<EvalCaseInput, "input">, defaultMode: EvalConversationMode): EvalConversationMode {
  const mode = record(c.input).mode;
  return mode === "script" || mode === "simulated" ? mode : defaultMode;
}

function mocksOf(value: unknown): MockRow[] {
  return Object.entries(record(value)).map(([tool, raw]) => {
    const entry = record(raw);
    if (typeof entry.error === "string") return { tool, kind: "error" as const, text: entry.error };
    return { tool, kind: "result" as const, text: JSON.stringify(entry.result ?? null) };
  });
}

export function scenarioFromCase(c: EvalCaseInput & { id?: string }, defaultMode: EvalConversationMode): ScenarioDraft {
  const input = record(c.input);
  const expected = record(c.expected);
  const script = strings(input.script);
  return {
    id: c.id ?? "",
    title: c.title ?? "",
    tags: (c.tags ?? []).join(" "),
    mode: modeOfCase(c, defaultMode),
    opening: typeof input.opening === "string" ? input.opening : "",
    persona: typeof input.persona === "string" ? input.persona : "",
    goal: typeof input.goal === "string" ? input.goal : "",
    facts: strings(input.facts),
    script: script.length > 0 ? script : [""],
    outcome: typeof expected.outcome === "string" ? expected.outcome : "",
    tools: strings(expected.tools),
    forbiddenTools: strings(expected.forbidden_tools),
    mocks: mocksOf(input.tool_mocks),
  };
}

/** Fields the effective mode ignores; the editor collapses them under "Ignored in this mode". */
export function ignoredFields(mode: EvalConversationMode): Array<"opening" | "persona" | "goal" | "facts" | "script"> {
  return mode === "script" ? ["opening", "persona", "goal", "facts"] : ["script"];
}

function lengthError(label: string, text: string, max: number): string | null {
  if (text.trim() === "") return `${label} is required`;
  return text.length > max ? `${label} is limited to ${max.toLocaleString("en-US")} characters` : null;
}

function mockValue(row: MockRow): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (row.kind === "error") {
    if (row.text.trim() === "") return { ok: false, error: "Error text is required" };
    if (row.text.length > MOCK_ERROR_MAX) return { ok: false, error: `Error text is limited to ${MOCK_ERROR_MAX} characters` };
    return { ok: true, value: { error: row.text } };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.text);
  } catch {
    return { ok: false, error: "Not valid JSON" };
  }
  if (JSON.stringify(parsed).length > MOCK_MAX_BYTES) return { ok: false, error: "Result is over 20 KB" };
  return { ok: true, value: { result: parsed } };
}

export type ScenarioResult = { ok: true; case: EvalCaseInput & { id: string } } | { ok: false; errors: ScenarioErrors };

/** Draft to case. `defaultMode` is the eval's mode: `input.mode` is written only when the scenario differs from it. */
export function scenarioToCase(
  draft: ScenarioDraft,
  opts: { defaultMode: EvalConversationMode; existingIds: readonly string[]; editing?: boolean },
): ScenarioResult {
  const errors: ScenarioErrors = {};
  const id = draft.id.trim();
  if (!CASE_ID_PATTERN.test(id)) errors.id = "Use letters, digits, . _ - (max 64)";
  else if (!opts.editing && opts.existingIds.includes(id)) errors.id = "That id is already used";
  const title = draft.title.trim();
  if (title.length > TITLE_MAX) errors.title = `At most ${TITLE_MAX} characters`;
  const tags = parseTagsText(draft.tags);
  if (!tags.ok) errors.tags = tags.error;

  const input: Record<string, unknown> = {};
  if (draft.mode !== opts.defaultMode) input.mode = draft.mode;
  if (draft.mode === "script") {
    const messages = draft.script.map((m) => m.trim() === "" ? "" : m);
    const filled = messages.filter((m) => m !== "");
    if (filled.length === 0) errors.script = "Add at least one user message";
    else if (filled.length > SCRIPT_MAX_ITEMS) errors.script = `At most ${SCRIPT_MAX_ITEMS} messages`;
    else if (filled.some((m) => m.length > SCRIPT_MAX_CHARS)) errors.script = `Each message is limited to ${SCRIPT_MAX_CHARS.toLocaleString("en-US")} characters`;
    input.script = filled;
    for (const key of ["opening", "persona", "goal"] as const) if (draft[key].trim() !== "") input[key] = draft[key];
    const keptFacts = draft.facts.filter((f) => f.trim() !== "");
    if (keptFacts.length > 0) input.facts = keptFacts;
  } else {
    const opening = lengthError("Opening", draft.opening, OPENING_MAX);
    if (opening) errors.opening = opening;
    const persona = lengthError("Persona", draft.persona, PERSONA_MAX);
    if (persona) errors.persona = persona;
    const goal = lengthError("Goal", draft.goal, GOAL_MAX);
    if (goal) errors.goal = goal;
    if (!opening) input.opening = draft.opening;
    if (!persona) input.persona = draft.persona;
    if (!goal) input.goal = draft.goal;
    const facts = draft.facts.filter((f) => f.trim() !== "");
    if (facts.length > FACTS_MAX_ITEMS) errors.facts = `At most ${FACTS_MAX_ITEMS} facts`;
    else if (facts.some((f) => f.length > FACT_MAX_CHARS)) errors.facts = `Each fact is limited to ${FACT_MAX_CHARS} characters`;
    if (facts.length > 0) input.facts = facts;
    const keptScript = draft.script.filter((m) => m.trim() !== "");
    if (keptScript.length > 0) input.script = keptScript;
  }

  const mocks: Record<string, unknown> = {};
  const seen = new Set<string>();
  draft.mocks.forEach((row, i) => {
    const tool = row.tool.trim();
    if (tool === "" && row.text.trim() === "") return;
    if (!/^[^\s]{1,128}$/.test(tool)) {
      errors[`mock.${i}.tool`] = "Tool id is required (no spaces, max 128)";
      return;
    }
    if (seen.has(tool)) {
      errors[`mock.${i}.tool`] = "Another mock already uses this tool";
      return;
    }
    seen.add(tool);
    const value = mockValue(row);
    if (!value.ok) errors[`mock.${i}.value`] = value.error;
    else mocks[tool] = value.value;
  });
  if (Object.keys(mocks).length > MOCKS_MAX) errors.mocks = `At most ${MOCKS_MAX} mocks`;
  if (Object.keys(mocks).length > 0) input.tool_mocks = mocks;

  const outcome = draft.outcome.trim();
  if (outcome.length > OUTCOME_MAX) errors.outcome = `Outcome is limited to ${OUTCOME_MAX} characters`;
  const tools = draft.tools.filter((t) => t.trim() !== "");
  const forbidden = draft.forbiddenTools.filter((t) => t.trim() !== "");
  if (tools.length > EXPECTED_TOOLS_MAX) errors.tools = `At most ${EXPECTED_TOOLS_MAX} tools`;
  if (forbidden.length > EXPECTED_TOOLS_MAX) errors.forbiddenTools = `At most ${EXPECTED_TOOLS_MAX} tools`;
  const expected: Record<string, unknown> = {
    ...(outcome !== "" ? { outcome } : {}),
    ...(tools.length > 0 ? { tools } : {}),
    ...(forbidden.length > 0 ? { forbidden_tools: forbidden } : {}),
  };

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    case: {
      id,
      input,
      ...(title !== "" ? { title } : {}),
      ...(Object.keys(expected).length > 0 ? { expected } : {}),
      ...(tags.ok && tags.tags.length > 0 ? { tags: tags.tags } : {}),
    },
  };
}

/** Same rules as the server's scenario check, so cases the wizard holds can be counted without a request. */
export function scenarioProblem(c: Pick<EvalCaseInput, "input">, defaultMode: EvalConversationMode): string | null {
  const input = record(c.input);
  const mode = modeOfCase(c, defaultMode);
  if (mode === "script") {
    const script = Array.isArray(input.script) ? input.script : [];
    if (script.length === 0) return "scenario needs a script with at least one message";
    if (script.length > SCRIPT_MAX_ITEMS || script.some((m) => typeof m !== "string" || m.length < 1 || m.length > SCRIPT_MAX_CHARS)) {
      return "scenario script has an invalid message";
    }
    return null;
  }
  for (const [key, max] of [["opening", OPENING_MAX], ["persona", PERSONA_MAX], ["goal", GOAL_MAX]] as const) {
    const v = input[key];
    if (typeof v !== "string" || v.trim() === "") return `scenario needs ${key}`;
    if (v.length > max) return `scenario ${key} is too long`;
  }
  return null;
}

export function countValidScenarios(cases: readonly EvalCaseInput[], defaultMode: EvalConversationMode): { ready: number; skipped: number } {
  let ready = 0;
  for (const c of cases) if (scenarioProblem(c, defaultMode) === null) ready += 1;
  return { ready, skipped: cases.length - ready };
}

export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return [...list];
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item as T);
  return next;
}

export type ScenarioRowView = {
  id: string;
  mode: EvalConversationMode;
  title: string;
  opening: string;
  expectedTools: string;
  tags: string;
};

function oneLine(text: string, limit = 120): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

export function scenarioRow(c: EvalCaseInput & { id?: string }, defaultMode: EvalConversationMode, index = 0): ScenarioRowView {
  const input = record(c.input);
  const mode = modeOfCase(c, defaultMode);
  const script = strings(input.script);
  const first = mode === "script" ? (script[0] ?? "") : typeof input.opening === "string" ? input.opening : (script[0] ?? "");
  return {
    id: c.id ?? `c${String(index + 1).padStart(3, "0")}`,
    mode,
    title: c.title ?? "",
    opening: oneLine(first),
    expectedTools: strings(record(c.expected).tools).join(", "),
    tags: (c.tags ?? []).join(" "),
  };
}

export function modeLabel(mode: EvalConversationMode): string {
  return mode === "script" ? "Script" : "Simulated";
}

export function scenarioSummary(total: number, invalid: number): string {
  const base = `${total} ${total === 1 ? "scenario" : "scenarios"}`;
  return invalid === 0 ? `${base} · all valid` : `${base} · ${invalid} skipped`;
}

export const INVALID_SCENARIOS_TAIL = "Invalid scenarios are skipped in runs until fixed.";

export function invalidScenarioBanner(invalid: number, total: number): { title: string; tail: string } | null {
  if (invalid <= 0) return null;
  return { title: `${invalid} of ${total} scenarios are invalid.`, tail: INVALID_SCENARIOS_TAIL };
}

export const MIXED_USE_BANNER = "This dataset is used by a stage eval and an agent eval; most cases will be invalid for one of them.";
export const IGNORED_TITLE = "Ignored in this mode";

/** Evals that use this dataset, by kind; both kinds at once is the mixed-use case. */
export function isMixedUse(usedBy: readonly string[], kinds: ReadonlyMap<string, "stage" | "agent">): boolean {
  const seen = new Set(usedBy.map((id) => kinds.get(id)).filter((k): k is "stage" | "agent" => k !== undefined));
  return seen.has("stage") && seen.has("agent");
}
