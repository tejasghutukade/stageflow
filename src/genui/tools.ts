import { Type, type TSchema } from "typebox";
import { scrubSecrets } from "../compaction/scrub.js";
import { ArtifactPublishError, STATIC_CONTENT_MAX_BYTES, type ArtifactIssue } from "../artifacts/limits.js";
import { SessionPublishError, type SessionPublishSuccess } from "../artifacts/sessionPublish.js";
import { PRESENT_UI_TOOL_NAME, PUBLISH_ARTIFACT_TOOL_NAME } from "./names.js";
import { presentArtifact, presentCard, presentInline, type PresentArtifactResult } from "./present.js";
import { publishArtifactParameterSchema, publishBodyFromToolParams } from "./publishParams.js";
import { PUBLISH_KINDS } from "./kindsList.js";
import { inlineKinds, type Surface, type SurfacePolicy } from "./surface.js";

export { PRESENT_UI_TOOL_NAME, PUBLISH_ARTIFACT_TOOL_NAME } from "./names.js";

export function presentUiParameterSchema() {
  return Type.Object({
    key: Type.Optional(Type.String({ description: "Artifact key (owner/id) in this project." })),
    version: Type.Optional(Type.Integer({ minimum: 1, description: "Version to show. Omit to show the current version." })),
    title: Type.Optional(Type.String({ description: "Title shown with the artifact. Defaults to the artifact title." })),
    program: Type.Optional(Type.String({ description: "Program or text to save as a session artifact. Requires manifest." })),
    manifest: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Publish manifest, including kind. Required with program." })),
  });
}

export function presentCardParameterSchema() {
  return Type.Object({
    title: Type.Optional(Type.String({ description: "Short title shown above the card." })),
    program: Type.String({ description: "The card program: live.declarative, markdown text (static.markdown), or a full HTML document (live.html)." }),
    manifest: Type.Record(Type.String(), Type.Unknown(), {
      description: "Manifest with kind. live.declarative: format, library, bindings: []. live.html: format html, optional libraries ({name, version}), empty csp. static.markdown: kind only.",
    }),
  });
}

export type GenUiIssue = { path: string; message: string; code?: string };

export type GenUiToolResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; code: string; message: string; issues?: GenUiIssue[] };

/** One tool, defined once. Adapters (`adapters/pi.ts`, `adapters/operator.ts`) map it onto a caller's tool shape. */
export type GenUiToolSpec<P extends TSchema = TSchema> = {
  name: string;
  label: string;
  description: string;
  parameters: P;
  /** Runs synchronously up to its first await, so a call reserves its budget slot before parallel calls continue. */
  handler(args: unknown, surface: Surface): Promise<GenUiToolResult>;
};

function failure(code: string, message: string): GenUiToolResult {
  return { ok: false, code, message };
}

function fromPresent(result: PresentArtifactResult): GenUiToolResult {
  return result.ok ? { ok: true, value: result.envelope as unknown as Record<string, unknown> } : failure(result.code, result.message);
}

function argsRecord(args: unknown): Record<string, unknown> {
  return args !== null && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
}

function presentDescription(policy: SurfacePolicy): string {
  if (!policy.describeKinds) {
    return "Draw a generative card in this conversation (charts, tables, markdown, and the other kinds the playbook lists). Pass program, manifest (with kind) and a title. The card shows only what the program contains. To change a card, call again with the full updated program.";
  }
  const kinds = policy.kinds.join(", ");
  return policy.canShowSaved
    ? `Show an artifact from this project in the conversation. Kinds: ${kinds}. Pass key, or program and manifest for a one-off. Pass version only to pin one version. The result is a ui part. A missing key, a key from another project, or an invalid program is refused.`
    : `Draw a card in this conversation. Kinds: ${kinds}. Pass program, manifest (with kind) and a title. The card shows only what the program contains. To change a card, call again with the full updated program. An invalid program is refused with the reason.`;
}

async function presentProgram(surface: Surface, input: { title?: string; program: string; manifest: unknown }, slot: number): Promise<PresentArtifactResult> {
  const allowedKinds = inlineKinds(surface.policy);
  if (surface.policy.cardsInConversation) {
    return presentCard({ projectRoot: surface.projectRoot, surfaceKey: surface.key, ...input, presentedInMessage: slot, allowedKinds });
  }
  const store = await surface.artifacts?.();
  if (!store) return { ok: false, code: "ui.unavailable", message: "present_ui is not available" };
  return presentInline({
    ...store,
    projectRoot: surface.projectRoot,
    ...input,
    sessionId: surface.id,
    agentId: surface.owner.kind === "agent" ? surface.owner.agent : "",
    presentedInMessage: slot,
    allowedKinds,
  });
}

async function presentSaved(surface: Surface, input: { key: string; version?: number; title?: string }): Promise<PresentArtifactResult> {
  const store = await surface.artifacts?.();
  if (!store) return { ok: false, code: "ui.unavailable", message: "present_ui is not available" };
  return presentArtifact({ ...store, projectRoot: surface.projectRoot, ...input, allowedKinds: surface.policy.kinds });
}

