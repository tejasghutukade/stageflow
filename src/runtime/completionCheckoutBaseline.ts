import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CheckoutSnapshot } from "./completionCheckRunner.js";
import { attemptWorkspaceDir } from "../runstore/workspaceLayout.js";

function baselinePath(
  workspaceDir: string,
  stageId: string,
  attempt: number,
): string {
  return path.join(
    attemptWorkspaceDir(workspaceDir, stageId, attempt),
    "completion-checkout-before.json",
  );
}

function parseSnapshot(value: unknown): CheckoutSnapshot | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const entries = (value as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) return undefined;
  if (!entries.every((entry) =>
    entry !== null &&
    typeof entry === "object" &&
    typeof (entry as { path?: unknown }).path === "string" &&
    typeof (entry as { fingerprint?: unknown }).fingerprint === "string",
  )) {
    return undefined;
  }
  return {
    entries: entries.map((entry) => ({
      path: (entry as { path: string }).path,
      fingerprint: (entry as { fingerprint: string }).fingerprint,
    })),
  };
}

export async function readCompletionCheckoutBaseline(
  workspaceDir: string,
  stageId: string,
  attempt: number,
): Promise<CheckoutSnapshot | undefined> {
  try {
    const raw = await readFile(baselinePath(workspaceDir, stageId, attempt), "utf8");
    return parseSnapshot(JSON.parse(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("completion checkout baseline is unreadable");
  }
}

export async function writeCompletionCheckoutBaseline(
  workspaceDir: string,
  stageId: string,
  attempt: number,
  snapshot: CheckoutSnapshot,
): Promise<void> {
  const target = baselinePath(workspaceDir, stageId, attempt);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp`;
  await writeFile(temporary, `${JSON.stringify(snapshot)}\n`, "utf8");
  await rename(temporary, target);
}
