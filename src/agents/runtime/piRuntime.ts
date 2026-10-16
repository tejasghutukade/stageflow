import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  type AgentSession,
  defineTool,
  type ExtensionFactory,
  type InlineExtension,
  ModelRuntime,
  resolveCliModel,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { collectMcpExtensionToolNames, mcpToolMetadataMissing } from "../../agent/piAdapter.js";
import { attachIsolatedMcp } from "../../agent/piIsolatedMcp.js";
import { warmIsolatedMcpMetadata } from "../../agent/piIsolatedMcpProbe.js";
import { createPiAgentSession, createSealedResourceLoader } from "../../agent/piSessionFactory.js";
import { bindCursorApiKey, isCursorModelRef } from "../../agent/cursorProvider.js";
import { findProviderSupport } from "../../agent/providerSupport.js";
import { BUILTIN_TOOL_GROUPS, type AgentDefinition } from "../../config/loadAgent.js";
import { resolveSkillByName } from "../../config/listSkills.js";
import { resolveStageMcpServers } from "../../config/resolveStageMcpServers.js";
import { globalStageflowHome } from "../../project/globalHome.js";
import { isUsableAuthFile, resolveCredentialBinding } from "../../runtime/credentialBinding.js";
import { getModelCatalog } from "../../models/catalog.js";
import { AgentError } from "../errors.js";
import { isWritePathForbidden } from "../policy.js";
import { prepareExecutionLaunch, type SandboxRunner } from "../sandbox.js";
import { grantIdForPiTool, type CompleteInput, type CompleteResult, type ConversationBackend, type TurnHooks } from "./types.js";

export type PiRuntimeOptions = {
  cwd: string;
  agentDir: string;
  sandbox?: SandboxRunner;
  /** Test seam: replaces session construction. */
  openSession?: (input: OpenSessionInput) => Promise<OpenedSession>;
};

export type OpenSessionInput = {
  projectRoot: string;
  definition: AgentDefinition;
  systemPrompt: string;
  /** Pi tool names the session may expose. */
  toolNames: string[];
  /** Runs before each tool call; the session wires it to `pi.on("tool_call")`. */
  gate: (call: { toolCallId: string; toolName: string; input: Record<string, unknown> }) => Promise<{ block: true; reason: string; terminate?: boolean } | undefined>;
  delegateTool?: (agentId: string, message: string) => Promise<string>;
  hooks: () => TurnHooks | undefined;
};

export type OpenedSession = {
  session: Pick<AgentSession, "prompt" | "subscribe" | "dispose"> & { abort?: AgentSession["abort"] };
  /** Tool names that exist on the session (builtins + MCP + delegation) for grant mapping. */
  toolNames: string[];
  shutdown(): Promise<void>;
};

function piToolNames(definition: AgentDefinition): string[] {
  return definition.tools.builtin.flatMap((group) => [...BUILTIN_TOOL_GROUPS[group]]);
}

async function projectContext(projectRoot: string): Promise<string> {
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    try {
      const text = await readFile(path.join(projectRoot, name), "utf8");
      return `\n\n# Project context (${name})\n${text.slice(0, 20_000)}`;
    } catch {
      continue;
    }
  }
  return "";
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block && typeof block === "object" && (block as { type?: string }).type === "text" ? String((block as { text?: string }).text ?? "") : ""))
    .join("");
}

function replayPrompt(prior: Array<{ role: string; text: string }>): string {
  return [
    "Earlier conversation in this session (restored after a restart). Continue from it; do not re-ask answered questions.",
    "",
    ...prior.map((m) => `${m.role}: ${m.text.trim()}`),
  ].join("\n");
}

