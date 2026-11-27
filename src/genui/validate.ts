import { ArtifactPublishError, type ArtifactIssue } from "../artifacts/limits.js";
import { genUiKind, type GenUiContent, type GenUiKind, type GenUiMode } from "./kinds.js";

export type GenUiValidateInput = {
  kind: string;
  manifest: unknown;
  /** Program text, or a reader for it when the caller holds bytes. */
  program: string | (() => string);
  bytes?: Buffer;
  mode: GenUiMode;
};

function entryOf(kind: string): GenUiKind {
  const entry = genUiKind(kind);
  if (!entry) {
    const message = `Unsupported artifact kind: ${kind}`;
    throw new ArtifactPublishError(400, "artifact.invalid_kind", message, [{ path: "kind", message }]);
  }
  return entry;
}

function reader(program: string | (() => string)): () => string {
  if (typeof program !== "function") return () => program;
  let cached: string | undefined;
  return () => (cached ??= program());
}

/** The byte cap for this kind and mode: a card's own cap, or the artifact cap. */
export function genUiByteLimit(kind: string, mode: GenUiMode): number {
  const limits = entryOf(kind).limits;
  return mode === "card" ? (limits.cardBytes ?? limits.artifactBytes) : limits.artifactBytes;
}

/** Throws artifact.too_large when the content is over the kind's cap for this mode. */
export function assertGenUiSize(kind: string, byteLength: number, mode: GenUiMode): void {
  const cap = genUiByteLimit(kind, mode);
  if (byteLength <= cap) return;
  const subject = mode === "card" ? "program" : "content";
  const message = `${subject} is larger than ${cap} bytes`;
  throw new ArtifactPublishError(413, "artifact.too_large", message, [{ path: subject, message }]);
}

/** Per-kind manifest checks that need no project access. Card mode adds the display-only rules. */
export function parseGenUiManifest(input: GenUiValidateInput): GenUiContent {
  return entryOf(input.kind).parse({
    manifest: input.manifest,
    text: reader(input.program),
    ...(input.bytes ? { bytes: input.bytes } : {}),
    mode: input.mode,
  });
}

/** Per-kind program checks against the project (functions, components, HTML scan). Returns warnings. */
export function checkGenUiContent(input: {
  kind: string;
  content: GenUiContent;
  program: string | (() => string);
  projectRoot: string;
  mode: GenUiMode;
}): Promise<ArtifactIssue[]> {
  return entryOf(input.kind).check({
    content: input.content,
    text: reader(input.program),
    projectRoot: input.projectRoot,
    mode: input.mode,
  });
}

/** The one validator for generative UI content: what a card and a published artifact of a kind must satisfy. */
export async function validateGenUi(
  input: GenUiValidateInput & { projectRoot: string },
): Promise<{ content: GenUiContent; warnings: ArtifactIssue[] }> {
  const program = reader(input.program);
  const content = parseGenUiManifest({ ...input, program });
  const warnings = await checkGenUiContent({ kind: input.kind, content, program, projectRoot: input.projectRoot, mode: input.mode });
  return { content, warnings };
}
