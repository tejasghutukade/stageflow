import { rm } from "node:fs/promises";
import type { A2aStore } from "../a2a/store.js";
import type { RunStore } from "../runstore/port.js";
import { reclaimWorkspaceBinding } from "./repositoryMaterialize.js";

/**
 * Hard-delete a run across A2A, workspace, worktree/branch, then store rows last.
 * Filesystem/git step failures are logged and do not abort the sequence (R10).
 */
export async function deleteRunEverywhere(
  store: RunStore,
  a2aStore: A2aStore,
  runId: string,
): Promise<void> {
  try {
    await a2aStore.deleteByRunId(runId);
  } catch (err) {
    console.error(
      `deleteRunEverywhere: A2A cleanup failed for ${runId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  let meta;
  try {
    meta = await store.readRunMeta(runId);
  } catch {
    meta = undefined;
  }

  const workspaceDir = store.getWorkspaceDir(runId);
  try {
    await rm(workspaceDir, { recursive: true, force: true });
  } catch (err) {
    console.error(
      `deleteRunEverywhere: workspace rm failed for ${runId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  if (meta !== undefined) {
    try {
      await reclaimWorkspaceBinding(meta);
    } catch (err) {
      console.error(
        `deleteRunEverywhere: reclaimWorkspaceBinding failed for ${runId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  await store.deleteRun(runId);
}
