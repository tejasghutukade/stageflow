import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import {
  agentAuthorContextAdapter,
  emptyAgentAuthorDraft,
  isAgentAuthorContext,
  readAgentAuthorDraft,
  type AgentAuthorContext,
  type AgentAuthorDraft,
} from "../agentAuthorContext.js";
import { AGENT_ID_PATTERN, parseAgentDefinition } from "../../config/loadAgent.js";
import { listProjectMcpCatalog } from "../../config/resolveStageMcpServers.js";
import type {
  OperatorAgentProfile,
  OperatorAgentProposal,
  OperatorAgentTool,
  OperatorAgentToolContext,
} from "../types.js";
import { AGENT_AUTHOR_PLAYBOOK } from "./agentAuthorPlaybook.js";
import { authorReadRefusal } from "./authorReadable.js";
import { connectionsFilePath } from "../../channels/registry.js";
import { loadConnectionsFile } from "../../channels/config.js";
import { listSkills } from "../../config/listSkills.js";
import { globalStageflowHome } from "../../project/globalHome.js";

export const AGENT_AUTHOR_PROFILE_ID = "agent-author";

const MAX_READ_CHARS = 32_000;

let proposalSeq = 0;

function nextProposalId(): string {
  proposalSeq += 1;
  return `agent-author-${proposalSeq}`;
}

function projectRootOf(ctx: OperatorAgentToolContext): string | undefined {
  const context = ctx.getContext();
  if (!isAgentAuthorContext(context)) return undefined;
  const root = context.projectRoot?.trim();
  return root || undefined;
}

function rejectEscape(root: string, rel: string): string | null {
  if (!rel || path.isAbsolute(rel) || rel.includes("\0")) return "path must be a relative project path";
  const parts = rel.split(/[/\\]/);
  if (parts.some((part) => part === ".." || part === ".git" || part === "node_modules")) {
    return "path is outside the readable project surface";
  }
  const target = path.resolve(root, rel);
  const base = path.resolve(root);
  if (target !== base && !target.startsWith(base + path.sep)) return "path escapes the project";
  return null;
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function coercePlainObject(value: unknown): Record<string, unknown> | null {
  if (isPlainObject(value)) return value;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (isPlainObject(parsed)) return parsed;
  } catch {
    /* not JSON */
  }
  try {
    const parsed = parseYaml(trimmed) as unknown;
    if (isPlainObject(parsed)) return parsed;
  } catch {
    /* not YAML */
  }
  return null;
}

export function formatAgentAuthorTurnPrompt(
  message: string,
  contextSnapshot: unknown,
): string {
  const draft = readAgentAuthorDraft(contextSnapshot);
  const draftJson = JSON.stringify(draft, null, 2);
  return [
    "Current agent draft JSON. Ask until the job is clear. Call update_agent_draft only when you draft or revise; do not reply with YAML instead:",
    draftJson,
    "",
    "Operator message:",
    message.trim(),
  ].join("\n");
}

export function agentAuthorBridgeHint(toolNames: readonly string[]): string {
  return [
    "Agent author: a thin first request is not a spec. Ask what you still need, or offer one suggestion when the answer is vague. Do not call update_agent_draft until they confirm the job or tell you to go ahead.",
    "When you do change the draft, call update_agent_draft before you finish. Chat YAML does not update the panel.",
    "You may read only docs/, policies/, AGENTS.md, and README.md. Do not grant a connection, MCP server, or skill that list_author_catalog or list_mcp_servers did not return. Do not set tools.browser.",
    `Tools: ${toolNames.join(", ")}`,
  ].join("\n");
}

function patchFromToolArgs(args: Record<string, unknown>): Record<string, unknown> | null {
  const patch = coercePlainObject(args.patch);
  if (patch) return patch;
  const { summary: _summary, patch: _patch, ...rest } = args;
  if (Object.keys(rest).length === 0) return null;
  return coercePlainObject(rest) ?? (isPlainObject(rest) ? rest : null);
}

