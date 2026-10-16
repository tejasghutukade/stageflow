import { z } from "zod";
import { defaultAgentProjectRoot } from "../agents/projectRoot.js";
import type { McpServer } from "@modelcontextprotocol/server";
import { AGENT_ID_PATTERN } from "../config/loadAgent.js";
import { AgentError, isAgentError } from "../agents/errors.js";
import type { AgentChatController } from "../agents/chatTurn.js";
import type { AgentService } from "../agents/service.js";
import { SESSION_STATUSES } from "../agents/store.js";
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
  /** A session must belong to the agent named in the call, or it is not found (as in the HTTP routes). */
  const sessionFor = async (id: string, sessionId: string) => {
    const detail = await service().getSession(root(), sessionId);
    if (detail.session.agentId !== id) throw new AgentError("agent.session_not_found");
    return detail;
  };

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
      description: "Fetch a session of an agent: transcript, turns, approvals.",
      inputSchema: z.object({ id: agentId, sessionId: z.string() }),
    },
    ({ id, sessionId }) => call(() => sessionFor(id, sessionId)),
  );

  server.registerTool(
    "list_agent_sessions",
    {
      description: "List an agent's sessions, newest first, with turn counts, tokens and cost.",
      inputSchema: z.object({
        id: agentId,
        status: z.enum(SESSION_STATUSES).optional(),
        search: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
        cursor: z.string().optional(),
      }),
    },
    ({ id, status, search, limit, cursor }) =>
      call(() =>
        service().listSessions(root(), id, {
          limit: limit ?? 25,
          ...(status ? { status } : {}),
          ...(search ? { search } : {}),
          ...(cursor ? { cursor } : {}),
        }),
      ),
  );

  server.registerTool(
    "stop_agent_session",
    {
      description: "Stop the turn currently running in a session. The session stays open.",
      inputSchema: z.object({ id: agentId, sessionId: z.string() }),
    },
    ({ id, sessionId }) =>
      call(async () => {
        await sessionFor(id, sessionId);
        return { stopped: chat().stop(sessionId) };
      }),
  );

  server.registerTool(
    "archive_agent",
    {
      description: "Archive an agent: its definition leaves the project and new sessions are refused. Past sessions are kept.",
      inputSchema: z.object({ id: agentId }),
    },
    ({ id }) => call(async () => { await service().archive(root(), id); return { archived: true }; }),
  );

  server.registerTool(
    "approve_agent_action",
    {
      description: "Approve the pending ask-first action on a session of an agent, as an operator.",
      inputSchema: z.object({ id: agentId, sessionId: z.string() }),
    },
    ({ id, sessionId }) =>
      call(async () => {
        await sessionFor(id, sessionId);
        return service().decideApproval(root(), sessionId, "approve", { kind: "operator" });
      }),
  );

  server.registerTool(
    "deny_agent_action",
    {
      description: "Deny the pending ask-first action on a session of an agent. The agent is told it was refused.",
      inputSchema: z.object({ id: agentId, sessionId: z.string() }),
    },
    ({ id, sessionId }) =>
      call(async () => {
        await sessionFor(id, sessionId);
        return service().decideApproval(root(), sessionId, "deny", { kind: "operator" });
      }),
  );
}
