import {
  type CreateAgentSessionResult,
  type EventBus,
  type InlineExtension,
  type ToolDefinition,
  createAgentSession,
  DefaultResourceLoader,
  type ModelRuntime,
  type SessionManager,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";

export const WORKSHOP_FORBIDDEN_BUILTIN_TOOLS = ["bash", "write", "edit"] as const;

export type SealedResourceLoaderOptions = {
  cwd: string;
  agentDir: string;
  settingsManager: SettingsManager;
  systemPrompt: string;
  additionalExtensionPaths?: string[];
  additionalSkillPaths?: string[];
  extensionFactories?: InlineExtension[];
  eventBus?: EventBus;
};

/**
 * DefaultResourceLoader with host/global discovery turned off.
 *
 * Without these flags the loader walks up from the run folder and would pick
 * up the consumer project's AGENTS.md, `.agents/skills/`, `.pi/extensions`,
 * and APPEND_SYSTEM.md. Stages must not inherit that context.
 *
 * `additionalExtensionPaths` is the Cursor/provider seam. `extensionFactories`
 * is the isolated MCP seam. With `noExtensions: true`, discovered
 * global/project packages stay out; only those allowlists load.
 * `additionalSkillPaths` is the matching allowlist for one named skill.
 */
export function createSealedResourceLoader(
  options: SealedResourceLoaderOptions,
): DefaultResourceLoader {
  return new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager: options.settingsManager,
    systemPromptOverride: () => options.systemPrompt,
    appendSystemPromptOverride: () => [],
    additionalExtensionPaths: options.additionalExtensionPaths,
    additionalSkillPaths: options.additionalSkillPaths,
    ...(options.extensionFactories !== undefined
      ? { extensionFactories: options.extensionFactories }
      : {}),
    ...(options.eventBus !== undefined ? { eventBus: options.eventBus } : {}),
    noContextFiles: true,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
  });
}

export type CreatePiAgentSessionOptions = {
  cwd: string;
  agentDir: string;
  modelRuntime: ModelRuntime;
  sessionManager: SessionManager;
  customTools?: ToolDefinition[];
  tools?: string[];
  settingsManager?: SettingsManager;
  resourceLoader: DefaultResourceLoader;
};

export async function createPiAgentSession(
  options: CreatePiAgentSessionOptions,
): Promise<CreateAgentSessionResult> {
  return createAgentSession({
    cwd: options.cwd,
    agentDir: options.agentDir,
    modelRuntime: options.modelRuntime,
    ...(options.tools !== undefined ? { tools: options.tools } : {}),
    ...(options.customTools !== undefined
      ? { customTools: options.customTools }
      : {}),
    resourceLoader: options.resourceLoader,
    sessionManager: options.sessionManager,
    ...(options.settingsManager !== undefined
      ? { settingsManager: options.settingsManager }
      : {}),
  });
}

export function assertWorkshopToolsExcludeDiskShell(
  tools: readonly string[],
): void {
  const forbidden = WORKSHOP_FORBIDDEN_BUILTIN_TOOLS.filter((name) =>
    tools.includes(name),
  );
  if (forbidden.length > 0) {
    throw new Error(
      `Workshop Pi allowlist must not include disk/shell builtins: ${forbidden.join(", ")}`,
    );
  }
}

export function resolveWorkshopToolNames(customToolNames: string[]): string[] {
  assertWorkshopToolsExcludeDiskShell(customToolNames);
  return [...customToolNames];
}