/** Objects merge key by key; arrays and scalars replace; `null` removes the key. */
export function mergeDraftPatch(draft: AgentAuthorDraft, patch: Record<string, unknown>): AgentAuthorDraft {
  const next: AgentAuthorDraft = structuredClone(draft);
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else if (isPlainObject(value) && isPlainObject(next[key])) {
      next[key] = mergeDraftPatch(next[key] as Record<string, unknown>, value);
    } else next[key] = structuredClone(value);
  }
  return next;
}

function slugId(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^[^a-z]+/, "")
    .slice(0, 64);
  return AGENT_ID_PATTERN.test(slug) ? slug : "";
}

const readProjectFile: OperatorAgentTool = {
  name: "read_project_file",
  description:
    "Read a text file inside the operator project. Relative path only. Refuses .git, node_modules, and paths outside the project. Does not write.",
  async handler(args, ctx) {
    const root = projectRootOf(ctx);
    const rel = stringArg(args, "path")?.trim();
    if (!root) return { ok: false, content: null, error: "project root is not set" };
    if (!rel) return { ok: false, content: null, error: "path is required" };
    const rejected = rejectEscape(root, rel);
    if (rejected) return { ok: false, content: null, error: rejected };
    const docsOnly = authorReadRefusal(rel);
    if (docsOnly) return { ok: false, content: null, error: docsOnly };
    try {
      const bytes = await readFile(path.resolve(root, rel));
      if (bytes.includes(0)) return { ok: false, content: null, error: "file is not text" };
      const text = bytes.toString("utf8");
      return {
        ok: true,
        content: {
          path: rel,
          text: text.length > MAX_READ_CHARS ? `${text.slice(0, MAX_READ_CHARS)}\n…truncated` : text,
        },
      };
    } catch {
      return { ok: false, content: null, error: "file is not readable" };
    }
  },
};

