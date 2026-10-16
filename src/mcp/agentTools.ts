import { z } from "zod";
import { defaultAgentProjectRoot } from "../agents/projectRoot.js";
import type { McpServer } from "@modelcontextprotocol/server";
import { AGENT_ID_PATTERN } from "../config/loadAgent.js";
import { isAgentError } from "../agents/errors.js";
import type { AgentChatController } from "../agents/chatTurn.js";
import type { AgentService } from "../agents/service.js";
import type { McpToolDeps } from "./deps.js";
import { textResult } from "./toolResults.js";

const agentId = z.string().regex(AGENT_ID_PATTERN);
const MCP_ACTOR = { source: "api" as const, author: "mcp" };

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`MCP agent tools require ${what} from host bootstrap`);
  return value;
}

/** Run a service call and turn domain failures into tool errors with their code and field issues. */
async function call(work: () => Promise<unknown>) {
  try {
    return textResult(await work());
  } catch (error) {
    if (isAgentError(error)) {
      return textResult(
        { code: error.code, message: error.message, ...(error.issues.length ? { issues: error.issues } : {}) },
        true,
      );
    }
    throw error;
  }
}

/**
 * Agent management for operators driving Stageflow over MCP. These tools are
 * never granted to a running agent (KTD9): the host does not expose its own
 * MCP server to agent sessions.
 */
export function registerAgentTools(server: McpServer, deps: McpToolDeps): void {
  const service = (): AgentService => required(deps.agentService, "agentService");
  const chat = (): AgentChatController => required(deps.agentChat, "agentChat");
  const root = () => defaultAgentProjectRoot(deps.cwd);

  server.registerTool(
    "list_agents",
    { description: "List project agents (agents/*.agent.yaml) with status and session stats.", inputSchema: z.object({}) },
    () => call(async () => ({ agents: await service().list(root()) })),
  );

  server.registerTool(
    "get_agent",
    {
      description: "Get one agent: summary, full definition, canonical YAML, and warnings.",
      inputSchema: z.object({ id: agentId }),
    },
    ({ id }) => call(() => service().get(root(), id)),
  );

  server.registerTool(
    "validate_agent",
    {
      description: "Validate an agent definition without saving. Returns field issues, warnings, and canonical YAML.",
      inputSchema: z.object({ definition: z.record(z.string(), z.unknown()) }),
    },
    ({ definition }) => call(() => service().validate(root(), definition)),
  );

  server.registerTool(
    "create_agent",
    {
      description: "Create an agent. It always starts disabled; enable it with enable_agent.",
      inputSchema: z.object({ definition: z.record(z.string(), z.unknown()) }),
    },
    ({ definition }) => call(() => service().create(root(), definition, MCP_ACTOR)),
  );

  server.registerTool(
    "save_agent",
    {
      description:
        "Save a full agent definition as a new revision. baseRevision must be the current revision (optimistic lock).",
      inputSchema: z.object({
        id: agentId,
        baseRevision: z.number().int().nonnegative(),
        definition: z.record(z.string(), z.unknown()),
        summary: z.string().max(200).optional(),
      }),
    },
    ({ id, baseRevision, definition, summary }) =>
      call(() => service().save(root(), id, { baseRevision, definition, summary: summary ?? null }, MCP_ACTOR)),
  );

  server.registerTool(
    "enable_agent",
    { description: "Enable an agent for new sessions and turns.", inputSchema: z.object({ id: agentId }) },
    ({ id }) => call(() => service().setEnabled(root(), id, true, MCP_ACTOR)),
  );

  server.registerTool(
    "disable_agent",
    {
      description: "Disable an agent. New sessions and turns are refused; a running turn finishes.",
      inputSchema: z.object({ id: agentId }),
    },
    ({ id }) => call(() => service().setEnabled(root(), id, false, MCP_ACTOR)),
  );

  server.registerTool(
    "list_agent_revisions",
    { description: "List an agent's revisions, newest first.", inputSchema: z.object({ id: agentId }) },
    ({ id }) => call(async () => ({ revisions: await service().listRevisions(root(), id) })),
  );

  server.registerTool(
    "restore_agent_revision",
    {
      description: "Save an earlier revision's definition as the newest revision.",
      inputSchema: z.object({
        id: agentId,
        revision: z.number().int().positive(),
        baseRevision: z.number().int().nonnegative(),
      }),
    },
    ({ id, revision, baseRevision }) =>
      call(() => service().restore(root(), id, { revision, baseRevision }, MCP_ACTOR)),
  );

  server.registerTool(
    "agent_chat",
    {
      description: "Send one message to an agent and wait for its reply. Omit sessionId to start a new session.",
      inputSchema: z.object({ id: agentId, message: z.string().min(1), sessionId: z.string().optional() }),
    },
    ({ id, message, sessionId }) =>
      call(() =>
        chat().send({
          projectRoot: root(),
          agentId: id,
          text: message,
          source: "mcp",
          ...(sessionId ? { sessionId } : {}),
        }),
      ),
  );

  server.registerTool(
    "get_agent_session",
    {
      description: "Fetch a session: transcript, turns, approvals.",
      inputSchema: z.object({ sessionId: z.string() }),
    },
    ({ sessionId }) => call(() => service().getSession(root(), sessionId)),
  );

  server.registerTool(
    "approve_agent_action",
    {
      description: "Approve the pending ask-first action on a session, as an operator.",
      inputSchema: z.object({ sessionId: z.string() }),
    },
    ({ sessionId }) => call(() => service().decideApproval(root(), sessionId, "approve", { kind: "operator" })),
  );

  server.registerTool(
    "deny_agent_action",
    {
      description: "Deny the pending ask-first action on a session. The agent is told it was refused.",
      inputSchema: z.object({ sessionId: z.string() }),
    },
    ({ sessionId }) => call(() => service().decideApproval(root(), sessionId, "deny", { kind: "operator" })),
  );
}
