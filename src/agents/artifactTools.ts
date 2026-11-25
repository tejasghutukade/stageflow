import path from "node:path";
import type { AgentDefinition } from "../config/loadAgent.js";
import { grantedStageflowTools } from "../toolkit/meta.js";
import type { ToolkitTool } from "../toolkit/index.js";
import { STAGEFLOW_PI_PREFIX } from "./runtime/types.js";
import { parseArtifactShowKey } from "../cli/artifactListFormat.js";
import { scrubSecrets } from "../compaction/scrub.js";
import { inspectArtifactUnderRoot } from "../runtime/artifactDiskInspect.js";
import { PATH_DENIED_MESSAGE } from "../runread/readArtifact.js";
import {
  ARTIFACT_DESCRIPTION_MAX_CHARS,
  ARTIFACT_SUMMARY_MAX_CHARS,
  ARTIFACT_TAG_MAX,
  ARTIFACT_TITLE_MAX_CHARS,
  LIVE_PROGRAM_MAX_BYTES,
  STATIC_CONTENT_MAX_BYTES,
  ArtifactPublishError,
  type ArtifactIssue,
} from "../artifacts/limits.js";
import { SessionPublishError, type SessionPublishBody, type SessionPublishSuccess } from "../artifacts/sessionPublish.js";
import { storedProjectMatches } from "../artifacts/projectIdentity.js";
import { bindableFunctionsFromAttachments } from "../artifacts/bindable.js";
import { liveArtifactsPromptSection } from "../artifacts/livePrompt.js";
import { LIVE_DECLARATIVE_KIND, LIVE_HTML_KIND } from "../artifacts/kinds.js";
import { PUBLISH_ARTIFACT_TOOL_NAME } from "../tools/stageToolNames.js";
import {
  STATIC_KINDS,
  publishArtifactParameterSchema,
  publishBodyFromToolParams,
  readCappedPublishFile,
} from "../tools/publishArtifact.js";
import { isWritePathForbidden } from "./policy.js";

export const AGENT_ARTIFACT_READ_SENTENCE =
  `You can list and read artifacts in this project with ${STAGEFLOW_PI_PREFIX}get_artifact.`;

export const AGENT_ARTIFACT_DELETE_SENTENCE =
  `You can delete an artifact this agent owns in this project with ${STAGEFLOW_PI_PREFIX}delete_artifact.`;

export const AGENT_ARTIFACT_REFRESH_SENTENCE =
  `You can refresh a live artifact this agent owns in this project with ${STAGEFLOW_PI_PREFIX}refresh_artifact.`;

export function agentHoldsArtifactWrite(definition: Pick<AgentDefinition, "tools">): boolean {
  return grantedStageflowTools(definition.tools.stageflow).includes("save_artifact");
}

export function agentHoldsArtifactRead(definition: Pick<AgentDefinition, "tools">): boolean {
  return grantedStageflowTools(definition.tools.stageflow).includes("get_artifact");
}

function agentHoldsArtifactCleanup(definition: Pick<AgentDefinition, "tools">): boolean {
  return grantedStageflowTools(definition.tools.stageflow).includes("delete_artifact");
}

function agentHoldsArtifactRefresh(definition: Pick<AgentDefinition, "tools">): boolean {
  return grantedStageflowTools(definition.tools.stageflow).includes("refresh_artifact");
}

export function agentArtifactPromptSection(
  definition: Pick<AgentDefinition, "tools">,
  projectRoot?: string,
): string | undefined {
  if (agentHoldsArtifactWrite(definition)) {
    const mib = Math.floor(STATIC_CONTENT_MAX_BYTES / (1024 * 1024));
    const lines = [
      "# Published artifacts",
      "",
      "Use publish_artifact for a final deliverable a person should open later. Skip scratch notes, logs, and intermediate files. Artifacts you publish are owned by this agent. This prompt does not list other agents' artifacts.",
      "",
      "The id is a lowercase slug: it starts with a letter, then has up to 63 letters, digits, underscores, or hyphens (`^[a-z][a-z0-9_-]{0,63}$`). Publishing the same id again creates a new version. If the bytes and kind are unchanged, the current version is kept and the tool returns unchanged.",
      "",
      `Kinds: ${STATIC_KINDS.join(", ")}, ${LIVE_DECLARATIVE_KIND}, ${LIVE_HTML_KIND}. Static content is at most ${mib} MiB. A live.declarative program is the content string, at most ${Math.round(LIVE_PROGRAM_MAX_BYTES / 1024)} KiB. live.html takes format, csp, libraries, bindings, and optional refresh. The title is at most ${ARTIFACT_TITLE_MAX_CHARS} characters. You may set at most ${ARTIFACT_TAG_MAX} tags, each matching [a-z0-9_-] and at most 32 characters. Description and summary are at most ${ARTIFACT_DESCRIPTION_MAX_CHARS} and ${ARTIFACT_SUMMARY_MAX_CHARS} characters.`,
      "",
      "Give path, content, or content_base64, and only one of them. path is relative to the project root. It must stay inside the project, must not be absolute, must not contain .., must not name an agent definition, must not point under the Stageflow home, and must not be a symlink. content is inline text. content_base64 is an image (png, jpeg, gif, or webp).",
    ];
    if (agentHoldsArtifactRead(definition)) {
      lines.push("", AGENT_ARTIFACT_READ_SENTENCE);
    }
    const functions = projectRoot ? bindableFunctionsFromAttachments(projectRoot, definition.tools.functions ?? []) : [];
    lines.push("", liveArtifactsPromptSection(functions));
    return withArtifactSentences(definition, lines.join("\n"));
  }
  if (agentHoldsArtifactRead(definition)) return withArtifactSentences(definition, AGENT_ARTIFACT_READ_SENTENCE);
  return withArtifactSentences(definition, undefined);
}

