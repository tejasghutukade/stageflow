import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AgentDetail, AgentSummary } from "../agents/service.js";
import { isAgentError } from "../agents/errors.js";
import { effectiveAskFirst } from "../agents/policy.js";
import { canonicalJson, sha256Hex } from "../evals/canonical.js";
import type { EvalFile } from "../evals/types.js";
import { grantedToolIds, parseAgentYaml, type AgentDefinition, type AgentIssue } from "./loadAgent.js";
import { loadFailure, loadSuccess, type LoadIssue, type LoadOutcome } from "./loadOutcome.js";
import { TOOL_META, STAGEFLOW_GRANT_PREFIX } from "../toolkit/meta.js";

export type AgentToolRisk =
  | "read"
  | "write"
  | "shell"
  | "destructive"
  | "external"
  | "mcp_unknown"
  | "sub_agent"
  | "browser";

export type AgentToolGrant = { id: string; risk: AgentToolRisk };

export type ResolvedAgentTarget = {
  agentId: string;
  /** The revision read now; null when resolved offline from the file alone. */
  revision: number | null;
  definitionHash: string;
  /** The definition after the eval's `defaults.model` override. */
  definition: AgentDefinition;
  modelResolved: string | undefined;
  tools: AgentToolGrant[];
  askFirst: string[];
  issues: LoadIssue[];
};

/** The slice of `AgentService` that eval resolution reads. */
export type AgentCatalogPort = {
  get(projectRoot: string, agentId: string): Promise<AgentDetail>;
  list(projectRoot: string): Promise<AgentSummary[]>;
};

const BUILTIN_RISK: Record<string, AgentToolRisk> = {
  read: "read",
  grep: "read",
  find: "read",
  ls: "read",
  write: "write",
  edit: "write",
  bash: "shell",
};

function agentIssue(code: string, message: string, severity: "error" | "warning" = "error"): LoadIssue {
  return { code, message, category: "eval", severity };
}

function grantRisk(id: string): AgentToolRisk {
  if (id in BUILTIN_RISK) return BUILTIN_RISK[id] as AgentToolRisk;
  if (id.startsWith("agent:")) return "sub_agent";
  if (id.startsWith(STAGEFLOW_GRANT_PREFIX)) {
    return TOOL_META[id.slice(STAGEFLOW_GRANT_PREFIX.length)]?.risk ?? "mcp_unknown";
  }
  return "mcp_unknown";
}

export function agentToolGrants(definition: AgentDefinition): AgentToolGrant[] {
  const grants = [...grantedToolIds(definition)].sort().map((id) => ({ id, risk: grantRisk(id) }));
  if (definition.tools.browser) grants.push({ id: "browser", risk: "browser" });
  return grants;
}

/** sha256 of the canonical JSON of the definition after the eval's `defaults.model` override. */
export function agentDefinitionHash(definition: AgentDefinition): string {
  return sha256Hex(canonicalJson(definition));
}

function withModelOverride(definition: AgentDefinition, model: string | undefined): AgentDefinition {
  return model === undefined ? definition : { ...definition, model: { ...definition.model, id: model } };
}

function firstIssue(issues: AgentIssue[]): string {
  const issue = issues[0];
  if (!issue) return "the definition does not load";
  return issue.path ? `${issue.path}: ${issue.message}` : issue.message;
}

function resolved(
  agentId: string,
  revision: number | null,
  base: AgentDefinition,
  file: EvalFile,
  warnings: LoadIssue[],
): LoadOutcome<ResolvedAgentTarget> {
  const definition = withModelOverride(base, file.defaults?.model);
  const issues = [...warnings];
  if (!definition.enabled) {
    issues.push(
      agentIssue(
        "eval.agent_disabled",
        `Agent "${agentId}" is disabled; eval sessions run anyway`,
        "warning",
      ),
    );
  }
  return loadSuccess(
    {
      agentId,
      revision,
      definitionHash: agentDefinitionHash(definition),
      definition,
      modelResolved: definition.model.id,
      tools: agentToolGrants(definition),
      askFirst: effectiveAskFirst(definition),
      issues,
    },
    issues,
  );
}

export async function resolveAgentTarget(
  file: EvalFile,
  projectRoot: string,
  agents: AgentCatalogPort,
): Promise<LoadOutcome<ResolvedAgentTarget>> {
  if (file.target.kind !== "agent") {
    return loadFailure([agentIssue("eval.target_unresolved", "Not an agent target")]);
  }
  const agentId = file.target.agent;
  let detail: AgentDetail;
  try {
    detail = await agents.get(projectRoot, agentId);
  } catch (err) {
    if (isAgentError(err) && err.code === "agent.not_found") {
      return loadFailure([agentIssue("eval.agent_not_found", `Agent "${agentId}" was not found`)]);
    }
    throw err;
  }
  const listed = await agents.list(projectRoot);
  if (!listed.some((agent) => agent.id === agentId)) {
    return loadFailure([agentIssue("eval.agent_archived", `Agent "${agentId}" is archived`)]);
  }
  if (detail.agent.issues.length > 0 || detail.definition === null) {
    return loadFailure([
      agentIssue(
        "eval.agent_invalid",
        `Agent "${agentId}" has problems in its definition: ${firstIssue(detail.agent.issues)}`,
      ),
    ]);
  }
  return resolved(agentId, detail.agent.revision, detail.definition, file, []);
}

/** Offline resolution (`sf eval validate` without an agent service): parses `agents/<id>.agent.yaml` only. */
export async function resolveAgentTargetFromFile(
  file: EvalFile,
  projectRoot: string,
): Promise<LoadOutcome<ResolvedAgentTarget>> {
  if (file.target.kind !== "agent") {
    return loadFailure([agentIssue("eval.target_unresolved", "Not an agent target")]);
  }
  const agentId = file.target.agent;
  let text: string;
  try {
    text = await readFile(path.join(projectRoot, "agents", `${agentId}.agent.yaml`), "utf8");
  } catch {
    return loadFailure([agentIssue("eval.agent_not_found", `Agent "${agentId}" was not found`)]);
  }
  const parsed = parseAgentYaml(text);
  if (!parsed.ok) {
    return loadFailure([
      agentIssue(
        "eval.agent_invalid",
        `Agent "${agentId}" has problems in its definition: ${firstIssue(parsed.issues)}`,
      ),
    ]);
  }
  if (parsed.value.id !== agentId) {
    return loadFailure([
      agentIssue(
        "eval.agent_invalid",
        `Agent "${agentId}" has problems in its definition: id must match the file name`,
      ),
    ]);
  }
  return resolved(agentId, null, parsed.value, file, []);
}
