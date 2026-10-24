import type { EvalRunDetail, EvalRunOptions } from "../../../api/evalTypes";
import { formatCost } from "../format";
import { kindLabel } from "./gradersModel";
import { hash6, settingsOf, stageLabel, suiteTypeLabel } from "./headerModel";
import { agentIdOf, agentNameOf, agentRevisionOf, conversationOf, isAgentRun } from "../agentRun";
import { outcomeBadge } from "./transcriptModel";

export type Chip = { text: string; tone: "ok" | "needs" | "muted" };

export type ConfigRow = { label: string; value: string; chip?: Chip };

type Snapshot = Record<string, any>;

function target(run: EvalRunDetail): Snapshot {
  return (run.config?.target ?? {}) as Snapshot;
}

export function editedChip(snapshotHash: string | null | undefined, currentHash: string | null | undefined): Chip | null {
  if (!snapshotHash || !currentHash) return null;
  return snapshotHash === currentHash ? null : { text: `edited since: now ${hash6(currentHash)}`, tone: "needs" };
}

export function stageEdited(run: EvalRunDetail): boolean {
  return editedChip(target(run).stage_version_hash, run.current?.stage_version_hash) !== null;
}

/** Agent runs: the agent changed if its revision or definition hash is not what the run used. */
export function agentEdited(run: EvalRunDetail): boolean {
  return agentRevisionChip(run) !== null || editedChip(target(run).definition_hash, run.current?.agent_definition_hash) !== null;
}

export function agentRevisionChip(run: EvalRunDetail): Chip | null {
  const used = agentRevisionOf(run);
  const now = run.current?.agent_revision;
  if (used === null || now === null || now === undefined || used === now) return null;
  return { text: `edited since: now r${now}`, tone: "needs" };
}

export type ToolRow = { id: string; cls: string; risk: string; outcome: string; tone: "ok" | "needs" | "muted" | "fail" };

const CLASS_LABELS: Record<string, string> = {
  read: "read",
  write: "write",
  shell: "shell",
  destructive: "destructive",
  external: "external",
  mcp_unknown: "unknown MCP",
  sub_agent: "sub-agent",
  browser: "browser",
  operator_only: "operator only",
};

function listedReadOnly(id: string, list: readonly string[]): boolean {
  return list.some((entry) => entry === id || (entry.endsWith(".*") && id.startsWith(entry.slice(0, -1))));
}

/** The policy outcome a tool gets under the run's settings, per the file schema's decision table (a scenario mock turns Stubbed into Mocked). */
export function toolOutcome(
  tool: { id: string; class: string },
  conv: { tools?: string; approvals?: string; read_only_tools?: string[] },
  askFirst: readonly string[],
): { label: string; tone: ToolRow["tone"] } {
  if (tool.class === "operator_only") return { label: outcomeBadge("denied").label, tone: "fail" };
  const readClass = tool.class === "read" || listedReadOnly(tool.id, conv.read_only_tools ?? []);
  if (askFirst.includes(tool.id) || tool.id === "bash") {
    if (conv.approvals === "deny") return { label: outcomeBadge("denied").label, tone: "fail" };
    if (conv.approvals !== "auto_approve_read" || !readClass) return { label: outcomeBadge("would_ask_first").label, tone: "needs" };
  }
  if (conv.tools === "real" || readClass) return { label: outcomeBadge("ran").label, tone: "ok" };
  return { label: `${outcomeBadge("stubbed").label}, Mocked if the scenario mocks it`, tone: "muted" };
}

export function agentToolRows(run: EvalRunDetail): ToolRow[] {
  const tools: Snapshot[] = Array.isArray(target(run).tools) ? target(run).tools : [];
  const askFirst: string[] = Array.isArray(target(run).ask_first) ? target(run).ask_first : [];
  const conv = conversationOf(run);
  return tools.map((t) => {
    const outcome = toolOutcome({ id: String(t.id), class: String(t.class) }, conv, askFirst);
    return {
      id: String(t.id),
      cls: CLASS_LABELS[String(t.class)] ?? String(t.class),
      risk: String(t.risk ?? ""),
      outcome: outcome.label,
      tone: outcome.tone,
    };
  });
}