const listProjectFiles: OperatorAgentTool = {
  name: "list_project_files",
  description:
    "List documentation the author may read: docs/ and policies/ (.md and .txt), plus AGENTS.md and README.md at the project root. Does not list source code.",
  async handler(_args, ctx) {
    const root = projectRootOf(ctx);
    if (!root) return { ok: false, content: null, error: "project root is not set" };
    const files: string[] = [];
    for (const name of ["AGENTS.md", "README.md"]) {
      try {
        await readFile(path.join(root, name));
        files.push(name);
      } catch {
        /* absent */
      }
    }
    async function walk(rel: string): Promise<void> {
      let entries;
      try {
        entries = await readdir(path.join(root!, rel), { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        const child = `${rel}/${entry.name}`;
        if (entry.isDirectory()) await walk(child);
        else if (!authorReadRefusal(child)) files.push(child);
      }
    }
    await walk("docs");
    await walk("policies");
    files.sort();
    return { ok: true, content: { files } };
  },
};

const readAgentDraft: OperatorAgentTool = {
  name: "read_agent_draft",
  description:
    "Read the current unsaved agent draft (agents/<id>.agent.yaml shape). Use before update_agent_draft when you need the latest fields.",
  handler(_args, ctx) {
    const draft = readAgentAuthorDraft(ctx.getContext());
    const context = ctx.getContext();
    const projectRoot = isAgentAuthorContext(context) ? context.projectRoot : undefined;
    return {
      ok: true,
      content: {
        ...(projectRoot ? { projectRoot } : {}),
        draft,
      },
    };
  },
};

const listMcpServers: OperatorAgentTool = {
  name: "list_mcp_servers",
  description: "List MCP server names declared in the project's .mcp.json. Use these names under tools.mcp. Does not connect.",
  async handler(_args, ctx) {
    const root = projectRootOf(ctx);
    if (!root) return { ok: false, content: null, error: "project root is not set" };
    const catalog = await listProjectMcpCatalog(root);
    return { ok: true, content: { status: catalog.status, servers: catalog.servers.map((server) => server.name) } };
  },
};

const listAuthorCatalog: OperatorAgentTool = {
  name: "list_author_catalog",
  description:
    "List host connections (id and provider only) and installed skill names. No secrets. Use these ids in channel.connection_id and tools.skills. If a name is not listed, do not grant it.",
  async handler(_args, ctx) {
    const root = projectRootOf(ctx);
    if (!root) return { ok: false, content: null, error: "project root is not set" };
    let connections: Array<{ id: string; provider: string }> = [];
    try {
      const loaded = loadConnectionsFile(connectionsFilePath(root));
      connections = loaded.connections.map((entry) => ({ id: entry.id, provider: entry.provider }));
    } catch {
      connections = [];
    }
    let skills: string[] = [];
    try {
      const catalog = await listSkills({ cwd: root, agentDir: path.join(globalStageflowHome(), "workshop", "agent") });
      skills = catalog.skills.map((skill) => skill.name);
    } catch {
      skills = [];
    }
    return { ok: true, content: { connections, skills } };
  },
};

const updateAgentDraft: OperatorAgentTool = {
  name: "update_agent_draft",
  description: [
    "Change the unsaved agent draft. Arguments: patch (object, required) and summary (one short sentence).",
    "patch uses the agent YAML schema: objects merge key by key, arrays replace, null removes a key.",
    "The result lists validation issues; fix them in a follow-up patch. Does not write YAML.",
  ].join(" "),
  handler(args, ctx) {
    const patch = patchFromToolArgs(args);
    if (!patch) return { ok: false, content: null, error: "patch must be an object (JSON or YAML)" };
    const currentContext = ctx.getContext();
    const current = readAgentAuthorDraft(currentContext);
    const next = mergeDraftPatch(current, patch);
    if (typeof next.name === "string" && next.name.trim() && !(typeof next.id === "string" && next.id.trim())) {
      const id = slugId(next.name);
      if (id) next.id = id;
    }
    const parsed = parseAgentDefinition(next);
    const summary = stringArg(args, "summary")?.trim() || "Updated the agent draft";
    const proposal: OperatorAgentProposal = {
      id: nextProposalId(),
      summary,
      baseContext: currentContext,
      nextContext: {
        kind: "agent_author",
        ...(isAgentAuthorContext(currentContext) && currentContext.projectRoot
          ? { projectRoot: currentContext.projectRoot }
          : {}),
        draft: next,
      },
    };
    ctx.emitProposal(proposal);
    return {
      ok: true,
      content: { summary, valid: parsed.ok, issues: parsed.ok ? [] : parsed.issues.map((issue) => `${issue.path || "(draft)"}: ${issue.message}`) },
    };
  },
};

export const AGENT_AUTHOR_TOOL_NAMES = [
  "read_agent_draft",
  "read_project_file",
  "list_project_files",
  "list_mcp_servers",
  "list_author_catalog",
  "update_agent_draft",
] as const;

export function createAgentAuthorProfile(): OperatorAgentProfile {
  return {
    id: AGENT_AUTHOR_PROFILE_ID,
    title: "Agent author",
    playbook: AGENT_AUTHOR_PLAYBOOK,
    greeting: "Who is this agent for, and what does a good result look like? I'll ask a few questions before I fill the config.",
    tools: [readAgentDraft, readProjectFile, listProjectFiles, listMcpServers, listAuthorCatalog, updateAgentDraft],
    contextAdapter: agentAuthorContextAdapter(),
  };
}

export function createAgentAuthorContext(input: { projectRoot: string; draft?: AgentAuthorDraft }): AgentAuthorContext {
  return {
    kind: "agent_author",
    projectRoot: input.projectRoot,
    draft: { ...emptyAgentAuthorDraft(), ...structuredClone(input.draft ?? {}) },
  };
}
