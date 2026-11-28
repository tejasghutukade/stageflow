import path from "node:path";
import type { AgentDefinition } from "../config/loadAgent.js";
import { grantedStageflowTools } from "../toolkit/meta.js";
import type { ToolkitTool } from "../toolkit/index.js";
import { STAGEFLOW_PI_PREFIX } from "./runtime/types.js";
import { parseArtifactShowKey } from "../cli/artifactListFormat.js";
import { inspectArtifactUnderRoot } from "../runtime/artifactDiskInspect.js";
import { PATH_DENIED_MESSAGE } from "../runread/readArtifact.js";
import { STATIC_CONTENT_MAX_BYTES, ArtifactPublishError } from "../artifacts/limits.js";
import type { SessionPublishBody, SessionPublishSuccess } from "../artifacts/sessionPublish.js";
import { storedProjectMatches } from "../artifacts/projectIdentity.js";
import { bindableFunctionsFromAttachments } from "../artifacts/bindable.js";
import { toPiTool, type GenUiPiTool } from "../genui/adapters/pi.js";
import { PUBLISH_KINDS } from "../genui/kindsList.js";
import { genUiPublishPrompt } from "../genui/prompt.js";
import { publishOnlyPolicy, surfaceKey } from "../genui/surface.js";
import { publishArtifactSpec } from "../genui/tools.js";
import type { publishArtifactParameterSchema } from "../genui/publishParams.js";
import { readCappedPublishFile } from "../tools/publishArtifact.js";
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
    const functions = projectRoot ? bindableFunctionsFromAttachments(projectRoot, definition.tools.functions ?? []) : [];
    const notes = agentHoldsArtifactRead(definition) ? [AGENT_ARTIFACT_READ_SENTENCE] : [];
    return withArtifactSentences(definition, genUiPublishPrompt({ publisher: "agent", notes, functions }));
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

export type AgentPublishTool = GenUiPiTool<ReturnType<typeof publishArtifactParameterSchema>>;

/** publish_artifact for an agent session: the agent publishes as itself, and paths resolve inside its project. */
export function createAgentPublishArtifactTool(options: {
  agentId: string;
  projectRoot: string;
  stageflowHome: string;
  /** The session the tool serves; only names the surface. */
  sessionId?: string;
  publish: (body: SessionPublishBody) => Promise<SessionPublishSuccess>;
}): AgentPublishTool {
  const id = options.sessionId ?? options.agentId;
  return toPiTool(publishArtifactSpec("agent"), {
    key: surfaceKey("agent", id),
    id,
    owner: { kind: "agent", agent: options.agentId },
    projectRoot: options.projectRoot,
    policy: publishOnlyPolicy(PUBLISH_KINDS),
    publish: {
      readPath: (rawPath) => readAgentPublishPath(options.projectRoot, options.stageflowHome, rawPath),
      publish: options.publish,
    },
  });
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

/**
 * get_artifact for an agent session: reads and lists stay in the agent's project; any owner in it is readable.
 * For an anonymous public visitor (`visitorSessionId`), session artifacts from other conversations are not found and
 * lists stay on project artifacts, so one visitor cannot read what the agent made for another.
 */
export function bindAgentArtifactRead(tool: ToolkitTool, projectRoot: string, visitorSessionId?: string): ToolkitTool {
  return {
    ...tool,
    async run(args, ctx) {
      const supplied = args.project_root;
      if (typeof supplied === "string" && supplied.trim().length > 0 && !storedProjectMatches(supplied, { path: projectRoot })) {
        return artifactNotFound();
      }
      const bound = { ...args, project_root: projectRoot };
      if (visitorSessionId === undefined) return tool.run(bound, ctx);
      if (args.list === true) return tool.run({ ...bound, scope: "project" }, ctx);
      if (typeof args.key !== "string") return tool.run(bound, ctx);
      const record = await tool.run({ key: args.key, project_root: projectRoot, view: "record" }, ctx);
      if (!record.ok) return record;
      if (!visibleToVisitor(record.text, visitorSessionId)) return artifactNotFound();
      return tool.run(bound, ctx);
    },
  };
}

/** A visitor may read project artifacts and session artifacts from their own conversation; anything unreadable fails closed. */
function visibleToVisitor(recordText: string, sessionId: string): boolean {
  let record: { scope?: unknown; source?: { session_id?: unknown } };
  try {
    record = JSON.parse(recordText) as typeof record;
  } catch {
    return false;
  }
  if (record.scope === "project") return true;
  return record.scope === "session" && record.source?.session_id === sessionId;
}
