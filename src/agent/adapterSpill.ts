/**
 * pi-mcp-adapter cuts MCP text output at its output-guard limit and writes the
 * full text to `<tmpdir>/pi-mcp-output-*\/output-<hex>.txt`. When that happens
 * the visible result is only a head preview, so the tool output budget reads
 * the full body from the spill file instead. Only real files inside the OS
 * temp dir with the adapter's naming are accepted.
 */
import { lstat, readFile, realpath, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isInsideDir } from "../runstore/workspaceLayout.js";

const SPILL_DIR = /^pi-mcp-output-[A-Za-z0-9]+$/;
const SPILL_FILE = /^output-[0-9a-f]{8}\.txt$/;
const SAVED_NOTICE = /Full text saved to: (\S+) —/;

export type AdapterSpill =
  | { kind: "none" }
  | { kind: "full"; text: string; sourcePath: string }
  | { kind: "lost"; reason: string };

type OutputGuardDetails = {
  truncated?: unknown;
  fullOutputPath?: unknown;
  writeError?: unknown;
};

function outputGuardOf(details: unknown): OutputGuardDetails | undefined {
  if (details === null || typeof details !== "object") return undefined;
  const guard = (details as { outputGuard?: unknown }).outputGuard;
  return guard !== null && typeof guard === "object"
    ? (guard as OutputGuardDetails)
    : undefined;
}

export async function acceptedAdapterSpillPath(
  candidate: string,
): Promise<string | undefined> {
  if (candidate.includes("\0") || !path.isAbsolute(candidate)) return undefined;
  let real: string;
  try {
    const linked = await lstat(candidate);
    if (!linked.isFile() && !linked.isSymbolicLink()) return undefined;
    real = await realpath(candidate);
    if (!(await lstat(real)).isFile()) return undefined;
  } catch {
    return undefined;
  }
  const tempRoot = await realpath(tmpdir());
  if (!isInsideDir(real, tempRoot)) return undefined;
  if (!SPILL_DIR.test(path.basename(path.dirname(real)))) return undefined;
  if (!SPILL_FILE.test(path.basename(real))) return undefined;
  return real;
}

export async function readAdapterSpill(
  text: string,
  details: unknown,
): Promise<AdapterSpill> {
  const guard = outputGuardOf(details);
  if (guard?.truncated !== true) {
    return { kind: "none" };
  }
  const candidates = [
    typeof guard?.fullOutputPath === "string" ? guard.fullOutputPath : undefined,
    SAVED_NOTICE.exec(text)?.[1],
  ].filter((candidate): candidate is string => candidate !== undefined);
  for (const candidate of new Set(candidates)) {
    const source = await acceptedAdapterSpillPath(candidate);
    if (source === undefined) continue;
    try {
      return { kind: "full", text: await readFile(source, "utf8"), sourcePath: source };
    } catch {
      continue;
    }
  }
  return {
    kind: "lost",
    reason:
      typeof guard?.writeError === "string"
        ? guard.writeError
        : "the MCP adapter's full-output file was not available",
  };
}

/** Removes a vetted spill file and its now-empty `pi-mcp-output-*` dir. */
export async function discardAdapterSpill(sourcePath: string): Promise<void> {
  try {
    await unlink(sourcePath);
    await rmdir(path.dirname(sourcePath));
  } catch {
    // best-effort cleanup
  }
}
