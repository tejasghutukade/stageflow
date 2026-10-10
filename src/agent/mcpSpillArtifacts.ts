import { copyFile, lstat, realpath, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionFactory, ToolResultEventResult } from "@earendil-works/pi-coding-agent";
import {
  ensureRealArtifactsDir,
  isInsideDir,
  resolveArtifactTarget,
  resolveContainedParent,
} from "../runstore/workspaceLayout.js";

export const STAGEFLOW_MCP_SPILL_EXTENSION_NAME = "stageflow-mcp-spill";

const SPILL_DIR = /^pi-mcp-output-[A-Za-z0-9]+$/;
const SPILL_FILE = /^(output|mcp-result)-[0-9a-f]{8}\.txt$/;
const SAVED_NOTICE =
  /Full text saved to: (\S+) —/;

const ARTIFACT_NOTE =
  "Stageflow saved the full output as a stage artifact at the path above. It is already stored. Read it with the read tool. Do not load it from a script or copy it with write_stage_artifact.";

type SpillContentBlock = { type: string; text?: string };

export type RelocateSpilledMcpOutputInput = {
  runWorkspaceDir: string;
  stageId: string;
  attempt: number;
  content: SpillContentBlock[];
  details: unknown;
  structuredContent?: unknown;
};

export type RelocatedMcpSpill = {
  content: SpillContentBlock[];
  details: unknown;
  structuredContent?: unknown;
};

export function createMcpSpillArtifactExtension(options: {
  runWorkspaceDir: string;
  stageId: string;
  attempt: number;
}): ExtensionFactory {
  const { runWorkspaceDir, stageId, attempt } = options;
  return (pi) => {
    pi.on("tool_result", async (event) => {
      let relocated: RelocatedMcpSpill | undefined;
      try {
        relocated = await relocateSpilledMcpOutput({
          runWorkspaceDir,
          stageId,
          attempt,
          content: event.content,
          details: event.details,
          ...(event.structuredContent !== undefined
            ? { structuredContent: event.structuredContent }
            : {}),
        });
      } catch {
        return undefined;
      }
      if (relocated === undefined) return undefined;
      return {
        content: relocated.content,
        details: relocated.details,
        ...(relocated.structuredContent !== undefined
          ? { structuredContent: relocated.structuredContent }
          : {}),
      } as ToolResultEventResult;
    });
  };
}

export async function relocateSpilledMcpOutput(
  input: RelocateSpilledMcpOutputInput,
): Promise<RelocatedMcpSpill | undefined> {
  const candidates = collectSpillCandidates(input.content, input.details);
  if (candidates.size === 0) return undefined;

  const replacements = new Map<string, string>();
  for (const candidate of candidates) {
    const source = await acceptedSpillPath(candidate);
    if (source === undefined) continue;
    const destination = await copySpillIntoArtifacts(input, source);
    if (destination === undefined) continue;
    replacements.set(candidate, destination);
    if (source !== candidate) replacements.set(source, destination);
  }
  if (replacements.size === 0) return undefined;

  let noted = false;
  const content = input.content.map((block) => {
    if (block.type !== "text" || typeof block.text !== "string") return block;
    const next = replacePathText(block.text, replacements);
    if (next === block.text) return block;
    noted = true;
    return { ...block, text: `${next}\n\n${ARTIFACT_NOTE}` };
  });
  if (!noted) {
    content.push({ type: "text", text: ARTIFACT_NOTE });
  }
  return {
    content,
    details: replacePathValue(input.details, replacements),
    ...(input.structuredContent !== undefined
      ? { structuredContent: replacePathValue(input.structuredContent, replacements) }
      : {}),
  };
}

function collectSpillCandidates(
  content: SpillContentBlock[],
  details: unknown,
): Set<string> {
  const found = new Set<string>();
  visit(content, undefined, found);
  visit(details, undefined, found);
  return found;
}

function visit(value: unknown, key: string | undefined, found: Set<string>): void {
  if (typeof value === "string") {
    if (key === "fullOutputPath" || key === "fullResultPath") found.add(value);
    const match = SAVED_NOTICE.exec(value);
    if (match?.[1] !== undefined) found.add(match[1]);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) visit(item, undefined, found);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [childKey, child] of Object.entries(value)) {
      visit(child, childKey, found);
    }
  }
}

async function acceptedSpillPath(candidate: string): Promise<string | undefined> {
  if (candidate.includes("\0") || !path.isAbsolute(candidate)) return undefined;
  let real: string;
  try {
    const linked = await lstat(candidate);
    if (!linked.isFile() && !linked.isSymbolicLink()) return undefined;
    real = await realpath(candidate);
    const file = await lstat(real);
    if (!file.isFile()) return undefined;
  } catch {
    return undefined;
  }
  const tempRoot = await realpath(tmpdir());
  if (!isInsideDir(real, tempRoot)) return undefined;
  if (!SPILL_DIR.test(path.basename(path.dirname(real)))) return undefined;
  if (!SPILL_FILE.test(path.basename(real))) return undefined;
  return real;
}

async function copySpillIntoArtifacts(
  input: RelocateSpilledMcpOutputInput,
  source: string,
): Promise<string | undefined> {
  const relativePath = path.posix.join("mcp-output", path.basename(source));
  const target = resolveArtifactTarget(
    input.runWorkspaceDir,
    input.stageId,
    input.attempt,
    relativePath,
  );
  const { realArtifacts } = await ensureRealArtifactsDir(
    input.runWorkspaceDir,
    target.artifactsDir,
  );
  const parent = await resolveContainedParent(
    realArtifacts,
    path.relative(target.artifactsDir, target.absolutePath),
  );
  const destination = path.join(parent, path.basename(target.absolutePath));
  await copyFile(source, destination);
  const written = await realpath(destination);
  if (!isInsideDir(written, realArtifacts)) {
    await unlink(destination).catch(() => undefined);
    return undefined;
  }
  return written;
}

function replacePathText(text: string, replacements: Map<string, string>): string {
  let next = text;
  for (const [from, to] of replacements) {
    if (next.includes(from)) next = next.split(from).join(to);
  }
  return next;
}

function replacePathValue(value: unknown, replacements: Map<string, string>): unknown {
  if (typeof value === "string") return replacePathText(value, replacements);
  if (Array.isArray(value)) return value.map((item) => replacePathValue(item, replacements));
  if (value !== null && typeof value === "object") {
    const next: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      next[key] = replacePathValue(child, replacements);
    }
    return next;
  }
  return value;
}