export function limitsLine(run: EvalRunDetail): string | null {
  const effective = target(run).limits_override?.effective;
  if (!effective || typeof effective.max_turns !== "number") return null;
  const minutes = typeof effective.session_minutes === "number" ? `, ${effective.session_minutes} minutes` : "";
  return `Eval limits replaced the agent's: ${effective.max_turns} turns${minutes}`;
}

export function agentCard(run: EvalRunDetail): ConfigRow[] {
  const t = target(run);
  const revision = agentRevisionOf(run);
  const revisionChip = agentRevisionChip(run);
  const hashChip = editedChip(t.definition_hash, run.current?.agent_definition_hash);
  const subs: Snapshot[] = Array.isArray(t.sub_agents) ? t.sub_agents : [];
  const askFirst: string[] = Array.isArray(t.ask_first) ? t.ask_first : [];
  const rows: ConfigRow[] = [
    { label: "Agent", value: agentNameOf(run) === agentIdOf(run) ? (agentIdOf(run) ?? "—") : `${agentNameOf(run)} · ${agentIdOf(run)}` },
    { label: "Revision", value: revision === null ? "—" : `r${revision}`, ...(revisionChip ? { chip: revisionChip } : {}) },
    { label: "Definition", value: hash6(t.definition_hash), ...(hashChip ? { chip: hashChip } : {}) },
    { label: "Model", value: typeof t.model === "string" && t.model !== "" ? t.model : "—" },
    { label: "Asks first", value: askFirst.length > 0 ? askFirst.join(", ") : "—" },
  ];
  const limits = limitsLine(run);
  if (limits) rows.push({ label: "Limits", value: limits });
  if (subs.length > 0) rows.push({ label: "Sub-agents", value: subs.map((a) => `${a.id} r${a.revision}`).join(", ") });
  return rows;
}

const TOOLS_WORDS: Record<string, string> = { read_only: "Read only", mocked: "Mocked", real: "Real" };
const APPROVALS_WORDS: Record<string, string> = { record_only: "Record only", deny: "Deny", auto_approve_read: "Auto-approve reads" };

export function conversationCard(run: EvalRunDetail): ConfigRow[] {
  const c = conversationOf(run);
  const engine = (run.config?.engine ?? {}) as Snapshot;
  const readOnly: string[] = Array.isArray(c.read_only_tools) ? c.read_only_tools : [];
  const timeout = typeof c.turn_timeout_ms === "number" ? `${Math.round(c.turn_timeout_ms / 1000)} s` : "—";
  return [
    { label: "Mode", value: c.mode === "simulated" ? "Simulated" : c.mode === "script" ? "Script" : "—" },
    { label: "Max turns", value: typeof c.max_turns === "number" ? String(c.max_turns) : "—" },
    { label: "Turn timeout", value: timeout },
    { label: "Tools", value: TOOLS_WORDS[String(c.tools)] ?? "—", ...(c.tools === "real" ? { chip: { text: "REAL TOOLS", tone: "needs" as const } } : {}) },
    { label: "Approvals", value: APPROVALS_WORDS[String(c.approvals)] ?? "—" },
    { label: "Read-only tools", value: readOnly.length > 0 ? readOnly.join(", ") : "—" },
    { label: "User model", value: typeof c.user_model === "string" && c.user_model !== "" ? c.user_model : "—" },
    { label: "Simulator prompt", value: c.simulator_prompt_version !== undefined ? `v${c.simulator_prompt_version}` : "—" },
    { label: "Conversation rubric prompt", value: engine.rubric_prompt_version !== undefined ? `v${engine.rubric_prompt_version}` : "—" },
  ];
}

export function usedRealTools(run: EvalRunDetail): boolean {
  return isAgentRun(run) && conversationOf(run).tools === "real";
}

export function datasetEdited(run: EvalRunDetail): boolean {
  const snapshot = (run.config?.dataset ?? {}) as Snapshot;
  return editedChip(snapshot.hash, run.current?.dataset_hash) !== null;
}

