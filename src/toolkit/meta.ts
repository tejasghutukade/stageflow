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
  | "evals.read"
  | "evals.run"
  | "evals.write"
  | "evals.cleanup"
  | "pipelines.author"
  | "connections"
  | "connections.cleanup"
  | "memories"
  | "memories.cleanup"
  | "functions.read"
  | "functions.write"
  | "functions.test"
  | "functions.cleanup";

export type ToolGroup = {
  id: ToolGroupId;
  title: string;
  summary: string;
  /** Never offered to agents: these decide things a person must decide (approvals, gates). */
  operatorOnly?: true;
};

export type ToolsetId =
  | "core"
  | "runs"
  | "catalog"
  | "agents"
  | "evals"
  | "functions"
  | "triggers"
  | "connections"
  | "memories";

export type Toolset = {
  id: ToolsetId;
  title: string;
  summary: string;
};

export const TOOLSETS: readonly Toolset[] = [
  { id: "core", title: "Core", summary: "Discover the project, author YAML, run pipelines, read outputs, and answer gates." },
  { id: "runs", title: "Run cleanup", summary: "Abandon stages and delete or garbage-collect runs." },
  { id: "catalog", title: "Catalog extras", summary: "Import tasks and probe project MCP servers." },
  { id: "agents", title: "Agents", summary: "List, manage, chat with and approve project agents." },
  { id: "evals", title: "Evals", summary: "Author, run, review and delete evals and datasets." },
  { id: "functions", title: "Functions", summary: "Author, test and delete reusable JavaScript functions." },
  { id: "triggers", title: "Triggers", summary: "List, configure and fire triggers." },
  { id: "connections", title: "Connections", summary: "Manage send channels and test recipients." },
  { id: "memories", title: "Memories", summary: "Manage host memories and their cards." },
];

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
  { id: "connections", title: "Connections", summary: "List, create, test and update host connections. Secret values are stored and never returned." },
  { id: "connections.cleanup", title: "Remove connections", summary: "Remove a connection and its stored secrets. Destructive." },
  { id: "memories", title: "Memories", summary: "List, create and edit host memories and their cards." },
  { id: "memories.cleanup", title: "Delete memory cards", summary: "Delete one card from a host memory. Destructive." },
  { id: "evals.read", title: "Read evals", summary: "List evals, runs and results; validate and compare. Free." },
  { id: "evals.run", title: "Run evals", summary: "Start and cancel eval runs, and try one case. Calls models and costs money." },
  { id: "evals.write", title: "Author evals", summary: "Create and edit evals and datasets, install a sample, and review or sort suggestions." },
  { id: "evals.cleanup", title: "Delete eval runs", summary: "Delete an eval run and its stored results. Destructive." },
  { id: "functions.read", title: "Look at functions", summary: "List functions and read a revision." },
  { id: "functions.write", title: "Author functions", summary: "Create, edit, and duplicate functions, and attach them through stage, pipeline, and agent writes." },
  { id: "functions.test", title: "Test functions", summary: "Ask to test a function." },
  { id: "functions.cleanup", title: "Delete functions", summary: "Delete a function that nothing references. Destructive." },
];

export type ToolMeta = {
  groups: ToolGroupId[];
  risk: ToolRisk;
  toolset: ToolsetId;
  /** Not offered to agents even though its group is. */
  operatorOnly?: true;
};

const t = (group: ToolGroupId, risk: ToolRisk, toolset: ToolsetId, operatorOnly?: true): ToolMeta => ({
  groups: [group],
  risk,
  toolset,
  ...(operatorOnly ? { operatorOnly } : {}),
});

