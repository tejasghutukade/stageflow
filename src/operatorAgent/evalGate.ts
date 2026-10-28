import { randomUUID } from "node:crypto";
import { STUB_RESULT, type EvalToolCallRecord, type EvalToolPolicy } from "../agents/evalGate.js";
import { TOOL_META } from "../toolkit/meta.js";
import type { OperatorAgentToolResult } from "./types.js";

const ALWAYS_BLOCKED = new Set([
  "run_eval",
  "agent_chat",
  "fire_trigger",
  "sort_eval_failures",
  "cancel_eval_run",
  "start_run",
  "run_stage",
  "rerun",
  "retry_stage",
  "resume_stage",
  "delete_run",
  "cancel_run",
  "gc_runs",
  "remove_connection",
  "delete_eval_run",
  "delete_memory_card",
  "archive_agent",
  "enable_agent",
  "set_trigger_enabled",
  "test_connection",
  "import_task_file",
  "probe_project_mcp",
]);

/** Tools that only talk to the person or read Stageflow's own docs. They never change the project. */
const SAFE = new Set(["confirm_action", "show_ui", "list_guide_topics", "read_guide_topic"]);

export type OperatorEvalPolicy = {
  tools: EvalToolPolicy;
  mocks: Record<string, { result?: unknown; error?: string }>;
};

/**
 * Tool gate for an eval of a built-in operator agent. Reads may run. Writes, sends and deletes
 * are stubbed or mocked and never reach the handler. `real` is treated as read-only: these
 * agents write the operator's own project, so an eval cannot opt into that.
 */
export function createOperatorEvalGate(options: {
  policy: OperatorEvalPolicy;
  turn: () => number;
}): {
  decide(name: string, args: Record<string, unknown>): OperatorAgentToolResult | null;
  observe(name: string, result: OperatorAgentToolResult): void;
  records(): EvalToolCallRecord[];
} {
  const records: EvalToolCallRecord[] = [];
  let pending: EvalToolCallRecord | undefined;

  const push = (record: EvalToolCallRecord): void => {
    records.push(record);
  };

  return {
    decide(name, args) {
      const base = { id: randomUUID(), turn: options.turn(), name, args };
      const mock = options.policy.mocks[name];
      const deny = (result: string, policyOutcome: EvalToolCallRecord["policyOutcome"]): OperatorAgentToolResult => {
        push({ ...base, policyOutcome, status: "not_run", result });
        return { ok: false, error: "eval.tool_not_run", content: { error: "eval.tool_not_run", message: result } };
      };
      if (ALWAYS_BLOCKED.has(name)) return deny(`${name} cannot run in an evaluation.`, "denied");
      if (mock && (options.policy.tools === "mocked" || !mayRun(name))) {
        const text = mock.error ?? (typeof mock.result === "string" ? mock.result : JSON.stringify(mock.result ?? null));
        push({ ...base, policyOutcome: "mocked", status: mock.error !== undefined ? "error" : "ok", result: text });
        return { ok: mock.error === undefined, ...(mock.error !== undefined ? { error: mock.error } : {}), content: mock.result ?? mock.error };
      }
      if (!mayRun(name)) return deny(STUB_RESULT(name), "stubbed");
      pending = { ...base, policyOutcome: "ran", status: "ok" };
      push(pending);
      return null;
    },
    observe(_name, result) {
      if (!pending) return;
      pending.result = typeof result.content === "string" ? result.content : JSON.stringify(result.content ?? null);
      if (!result.ok) pending.status = "error";
      pending = undefined;
    },
    records: () => records,
  };
}

function mayRun(name: string): boolean {
  if (SAFE.has(name)) return true;
  return TOOL_META[name]?.risk === "read";
}
