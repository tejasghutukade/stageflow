import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { defaultAgentProjectRoot } from "../agents/projectRoot.js";
import { AGENT_ID_PATTERN } from "../config/loadAgent.js";
import type { AgentChatController } from "../agents/chatTurn.js";
import { AgentError, isAgentError } from "../agents/errors.js";
import type { AgentService } from "../agents/service.js";
import {
  decideAgentActionFlatSchema,
  getAgentFlatSchema,
  getAgentSessionFlatSchema,
  saveAgentFlatSchema,
  setAgentEnabledFlatSchema,
} from "../toolkit/agentFunctionToolModes.js";
import type { McpToolDeps } from "./deps.js";
import { textResult } from "./toolResults.js";
import { consoleUrl, targetForPath, withProject } from "./writeTarget.js";

const agentId = z.string().regex(AGENT_ID_PATTERN);
const MCP_ACTOR = { source: "api" as const, author: "mcp" };

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`MCP agent tools require ${what} from host bootstrap`);
  return value;
}

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

function schemaError(message: string) {
  return textResult({ code: "invalid_arguments", message, status: 400 }, true);
}

/**
 * Agent management for operators driving Stageflow over MCP. A running agent reaches these
 * only through the Stageflow tool groups it is granted (`agents.*`); the guard in
 * `toolkit/guard.ts` stops it acting on its own sessions.
 */
export function registerAgentTools(server: McpServer, deps: McpToolDeps): void {
  const service = (): AgentService => required(deps.agentService, "agentService");
  const chat = (): AgentChatController => required(deps.agentChat, "agentChat");
  const root = () => defaultAgentProjectRoot(deps.cwd);
  const sessionFor = async (id: string, sessionId: string) => {
    const detail = await service().getSession(root(), sessionId);
    if (detail.session.agentId !== id) throw new AgentError("agent.session_not_found");
    return detail;
  };

  server.registerTool(
    "get_agent",
    {
      description:
        "List agents without id; with id and view definition get one agent; view revisions, revision, or diff read revision history.",
      inputSchema: getAgentFlatSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const parsed = getAgentFlatSchema.safeParse(args);
      if (!parsed.success) return schemaError(parsed.error.issues[0]?.message ?? "Invalid arguments");
      const value = parsed.data;
      if (value.id === undefined) {
        return call(async () => ({ agents: await service().list(root()) }));
      }
      const view = value.view ?? "definition";
      switch (view) {
        case "definition":
          return call(() => service().get(root(), value.id!));
        case "revisions":
          return call(async () => ({ revisions: await service().listRevisions(root(), value.id!) }));
        case "revision":
          return call(() => service().getRevision(root(), value.id!, value.revision!));
        case "diff":
          return call(() => service().diffRevisions(root(), value.id!, value.from!, value.to!));
      }
    },
  );

  server.registerTool(
    "get_agent_session",
    {
      description: "List an agent's sessions without sessionId, or fetch one session with sessionId.",
      inputSchema: getAgentSessionFlatSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const parsed = getAgentSessionFlatSchema.safeParse(args);
      if (!parsed.success) return schemaError(parsed.error.issues[0]?.message ?? "Invalid arguments");
      const value = parsed.data;
      if (value.sessionId === undefined) {
        return call(() =>
          service().listSessions(root(), value.id, {
            limit: value.limit ?? 25,
            ...(value.status ? { status: value.status } : {}),
            ...(value.search ? { search: value.search } : {}),
            ...(value.cursor ? { cursor: value.cursor } : {}),
          }),
        );
      }
      return call(() => sessionFor(value.id, value.sessionId!));
    },
  );

  server.registerTool(
    "save_agent",
    {
      description:
        "Create or update an agent. mode create always starts disabled. mode update needs baseRevision and either definition or revision to restore.",
      inputSchema: saveAgentFlatSchema,
    },
    async (args) => {
      const parsed = saveAgentFlatSchema.safeParse(args);
      if (!parsed.success) return schemaError(parsed.error.issues[0]?.message ?? "Invalid arguments");
      const value = parsed.data;
      const target = await targetForPath(deps, root());
      const link = (id: unknown) =>
        typeof id === "string" ? { console_url: consoleUrl(deps, `/agents/${encodeURIComponent(id)}`) } : {};
      if (value.mode === "create") {
        return call(async () =>
          withProject(
            await service().create(root(), value.definition!, MCP_ACTOR),
            target,
            link((value.definition as { id?: unknown } | undefined)?.id),
          ),
        );
      }
      if (value.revision !== undefined) {
        return call(async () =>
          withProject(
            await service().restore(root(), value.id!, { revision: value.revision!, baseRevision: value.baseRevision! }, MCP_ACTOR),
            target,
            link(value.id),
          ),
        );
      }
      return call(async () =>
        withProject(
          await service().save(
            root(),
            value.id!,
            { baseRevision: value.baseRevision!, definition: value.definition!, summary: value.summary ?? null },
            MCP_ACTOR,
          ),
          target,
          link(value.id),
        ),
      );
    },
  );

  server.registerTool(
    "set_agent_enabled",
    {
      description: "Enable or disable an agent for new sessions and turns.",
      inputSchema: setAgentEnabledFlatSchema,
    },
    ({ id, enabled }) => call(() => service().setEnabled(root(), id, enabled, MCP_ACTOR)),
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
    "stop_agent_session",
    {
      description: "Stop the turn currently running in a session. The session stays open.",
      inputSchema: z.object({ id: agentId, sessionId: z.string() }),
    },
    async ({ id, sessionId }) =>
      call(async () => {
        await sessionFor(id, sessionId);
        return { stopped: chat().stop(sessionId) };
      }),
  );

  server.registerTool(
    "archive_agent",
    {
      description: "Archive an agent. New sessions are refused. Past sessions are kept.",
      inputSchema: z.object({ id: agentId }),
    },
    ({ id }) => call(async () => { await service().archive(root(), id); return { archived: true }; }),
  );

  server.registerTool(
    "decide_agent_action",
    {
      description: "Approve or deny the pending ask-first action on a session of an agent, as an operator.",
      inputSchema: decideAgentActionFlatSchema,
    },
    async ({ id, sessionId, action }) =>
      call(async () => {
        await sessionFor(id, sessionId);
        return service().decideApproval(root(), sessionId, action, { kind: "operator" });
      }),
  );
}