export function changedGraders(run: EvalRunDetail): string[] {
  const current = run.current?.grader_hashes;
  if (!current) return [];
  const snapshot: Snapshot[] = Array.isArray(run.config?.graders) ? run.config.graders : [];
  const changed = snapshot.filter((g) => current[g.id] !== undefined && current[g.id] !== g.hash).map((g) => String(g.id));
  const added = Object.keys(current).filter((id) => !snapshot.some((g) => g.id === id));
  const removed = snapshot.filter((g) => current[g.id] === undefined).map((g) => String(g.id));
  return [...changed, ...added, ...removed];
}

export function stageCard(run: EvalRunDetail): ConfigRow[] {
  const t = target(run);
  const { stage, pipeline } = stageLabel(run);
  const file = typeof t.stage_definition?.file === "string" ? t.stage_definition.file : t.file;
  const where = pipeline && stage ? `${stage} in ${pipeline}` : (stage ?? "—");
  const thinking = t.stage_definition?.thinking ?? t.stage_definition?.thinking_level;
  const model = typeof t.model === "string" && t.model !== "" ? t.model : "—";
  const chip = editedChip(t.stage_version_hash, run.current?.stage_version_hash);
  return [
    { label: "Stage", value: file && pipeline ? `${where} · ${file}` : where },
    { label: "Version", value: hash6(t.stage_version_hash), ...(chip ? { chip } : {}) },
    { label: "Model", value: typeof thinking === "string" && thinking !== "" ? `${model} · thinking ${thinking}` : model },
    { label: "Output schema", value: t.output_schema_hash ? hash6(t.output_schema_hash) : "—" },
  ];
}

export function datasetCard(run: EvalRunDetail): { status: Chip | null; rows: ConfigRow[] } {
  const d = (run.config?.dataset ?? {}) as Snapshot;
  const t = target(run);
  const current = run.current?.dataset_hash ?? null;
  const status: Chip | null =
    current === null || !d.hash
      ? null
      : current === d.hash
        ? { text: "unchanged since this run", tone: "ok" }
        : { text: `edited since: now ${hash6(current)}`, tone: "needs" };
  return {
    status,
    rows: [
      { label: "File", value: String(d.path ?? "—") },
      { label: "Content hash", value: hash6(d.hash) },
      { label: "Cases run", value: `${d.cases_run ?? 0} of ${d.case_count ?? 0} · ${d.cases_skipped ?? 0} skipped` },
      { label: "Input schema", value: t.input_schema_hash ? `io.input · ${hash6(t.input_schema_hash)}` : "—" },
    ],
  };
}

export type GraderConfigRow = {
  id: string;
  kind: string;
  weightText: string;
  hash: string;
  versionText: string | null;
  notCalibrated: boolean;
  edited: Chip | null;
};

export function gradersCard(run: EvalRunDetail): { count: number; summary: string; rows: GraderConfigRow[] } {
  const snapshot: Snapshot[] = Array.isArray(run.config?.graders) ? run.config.graders : [];
  const current = run.current?.grader_hashes ?? null;
  const rows = snapshot.map((g) => ({
    id: String(g.id),
    kind: kindLabel(String(g.type)).toLowerCase(),
    weightText: g.must_pass ? "must pass" : `×${g.weight ?? 1}`,
    hash: hash6(g.hash),
    versionText: g.type === "rubric" && g.version_ordinal ? `v${g.version_ordinal}` : null,
    notCalibrated: g.type === "rubric",
    edited: current && current[g.id] !== undefined ? editedChip(g.hash, current[g.id]) : null,
  }));
  const versions = rows.filter((r) => r.versionText).map((r) => r.versionText as string);
  const unique = [...new Set(versions)];
  return {
    count: rows.length,
    summary: unique.length === 0 ? `${rows.length}` : `${rows.length} · rubrics ${unique.join(", ")}`,
    rows,
  };
}

