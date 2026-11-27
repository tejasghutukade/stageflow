import type { AgentDefinition } from "../config/loadAgent.js";
import type { PresentArtifactResult } from "../genui/present.js";
import { agentPresentUiPrompt } from "../genui/prompt.js";
import { PRESENT_UI_TOOL_NAME, presentCardParameterSchema, presentUiParameterSchema } from "../genui/tools.js";

export function appendAgentPresentUiPrompt(
  systemPrompt: string,
  definition: Pick<AgentDefinition, "ui">,
  options: { htmlCardsAvailable?: boolean } = {},
): string {
  const section = agentPresentUiPrompt(definition, options);
  if (section === undefined) return systemPrompt;
  return `${systemPrompt}\n\n${section}`;
}

function presentError(code: string, message: string) {
  const payload = { code, message };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    details: payload,
    isError: true as const,
  };
}

export type PresentUiTool = {
  name: typeof PRESENT_UI_TOOL_NAME;
  label: string;
  description: string;
  parameters: ReturnType<typeof presentUiParameterSchema>;
  execute(toolCallId: string, params: unknown): Promise<{
    content: Array<{ type: "text"; text: string }>;
    details: Record<string, unknown>;
    isError?: true;
  }>;
};

export function createPresentUiTool(options: {
  kinds: readonly string[];
  projectRoot: string;
  /** "conversation" offers cards only (program and manifest); "artifacts" also shows saved artifacts by key. */
  persistence?: "conversation" | "artifacts";
  present: (input: {
    key?: string;
    version?: number;
    title?: string;
    program?: string;
    manifest?: unknown;
    presentedInMessage: number;
  }) => Promise<PresentArtifactResult>;
}): PresentUiTool {
  const conversation = (options.persistence ?? "artifacts") === "conversation";
  return {
    name: PRESENT_UI_TOOL_NAME,
    label: conversation ? "Draw card" : "Present artifact",
    description: conversation
      ? `Draw a card in this conversation. Kinds: ${options.kinds.join(", ")}. Pass program, manifest (with kind) and a title. The card shows only what the program contains. To change a card, call again with the full updated program. An invalid program is refused with the reason.`
      : `Show an artifact from this project in the conversation. Kinds: ${options.kinds.join(", ")}. Pass key, or program and manifest for a one-off. Pass version only to pin one version. The result is a ui part. A missing key, a key from another project, or an invalid program is refused.`,
    parameters: (conversation ? presentCardParameterSchema() : presentUiParameterSchema()) as ReturnType<typeof presentUiParameterSchema>,
    execute: async (_toolCallId, params) => {
      const record = params !== null && typeof params === "object" && !Array.isArray(params) ? (params as Record<string, unknown>) : {};
      const key = record.key;
      const version = record.version;
      const title = record.title;
      const program = record.program;
      const manifest = record.manifest;
      const hasProgram = typeof program === "string";
      const hasKey = typeof key === "string" && key.trim().length > 0;
      if (conversation && hasKey) {
        return presentError("ui.key_needs_artifacts", "This agent draws cards in the conversation and cannot show saved artifacts. Pass program and manifest instead");
      }
      if (hasProgram === hasKey) return presentError("artifact.invalid_shape", conversation ? "Pass program and manifest" : "Pass key, or program and manifest, not both");
      if (version !== undefined && (typeof version !== "number" || !Number.isInteger(version))) {
        return presentError("artifact.invalid_id", "Version must be a positive integer");
      }
      if (title !== undefined && typeof title !== "string") return presentError("artifact.invalid_id", "Title must be text");
      if (hasProgram && (manifest === undefined || manifest === null || typeof manifest !== "object" || Array.isArray(manifest))) {
        return presentError("artifact.invalid_shape", "manifest is required");
      }
      try {
        const result = await options.present({
          ...(hasKey ? { key: key as string } : {}),
          ...(typeof version === "number" ? { version } : {}),
          ...(typeof title === "string" ? { title } : {}),
          ...(hasProgram ? { program, manifest } : {}),
          presentedInMessage: 0,
        });
        if (!result.ok) return presentError(result.code, result.message);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result.envelope) }],
          details: result.envelope as unknown as Record<string, unknown>,
        };
      } catch {
        return presentError("ui.unavailable", "present_ui is not available");
      }
    },
  };
}
