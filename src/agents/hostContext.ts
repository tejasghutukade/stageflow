import type Database from "better-sqlite3";
import type { ChannelService } from "../channels/service.js";
import { listSkills } from "../config/listSkills.js";
import { listProjectMcpCatalog } from "../config/resolveStageMcpServers.js";
import { channelInboundConnections } from "./communications/channelConnections.js";
import { AgentInboundRouter } from "./communications/inbound.js";
import { AgentChatController } from "./chatTurn.js";
import { otlpSinkFromEnv, type OtlpSink } from "./otlpSink.js";
import type { McpToolDeps } from "../mcp/deps.js";
import { buildToolkit, type ToolkitTool } from "../toolkit/index.js";
import { createPiAgentRuntime } from "./runtime/piRuntime.js";
import { AgentService, type AgentEnvironment } from "./service.js";
import type { ConversationBackend } from "./sessions.js";
import { getModelCatalog } from "../models/catalog.js";
import { defaultAgentProjectRoot } from "./projectRoot.js";
import { PublicWebChat } from "./webChat/publicChat.js";
import { AgentStore } from "./store.js";

export type AgentHostContext = {
  service: AgentService;
  inbound: AgentInboundRouter;
  publicChat: PublicWebChat;
  chat: AgentChatController;
  backend: ConversationBackend;
};

/** Read-only lookups the editor warnings use: `.mcp.json`, skills, and channel connections. */
export function createAgentEnvironment(options: {
  agentDir: string;
  cwd: string;
  channels?: Pick<ChannelService, "list">;
}): AgentEnvironment {
  return {
    async mcpServerNames(projectRoot) {
      const catalog = await listProjectMcpCatalog(projectRoot);
      return catalog.status === "ok" ? catalog.servers.map((server) => server.name) : [];
    },
    async skillNames(projectRoot) {
      const catalog = await listSkills({ cwd: projectRoot, agentDir: options.agentDir });
      return catalog.skills.map((skill) => skill.name);
    },
    async modelInfo(id) {
      const snapshot = await getModelCatalog(options.cwd).snapshot().catch(() => undefined);
      if (!snapshot || snapshot.providers.length === 0) return undefined;
      const model = snapshot.providers.flatMap((provider) => provider.models).find((entry) => entry.id === id);
      return { known: model !== undefined, nativeTools: model?.nativeTools ?? false };
    },
    async connectionIds() {
      if (!options.channels) return undefined;
      return options.channels.list().connections.map((connection) => connection.id);
    },
  };
}

/**
 * Agent runtime for one Host. Agent state shares the Host's SQLite connection
 * (migration 013). Turns left running by a previous process are failed here,
 * since nothing can resume them.
 */
export function createAgentHostContext(options: {
  cwd: string;
  agentDir: string;
  connection: Database.Database;
  channels?: Pick<ChannelService, "list">;
  backend?: ConversationBackend;
  environment?: AgentEnvironment;
  otlpSink?: OtlpSink | undefined;
  /** Host services the Stageflow tools need; agent services are added here. Without it agents get no Stageflow tools. */
  toolkitDeps?: Pick<McpToolDeps, "manager" | "store" | "agentDir" | "providerAuthContext" | "projectRoot" | "providerBoot">;
}): AgentHostContext {
  const service = new AgentService({
    store: new AgentStore(options.connection),
    environment:
      options.environment ??
      createAgentEnvironment({
        agentDir: options.agentDir,
        cwd: options.cwd,
        ...(options.channels ? { channels: options.channels } : {}),
      }),
  });
  service.recoverInterruptedTurns();
  let toolkit: ToolkitTool[] | undefined;
  let chatRef: AgentChatController | undefined;
  const backend =
    options.backend ??
    createPiAgentRuntime({
      cwd: options.cwd,
      agentDir: options.agentDir,
      ...(options.toolkitDeps
        ? {
            toolkit: () =>
              (toolkit ??= buildToolkit({
                ...options.toolkitDeps!,
                cwd: options.cwd,
                agentService: service,
                ...(chatRef ? { agentChat: chatRef } : {}),
              })),
          }
        : {}),
    });
  const chat = new AgentChatController({
    service,
    backend,
    otlpSink: "otlpSink" in options ? options.otlpSink : otlpSinkFromEnv(),
    logError: (message) => console.error(message),
  });
  chatRef = chat;
  const inbound = new AgentInboundRouter({
    service,
    chat,
    connections: channelInboundConnections(options.cwd),
    projectRoot: defaultAgentProjectRoot(options.cwd),
    logError: (message) => console.error(message),
  });
  const publicChat = new PublicWebChat({
    service,
    chat,
    projectRoot: defaultAgentProjectRoot(options.cwd),
    allowedOrigins: (process.env.STAGEFLOW_PUBLIC_CHAT_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
    logError: (message) => console.error(message),
  });
  return { service, chat, backend, inbound, publicChat };
}