export function settingsCard(run: EvalRunDetail): ConfigRow[] {
  const s = settingsOf(run);
  const overrides = (run.config?.overrides ?? {}) as Snapshot;
  const engine = (run.config?.engine ?? {}) as Snapshot;
  const threshold = Number(s.pass_threshold);
  const limit = Number(s.max_cost_usd);
  const noun = isAgentRun(run) ? "agent" : "stage";
  const modelNote =
    typeof overrides.model === "string" && overrides.model !== ""
      ? `${noun} model overridden: ${overrides.model}`
      : `${noun} model not overridden`;
  return [
    {
      label: "Judge model",
      value: typeof s.judge === "string" && s.judge !== "" ? s.judge : "—",
      ...(s.judge_same_as_stage ? { chip: { text: `same as ${isAgentRun(run) ? "agent" : "stage"} model`, tone: "needs" as const } } : {}),
    },
    {
      label: "Repeats · threshold · limit",
      value: `${s.repeats ?? "—"} · ${Number.isFinite(threshold) ? threshold.toFixed(2) : "—"} · ${
        Number.isFinite(limit) ? formatCost(limit) : "—"
      } (spent ${formatCost(run.progress.cost_usd)})`,
    },
    { label: "Suite type", value: `${suiteTypeLabel(run).toLowerCase()} · ${modelNote}` },
    {
      label: "Software",
      value: `Stageflow ${run.config?.stageflow_version ?? "—"} · eval engine ${engine.name ?? "—"} ${engine.version ?? ""}`.trim(),
    },
  ];
}

export function fingerprintNote(): string {
  return "Saved with the results and never edited. Runs with the same fingerprint compare directly.";
}

export function caseSubset(run: EvalRunDetail): string[] | null {
  const ids = (run.components as { case_ids?: unknown })?.case_ids;
  return Array.isArray(ids) ? (ids as string[]) : null;
}

export function reproduceCommand(run: EvalRunDetail): string {
  const s = settingsOf(run);
  const overrides = (run.config?.overrides ?? {}) as Snapshot;
  const parts = ["sf eval run", run.eval_path];
  if (s.repeats !== undefined) parts.push(`--repeats ${s.repeats}`);
  if (typeof s.judge === "string" && s.judge !== "") parts.push(`--judge ${s.judge}`);
  if (typeof overrides.model === "string" && overrides.model !== "") parts.push(`--model ${overrides.model}`);
  if (overrides.max_cost_usd !== null && overrides.max_cost_usd !== undefined) parts.push(`--max-cost ${s.max_cost_usd}`);
  if (typeof overrides.user_model === "string" && overrides.user_model !== "") parts.push(`--user-model ${overrides.user_model}`);
  if (usedRealTools(run)) parts.push("--allow-real-tools");
  for (const id of caseSubset(run) ?? []) parts.push(`--case ${id}`);
  return parts.join(" ");
}

export function rerunOverrides(run: EvalRunDetail): EvalRunOptions {
  const s = settingsOf(run);
  const overrides = (run.config?.overrides ?? {}) as Snapshot;
  const out: EvalRunOptions = {};
  if (Number.isInteger(s.repeats)) out.repeats = s.repeats;
  if (typeof s.judge === "string" && s.judge !== "") out.judge = s.judge;
  if (typeof overrides.model === "string" && overrides.model !== "") out.model = overrides.model;
  if (Number.isFinite(Number(s.max_cost_usd))) out.max_cost_usd = Number(s.max_cost_usd);
  if (typeof overrides.user_model === "string" && overrides.user_model !== "") out.user_model = overrides.user_model;
  if (overrides.tools === "read_only" || overrides.tools === "mocked") out.tools = overrides.tools;
  if (overrides.approvals === "deny" || overrides.approvals === "record_only") out.approvals = overrides.approvals;
  const subset = caseSubset(run);
  if (subset && subset.length > 0) out.case_ids = subset;
  return out;
}

export function rerunNote(run: EvalRunDetail): string | null {
  const names: string[] = [];
  if (isAgentRun(run) ? agentEdited(run) : stageEdited(run)) names.push(isAgentRun(run) ? "agent" : "stage");
  if (datasetEdited(run)) names.push("dataset");
  if (changedGraders(run).length > 0) names.push("graders");
  if (names.length === 0) return null;
  const joined = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `The ${joined} changed since this run; this will use the current ones.`;
}

export function exportFileName(run: Pick<EvalRunDetail, "eval_id" | "run_number">, what: "results" | "config"): string {
  return `${run.eval_id}-run-${run.run_number}-${what}.json`;
}
