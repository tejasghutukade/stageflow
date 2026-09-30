/**
 * Live Pi-backed OperatorAgentModel for Workshop Author.
 *
 * Uses the shared Pi session factory (not AgentPort). Workshop tools only —
 * resolveWorkshopToolNames / assertWorkshopToolsExcludeDiskShell. Durable Pi
 * session per host tool-context (R7). Restart: new Pi + transcript replay (KTD7).
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  type AgentSession,
  defineTool,
  ModelRuntime,
  resolveCliModel,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  createPiAgentSession,
  createSealedResourceLoader,
  resolveWorkshopToolNames,
} from "../agent/piSessionFactory.js";
import { findProviderSupport } from "../agent/providerSupport.js";
import "../agent/cursorProvider.js";
import { globalStageflowHome } from "../project/globalHome.js";
import {
  isUsableAuthFile,
  resolveCredentialBinding,
} from "../runtime/credentialBinding.js";
import { resolveWorkshopModel } from "../workshop/modelSettings.js";
import {
  createOperatorAgentHost,
  invokeProfileTool,
  type OperatorAgentModel,
  type OperatorAgentModelTurn,
} from "./host.js";
import {
  createWorkshopAuthorProfile,
  type WorkshopAuthorProfileOptions,
} from "./profiles/workshopAuthor.js";
import type {
  OperatorAgentHost,
  OperatorAgentProfile,
  OperatorAgentSessionEvent,
  OperatorAgentTool,
  OperatorAgentToolContext,
  OperatorAgentToolResult,
} from "./types.js";

export type WorkshopTranscriptSeedMessage = {
  role: string;
  text: string;
};

export type PiOperatorAgentModelOptions = {
  cwd: string;
  /** Sealed Pi agent dir; defaults under `$STAGEFLOW_HOME/workshop/agent`. */
  agentDir?: string;
  /** Override credential auth.json; defaults via resolveCredentialBinding(cwd). */
  authPath?: string;
  /** Model id; defaults via resolveWorkshopModel. */
  model?: string | null;
  settingsDefault?: string | null;
  profileDefault?: string | null;
  /**
   * Optional directory for durable Pi session JSONL (new file each process;
   * restart still uses new Pi + replay — KTD7).
   */
  piSessionDir?: string;
  /** Test seam: inject session construction. */
  openPiSession?: (
    input: PiOperatorOpenSessionInput,
  ) => Promise<PiOperatorSessionHandle>;
  /** Test seam: skip live auth / model resolution. */
  resolveModelId?: () => string;
};

export type PiOperatorOpenSessionInput = {
  cwd: string;
  agentDir: string;
  systemPrompt: string;
  toolNames: string[];
  customTools: ReturnType<typeof defineTool>[];
  modelId: string;
  authPath: string;
  piSessionDir?: string;
};

export type PiOperatorSessionHandle = {
  session: Pick<
    AgentSession,
    "prompt" | "subscribe" | "dispose" | "bindExtensions" | "setModel" | "setThinkingLevel"
  > & {
    agent?: { state: { messages: unknown } };
  };
  sessionManager: {
    appendCustomMessageEntry: SessionManager["appendCustomMessageEntry"];
    buildSessionContext: SessionManager["buildSessionContext"];
    getSessionId: SessionManager["getSessionId"];
  };
  restoreProvider?: () => void;
  shutdown: () => Promise<void>;
  piSessionId: string;
};

export type PiOperatorAgentModel = OperatorAgentModel & {
  prepareRestart(input: {
    tools: OperatorAgentToolContext;
    profile: OperatorAgentProfile;
    transcript: readonly WorkshopTranscriptSeedMessage[];
  }): Promise<void>;
  releaseTools(tools: OperatorAgentToolContext): Promise<void>;
  dispose(): Promise<void>;
  getPiSessionId(tools: OperatorAgentToolContext): string | undefined;
};

const FLEX_PARAMS = Type.Object(
  {},
  { additionalProperties: true },
);

function workshopAgentDir(): string {
  return path.join(globalStageflowHome(), "workshop", "agent");
}