export const TOOL_META: Readonly<Record<string, ToolMeta>> = {
  get_started: t("discover", "read", "core", true),
  list_catalog: t("discover", "read", "core"),
  validate: {
    groups: ["agents.read", "connections", "discover", "evals.read", "pipelines.author"],
    risk: "read",
    toolset: "core",
  },
  read_pipeline: { groups: ["discover", "pipelines.author"], risk: "read", toolset: "core" },
  probe_project_mcp: t("discover", "external", "catalog"),
  import_task: t("pipelines.author", "external", "catalog"),

  get_run: t("runs.read", "read", "core"),
  get_stage: t("runs.read", "read", "core"),
  run_files: t("runs.read", "read", "core"),
  wait_run: t("runs.read", "read", "core"),

  start_run: t("runs.control", "write", "core"),
  stage_action: t("runs.control", "write", "core"),
  cancel_run: t("runs.cleanup", "destructive", "core"),
  abandon_stage: t("runs.cleanup", "destructive", "runs"),
  delete_runs: t("runs.cleanup", "destructive", "runs"),

  list_waiting: t("gates.read", "read", "core"),
  answer_gate: t("gates.decide", "write", "core", true),
  decide_feedback_loop: t("gates.decide", "write", "core", true),

  get_trigger: t("triggers", "read", "triggers"),
  save_trigger: t("triggers", "write", "triggers"),
  fire_trigger: t("triggers", "external", "triggers"),

  get_agent: t("agents.read", "read", "agents"),
  get_agent_session: t("agents.read", "read", "agents"),

  save_agent: t("agents.manage", "write", "agents"),
  set_agent_enabled: t("agents.manage", "write", "agents"),
  archive_agent: t("agents.cleanup", "destructive", "agents"),

  agent_chat: t("agents.converse", "external", "agents"),
  stop_agent_session: t("agents.converse", "write", "agents"),
  decide_agent_action: t("gates.decide", "write", "agents", true),

  write_pipeline: t("pipelines.author", "write", "core"),
  write_stage: t("pipelines.author", "write", "core"),
  write_task: t("pipelines.author", "write", "core"),

  get_connection: t("connections", "read", "connections"),
  save_connection: t("connections", "write", "connections"),
  test_connection: t("connections", "external", "connections"),
  remove_connection: t("connections.cleanup", "destructive", "connections"),

  get_memory: t("memories", "read", "memories"),
  save_memory: t("memories", "write", "memories"),
  delete_memory_card: t("memories.cleanup", "destructive", "memories"),

  get_eval: t("evals.read", "read", "evals"),
  get_eval_run: t("evals.read", "read", "evals"),
  get_eval_results: t("evals.read", "read", "evals"),
  compare_eval_runs: t("evals.read", "read", "evals"),
  get_eval_failures: t("evals.read", "read", "evals"),
  run_eval: t("evals.run", "external", "evals"),
  sort_eval_failures: t("evals.run", "external", "evals"),
  calibrate_eval_grader: t("evals.run", "external", "evals"),
  cancel_eval_run: t("evals.run", "write", "evals"),
  try_eval_case: t("evals.run", "external", "evals"),

  save_eval: t("evals.write", "write", "evals"),
  save_dataset: t("evals.write", "write", "evals"),
  review_eval_results: t("evals.write", "write", "evals"),
  delete_eval_run: t("evals.cleanup", "destructive", "evals"),

  get_function: t("functions.read", "read", "functions"),
  save_function: t("functions.write", "write", "functions"),
  test_function: t("functions.test", "read", "functions"),
  delete_function: t("functions.cleanup", "destructive", "functions"),
};

export type StageflowGrants = { groups: readonly string[]; tools: readonly string[] };

/** The grant id the policy gate and `approvals.ask_first` use for a Stageflow tool. */
export const STAGEFLOW_GRANT_PREFIX = "stageflow.";
export const stageflowGrantId = (tool: string): string => `${STAGEFLOW_GRANT_PREFIX}${tool}`;

export function isToolGroupId(value: string): value is ToolGroupId {
  return TOOL_GROUPS.some((group) => group.id === value);
}

export function isToolsetId(value: string): value is ToolsetId {
  return TOOLSETS.some((toolset) => toolset.id === value);
}

export function toolsInToolset(toolset: ToolsetId): string[] {
  return Object.entries(TOOL_META)
    .filter(([, meta]) => meta.toolset === toolset)
    .map(([name]) => name)
    .sort();
}

export function isOperatorOnlyGroup(group: string): boolean {
  return TOOL_GROUPS.some((entry) => entry.id === group && entry.operatorOnly === true);
}

export function isOperatorOnlyTool(name: string): boolean {
  const meta = TOOL_META[name];
  return meta !== undefined && (meta.operatorOnly === true || meta.groups.some((entry) => isOperatorOnlyGroup(entry)));
}

/** Tools of a group an agent may hold; operator-only tools are left out. */
export function toolsInGroup(group: string): string[] {
  return Object.entries(TOOL_META)
    .filter(([name, meta]) => meta.groups.includes(group as ToolGroupId) && !isOperatorOnlyTool(name))
    .map(([name]) => name);
}

/** Every Stageflow tool name a definition grants, whole groups and single tools together. */
export function grantedStageflowTools(grants: StageflowGrants): string[] {
  const names = new Set<string>(grants.tools.filter((tool) => tool in TOOL_META && !isOperatorOnlyTool(tool)));
  for (const group of grants.groups) for (const tool of toolsInGroup(group)) names.add(tool);
  return [...names].sort();
}
