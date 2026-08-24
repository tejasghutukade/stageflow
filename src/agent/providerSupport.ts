/**
 * Optional hooks for model providers that need more than Pi's built-in
 * auth/models (typically an allowlisted extension that calls registerProvider).
 *
 * PiAgentAdapter stays provider-agnostic: it only consumes this interface.
 * Concrete providers (Cursor today) live in their own modules and register here.
 */

export type ProviderPrepareResult = {
  /** Absolute paths passed to DefaultResourceLoader.additionalExtensionPaths. */
  extensionPaths: string[];
  /** Optional env / process restore after the stage ends. */
  restore?: () => void;
  /** Failure before session create (missing extension, bad config, …). */
  error?: string;
};

export type StageProviderSupport = {
  /** Stable id for logs/docs (e.g. "cursor"). */
  id: string;
  matches(modelRef: string): boolean;
  prepare(modelRef: string): ProviderPrepareResult;
  /**
   * Extra guidance for how the model must call emit_stage_envelope
   * (e.g. MCP bridge name). When omitted, the generic Pi tool name is used.
   */
  emitToolHint?(toolName: string): string;
};

const registry: StageProviderSupport[] = [];

export function registerProviderSupport(support: StageProviderSupport): void {
  const existing = registry.findIndex((entry) => entry.id === support.id);
  if (existing >= 0) {
    registry[existing] = support;
    return;
  }
  registry.push(support);
}

export function findProviderSupport(
  modelRef: string,
): StageProviderSupport | undefined {
  return registry.find((entry) => entry.matches(modelRef));
}