function toolResultContent(result: OperatorAgentToolResult): {
  content: Array<{ type: "text"; text: string }>;
  details: OperatorAgentToolResult;
  isError?: boolean;
} {
  const text = JSON.stringify(result);
  return {
    content: [{ type: "text" as const, text }],
    details: result,
    ...(result.ok ? {} : { isError: true }),
  };
}

function buildWorkshopCustomTools(
  profileTools: OperatorAgentTool[],
  getProfile: () => OperatorAgentProfile,
  getTools: () => OperatorAgentToolContext,
  onToolResult: (name: string, result: OperatorAgentToolResult) => void,
): ReturnType<typeof defineTool>[] {
  return profileTools.map((tool) =>
    defineTool({
      name: tool.name,
      label: tool.name,
      description: tool.description,
      parameters: FLEX_PARAMS,
      execute: async (_toolCallId: string, params: unknown) => {
        const args =
          params !== null && typeof params === "object" && !Array.isArray(params)
            ? (params as Record<string, unknown>)
            : {};
        const result = await invokeProfileTool(
          getProfile(),
          tool.name,
          args,
          getTools(),
        );
        onToolResult(tool.name, result);
        return toolResultContent(result);
      },
    }),
  );
}

function formatTranscriptReplay(
  transcript: readonly WorkshopTranscriptSeedMessage[],
): string {
  const lines = transcript
    .filter((m) => typeof m.text === "string" && m.text.trim())
    .map((m) => `${m.role}: ${m.text.trim()}`);
  return [
    "Prior Workshop Author conversation (restored after host restart).",
    "Continue from this context; do not re-ask questions already answered.",
    "",
    ...lines,
  ].join("\n");
}

function authNotConfiguredError(authPath: string): Error {
  return new Error(
    `Workshop Author provider auth is not configured (auth file missing or empty: ${authPath}). Configure credentials via \`sf providers\` / the operator console Providers page, then retry.`,
  );
}

function syncAgentMessages(
  session: PiOperatorSessionHandle["session"],
  sessionManager: PiOperatorSessionHandle["sessionManager"],
): void {
  if (session.agent?.state) {
    session.agent.state.messages = sessionManager.buildSessionContext().messages;
  }
}

function extractAssistantText(message: {
  role?: string;
  content?: unknown;
}): string | undefined {
  if (message.role !== "assistant") return undefined;
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: string; text?: string };
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return parts.length > 0 ? parts.join("") : undefined;
}

async function openDefaultPiSession(
  input: PiOperatorOpenSessionInput,
): Promise<PiOperatorSessionHandle> {
  if (!isUsableAuthFile(input.authPath)) {
    throw authNotConfiguredError(input.authPath);
  }

  const provider = findProviderSupport(input.modelId);
  const additionalExtensionPaths: string[] = [];
  let restoreProvider: (() => void) | undefined;
  if (provider) {
    const prepared = provider.prepare(input.modelId);
    if (prepared.error) {
      throw new Error(prepared.error);
    }
    additionalExtensionPaths.push(...prepared.extensionPaths);
    restoreProvider = prepared.restore;
  }

  await mkdir(input.agentDir, { recursive: true });
  if (input.piSessionDir) {
    await mkdir(input.piSessionDir, { recursive: true });
  }

  const modelRuntime = await ModelRuntime.create({
    authPath: input.authPath,
    modelsPath: path.join(path.dirname(input.authPath), "models.json"),
  });
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
  });
  const loader = createSealedResourceLoader({
    cwd: input.cwd,
    agentDir: input.agentDir,
    settingsManager,
    systemPrompt: input.systemPrompt,
    ...(additionalExtensionPaths.length > 0
      ? { additionalExtensionPaths }
      : {}),
  });
  await loader.reload();

  const extensionErrors = loader.getExtensions().errors;
  if (extensionErrors.length > 0) {
    restoreProvider?.();
    throw new Error(
      `Failed to load Pi extension(s): ${extensionErrors
        .map((e) => `${e.path}: ${e.error}`)
        .join("; ")}`,
    );
  }

  const sessionManager = input.piSessionDir
    ? SessionManager.create(input.cwd, input.piSessionDir)
    : SessionManager.inMemory(input.cwd);

  let session: AgentSession | undefined;
  try {
    const created = await createPiAgentSession({
      cwd: input.cwd,
      agentDir: input.agentDir,
      modelRuntime,
      sessionManager,
      settingsManager,
      resourceLoader: loader,
      tools: input.toolNames,
      customTools: input.customTools,
    });
    session = created.session;
    await session.bindExtensions({});

    const resolved = resolveCliModel({
      cliModel: input.modelId,
      modelRuntime,
    });
    if (resolved.error || !resolved.model) {
      throw new Error(
        resolved.error ?? `Model not found: ${input.modelId}`,
      );
    }
    await session.setModel(resolved.model);
    if (resolved.thinkingLevel) {
      session.setThinkingLevel(resolved.thinkingLevel);
    }

    const live = session;
    return {
      session: live,
      sessionManager,
      restoreProvider,
      piSessionId: sessionManager.getSessionId(),
      shutdown: async () => {
        try {
          live.dispose();
        } catch {
          // best-effort
        }
        restoreProvider?.();
      },
    };
  } catch (err) {
    try {
      session?.dispose();
    } catch {
      // best-effort
    }
    restoreProvider?.();
    throw err;
  }
}

