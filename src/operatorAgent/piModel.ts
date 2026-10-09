/**
 * Live Pi-backed OperatorAgentModel for Workshop Author.
 *
 * Pi backend behind AgentPort, using the shared session factory. Not a StagePort.
 * Workshop tools only —
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
import { cursorBridgePrompt } from "../agent/cursorProvider.js";
import { findProviderSupport } from "../agent/providerSupport.js";
import "../agent/cursorProvider.js";
import { logger as rootLogger } from "../logging/logger.js";
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
import { readDraftFromContext } from "./draftContext.js";
import type {
  OperatorAgentHost,
  OperatorAgentProfile,
  OperatorAgentSessionEvent,
  OperatorAgentTool,
  OperatorAgentToolContext,
  OperatorAgentToolResult,
  WorkshopToolActivityUpdate,
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
    | "prompt"
    | "subscribe"
    | "dispose"
    | "bindExtensions"
    | "setModel"
    | "setThinkingLevel"
  > & {
    agent?: { state: { messages: unknown } };
    abort?: AgentSession["abort"];
  };
  sessionManager: {
    appendCustomMessageEntry: SessionManager["appendCustomMessageEntry"];
    buildSessionContext: SessionManager["buildSessionContext"];
    getSessionId: SessionManager["getSessionId"];
  };
  restoreProvider?: () => void;
  shutdown: () => Promise<void>;
  piSessionId: string;
  /** Extension paths loaded when this Pi session was opened. Absent on test doubles. */
  extensionPaths?: readonly string[];
  /** Switch the live Pi model before the next prompt. No-op when unchanged. */
  applyModel?: (modelId: string) => Promise<void>;
};

export function sessionNeedsExtensionReload(
  loaded: readonly string[] | undefined,
  needed: readonly string[],
): boolean {
  if (loaded === undefined) return false;
  const have = new Set(loaded);
  return needed.some((extensionPath) => !have.has(extensionPath));
}

function extensionPathsForModel(modelId: string): string[] {
  const provider = findProviderSupport(modelId);
  if (!provider) return [];
  const prepared = provider.prepare(modelId);
  if (prepared.error) return [];
  return prepared.extensionPaths;
}

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

const workshopLog = rootLogger.child({ component: "workshop" });

export function workshopToolLogFields(
  args: Record<string, unknown>,
  result?: OperatorAgentToolResult,
): Record<string, unknown> {
  const body = args.body;
  const fields: Record<string, unknown> = {
    argKeys: Object.keys(args),
    id: typeof args.id === "string" ? args.id : undefined,
    bodyType:
      body === undefined ? "missing" : Array.isArray(body) ? "array" : typeof body,
  };
  if (body !== null && typeof body === "object" && !Array.isArray(body)) {
    fields.bodyKeys = Object.keys(body);
  }
  if (typeof body === "string") {
    fields.bodyChars = body.length;
    fields.bodyIgnored = true;
  }
  if (result) {
    fields.ok = result.ok;
    if (result.error) fields.error = result.error;
    try {
      fields.resultBytes = JSON.stringify(result).length;
    } catch {
      fields.resultBytes = -1;
    }
  }
  return fields;
}

export function workshopToolActivity(
  id: string,
  name: string,
  phase: "start" | "done",
  args: Record<string, unknown>,
  result?: OperatorAgentToolResult,
): WorkshopToolActivityUpdate {
  const target = typeof args.id === "string" ? args.id : undefined;
  const base = { id, name, ...(target ? { target } : {}) };
  if (phase === "start") return { ...base, status: "running" };
  if (!result?.ok) {
    return {
      ...base,
      status: "error",
      errorMessage: result?.error ?? "unknown error",
    };
  }
  return { ...base, status: "complete" };
}