async function openPiSession(options: PiRuntimeOptions, input: OpenSessionInput): Promise<OpenedSession> {
  const { definition, projectRoot } = input;
  const modelId = definition.model.id ?? (await getModelCatalog(options.cwd).defaultModel());
  // Cursor's SDK agent runs its own file and shell tools beside Pi's, so grants and ask-first cannot hold.
  if (isCursorModelRef(modelId) && process.env.STAGEFLOW_AGENTS_ALLOW_CURSOR_NATIVE_TOOLS !== "1") {
    throw new AgentError(
      "agent.backend_unavailable",
      "Cursor models run their own file and shell tools outside this agent's grants and approvals. Choose another provider's model, or set STAGEFLOW_AGENTS_ALLOW_CURSOR_NATIVE_TOOLS=1 on the Host to accept that.",
    );
  }
  const provider = findProviderSupport(modelId);
  const authPath = resolveCredentialBinding(options.cwd).authPath;
  if (!provider && !isUsableAuthFile(authPath)) {
    throw new AgentError("agent.backend_unavailable", "Provider auth is not configured. Add credentials in Providers, then retry.");
  }
  const restoreKey = bindCursorApiKey(modelId);
  const extensionPaths: string[] = [];
  let restoreProvider: (() => void) | undefined;
  if (provider) {
    const prepared = provider.prepare(modelId);
    if (prepared.error) throw new AgentError("agent.backend_unavailable", prepared.error);
    extensionPaths.push(...prepared.extensionPaths);
    restoreProvider = prepared.restore;
  }
  const cleanup = () => {
    restoreKey?.();
    restoreProvider?.();
  };

  let attached: Awaited<ReturnType<typeof attachIsolatedMcp>> | undefined;
  let session: AgentSession | undefined;
  try {
    await mkdir(options.agentDir, { recursive: true });
    const modelRuntime = await ModelRuntime.create({ authPath, modelsPath: path.join(path.dirname(authPath), "models.json") });
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: true } });

    const mcpServers = Object.keys(definition.tools.mcp);
    const resolvedMcp =
      mcpServers.length > 0
        ? await resolveStageMcpServers({ projectRoot, allowlist: mcpServers, env: process.env })
        : undefined;
    attached = await attachIsolatedMcp(resolvedMcp, { lifecycle: "lazy" });

    const skillPaths: string[] = [];
    for (const name of definition.tools.skills) {
      const skill = await resolveSkillByName(name, { cwd: projectRoot, agentDir: options.agentDir });
      if (!skill) throw new AgentError("agent.backend_unavailable", `Skill "${name}" is not installed`);
      skillPaths.push(skill.filePath);
    }

    const gateExtension: ExtensionFactory = (pi) => {
      pi.on("tool_call", async (event) => {
        const outcome = await input.gate({ toolCallId: event.toolCallId, toolName: event.toolName, input: event.input as Record<string, unknown> });
        return outcome;
      });
    };
    const extensionFactories: InlineExtension[] = [{ name: "stageflow-agent-gate", factory: gateExtension }, ...(attached.extensionFactories ?? [])];
    const loader = createSealedResourceLoader({
      cwd: projectRoot,
      agentDir: options.agentDir,
      settingsManager,
      systemPrompt: input.systemPrompt,
      additionalExtensionPaths: extensionPaths,
      ...(skillPaths.length > 0 ? { additionalSkillPaths: skillPaths } : {}),
      extensionFactories,
      ...(attached.eventBus ? { eventBus: attached.eventBus } : {}),
    });
    await loader.reload();
    if (resolvedMcp && mcpToolMetadataMissing(loader)) {
      await warmIsolatedMcpMetadata(resolvedMcp, { cwd: projectRoot });
      await loader.reload();
      if (mcpToolMetadataMissing(loader)) {
        throw new AgentError("agent.backend_unavailable", `MCP tool metadata unavailable for: ${mcpServers.join(", ")}`);
      }
    }
    const errors = loader.getExtensions().errors;
    if (errors.length > 0) {
      throw new AgentError("agent.backend_unavailable", `Failed to load extension(s): ${errors.map((e) => `${e.path}: ${e.error}`).join("; ")}`);
    }

    const toolNames = [...input.toolNames];
    if (attached.extensionFactories) {
      const mcp = collectMcpExtensionToolNames(loader);
      if (!mcp.ok) throw new AgentError("agent.backend_unavailable", `MCP adapter registered unrequested tool(s): ${mcp.unrequested.join(", ")}`);
      // Only tools the definition grants are exposed; the gate repeats this check on every call.
      toolNames.push(
        ...mcp.names.filter((name) => {
          const id = grantIdForPiTool(name, mcpServers, []);
          const dot = id.indexOf(".");
          if (dot < 0) return false;
          const allowed = definition.tools.mcp[id.slice(0, dot)];
          return allowed?.includes("*") || allowed?.includes(id.slice(dot + 1));
        }),
      );
    }
    const customTools = [];
    if (input.delegateTool) {
      for (const agentId of definition.sub_agents) {
        customTools.push(
          defineTool({
            name: `agent_${agentId}`,
            label: `Ask ${agentId}`,
            description: `Hand a task to the "${agentId}" agent and get its reply.`,
            parameters: Type.Object({ message: Type.String({ description: "The task or question for the agent." }) }),
            execute: async (_id: string, args: { message: string }) => {
              const reply = await input.delegateTool!(agentId, args.message);
              return { content: [{ type: "text" as const, text: reply }], details: {} };
            },
          }),
        );
        toolNames.push(`agent_${agentId}`);
      }
    }

    const sessionDir = path.join(globalStageflowHome(), "agents", "pi-sessions");
    await mkdir(sessionDir, { recursive: true });
    const created = await createPiAgentSession({
      cwd: projectRoot,
      agentDir: options.agentDir,
      modelRuntime,
      sessionManager: SessionManager.create(projectRoot, sessionDir),
      settingsManager,
      resourceLoader: loader,
      tools: toolNames,
      customTools,
    });
    session = created.session;
    await session.bindExtensions({});
    const resolved = resolveCliModel({ cliModel: modelId, modelRuntime });
    if (resolved.error || !resolved.model) throw new AgentError("agent.backend_unavailable", resolved.error ?? `Model not found: ${modelId}`);
    await session.setModel(resolved.model);
    session.setThinkingLevel((resolved.thinkingLevel ?? definition.model.thinking) as Parameters<AgentSession["setThinkingLevel"]>[0]);

    const live = session;
    const live_attached = attached;
    return {
      session: live,
      toolNames,
      shutdown: async () => {
        try {
          live.dispose();
        } catch {
          // best-effort
        }
        live_attached.cancel?.();
        cleanup();
      },
    };
  } catch (error) {
    try {
      session?.dispose();
    } catch {
      // best-effort
    }
    attached?.cancel?.();
    cleanup();
    throw error;
  }
}