type BoundPiState = {
  handle: PiOperatorSessionHandle;
  profileId: string;
  profile: OperatorAgentProfile;
  tools: OperatorAgentToolContext;
  toolEvents: OperatorAgentSessionEvent[];
  started: boolean;
  replayed: boolean;
};

/**
 * Pi OperatorAgentModel: durable session per host tool-context, Workshop tools only.
 */
export function createPiOperatorAgentModel(
  options: PiOperatorAgentModelOptions,
): PiOperatorAgentModel {
  const cwd = options.cwd;
  const agentDir = options.agentDir ?? workshopAgentDir();
  const openPiSession = options.openPiSession ?? openDefaultPiSession;
  const bindings = new WeakMap<OperatorAgentToolContext, BoundPiState>();
  const activeTools = new Set<OperatorAgentToolContext>();

  function resolveAuthPath(): string {
    if (options.authPath) return options.authPath;
    return resolveCredentialBinding(cwd).authPath;
  }

  function resolveModelId(): string {
    if (options.resolveModelId) return options.resolveModelId();
    return resolveWorkshopModel({
      sessionOverride: options.model,
      settingsDefault: options.settingsDefault,
      profileDefault: options.profileDefault,
    });
  }

  async function ensureBound(
    profile: OperatorAgentProfile,
    tools: OperatorAgentToolContext,
  ): Promise<BoundPiState> {
    const existing = bindings.get(tools);
    if (existing && existing.profileId === profile.id) {
      existing.profile = profile;
      existing.tools = tools;
      return existing;
    }
    if (existing) {
      await existing.handle.shutdown();
      bindings.delete(tools);
    }

    const bindingHolder: {
      current: BoundPiState | null;
    } = { current: null };

    const toolNames = resolveWorkshopToolNames(profile.tools.map((t) => t.name));
    const customTools = buildWorkshopCustomTools(
      profile.tools,
      () => {
        if (!bindingHolder.current) {
          throw new Error("Workshop Pi profile not bound");
        }
        return bindingHolder.current.profile;
      },
      () => {
        if (!bindingHolder.current) {
          throw new Error("Workshop Pi tool context not bound");
        }
        return bindingHolder.current.tools;
      },
      (name, result) => {
        if (!bindingHolder.current) return;
        bindingHolder.current.toolEvents.push({
          type: "tool_result",
          name,
          result,
        });
      },
    );

    const handle = await openPiSession({
      cwd,
      agentDir,
      systemPrompt: profile.playbook,
      toolNames,
      customTools,
      modelId: resolveModelId(),
      authPath: resolveAuthPath(),
      ...(options.piSessionDir ? { piSessionDir: options.piSessionDir } : {}),
    });

    const binding: BoundPiState = {
      handle,
      profileId: profile.id,
      profile,
      tools,
      toolEvents: [],
      started: true,
      replayed: false,
    };
    bindingHolder.current = binding;
    bindings.set(tools, binding);
    activeTools.add(tools);
    return binding;
  }

  async function releaseTools(tools: OperatorAgentToolContext): Promise<void> {
    const state = bindings.get(tools);
    if (!state) return;
    bindings.delete(tools);
    activeTools.delete(tools);
    await state.handle.shutdown();
  }

  const model: PiOperatorAgentModel = {
    async prepareRestart({ tools, profile, transcript }) {
      const state = await ensureBound(profile, tools);
      if (state.replayed || transcript.length === 0) return;
      state.handle.sessionManager.appendCustomMessageEntry(
        "stageflow.workshop_transcript_replay",
        formatTranscriptReplay(transcript),
        true,
        { messageCount: transcript.length },
      );
      syncAgentMessages(state.handle.session, state.handle.sessionManager);
      state.replayed = true;
    },

    async complete({ profile, message, tools, onDelta }) {
      let state: BoundPiState;
      try {
        state = await ensureBound(profile, tools);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          events: [{ type: "error", message: msg }],
        };
      }

      state.profile = profile;
      state.tools = tools;
      state.toolEvents = [];

      const events: OperatorAgentSessionEvent[] = [];
      let assistantText = "";

      const unsubscribe = state.handle.session.subscribe((event) => {
        const e = event as {
          type?: string;
          assistantMessageEvent?: { type?: string; delta?: string };
          message?: { role?: string; content?: unknown };
        };
        if (e.type === "message_update") {
          const ame = e.assistantMessageEvent;
          if (ame?.type === "text_delta" && typeof ame.delta === "string") {
            assistantText += ame.delta;
            onDelta?.(ame.delta);
          }
          return;
        }
        if (e.type === "message_end" && e.message) {
          const text = extractAssistantText(e.message);
          if (text && !assistantText) {
            assistantText = text;
          }
        }
      });

      try {
        await state.handle.session.prompt(message);
      } catch (err) {
        unsubscribe();
        const msg = err instanceof Error ? err.message : String(err);
        return {
          events: [
            ...state.toolEvents,
            { type: "error", message: msg },
          ],
        };
      }
      unsubscribe();

      for (const toolEvent of state.toolEvents) {
        events.push(toolEvent);
      }
      if (assistantText.trim()) {
        events.push({
          type: "message",
          role: "assistant",
          text: assistantText,
        });
      }
      return { events } satisfies OperatorAgentModelTurn;
    },

    releaseTools,

    async dispose() {
      const pending = [...activeTools];
      activeTools.clear();
      for (const tools of pending) {
        const state = bindings.get(tools);
        bindings.delete(tools);
        if (state) await state.handle.shutdown();
      }
    },

    getPiSessionId(tools) {
      return bindings.get(tools)?.handle.piSessionId;
    },
  };

  return model;
}

export type LiveWorkshopOperatorHostOptions = WorkshopAuthorProfileOptions &
  PiOperatorAgentModelOptions;

export function createLiveWorkshopOperatorHost(
  options: LiveWorkshopOperatorHostOptions,
): OperatorAgentHost {
  const {
    cwd,
    agentDir,
    authPath,
    model,
    settingsDefault,
    profileDefault,
    piSessionDir,
    openPiSession,
    resolveModelId,
    retriever,
    projectRoot,
  } = options;

  return createOperatorAgentHost(
    createPiOperatorAgentModel({
      cwd,
      ...(agentDir !== undefined ? { agentDir } : {}),
      ...(authPath !== undefined ? { authPath } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(settingsDefault !== undefined ? { settingsDefault } : {}),
      ...(profileDefault !== undefined ? { profileDefault } : {}),
      ...(piSessionDir !== undefined ? { piSessionDir } : {}),
      ...(openPiSession !== undefined ? { openPiSession } : {}),
      ...(resolveModelId !== undefined ? { resolveModelId } : {}),
    }),
    [
      createWorkshopAuthorProfile({
        retriever,
        projectRoot: projectRoot ?? cwd,
      }),
    ],
  );
}
