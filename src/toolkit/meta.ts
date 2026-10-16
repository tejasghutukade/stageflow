/**
 * Pure description of Stageflow's own tools: which group each belongs to and
 * how risky it is. No handlers live here, so config validation and the console
 * can import it without pulling in the runtime.
 */

export type ToolRisk = "read" | "write" | "destructive" | "external";

export type ToolGroupId =
  | "discover"
  | "runs.read"
  | "runs.control"
  | "runs.cleanup"
  | "gates.read"
  | "gates.decide"
  | "triggers"
  | "agents.read"
  | "agents.manage"
  | "agents.cleanup"
  | "agents.converse"
  | "pipelines.author";

export type ToolGroup = {
  id: ToolGroupId;
  title: string;
  summary: string;
  /** Never offered to agents: these decide things a person must decide (approvals, gates). */
  operatorOnly?: true;
};

export const TOOL_GROUPS: readonly ToolGroup[] = [
  { id: "discover", title: "Discover the project", summary: "List pipelines, tasks, skills, models and providers; validate and preflight." },
  { id: "runs.read", title: "Watch runs", summary: "Read runs, stage events, logs, envelopes, artifacts and checkout diffs." },
  { id: "runs.control", title: "Run and recover pipelines", summary: "Start, rerun, retry, resume and recover runs." },
  { id: "runs.cleanup", title: "Cancel and delete runs", summary: "Cancel runs, abandon stages, delete runs and collect old ones. Destructive." },
  { id: "gates.read", title: "See what is waiting", summary: "List the gates and questions waiting on a person." },
  { id: "gates.decide", title: "Decide gates and approvals", summary: "Answer gates and approve or deny agent actions. Only a person can do this.", operatorOnly: true },
  { id: "triggers", title: "Triggers", summary: "List, create and fire triggers." },
  { id: "agents.read", title: "Look at agents", summary: "List agents, revisions and sessions." },
  { id: "agents.manage", title: "Manage agents", summary: "Create, save, enable, disable and restore agents." },
  { id: "agents.cleanup", title: "Archive agents", summary: "Archive an agent. Destructive." },
  { id: "agents.converse", title: "Talk to agents", summary: "Chat with an agent and stop its running turn." },
  { id: "pipelines.author", title: "Author pipelines and tasks", summary: "Read, create and edit pipelines, stages and tasks directly on disk." },
];

export type ToolMeta = {
  group: ToolGroupId;
  risk: ToolRisk;
  /** Not offered to agents even though its group is. */
  operatorOnly?: true;
};

const t = (group: ToolGroupId, risk: ToolRisk, operatorOnly?: true): ToolMeta => ({ group, risk, ...(operatorOnly ? { operatorOnly } : {}) });

export const TOOL_META: Readonly<Record<string, ToolMeta>> = {
  get_started: t("discover", "read", true),
  list_skills: t("discover", "read"),
  list_pipelines: t("discover", "read"),
  list_tasks: t("discover", "read"),
  list_models: t("discover", "read"),
  list_providers: t("discover", "read"),
  get_health: t("discover", "read"),
  preflight: t("discover", "read"),
  validate: t("discover", "read"),
  describe_pipeline: t("discover", "read"),
  list_project_mcp: t("discover", "read"),
  probe_project_mcp: t("discover", "external"),

  list_runs: t("runs.read", "read"),
  get_run: t("runs.read", "read"),
  export_run: t("runs.read", "read"),
  read_artifact: t("runs.read", "read"),
  wait_run: t("runs.read", "read"),
  list_stage_events: t("runs.read", "read"),
  tail_stage_log: t("runs.read", "read"),
  get_stage_verification: t("runs.read", "read"),
  get_envelope: t("runs.read", "read"),
  list_checkout_changes: t("runs.read", "read"),
  get_run_diff: t("runs.read", "read"),
  read_checkout_file: t("runs.read", "read"),

  start_run: t("runs.control", "write"),
  run_stage: t("runs.control", "write"),
  rerun: t("runs.control", "write"),
  retry_stage: t("runs.control", "write"),
  resume_stage: t("runs.control", "write"),
  recover_manual_stage: t("runs.control", "write"),
  stop_manual_recovery: t("runs.control", "write"),
  cancel_run: t("runs.cleanup", "destructive"),
  abandon_stage: t("runs.cleanup", "destructive"),
  delete_run: t("runs.cleanup", "destructive"),
  gc_runs: t("runs.cleanup", "destructive"),

  list_waiting: t("gates.read", "read"),
  get_waiting_summary: t("gates.read", "read"),
  answer_gate: t("gates.decide", "write", true),
  decide_feedback_loop: t("gates.decide", "write", true),

  list_triggers: t("triggers", "read"),
  get_trigger: t("triggers", "read"),
  create_trigger: t("triggers", "write"),
  update_trigger: t("triggers", "write"),
  set_trigger_enabled: t("triggers", "write"),
  fire_trigger: t("triggers", "external"),

  list_agents: t("agents.read", "read"),
  get_agent: t("agents.read", "read"),
  validate_agent: t("agents.read", "read"),
  list_agent_revisions: t("agents.read", "read"),
  get_agent_session: t("agents.read", "read"),
  list_agent_sessions: t("agents.read", "read"),

  create_agent: t("agents.manage", "write"),
  save_agent: t("agents.manage", "write"),
  enable_agent: t("agents.manage", "write"),
  disable_agent: t("agents.manage", "write"),
  restore_agent_revision: t("agents.manage", "write"),
  archive_agent: t("agents.cleanup", "destructive"),

  agent_chat: t("agents.converse", "external"),
  stop_agent_session: t("agents.converse", "write"),
  approve_agent_action: t("gates.decide", "write", true),
  deny_agent_action: t("gates.decide", "write", true),

  read_pipeline: t("pipelines.author", "read"),
  create_pipeline: t("pipelines.author", "write"),
  edit_pipeline: t("pipelines.author", "write"),
  create_stage: t("pipelines.author", "write"),
  edit_stage: t("pipelines.author", "write"),
  create_task: t("pipelines.author", "write"),
  edit_task: t("pipelines.author", "write"),
};

export type StageflowGrants = { groups: readonly string[]; tools: readonly string[] };

/** The grant id the policy gate and `approvals.ask_first` use for a Stageflow tool. */
export const STAGEFLOW_GRANT_PREFIX = "stageflow.";
export const stageflowGrantId = (tool: string): string => `${STAGEFLOW_GRANT_PREFIX}${tool}`;

export function isToolGroupId(value: string): value is ToolGroupId {
  return TOOL_GROUPS.some((group) => group.id === value);
}

export function isOperatorOnlyGroup(group: string): boolean {
  return TOOL_GROUPS.some((entry) => entry.id === group && entry.operatorOnly === true);
}

export function isOperatorOnlyTool(name: string): boolean {
  const meta = TOOL_META[name];
  return meta !== undefined && (meta.operatorOnly === true || isOperatorOnlyGroup(meta.group));
}

/** Tools of a group an agent may hold; operator-only tools are left out. */
export function toolsInGroup(group: string): string[] {
  return Object.entries(TOOL_META)
    .filter(([name, meta]) => meta.group === group && !isOperatorOnlyTool(name))
    .map(([name]) => name);
}

/** Every Stageflow tool name a definition grants, whole groups and single tools together. */
export function grantedStageflowTools(grants: StageflowGrants): string[] {
  const names = new Set<string>(grants.tools.filter((tool) => tool in TOOL_META && !isOperatorOnlyTool(tool)));
  for (const group of grants.groups) for (const tool of toolsInGroup(group)) names.add(tool);
  return [...names].sort();
}
