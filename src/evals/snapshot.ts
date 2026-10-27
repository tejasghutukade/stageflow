import { canonicalJson, sha256Hex } from "./canonical.js";
import { CONFIG_SNAPSHOT_VERSION, CONVERSATION_RUBRIC_PROMPT_VERSION, RUBRIC_PROMPT_VERSION } from "./constants.js";

export type SnapshotOverrides = {
  repeats: number | null;
  judge: string | null;
  model: string | null;
  max_cost_usd: number | null;
  case_ids: string[] | null;
  tags: string[] | null;
  only_failed_from: string | null;
  user_model?: string | null;
  tools?: string | null;
  approvals?: string | null;
};

export type SnapshotGrader = {
  id: string;
  type: string;
  hash: string;
  version_ordinal: number;
  weight: number;
  must_pass: boolean;
};

export type StageSnapshotTarget = {
  kind: "stage";
  pipeline_path: string | null;
  stage_id: string | null;
  file: string | null;
  stage_version_hash: string;
  stage_definition: Record<string, unknown>;
  model: string;
  model_tier: string;
  input_schema_hash: string | null;
  output_schema_hash: string | null;
};

export type AgentLimitSet = {
  max_turns: number | null;
  session_minutes: number | null;
  cost_usd: number | null;
  always_on: boolean;
};

export type AgentSnapshotTarget = {
  kind: "agent";
  agent_id: string;
  revision: number;
  definition_hash: string;
  definition: Record<string, unknown>;
  model: string;
  model_tier: string;
  tools: Array<{ id: string; risk: string; class: string }>;
  ask_first: string[];
  sub_agents: Array<{ id: string; revision: number }>;
  limits_override: {
    agent: AgentLimitSet;
    effective: AgentLimitSet;
    capture: string;
    otlp: boolean;
    groundedness: boolean;
  };
};

export type ConversationSettings = {
  mode: string;
  max_turns: number;
  turn_timeout_ms: number;
  tools: string;
  approvals: string;
  read_only_tools: string[];
  real_tools_confirmed: boolean;
  user_model: string;
  user_model_from_judge: boolean;
  simulator_prompt_version: number;
};

export type InternalAgentSnapshotTarget = {
  kind: "internal_agent";
  profile_id: string;
  title: string;
  playbook_hash: string;
  tools: string[];
  model: string;
};

export type ConfigSnapshot = {
  snapshot_version: number;
  eval: { id: string; path: string; hash: string; definition: Record<string, unknown> };
  overrides: SnapshotOverrides;
  target: StageSnapshotTarget | AgentSnapshotTarget | InternalAgentSnapshotTarget;
  dataset: {
    path: string;
    hash: string;
    format: string;
    case_count: number;
    cases_run: number;
    cases_skipped: number;
    skipped_case_ids: string[];
  };
  graders: SnapshotGrader[];
  settings: {
    repeats: number;
    pass_threshold: number;
    judge: string;
    judge_same_as_stage: boolean;
    max_cost_usd: number;
    concurrency: number;
    suite_type: string;
    conversation?: ConversationSettings;
  };
  engine: { name: string; version: string; rubric_prompt_version: number; node_version: string };
  stageflow_version: string;
};

/** Every fingerprint input, as the exact value fingerprinted, so two runs can be diffed by key. */
export type ConfigComponents = {
  stage: string;
  model: string;
  dataset: string;
  case_ids: string[] | null;
  graders: Record<string, string>;
  judge: string;
  repeats: number;
  pass_threshold: number;
  engine: { name: string; version: string };
  rubric_prompt_version: number;
  agent?: AgentComponent;
};

/** Agent-only fingerprint inputs; absent for stage runs so stage payloads hash identically. */
export type AgentComponent = {
  revision: number;
  mode: string;
  max_turns: number;
  turn_timeout_ms: number;
  tools: string;
  approvals: string;
  read_only_tools: string[];
  user_model: string | null;
  simulator_prompt_version: number;
};

export type ComponentsInput = {
  stageVersionHash: string;
  model: string;
  datasetHash: string;
  caseIds: readonly string[] | null;
  graders: ReadonlyArray<{ id: string; hash: string }>;
  judge: string;
  repeats: number;
  passThreshold: number;
  engine: { name: string; version: string };
  rubricPromptVersion?: number;
  agent?: AgentComponent;
};

export function buildComponents(input: ComponentsInput): ConfigComponents {
  const graders: Record<string, string> = {};
  for (const grader of [...input.graders].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    graders[grader.id] = grader.hash;
  }
  const agent = input.agent;
  return {
    stage: input.stageVersionHash,
    model: input.model,
    dataset: input.datasetHash,
    case_ids: input.caseIds === null ? null : [...input.caseIds].sort(),
    graders,
    judge: input.judge,
    repeats: input.repeats,
    pass_threshold: input.passThreshold,
    engine: { name: input.engine.name, version: input.engine.version },
    rubric_prompt_version:
      input.rubricPromptVersion ?? (agent ? CONVERSATION_RUBRIC_PROMPT_VERSION : RUBRIC_PROMPT_VERSION),
    ...(agent ? { agent: { ...agent, read_only_tools: [...agent.read_only_tools].sort() } } : {}),
  };
}

/** First 8 hex of sha256 over the canonical fingerprint payload. */
export function computeFingerprint(components: ConfigComponents): string {
  const payload = {
    stage_version_hash: components.stage,
    model: components.model,
    dataset_hash: components.dataset,
    case_ids: components.case_ids,
    graders: Object.entries(components.graders)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([id, hash]) => ({ id, hash })),
    repeats: components.repeats,
    pass_threshold: components.pass_threshold,
    judge: components.judge,
    engine: components.engine,
    rubric_prompt_version: components.rubric_prompt_version,
    ...(components.agent ? { agent: components.agent } : {}),
  };
  return sha256Hex(canonicalJson(payload)).slice(0, 8);
}

export type SnapshotInput = {
  evalId: string;
  evalPath: string;
  evalHash: string;
  evalDefinition: Record<string, unknown>;
  overrides: SnapshotOverrides;
  target: Omit<StageSnapshotTarget, "kind"> | Omit<AgentSnapshotTarget, "kind"> | Omit<InternalAgentSnapshotTarget, "kind">;
  dataset: ConfigSnapshot["dataset"];
  graders: SnapshotGrader[];
  settings: ConfigSnapshot["settings"];
  engine: { name: string; version: string; nodeVersion: string };
  stageflowVersion: string;
};

export function buildSnapshot(input: SnapshotInput): ConfigSnapshot {
  const internalTarget = "profile_id" in input.target ? input.target : null;
  const agentTarget = !internalTarget && "agent_id" in input.target ? input.target : null;
  return {
    snapshot_version: CONFIG_SNAPSHOT_VERSION,
    eval: {
      id: input.evalId,
      path: input.evalPath,
      hash: input.evalHash,
      definition: input.evalDefinition,
    },
    overrides: input.overrides,
    target: internalTarget
      ? { kind: "internal_agent", ...internalTarget }
      : agentTarget
        ? { kind: "agent", ...agentTarget }
        : { kind: "stage", ...(input.target as Omit<StageSnapshotTarget, "kind">) },
    dataset: input.dataset,
    graders: input.graders,
    settings: input.settings,
    engine: {
      name: input.engine.name,
      version: input.engine.version,
      rubric_prompt_version: agentTarget || internalTarget ? CONVERSATION_RUBRIC_PROMPT_VERSION : RUBRIC_PROMPT_VERSION,
      node_version: input.engine.nodeVersion,
    },
    stageflow_version: input.stageflowVersion,
  };
}