function withArtifactSentences(
  definition: Pick<AgentDefinition, "tools">,
  section: string | undefined,
): string | undefined {
  const extras = [
    agentHoldsArtifactCleanup(definition) ? AGENT_ARTIFACT_DELETE_SENTENCE : undefined,
    agentHoldsArtifactRefresh(definition) ? AGENT_ARTIFACT_REFRESH_SENTENCE : undefined,
  ].filter((line): line is string => line !== undefined);
  if (extras.length === 0) return section;
  const tail = extras.join("\n\n");
  return section === undefined ? tail : `${section}\n\n${tail}`;
}

/** Leaves the prompt unchanged when the agent has no artifact read, write, cleanup, or refresh grant. */
export function appendAgentArtifactPrompt(
  systemPrompt: string,
  definition: Pick<AgentDefinition, "tools">,
  projectRoot?: string,
): string {
  const section = agentArtifactPromptSection(definition, projectRoot);
  if (section === undefined) return systemPrompt;
  return `${systemPrompt}\n\n${section}`;
}

function toolError(code: string, message: string, issues?: ArtifactIssue[]) {
  const payload = {
    code,
    message: scrubSecrets(message),
    ...(issues !== undefined
      ? {
          issues: issues.map((issue) => ({
            path: issue.path,
            message: scrubSecrets(issue.message),
            ...(issue.code ? { code: issue.code } : {}),
          })),
        }
      : {}),
  };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    details: payload,
    isError: true as const,
  };
}

function toolOk(result: SessionPublishSuccess) {
  const payload: { key: string; version: number; unchanged?: true; url?: string; warnings?: SessionPublishSuccess["warnings"] } = {
    key: result.key,
    version: result.version,
  };
  if (result.unchanged) payload.unchanged = true;
  if (result.url) payload.url = result.url;
  if (result.warnings && result.warnings.length > 0) payload.warnings = result.warnings;
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    details: payload,
  };
}

function denyPath(): never {
  throw new ArtifactPublishError(403, "artifact.invalid_shape", PATH_DENIED_MESSAGE, [
    { path: "path", message: PATH_DENIED_MESSAGE },
  ]);
}

export async function readAgentPublishPath(
  projectRoot: string,
  stageflowHome: string,
  rawPath: string,
): Promise<Buffer> {
  if (typeof rawPath !== "string" || rawPath.length === 0 || path.isAbsolute(rawPath)) denyPath();
  if (rawPath.split(/[/\\]/).some((segment) => segment === "" || segment === "." || segment === "..")) denyPath();
  const resolved = path.resolve(projectRoot, rawPath);
  if (isWritePathForbidden(projectRoot, stageflowHome, resolved)) denyPath();
  const presence = await inspectArtifactUnderRoot(projectRoot, rawPath);
  if (presence.file_type === "symlink") denyPath();
  if (presence.file_type === "missing") {
    throw new ArtifactPublishError(404, "artifact.not_found", `Artifact not found: ${rawPath}`, [
      { path: "path", message: `Artifact not found: ${rawPath}` },
    ]);
  }
  if (presence.file_type !== "file" || presence.absolutePath === undefined) denyPath();
  if (isWritePathForbidden(projectRoot, stageflowHome, presence.absolutePath)) denyPath();
  if ((presence.size_bytes ?? 0) > STATIC_CONTENT_MAX_BYTES) {
    throw new ArtifactPublishError(
      413,
      "artifact.too_large",
      `content is larger than ${STATIC_CONTENT_MAX_BYTES} bytes`,
      [{ path: "path", message: `content is larger than ${STATIC_CONTENT_MAX_BYTES} bytes` }],
    );
  }
  return readCappedPublishFile(presence.absolutePath, STATIC_CONTENT_MAX_BYTES);
}

