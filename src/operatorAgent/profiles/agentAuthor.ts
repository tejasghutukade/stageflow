import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
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
    "List readable project files: AGENTS.md when present, and YAML files under agents/. Does not write.",
  async handler(_args, ctx) {
    const root = projectRootOf(ctx);
    if (!root) return { ok: false, content: null, error: "project root is not set" };
    const files: string[] = [];
    try {
      await readFile(path.join(root, "AGENTS.md"));
      files.push("AGENTS.md");
    } catch {
      /* absent */
    }
    try {
      const entries = await readdir(path.join(root, "agents"), { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && /\.ya?ml$/i.test(entry.name)) files.push(`agents/${entry.name}`);
      }
    } catch {
      /* no agents dir */
    }
    return { ok: true, content: { files } };
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

const updateAgentDraft: OperatorAgentTool = {
  name: "update_agent_draft",
  description: [
    "Change the unsaved agent draft. Arguments: patch (object, required) and summary (one short sentence).",
    "patch uses the agent YAML schema: objects merge key by key, arrays replace, null removes a key.",
    "The result lists validation issues; fix them in a follow-up patch. Does not write YAML.",
  ].join(" "),
  handler(args, ctx) {
    const patch = args.patch;
    if (!isPlainObject(patch)) return { ok: false, content: null, error: "patch must be an object" };
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

export const AGENT_AUTHOR_TOOL_NAMES = ["read_project_file", "list_project_files", "list_mcp_servers", "update_agent_draft"] as const;

export function createAgentAuthorProfile(): OperatorAgentProfile {
  return {
    id: AGENT_AUTHOR_PROFILE_ID,
    title: "Agent author",
    playbook: AGENT_AUTHOR_PLAYBOOK,
    greeting: "What should this agent do?",
    tools: [readProjectFile, listProjectFiles, listMcpServers, updateAgentDraft],
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
