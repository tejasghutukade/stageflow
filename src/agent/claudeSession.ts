/**
 * Claude session continuity marker — the adapter's equivalent of Pi's
 * session JSONL file, minus the "reconstruct a dangling tool call" problem.
 *
 * Under "never let it go dangling" (see claudeAdapter.ts), by the time a
 * stage is waiting on an operator answer, the Claude CLI subprocess has
 * already exited cleanly on its own — there is nothing left to reopen or
 * repair. The only state that needs to survive a process restart is small
 * enough to write as one JSON file: the Claude `session_id` to resume, and
 * the exact operator prompt so a later `deliverAnswer()` can be validated
 * against it (and re-reported unchanged if `next()` is called again before
 * an answer arrives).
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AskOperatorPrompt } from "../tools/askOperator.js";
import type { StageRunInput } from "./port.js";
import { runtimeStageId } from "./port.js";
import type { StageUsage } from "../types/usage.js";

export type ClaudeSessionMarker = {
  sessionId: string;
  prompt?: AskOperatorPrompt;
  /** Cost/tokens accumulated by turns run so far, so a restart resuming this stage doesn't lose prior spend. */
  usage?: StageUsage;
};

/**
 * Derives a stable, per-attempt path from `input.resumeToken` — the same
 * value the runtime always recomputes identically for a given
 * (workspace, stage, attempt), so a later process asking for this stage's
 * marker lands on the same file. `resumeToken` defaults to Pi's own session
 * path (`.../pi-session.jsonl`); this adapter writes a sibling file instead
 * of reusing that path directly, so the two backends never share a file.
 */
export function claudeSessionMarkerPath(input: StageRunInput): string {
  if (input.resumeToken !== undefined && input.resumeToken.trim() !== "") {
    return path.join(path.dirname(input.resumeToken), "claude-session.json");
  }
  return path.join(
    input.roots.runWorkspaceDir,
    "stages",
    runtimeStageId(input),
    "claude-session.json",
  );
}

export async function readClaudeSessionMarker(
  markerPath: string,
): Promise<ClaudeSessionMarker | undefined> {
  try {
    const raw = await readFile(markerPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      typeof (parsed as { sessionId?: unknown }).sessionId === "string"
    ) {
      return parsed as ClaudeSessionMarker;
    }
    return undefined;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

export async function writeClaudeSessionMarker(
  markerPath: string,
  marker: ClaudeSessionMarker,
): Promise<void> {
  await mkdir(path.dirname(markerPath), { recursive: true });
  await writeFile(markerPath, JSON.stringify(marker), "utf8");
}

export async function clearClaudeSessionMarker(markerPath: string): Promise<void> {
  await rm(markerPath, { force: true });
}
