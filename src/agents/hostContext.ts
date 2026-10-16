import type Database from "better-sqlite3";
import type { ChannelService } from "../channels/service.js";
import { listSkills } from "../config/listSkills.js";
import { listProjectMcpCatalog } from "../config/resolveStageMcpServers.js";
import { channelInboundConnections } from "./communications/channelConnections.js";
import { channelHostFor } from "../channels/host.js";
import { channelIdentity } from "./communications/identity.js";
import { AgentInboundRouter } from "./communications/inbound.js";
import { ChannelSupervisor } from "./communications/supervisor.js";
import { AgentChatController } from "./chatTurn.js";
import { otlpSinkFromEnv, type OtlpSink } from "./otlpSink.js";
import type { ContactInfo } from "../channels/types.js";
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
  /** Streams held open to AgentMail and iMessage; absent unless the Host listens (not in tests). */
  channelListeners?: ChannelSupervisor;
  /** How people reach a connection (the number to text), cached for a minute. */
  channelContact(connectionId: string): Promise<{ provider: string; contact: ContactInfo } | undefined>;
  /** Stop what the Host started for agents (listeners). */
  stop(): Promise<void>;
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
    async connectionIdentity(connectionId) {
      try {
        const connection = channelHostFor(defaultAgentProjectRoot(options.cwd)).registry.resolve(connectionId, false);
        return channelIdentity({ id: connection.id, provider: connection.provider, config: connection.config, credential: connection.credential ? { secrets: connection.credential.secrets } : undefined });
      } catch {
        return undefined;
      }
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
  /** Hold streams open to AgentMail and iMessage for agents linked to them. Only a running Host does this. */
  listenOnChannels?: boolean;
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
    // The send ledger lives under the project root, so use the agents' writable root, not a read-only install dir.
    connections: channelInboundConnections(defaultAgentProjectRoot(options.cwd)),
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
  const connections = channelInboundConnections(defaultAgentProjectRoot(options.cwd));
  const channelListeners = options.listenOnChannels
    ? new ChannelSupervisor({
        service,
        projectRoot: defaultAgentProjectRoot(options.cwd),
        resolve: (id) => connections.resolve?.(id),
        deliver: (message) => inbound.deliver(message),
        log: (message) => console.error(message),
      })
    : undefined;
  const contactCache = new Map<string, { at: number; value: { provider: string; contact: ContactInfo } | undefined }>();
  const channelContact = async (connectionId: string) => {
    const cached = contactCache.get(connectionId);
    if (cached && Date.now() - cached.at < 60_000) return cached.value;
    const provider = connections.resolve?.(connectionId)?.provider;
    const contact = provider ? await connections.contact?.(connectionId) : undefined;
    const value = provider && contact ? { provider, contact } : undefined;
    // A failed lookup is retried on the next ask rather than remembered.
    if (value?.contact.ok !== false) contactCache.set(connectionId, { at: Date.now(), value });
    return value;
  };
  channelListeners?.start();
  if (options.listenOnChannels) void inbound.resumeInterrupted().catch((error) => console.error(`agent resume failed: ${String(error)}`));
  return { service, chat, backend, inbound, publicChat, channelContact, ...(channelListeners ? { channelListeners } : {}), stop: async () => void (await channelListeners?.stop()) };
}
