import {
  isOperatorOnlyGroup,
  toolsInGroup,
  TOOL_META,
  type ToolGroupId,
  type ToolMeta,
  type ToolRisk,
} from "./meta.js";

export type ToolRenameEntry = {
  readonly newTool: string;
  readonly fields: Readonly<Record<string, unknown>>;
};

const row = (newTool: string, fields: Record<string, unknown> = {}): ToolRenameEntry => ({ newTool, fields });

export const TOOL_RENAMES: Readonly<Record<string, ToolRenameEntry>> = {
  get_started: row("get_started"),
  list_pipelines: row("list_catalog", { kind: "pipelines" }),
  list_tasks: row("list_catalog", { kind: "tasks" }),
  list_skills: row("list_catalog", { kind: "skills" }),
  list_models: row("list_catalog", { kind: "models" }),
  list_project_mcp: row("list_catalog", { kind: "mcp_servers" }),
  list_providers: row("list_catalog", { kind: "providers" }),
  get_health: row("list_catalog", { kind: "health" }),
  validate: row("validate"),
  validate_catalog_draft: row("validate", { kind: "draft" }),
  preflight: row("validate", { preflight: true }),
  validate_agent: row("validate", { kind: "agent" }),
  validate_eval: row("validate", { kind: "eval" }),
  validate_connection_target: row("validate", { kind: "connection_recipient" }),
  read_pipeline: row("read_pipeline", { view: "package" }),
  describe_pipeline: row("read_pipeline", { view: "dag" }),
  create_pipeline: row("write_pipeline", { mode: "create" }),
  edit_pipeline: row("write_pipeline", { mode: "update" }),
  create_stage: row("write_stage", { mode: "create" }),
  edit_stage: row("write_stage", { patch: true }),
  create_stage_file: row("write_stage", { mode: "create", no_pipeline: true }),
  write_catalog_file: row("write_stage", { mode: "update", form: "content" }),
  create_task: row("write_task", { mode: "create" }),
  edit_task: row("write_task", { mode: "update" }),
  create_task_file: row("write_task", { mode: "create", no_pipeline: true }),
  update_task_file: row("write_task", { mode: "update", no_pipeline: true }),
  import_task_file: row("import_task"),
  probe_project_mcp: row("probe_project_mcp"),
  start_run: row("start_run", { pipeline: true }),
  run_stage: row("start_run", { stage: true }),
  rerun: row("start_run", { from_run: true }),
  get_run: row("get_run"),
  list_runs: row("get_run"),
  export_run: row("get_run", { view: "export" }),
  list_stage_events: row("get_stage", { view: "events" }),
  tail_stage_log: row("get_stage", { view: "log" }),
  get_envelope: row("get_stage", { view: "envelope" }),
  get_stage_verification: row("get_stage", { view: "verification" }),
  read_artifact: row("run_files", { view: "artifact" }),
  list_checkout_changes: row("run_files", { view: "changes" }),
  get_run_diff: row("run_files", { view: "diff" }),
  read_checkout_file: row("run_files", { view: "file" }),
  wait_run: row("wait_run"),
  retry_stage: row("stage_action", { action: "retry" }),
  resume_stage: row("stage_action", { action: "resume" }),
  recover_manual_stage: row("stage_action", { action: "recover" }),
  stop_manual_recovery: row("stage_action", { action: "stop_recovery" }),
  cancel_run: row("cancel_run"),
  abandon_stage: row("abandon_stage"),
  delete_run: row("delete_runs"),
  gc_runs: row("delete_runs", { gc: true }),
  list_waiting: row("list_waiting", { detail: "full" }),
  get_waiting_summary: row("list_waiting", { detail: "summary" }),
  answer_gate: row("answer_gate"),
  decide_feedback_loop: row("decide_feedback_loop"),
  list_triggers: row("get_trigger", { list: true }),
  get_trigger: row("get_trigger"),
  create_trigger: row("save_trigger", { mode: "create" }),
  update_trigger: row("save_trigger", { mode: "update" }),
  set_trigger_enabled: row("save_trigger", { mode: "update", enabled_only: true }),
  fire_trigger: row("fire_trigger"),
  list_agents: row("get_agent", { list: true }),
  get_agent: row("get_agent", { view: "definition" }),
  list_agent_revisions: row("get_agent", { view: "revisions" }),
  get_agent_revision: row("get_agent", { view: "revision" }),
  diff_agent_revisions: row("get_agent", { view: "diff" }),
  list_agent_sessions: row("get_agent_session", { list: true }),
  get_agent_session: row("get_agent_session"),
  create_agent: row("save_agent", { mode: "create" }),
  save_agent: row("save_agent", { mode: "update" }),
  restore_agent_revision: row("save_agent", { mode: "update", from_revision: true }),
  enable_agent: row("set_agent_enabled", { enabled: true }),
  disable_agent: row("set_agent_enabled", { enabled: false }),
  archive_agent: row("archive_agent"),
  agent_chat: row("agent_chat"),
  stop_agent_session: row("stop_agent_session"),
  approve_agent_action: row("decide_agent_action", { action: "approve" }),
  deny_agent_action: row("decide_agent_action", { action: "deny" }),
  list_functions: row("get_function", { list: true }),
  get_function: row("get_function"),
  list_function_revisions: row("get_function", { view: "revisions" }),
  get_function_revision: row("get_function", { view: "revision" }),
  create_function: row("save_function", { mode: "create" }),
  save_function: row("save_function", { mode: "update" }),
  duplicate_function: row("save_function", { mode: "create", copy_from: true }),
  test_function: row("test_function"),
  delete_function: row("delete_function"),
  list_connections: row("get_connection"),
  create_connection: row("save_connection", { mode: "create" }),
  update_connection: row("save_connection", { mode: "update" }),
  test_connection: row("test_connection"),
  remove_connection: row("remove_connection"),
  list_memories: row("get_memory", { list: true }),
  get_memory: row("get_memory"),
  create_memory: row("save_memory", { mode: "create" }),
  write_memory: row("save_memory", { mode: "update" }),
  write_memory_card: row("save_memory", { mode: "update", card: true }),
  delete_memory_card: row("delete_memory_card"),
  get_artifact: row("get_artifact"),
  save_artifact: row("save_artifact"),
  refresh_artifact: row("refresh_artifact"),
  delete_artifact: row("delete_artifact"),
  promote_artifact: row("promote_artifact"),
  list_evals: row("get_eval", { list: true }),
  get_eval: row("get_eval", { view: "definition" }),
  list_grader_calibrations: row("get_eval", { view: "calibrations" }),
  create_eval: row("save_eval", { mode: "create" }),
  update_eval: row("save_eval", { mode: "update" }),
  install_eval_sample: row("save_eval", { mode: "create", source: "sample" }),
  create_dataset: row("save_dataset", { action: "create" }),
  update_dataset_cases: row("save_dataset", { action: "ops" }),
  convert_dataset: row("save_dataset", { action: "convert" }),
  list_eval_runs: row("get_eval_run", { list: true }),
  get_eval_run: row("get_eval_run"),
  get_eval_run_export: row("get_eval_run", { view: "export" }),
  get_eval_results: row("get_eval_results"),
  get_eval_result: row("get_eval_results", { case_id: true }),
  compare_eval_runs: row("compare_eval_runs"),
  get_eval_failure_suggestions: row("get_eval_failures", { view: "suggestions" }),
  get_eval_failure_sort_status: row("get_eval_failures", { view: "sort_status" }),
  put_eval_review: row("review_eval_results", { action: "label" }),
  accept_eval_failure_suggestions: row("review_eval_results", { action: "accept" }),
  dismiss_eval_failure_suggestions: row("review_eval_results", { action: "dismiss" }),
  run_eval: row("run_eval"),
  try_eval_case: row("try_eval_case"),
  sort_eval_failures: row("sort_eval_failures"),
  calibrate_eval_grader: row("calibrate_eval_grader"),
  cancel_eval_run: row("cancel_eval_run"),
  delete_eval_run: row("delete_eval_run"),
};