async function handlePresent(args: unknown, surface: Surface): Promise<GenUiToolResult> {
  const { policy } = surface;
  const { key, version, title, program, manifest } = argsRecord(args);
  const hasProgram = typeof program === "string";
  const hasKey = typeof key === "string" && key.trim().length > 0;
  if (!policy.canShowSaved && hasKey) {
    return failure("ui.key_needs_artifacts", "This agent draws cards in the conversation and cannot show saved artifacts. Pass program and manifest instead");
  }
  if (hasProgram === hasKey) return failure("artifact.invalid_shape", policy.canShowSaved ? "Pass key, or program and manifest, not both" : "Pass program and manifest");
  if (version !== undefined && (typeof version !== "number" || !Number.isInteger(version))) {
    return failure("artifact.invalid_id", "Version must be a positive integer");
  }
  if (title !== undefined && typeof title !== "string") return failure("artifact.invalid_id", "Title must be text");
  if (hasProgram && (manifest === undefined || manifest === null || typeof manifest !== "object" || Array.isArray(manifest))) {
    return failure("artifact.invalid_shape", "manifest is required");
  }
  const titled = typeof title === "string" ? { title } : {};
  if (hasKey) {
    try {
      return fromPresent(await presentSaved(surface, { key: key as string, ...(typeof version === "number" ? { version } : {}), ...titled }));
    } catch {
      return failure("ui.unavailable", "present_ui is not available");
    }
  }
  const slot = surface.budget?.reserve() ?? 1;
  let result: PresentArtifactResult;
  try {
    result = await presentProgram(surface, { ...titled, program: program as string, manifest }, slot);
  } catch {
    result = { ok: false, code: "ui.unavailable", message: "present_ui is not available" };
  }
  if (!result.ok) surface.budget?.release();
  return fromPresent(result);
}

/** present_ui: a card in the conversation, or (artifacts mode) a saved artifact or a one-off session artifact. */
export function presentUiSpec(policy: SurfacePolicy): GenUiToolSpec {
  return {
    name: PRESENT_UI_TOOL_NAME,
    label: policy.canShowSaved ? "Present artifact" : "Draw card",
    description: presentDescription(policy),
    parameters: policy.canShowSaved ? presentUiParameterSchema() : presentCardParameterSchema(),
    handler: handlePresent,
  };
}

function scrubbedFailure(code: string, message: string, issues?: ArtifactIssue[]): GenUiToolResult {
  return {
    ok: false,
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
}

function publishedPayload(result: SessionPublishSuccess): Record<string, unknown> {
  const payload: { key: string; version: number; unchanged?: true; url?: string; warnings?: SessionPublishSuccess["warnings"] } = {
    key: result.key,
    version: result.version,
  };
  if (result.unchanged) payload.unchanged = true;
  if (result.url) payload.url = result.url;
  if (result.warnings && result.warnings.length > 0) payload.warnings = result.warnings;
  return payload;
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

async function handlePublish(args: unknown, surface: Surface): Promise<GenUiToolResult> {
  try {
    if (surface.owner.kind === "agent") rejectForeignOwner(surface.owner.agent, args);
    const port = surface.publish;
    if (!port) throw new SessionPublishError("artifact.invalid_shape", "artifact publish is not available");
    const body = await publishBodyFromToolParams(args, port.readPath);
    return { ok: true, value: publishedPayload(await port.publish(body)) };
  } catch (error) {
    if (error instanceof ArtifactPublishError || error instanceof SessionPublishError) {
      return scrubbedFailure(error.code, error.message, error.issues);
    }
    return scrubbedFailure("artifact.invalid_shape", "artifact publish failed");
  }
}

function publishDescription(publisher: "stage" | "agent"): string {
  const mib = Math.floor(STATIC_CONTENT_MAX_BYTES / (1024 * 1024));
  const subject = publisher === "agent" ? "owned by this agent" : "a person can open later";
  const turn = publisher === "stage" ? " This call does not end the turn." : "";
  return `Publish a titled, versioned artifact ${subject}. Kinds: ${PUBLISH_KINDS.join(", ")}. Static content at most ${mib} MiB. live.declarative takes content as the program plus format, library, bindings, and optional refresh. live.html takes the HTML document plus format, csp, libraries ({name, version} from the Host list), bindings, and optional refresh. Pass path, content, or content_base64. Publishing the same id again creates a new version.${turn} A validation error returns a code and issues; fix the arguments and call again.`;
}

/** publish_artifact for a stage attempt or an agent session; the surface's publish port reads paths and stores the artifact. */
export function publishArtifactSpec(publisher: "stage" | "agent") {
  return {
    name: PUBLISH_ARTIFACT_TOOL_NAME,
    label: "Publish artifact",
    description: publishDescription(publisher),
    parameters: publishArtifactParameterSchema(),
    handler: handlePublish,
  } satisfies GenUiToolSpec<ReturnType<typeof publishArtifactParameterSchema>>;
}