function workshopContextBuildId(context: unknown): string | undefined {
  if (
    context !== null &&
    typeof context === "object" &&
    "buildId" in context &&
    typeof (context as { buildId?: unknown }).buildId === "string"
  ) {
    const buildId = (context as { buildId: string }).buildId.trim();
    return buildId || undefined;
  }
  return undefined;
}

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
  reportActivity: (update: WorkshopToolActivityUpdate) => void,
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
        workshopLog.info(
          "workshop.tool.start",
          tool.name,
          workshopToolLogFields(args),
        );
        const callId =
          typeof _toolCallId === "string" && _toolCallId
            ? _toolCallId
            : `${tool.name}-${Date.now()}`;
        const pinnedBuildId = workshopContextBuildId(getTools().getContext());
        reportActivity({
          ...workshopToolActivity(callId, tool.name, "start", args),
          ...(pinnedBuildId ? { buildId: pinnedBuildId } : {}),
        });
        const result = await invokeProfileTool(
          getProfile(),
          tool.name,
          args,
          getTools(),
        );
        const fields = workshopToolLogFields(args, result);
        if (result.ok) {
          workshopLog.info("workshop.tool.done", tool.name, fields);
        } else {
          workshopLog.warn("workshop.tool.done", tool.name, fields);
        }
        const update = workshopToolActivity(
          callId,
          tool.name,
          "done",
          args,
          result,
        );
        const doneBuildId = workshopContextBuildId(getTools().getContext());
        if (result.ok) {
          const draft = readDraftFromContext(getTools().getContext());
          reportActivity({
            ...update,
            draft,
            ...(doneBuildId ? { buildId: doneBuildId } : {}),
          });
        } else {
          reportActivity({
            ...update,
            ...(doneBuildId ? { buildId: doneBuildId } : {}),
          });
        }
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

function processDataAuthPath(): string {
  return path.join(globalStageflowHome(), "agent", "auth.json");
}

function authNotConfiguredError(authPath: string): Error {
  const dataAuth = processDataAuthPath();
  const unusedDataFile =
    path.resolve(dataAuth) !== path.resolve(authPath) &&
    isUsableAuthFile(dataAuth)
      ? ` A usable auth file at ${dataAuth} in the process data directory is not used.`
      : "";
  return new Error(
    `Workshop Author provider auth is not configured (auth file missing or empty: ${authPath}).${unusedDataFile} Configure credentials via \`sf providers\` / the operator console Providers page, then retry.`,
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
    let currentModelId = input.modelId;
    const applyModel = async (modelId: string): Promise<void> => {
      if (modelId === currentModelId) return;
      const provider = findProviderSupport(modelId);
      if (provider) {
        const prepared = provider.prepare(modelId);
        if (prepared.error) {
          throw new Error(prepared.error);
        }
      }
      const next = resolveCliModel({
        cliModel: modelId,
        modelRuntime,
      });
      if (next.error || !next.model) {
        throw new Error(next.error ?? `Model not found: ${modelId}`);
      }
      await live.setModel(next.model);
      if (next.thinkingLevel) {
        live.setThinkingLevel(next.thinkingLevel);
      }
      currentModelId = modelId;
    };

    return {
      session: live,
      sessionManager,
      restoreProvider,
      piSessionId: sessionManager.getSessionId(),
      extensionPaths: additionalExtensionPaths,
      applyModel,
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
  reportActivity?: (update: WorkshopToolActivityUpdate) => void;
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
    modelId?: string,
  ): Promise<BoundPiState> {
    const existing = bindings.get(tools);
    if (existing && existing.profileId === profile.id) {
      const reload =
        modelId !== undefined &&
        sessionNeedsExtensionReload(
          existing.handle.extensionPaths,
          extensionPathsForModel(modelId),
        );
      if (!reload) {
        existing.profile = profile;
        existing.tools = tools;
        if (modelId) await existing.handle.applyModel?.(modelId);
        return existing;
      }
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
      (status) => {
        bindingHolder.current?.reportActivity?.(status);
      },
    );

    const handle = await openPiSession({
      cwd,
      agentDir,
      systemPrompt: profile.playbook,
      toolNames,
      customTools,
      modelId: modelId ?? resolveModelId(),
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

    async complete({ profile, message, tools, onDelta, onActivity, modelId }) {
      let state: BoundPiState;
      try {
        state = await ensureBound(profile, tools, modelId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          events: [{ type: "error", message: msg }],
        };
      }

      state.profile = profile;
      state.tools = tools;
      state.toolEvents = [];
      state.reportActivity = onActivity;
      workshopLog.info("workshop.turn.start", "prompt", {
        modelId,
        chars: message.length,
      });

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
        await state.handle.session.prompt(
          cursorBridgePrompt(
            message,
            modelId,
            profile.tools.map((tool) => tool.name),
          ),
        );
      } catch (err) {
        unsubscribe();
        const msg = err instanceof Error ? err.message : String(err);
        workshopLog.error("workshop.turn.done", msg, { modelId });
        return {
          events: [
            ...state.toolEvents,
            { type: "error", message: msg },
          ],
        };
      }
      unsubscribe();
      workshopLog.info("workshop.turn.done", "prompt", {
        modelId,
        toolCalls: state.toolEvents.length,
        textChars: assistantText.length,
      });

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

    async abort(tools) {
      const session = bindings.get(tools)?.handle.session;
      if (!session?.abort) return;
      workshopLog.info("workshop.turn.abort", "abort");
      await session.abort();
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