function rejectForeignOwner(agentId: string, params: unknown): void {
  if (params === null || typeof params !== "object" || Array.isArray(params)) return;
  if (!("owner" in params)) return;
  const owner = (params as { owner?: unknown }).owner;
  const self =
    owner !== null &&
    typeof owner === "object" &&
    !Array.isArray(owner) &&
    (owner as { kind?: unknown }).kind === "agent" &&
    (owner as { agent?: unknown }).agent === agentId &&
    Object.keys(owner).every((key) => key === "kind" || key === "agent");
  if (!self) {
    throw new ArtifactPublishError(403, "artifact.invalid_shape", "An agent can only publish artifacts it owns", [
      { path: "owner", message: "An agent can only publish artifacts it owns" },
    ]);
  }
}

export type AgentPublishTool = {
  name: typeof PUBLISH_ARTIFACT_TOOL_NAME;
  label: string;
  description: string;
  parameters: ReturnType<typeof publishArtifactParameterSchema>;
  execute(toolCallId: string, params: unknown): Promise<{
    content: Array<{ type: "text"; text: string }>;
    details: Record<string, unknown>;
    isError?: true;
  }>;
};

export function createAgentPublishArtifactTool(options: {
  agentId: string;
  projectRoot: string;
  stageflowHome: string;
  publish: (body: SessionPublishBody) => Promise<SessionPublishSuccess>;
}): AgentPublishTool {
  const mib = Math.floor(STATIC_CONTENT_MAX_BYTES / (1024 * 1024));
  return {
    name: PUBLISH_ARTIFACT_TOOL_NAME,
    label: "Publish artifact",
    description: `Publish a titled, versioned artifact owned by this agent. Kinds: ${STATIC_KINDS.join(", ")}, live.declarative, live.html. Static content at most ${mib} MiB. live.declarative takes content as the program plus format, library, bindings, and optional refresh. live.html takes the HTML document plus format, csp, libraries ({name, version} from the Host list), bindings, and optional refresh. Pass path, content, or content_base64. Publishing the same id again creates a new version. A validation error returns a code and issues; fix the arguments and call again.`,
    parameters: publishArtifactParameterSchema(),
    execute: async (_toolCallId, params) => {
      try {
        rejectForeignOwner(options.agentId, params);
        const body = await publishBodyFromToolParams(params, (rawPath) =>
          readAgentPublishPath(options.projectRoot, options.stageflowHome, rawPath),
        );
        const result = await options.publish(body);
        return toolOk(result);
      } catch (error) {
        if (error instanceof ArtifactPublishError || error instanceof SessionPublishError) {
          return toolError(error.code, error.message, error.issues);
        }
        return toolError("artifact.invalid_shape", "artifact publish failed");
      }
    },
  };
}

function artifactNotFound() {
  const payload = { code: "artifact.not_found", message: "Artifact not found", status: 404 };
  return { ok: false as const, text: JSON.stringify(payload) };
}

function bindAgentOwnedArtifact(tool: ToolkitTool, agentId: string, projectRoot: string): ToolkitTool {
  const own = `agent:${agentId}`;
  return {
    ...tool,
    async run(args, ctx) {
      const supplied = args.project_root;
      if (typeof supplied === "string" && supplied.trim().length > 0 && !storedProjectMatches(supplied, { path: projectRoot })) {
        return artifactNotFound();
      }
      const key = typeof args.key === "string" ? args.key : "";
      const parts = parseArtifactShowKey(key);
      if (parts && parts.ownerKey !== own) return artifactNotFound();
      return tool.run({ ...args, project_root: projectRoot }, ctx);
    },
  };
}

/** delete_artifact for an agent session: another owner, or another project, is artifact.not_found. */
export function bindAgentArtifactDelete(tool: ToolkitTool, agentId: string, projectRoot: string): ToolkitTool {
  return bindAgentOwnedArtifact(tool, agentId, projectRoot);
}

/** refresh_artifact for an agent session: another owner, or another project, is artifact.not_found. */
export function bindAgentArtifactRefresh(tool: ToolkitTool, agentId: string, projectRoot: string): ToolkitTool {
  return bindAgentOwnedArtifact(tool, agentId, projectRoot);
}

/** get_artifact for an agent session: reads and lists stay in the agent's project; any owner in it is readable. */
export function bindAgentArtifactRead(tool: ToolkitTool, projectRoot: string): ToolkitTool {
  return {
    ...tool,
    async run(args, ctx) {
      const supplied = args.project_root;
      if (typeof supplied === "string" && supplied.trim().length > 0 && !storedProjectMatches(supplied, { path: projectRoot })) {
        return artifactNotFound();
      }
      return tool.run({ ...args, project_root: projectRoot }, ctx);
    },
  };
}