export const GRANT_PARITY_READ_ONLY_EXCEPTIONS = {
  validate:
    "validate absorbs catalog, draft, preflight, agent, eval, and connection_recipient validation from multiple grant groups",
  read_pipeline: "read_pipeline absorbs describe_pipeline from discover alongside the pipelines.author package read",
} as const;

export function distinctNewToolNames(): string[] {
  return [...new Set(Object.values(TOOL_RENAMES).map((entry) => entry.newTool))].sort();
}

export function derivedConsolidatedToolMeta(): Readonly<Record<string, ToolMeta>> {
  const built = new Map<string, { risks: ToolRisk[]; operatorOnly: boolean[]; groups: Set<ToolGroupId> }>();
  for (const [oldName, mapping] of Object.entries(TOOL_RENAMES)) {
    const oldMeta = TOOL_META[oldName] ?? TOOL_META[mapping.newTool];
    if (!oldMeta) throw new Error(`TOOL_META missing old tool: ${oldName}`);
    let slot = built.get(mapping.newTool);
    if (!slot) {
      slot = { risks: [], operatorOnly: [], groups: new Set() };
      built.set(mapping.newTool, slot);
    }
    slot.risks.push(oldMeta.risk);
    slot.operatorOnly.push(oldMeta.operatorOnly === true);
    for (const group of oldMeta.groups) slot.groups.add(group);
  }
  const out: Record<string, ToolMeta> = {};
  for (const [name, slot] of built) {
    const canonical = TOOL_META[name];
    if (!canonical) throw new Error(`TOOL_META missing consolidated tool: ${name}`);
    const risk = slot.risks[0]!;
    const operatorOnly = slot.operatorOnly.every(Boolean) ? (true as const) : undefined;
    out[name] = {
      groups: [...slot.groups].sort() as ToolGroupId[],
      risk,
      toolset: canonical.toolset,
      ...(operatorOnly ? { operatorOnly } : {}),
    };
  }
  return out;
}

export function consolidatedToolsInGroup(group: ToolGroupId): string[] {
  const meta = derivedConsolidatedToolMeta();
  return Object.entries(meta)
    .filter(([name, entry]) => entry.groups.includes(group) && !isConsolidatedOperatorOnly(name, entry))
    .map(([name]) => name)
    .sort();
}

function isConsolidatedOperatorOnly(name: string, meta: ToolMeta): boolean {
  return meta.operatorOnly === true || meta.groups.some((entry) => isOperatorOnlyGroup(entry));
}

export function grantParityBeforeGroup(group: ToolGroupId): string[] {
  return [
    ...new Set(
      toolsInGroup(group).map((name) => TOOL_RENAMES[name]?.newTool ?? name),
    ),
  ].sort();
}