/**
 * Writes an oversized tool result to the stage attempt's artifacts directory
 * as `tool-output/<toolCallId>-<toolName>.<json|txt>`, normalized so the
 * builtin `read` tool can page it by line.
 */
import { resolveArtifactTarget } from "../runstore/workspaceLayout.js";
import { writeContainedArtifact } from "../runstore/writeContainedArtifact.js";
import { tryParseJson, utf8ByteLength } from "./toolOutputBudget.js";

export const TOOL_OUTPUT_ARTIFACT_DIR = "tool-output";
export const SPILL_WRAP_LINE_BYTES = 4 * 1024;
const NAME_PART_MAX = 64;

export type SpillToolOutputOptions = {
  runWorkspaceDir: string;
  stageId: string;
  attempt: number;
  toolCallId: string;
  toolName: string;
  text: string;
};

export type SpilledToolOutput = {
  runRelativePath: string;
  absolutePath: string;
  body: string;
  bytes: number;
  lines: number;
  format: "json" | "text";
  wrapped: boolean;
  hasLongLines: boolean;
  json?: unknown;
};

export function sanitizeNamePart(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^\.+/, "_");
  const capped = cleaned.slice(0, NAME_PART_MAX);
  return capped.length > 0 ? capped : "_";
}

function codePointUtf8Bytes(codePoint: number): number {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3;
  return 4;
}

export function wrapLongLines(
  text: string,
  maxLineBytes = SPILL_WRAP_LINE_BYTES,
): { text: string; wrapped: boolean } {
  let wrapped = false;
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (utf8ByteLength(line) <= maxLineBytes) {
      out.push(line);
      continue;
    }
    wrapped = true;
    // Cut by code points so a chunk never splits a surrogate pair.
    let start = 0;
    let offset = 0;
    let bytes = 0;
    for (const ch of line) {
      const size = codePointUtf8Bytes(ch.codePointAt(0)!);
      if (bytes + size > maxLineBytes && offset > start) {
        out.push(line.slice(start, offset));
        start = offset;
        bytes = 0;
      }
      bytes += size;
      offset += ch.length;
    }
    out.push(line.slice(start));
  }
  return { text: out.join("\n"), wrapped };
}

export function normalizeSpillBody(text: string): {
  body: string;
  format: "json" | "text";
  wrapped: boolean;
  hasLongLines: boolean;
  json?: unknown;
} {
  const parsed = tryParseJson(text);
  if (parsed.ok) {
    // JSON stays valid: long string values are not wrapped.
    const body = JSON.stringify(parsed.value, null, 2);
    return {
      body,
      format: "json",
      wrapped: false,
      json: parsed.value,
      hasLongLines: body.split("\n").some((line) => utf8ByteLength(line) > SPILL_WRAP_LINE_BYTES),
    };
  }
  const { text: body, wrapped } = wrapLongLines(text);
  return { body, format: "text", wrapped, hasLongLines: false };
}

export async function spillToolOutput(
  options: SpillToolOutputOptions,
): Promise<SpilledToolOutput> {
  const normalized = normalizeSpillBody(options.text);
  const fileName = `${sanitizeNamePart(options.toolCallId)}-${sanitizeNamePart(options.toolName)}.${normalized.format === "json" ? "json" : "txt"}`;
  const { absolutePath, runRelativePath, artifactsDir } = resolveArtifactTarget(
    options.runWorkspaceDir,
    options.stageId,
    options.attempt,
    `${TOOL_OUTPUT_ARTIFACT_DIR}/${fileName}`,
  );
  await writeContainedArtifact(
    options.runWorkspaceDir,
    artifactsDir,
    absolutePath,
    normalized.body,
  );
  return {
    runRelativePath,
    absolutePath,
    body: normalized.body,
    bytes: utf8ByteLength(normalized.body),
    lines: normalized.body.split("\n").length,
    format: normalized.format,
    wrapped: normalized.wrapped,
    hasLongLines: normalized.hasLongLines,
    ...(normalized.json !== undefined ? { json: normalized.json } : {}),
  };
}