type Bound = {
  opened: OpenedSession;
  definitionKey: string;
  hooks: TurnHooks | undefined;
  mcpServers: string[];
  subAgents: string[];
  /** Set while a turn runs: the stall watchdog's pause handle. */
  stall?: { hold(): () => void } | undefined;
};

/** Seconds of silence from the model before a turn is failed. 0 turns the watchdog off. */
function stallTimeoutMs(): number {
  const seconds = Number(process.env.STAGEFLOW_AGENT_STALL_SECONDS ?? 180);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 180_000;
}

export function createPiAgentRuntime(options: PiRuntimeOptions): ConversationBackend {
  const bound = new Map<string, Bound>();
  const open = options.openSession ?? ((input: OpenSessionInput) => openPiSession(options, input));

  async function ensure(input: CompleteInput): Promise<{ state: Bound; fresh: boolean }> {
    const existing = bound.get(input.sessionId);
    if (existing) return { state: existing, fresh: false };
    const { definition, projectRoot } = input;
    if (definition.model.backend !== "pi") {
      throw new AgentError("agent.backend_unavailable", `The ${definition.model.backend} backend is not available for agents yet.`);
    }
    await prepareExecutionLaunch(definition, projectRoot, options.sandbox);
    const mcpServers = Object.keys(definition.tools.mcp);
    const subAgents = [...definition.sub_agents];
    const state: Bound = { opened: undefined as never, definitionKey: definition.id, hooks: undefined, mcpServers, subAgents };
    const context = definition.project_context ? await projectContext(projectRoot) : "";
    const systemPrompt = `${definition.instructions}${context}`;
    state.opened = await open({
      projectRoot,
      definition,
      systemPrompt,
      toolNames: piToolNames(definition),
      hooks: () => state.hooks,
      ...(subAgents.length > 0 ? { delegateTool: (agentId, message) => state.hooks!.delegate(agentId, message) } : {}),
      gate: async (call) => {
        const hooks = state.hooks;
        if (!hooks) return { block: true, reason: "No turn is active" };
        const tool = grantIdForPiTool(call.toolName, mcpServers, subAgents);
        const target = typeof call.input.path === "string" ? call.input.path : undefined;
        if ((call.toolName === "write" || call.toolName === "edit") && target) {
          const resolved = path.isAbsolute(target) ? target : path.resolve(projectRoot, target);
          if (isWritePathForbidden(projectRoot, globalStageflowHome(), resolved)) {
            return { block: true, reason: "Agent definitions and Stageflow state cannot be written by an agent." };
          }
        }
        const release = state.stall?.hold();
        const decision = await hooks.gate({ id: call.toolCallId, tool, input: call.input }).finally(() => release?.());
        return decision.allow ? undefined : { block: true, reason: decision.reason, ...(decision.stopTurn ? { terminate: true } : {}) };
      },
    });
    bound.set(input.sessionId, state);
    return { state, fresh: true };
  }

  return {
    id: "pi",
    async complete(input) {
      const { state, fresh } = await ensure(input);
      state.hooks = input.hooks;
      const user = input.messages.at(-1);
      if (!user || user.role !== "user") return { text: "", toolOutputs: [] };
      const { session } = state.opened;
      const toolOutputs: string[] = [];
      let text = "";
      const usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
      let startedAt = new Date();
      const calls = new Map<string, { id: string; tool: string; input: Record<string, unknown> }>();
      // A model call that goes quiet (provider queue, dropped connection) must not hold the session forever.
      // Waiting on a person (approval), a running tool or a sub-agent is not a stall.
      const stallMs = stallTimeoutMs();
      let holds = 0;
      let stalled = false;
      let stallTimer: ReturnType<typeof setTimeout> | undefined;
      const arm = () => {
        if (stallTimer) clearTimeout(stallTimer);
        stallTimer = undefined;
        if (holds > 0 || stallMs <= 0) return;
        stallTimer = setTimeout(() => {
          stalled = true;
          void session.abort?.();
        }, stallMs);
      };
      state.stall = {
        hold() {
          holds += 1;
          arm();
          let released = false;
          return () => {
            if (released) return;
            released = true;
            holds -= 1;
            arm();
          };
        },
      };
      const toolHolds = new Map<string, () => void>();
      const unsubscribe = session.subscribe((event) => {
        arm();
        const e = event as Record<string, unknown> & {
          type?: string;
          assistantMessageEvent?: { type?: string; delta?: string };
          message?: { role?: string; model?: string; content?: unknown; usage?: { input: number; output: number; cost?: { total?: number } } };
          toolCallId?: string;
          toolName?: string;
          args?: Record<string, unknown>;
          result?: { content?: unknown; isError?: boolean };
          isError?: boolean;
        };
        if (e.type === "message_start" && e.message?.role === "assistant") startedAt = new Date();
        else if (e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta" && typeof e.assistantMessageEvent.delta === "string") {
          text += e.assistantMessageEvent.delta;
          input.onDelta(e.assistantMessageEvent.delta);
        } else if (e.type === "message_end" && e.message?.role === "assistant") {
          const u = e.message.usage;
          const info = { inputTokens: u?.input ?? 0, outputTokens: u?.output ?? 0, costUsd: u?.cost?.total ?? 0 };
          usage.inputTokens += info.inputTokens;
          usage.outputTokens += info.outputTokens;
          usage.costUsd += info.costUsd;
          input.hooks.modelFinished({ startedAt, endedAt: new Date(), ...info, ...(e.message.model ? { model: e.message.model } : {}) });
          const final = textOf(e.message.content);
          if (final && !text) text = final;
        } else if (e.type === "tool_execution_start" && e.toolCallId && e.toolName) {
          const call = { id: e.toolCallId, tool: grantIdForPiTool(e.toolName, state.mcpServers, state.subAgents), input: e.args ?? {} };
          calls.set(e.toolCallId, call);
          toolHolds.set(e.toolCallId, state.stall!.hold());
          input.hooks.toolStarted(call);
        } else if (e.type === "tool_execution_end" && e.toolCallId) {
          toolHolds.get(e.toolCallId)?.();
          toolHolds.delete(e.toolCallId);
          const call = calls.get(e.toolCallId);
          if (call) {
            const output = textOf(e.result?.content);
            toolOutputs.push(output);
            input.hooks.toolFinished(call, { ok: !(e.isError ?? e.result?.isError), output });
          }
        }
      });
      const onAbort = () => void session.abort?.();
      input.signal.addEventListener("abort", onAbort, { once: true });
      try {
        const prior = input.messages.slice(0, -1).map((m) => ({ role: m.role, text: m.text }));
        const prompt = fresh && prior.length > 0 ? `${replayPrompt(prior)}\n\nuser: ${user.text}` : user.text;
        arm();
        await session.prompt(prompt);
      } finally {
        if (stallTimer) clearTimeout(stallTimer);
        for (const release of toolHolds.values()) release();
        input.signal.removeEventListener("abort", onAbort);
        unsubscribe();
        state.hooks = undefined;
        state.stall = undefined;
      }
      if (stalled) {
        throw new AgentError(
          "agent.model_timeout",
          `The model stopped responding for ${Math.round(stallMs / 1000)} seconds. Try again, or pick a faster model or a lower thinking level.`,
        );
      }
      return { text, toolOutputs, usage };
    },
    async judge(input) {
      const opened = await open({
        projectRoot: input.projectRoot,
        definition: { ...input.definition, tools: { ...input.definition.tools, builtin: [], mcp: {}, skills: [] }, sub_agents: [] },
        systemPrompt: "You are a strict evaluator. Answer only with the requested number.",
        toolNames: [],
        gate: async () => ({ block: true, reason: "No tools" }),
        hooks: () => undefined,
      });
      let out = "";
      const unsubscribe = opened.session.subscribe((event) => {
        const e = event as { type?: string; assistantMessageEvent?: { type?: string; delta?: string } };
        if (e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta") out += e.assistantMessageEvent.delta ?? "";
      });
      const onAbort = () => void opened.session.abort?.();
      input.signal.addEventListener("abort", onAbort, { once: true });
      try {
        await opened.session.prompt(input.prompt);
      } finally {
        input.signal.removeEventListener("abort", onAbort);
        unsubscribe();
        await opened.shutdown();
      }
      return out;
    },
    async release(sessionId) {
      const state = bound.get(sessionId);
      bound.delete(sessionId);
      await state?.opened.shutdown();
    },
    async dispose() {
      const all = [...bound.values()];
      bound.clear();
      await Promise.all(all.map((state) => state.opened.shutdown()));
    },
  };
}
